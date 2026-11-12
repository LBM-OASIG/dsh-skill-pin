/**
 * dsh-skill-pin — host half.
 *
 * Keeps the skills a session actually loaded alive across context compaction.
 * It derives the loaded set from the Session log (`tool/call` events named
 * `skill`), watches the model-visible surface for the matching
 * `<skill_content name="…">` block, and re-injects the original body through
 * `agent/pre-step` only when that block is gone (compaction shadowed it, or
 * tool-result pruning truncated its middle). Nothing is injected for skills
 * the model never loaded, and nothing is injected while the body is still
 * visible.
 *
 * Zero package dependencies on purpose: the plugin only reads Cordis events,
 * the injected `skills` service, an optional `workingDirectory` lookup, and
 * plain Session data. State is a derived cache keyed by Session; the log stays
 * the source of truth.
 */

export const name = 'dsh-skill-pin';

/** Without the skill registry there is nothing to restore. */
export const inject = ['skills'];

/** Tool result pruner marker (see @deepseek-ai/dsh-compaction-tool-result-pruner). */
const PRUNE_MARKER = '[... tool result middle pruned ...]';

const BODY_OPEN_RE = /<skill_content name="([^"]+)">/;
const SKILL_TOOL_NAME = 'skill';

const DEFAULTS = {
  enabled: true,
  maxCharsPerSkill: 20_000,
  maxTotalChars: 40_000,
  maxSkills: 5,
  allowSkills: [],
  denySkills: [],
};

export function apply(ctx, config) {
  const cfg = normalizeConfig(config);

  /** session -> incremental scan cursor + loaded skill names (derived cache). */
  const ledger = new WeakMap();

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (decision === undefined || decision.kind === 'reject') return decision;
    try {
      return await restoreMissingSkills(ctx, cfg, ledger, payload, decision);
    } catch (error) {
      // A pre-step listener must never fail the turn: a broken lookup or an
      // unavailable service just leaves the host decision untouched.
      ctx.logger?.warn?.('dsh-skill-pin: restore skipped: %o', error);
      return decision;
    }
  });
}

async function restoreMissingSkills(ctx, cfg, ledger, { agent, signal }, decision) {
  if (!cfg.enabled) return decision;

  const session = agent?.session;
  if (session === undefined) return decision;
  if (typeof ctx.skills?.get !== 'function') return decision;

  const state = stateFor(ledger, session);
  scanLogForLoadedSkills(session, state);
  if (state.names.size === 0) return decision;

  // A pin we already added to this step's batch means the body is arriving
  // right now; the durable surface only catches up after the step commits.
  if ((decision.messages ?? []).some((message) => message?.source?.kind === 'skill-pin')) return decision;

  const bodies = scanSurfaceBodies(session);
  if (bodies === undefined) return decision; // unreadable surface: never guess

  const wanted = [...state.names]
    .filter((name) => cfg.allowSkills.length === 0 || cfg.allowSkills.includes(name))
    .filter((name) => !cfg.denySkills.includes(name))
    .filter((name) => bodies.get(name) !== 'intact')
    .slice(0, cfg.maxSkills);

  if (wanted.length === 0) return decision;


  const lookup = {
    ...(await resolveCwd(ctx, agent, session, signal) ?? {}),
    signal,
    scope: agent,
  };

  const messages = [];
  let total = 0;
  for (const name of wanted) {
    signal?.throwIfAborted?.();
    let skill;
    try {
      skill = await ctx.skills.get(name, lookup);
    } catch (error) {
      ctx.logger?.warn?.('dsh-skill-pin: lookup for "%s" failed: %o', name, error);
      continue;
    }
    if (skill === undefined) continue;

    const raw = typeof skill.content === 'string' ? skill.content : '';
    if (raw.length === 0) continue;

    const perSkill = Math.max(1, cfg.maxCharsPerSkill);
    const truncated = raw.length > perSkill;
    const body = truncated ? raw.slice(0, perSkill) : raw;
    if (total + body.length > cfg.maxTotalChars) continue;
    total += body.length;

    messages.push(makePinMessage(agent, skill, body, truncated, cfg));
  }

  if (messages.length === 0) return decision;
  ctx.logger?.info?.(
    'dsh-skill-pin: re-injected %d skill(s) after compaction: %s',
    messages.length,
    wanted.join(', '),
  );
  return { ...decision, messages: [...decision.messages, ...messages] };
}

function stateFor(ledger, session) {
  let state = ledger.get(session);
  if (state === undefined) {
    state = { scanned: 0, names: new Set() };
    ledger.set(session, state);
  }
  return state;
}

/**
 * cwd for the skill registry lookup: the live working directory when that
 * service is reachable, otherwise the session header. Never throws — a
 * undeclared service on a Cordis context throws on property access, so the
 * whole probe stays inside try/catch.
 */
async function resolveCwd(ctx, agent, session, signal) {
  let workingDirectory;
  try {
    workingDirectory = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined;
  } catch {
    workingDirectory = undefined;
  }
  if (typeof workingDirectory?.ensure === 'function') {
    try {
      const cwd = await workingDirectory.ensure(agent, signal);
      if (typeof cwd === 'string' && cwd.length > 0) return { cwd };
    } catch {
      // fall through to the session header
    }
  }
  const cwd = session?.header?.cwd;
  return typeof cwd === 'string' && cwd.length > 0 ? { cwd } : {};
}

/* ------------------------------------------------------------------ *
 * Log scan: which skills did this Session actually load?
 * ------------------------------------------------------------------ */

function scanLogForLoadedSkills(session, state) {
  const log = session?.log;
  if (!Array.isArray(log)) return state.names;
  if (state.scanned > log.length) state.scanned = 0; // log replaced/forked
  for (let index = state.scanned; index < log.length; index += 1) {
    const event = log[index];
    if (event?.type !== 'tool/call' || event.data?.name !== SKILL_TOOL_NAME) continue;
    const name = skillNameFromArguments(event.data.arguments);
    if (name !== undefined) state.names.add(name);
  }
  state.scanned = log.length;
  return state.names;
}

function skillNameFromArguments(raw) {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (value === null || typeof value !== 'object') return undefined;
  const name = value.name;
  return typeof name === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ? name : undefined;
}

/* ------------------------------------------------------------------ *
 * Surface scan: is the body still visible to the model?
 * ------------------------------------------------------------------ */

function scanSurfaceBodies(session) {
  const events = surfaceEvents(session);
  if (events === undefined) return undefined;
  const bodies = new Map();
  for (const event of events) {
    if (event?.type !== 'user/message' && event?.type !== 'tool/result') continue;
    const content = event.type === 'user/message' ? event.data?.content : event.data?.message?.content;
    const text = textOfContent(content);
    if (text.length === 0) continue;
    const match = BODY_OPEN_RE.exec(text);
    if (match === null) continue;
    const name = match[1];
    const pruned = text.includes(PRUNE_MARKER);
    if (bodies.get(name) === 'intact') continue;
    bodies.set(name, pruned ? 'pruned' : 'intact');
  }
  return bodies;
}

function surfaceEvents(session) {
  try {
    const nodes = session?.surface?.nodes;
    const eventAt = session?.eventAt;
    if (nodes === undefined || typeof eventAt !== 'function') return undefined;
    const out = [];
    for (const seq of Array.from(nodes)) {
      const event = eventAt.call(session, seq);
      if (event !== undefined) out.push(event);
    }
    return out;
  } catch {
    return undefined;
  }
}

function textOfContent(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text);
    }
  }
  return parts.join('\n');
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function makePinMessage(agent, skill, body, truncated, cfg) {
  const text = renderPin(skill, body, truncated, cfg);
  return {
    id: randomId(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'skill-pin', form: 'instructions', skills: [skill.name] },
  };
}

function renderPin(skill, body, truncated, cfg) {
  const name = escapeAttribute(skill.name);
  const resources = resourceLines(skill);
  return [
    '<system-reminder>',
    `<skill-pin name="${name}" reason="${truncated ? 'restored-truncated' : 'restored'}">`,
    `Earlier in this session the skill "${name}" was loaded, and its instructions are no longer visible in context`,
    '(context compaction removed them, or tool-result pruning truncated them).',
    'The original body is restored below: follow it, and do not reconstruct it from the compaction summary.',
    '</skill-pin>',
    `<skill_content name="${name}">`,
    '<skill_resources>',
    ...resources,
    'Load referenced resources only as needed.',
    '</skill_resources>',
    '',
    '<skill_instructions>',
    body,
    truncated ? `\n[skill-pin: truncated at ${cfg.maxCharsPerSkill} chars; load the skill again for the rest]` : '',
    '</skill_instructions>',
    '</skill_content>',
    '</system-reminder>',
  ].join('\n');
}

function resourceLines(skill) {
  const base = skill?.resourceBase;
  if (base === undefined) return ['Resources are managed by the skill provider.'];
  if (base.kind === 'directory') return [`Base directory for this skill: ${String(base.path)}`];
  if (base.kind === 'url') return [`Base URL for this skill: ${String(base.url)}`];
  if (base.kind === 'opaque') return [`Resources for this skill: ${String(base.description ?? '')}`];
  return ['Resources are managed by the skill provider.'];
}

function escapeAttribute(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

function randomId() {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  }
}

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

function normalizeConfig(input) {
  const raw = input !== null && typeof input === 'object' ? input : {};
  const unwrap = (value) =>
    value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;
  const bool = (value, fallback) => (typeof unwrap(value) === 'boolean' ? unwrap(value) : fallback);
  const num = (value, fallback) => {
    const n = unwrap(value);
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  const list = (value, fallback) => {
    const v = unwrap(value);
    if (Array.isArray(v)) return v.filter((item) => typeof item === 'string');
    if (typeof v === 'string') return v.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
    return fallback;
  };
  return {
    enabled: bool(raw.enabled, DEFAULTS.enabled),
    maxCharsPerSkill: num(raw.maxCharsPerSkill, DEFAULTS.maxCharsPerSkill),
    maxTotalChars: num(raw.maxTotalChars, DEFAULTS.maxTotalChars),
    maxSkills: num(raw.maxSkills, DEFAULTS.maxSkills),
    allowSkills: list(raw.allowSkills, DEFAULTS.allowSkills),
    denySkills: list(raw.denySkills, DEFAULTS.denySkills),
  };
}

/** Internals exposed for the plugin's own tests; not a public API. */
export const __test = { DEFAULTS, normalizeConfig, scanLogForLoadedSkills, scanSurfaceBodies, skillNameFromArguments, renderPin };
