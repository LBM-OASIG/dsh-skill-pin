import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apply, __test } from '../index.js';

const { scanLogForLoadedSkills, scanSurfaceBodies, skillNameFromArguments } = __test;

/* ------------------------------------------------------------------ *
 * Fakes
 * ------------------------------------------------------------------ */

function toolCall(seq, name, args) {
  return { seq, type: 'tool/call', data: { name, arguments: JSON.stringify(args) } };
}

function userMessage(seq, text, source = { kind: 'user' }) {
  return {
    seq,
    type: 'user/message',
    data: { content: [{ type: 'text', text }], source },
  };
}

function toolResult(seq, text, isError = false) {
  return {
    seq,
    type: 'tool/result',
    data: { message: { callId: `call-${seq}`, content: [{ type: 'text', text }], isError } },
  };
}

function makeSession(events = [], header = { cwd: 'C:/work' }) {
  return {
    log: events,
    header,
    surface: { nodes: events.map((event) => event.seq) },
    eventAt(seq) {
      return events.find((event) => event.seq === seq);
    },
  };
}

function makeCtx(skills = {}) {
  const handlers = new Map();
  const logs = [];
  const ctx = {
    on(type, handler) {
      handlers.set(type, handler);
      return () => {};
    },
    logger: {
      info: (...args) => logs.push(['info', args]),
      warn: (...args) => logs.push(['warn', args]),
    },
    skills: {
      async get(name) {
        return skills[name];
      },
    },
  };
  return { ctx, handlers, logs };
}

function skill(name, content, extra = {}) {
  return {
    name,
    description: `${name} skill`,
    content,
    provider: 'filesystem',
    resourceBase: { kind: 'directory', path: `C:/skills/${name}` },
    ...extra,
  };
}

const AGENT = { name: 'lead' };
function wire(session) {
  AGENT.session = session;
  return AGENT;
}

async function preStep(handlers, agent, decision = { kind: 'enter', messages: [] }) {
  const handler = handlers.get('agent/pre-step');
  assert.equal(typeof handler, 'function', 'plugin must register agent/pre-step');
  return handler({ agent, signal: { throwIfAborted() {} } }, async () => decision);
}

/* ------------------------------------------------------------------ *
 * Argument parsing
 * ------------------------------------------------------------------ */

test('skillNameFromArguments accepts JSON text and plain objects', () => {
  assert.equal(skillNameFromArguments('{"name":"unslop"}'), 'unslop');
  assert.equal(skillNameFromArguments({ name: 'dsh-skill-pin' }), 'dsh-skill-pin');
});

test('skillNameFromArguments rejects malformed input', () => {
  assert.equal(skillNameFromArguments(undefined), undefined);
  assert.equal(skillNameFromArguments('not json'), undefined);
  assert.equal(skillNameFromArguments({ name: 'Bad Name' }), undefined);
  assert.equal(skillNameFromArguments({ name: '' }), undefined);
  assert.equal(skillNameFromArguments(['unslop']), undefined);
});

/* ------------------------------------------------------------------ *
 * Log scan
 * ------------------------------------------------------------------ */

test('log scan collects only loaded skill names and is incremental', () => {
  const events = [
    toolCall(0, 'read', { file_path: 'a.md' }),
    toolCall(1, 'skill', { name: 'unslop' }),
    toolResult(2, '<skill_content name="unslop">...</skill_content>'),
    toolCall(3, 'skill', { name: 'office' }),
  ];
  const session = makeSession(events);
  const state = { scanned: 0, names: new Set() };

  scanLogForLoadedSkills(session, state);
  assert.deepEqual([...state.names].sort(), ['office', 'unslop']);

  events.push(toolCall(4, 'skill', { name: 'pdf' }));
  scanLogForLoadedSkills(session, state);
  assert.deepEqual([...state.names].sort(), ['office', 'pdf', 'unslop']);
  assert.equal(state.scanned, 5);
});

test('log scan survives a forked or truncated log without losing the set', () => {
  const session = makeSession([toolCall(0, 'skill', { name: 'unslop' })]);
  const state = { scanned: 0, names: new Set() };
  scanLogForLoadedSkills(session, state);
  session.log = [toolCall(0, 'skill', { name: 'unslop' }), toolCall(1, 'skill', { name: 'pdf' })];
  scanLogForLoadedSkills(session, state);
  assert.deepEqual([...state.names].sort(), ['pdf', 'unslop']);
});

/* ------------------------------------------------------------------ *
 * Surface scan
 * ------------------------------------------------------------------ */

test('surface scan marks an untouched body intact', () => {
  const events = [toolResult(0, '<skill_content name="unslop">\nBODY\n</skill_content>')];
  const bodies = scanSurfaceBodies(makeSession(events));
  assert.equal(bodies.get('unslop'), 'intact');
});

test('surface scan marks a pruned body as pruned', () => {
  const events = [
    toolResult(0, '<skill_content name="unslop">\nHEAD\n\n[... tool result middle pruned ...]\n\nTAIL\n</skill_content>'),
  ];
  const bodies = scanSurfaceBodies(makeSession(events));
  assert.equal(bodies.get('unslop'), 'pruned');
});

test('surface scan prefers intact when the same skill appears twice', () => {
  const events = [
    toolResult(0, '<skill_content name="unslop">\n[... tool result middle pruned ...]\n</skill_content>'),
    userMessage(1, '<system-reminder>\n<skill_content name="unslop">\nBODY\n</skill_content>\n</system-reminder>'),
  ];
  const bodies = scanSurfaceBodies(makeSession(events));
  assert.equal(bodies.get('unslop'), 'intact');
});

test('surface scan returns undefined when the surface is unreadable', () => {
  assert.equal(scanSurfaceBodies({}), undefined);
  assert.equal(scanSurfaceBodies({ surface: { nodes: [0] } }), undefined);
});

/* ------------------------------------------------------------------ *
 * pre-step behaviour
 * ------------------------------------------------------------------ */

test('does nothing when the skill body is still visible', async () => {
  const events = [
    toolCall(0, 'skill', { name: 'unslop' }),
    toolResult(1, '<skill_content name="unslop">\nBODY\n</skill_content>'),
  ];
  const { ctx, handlers } = makeCtx({ unslop: skill('unslop', 'BODY') });
  apply(ctx, {});
  const decision = { kind: 'enter', messages: [] };
  const out = await preStep(handlers, wire(makeSession(events)), decision);
  assert.equal(out, decision);
  assert.equal(out.messages.length, 0);
});

test('re-injects a body that compaction removed', async () => {
  const events = [toolCall(0, 'skill', { name: 'unslop' })];
  const { ctx, handlers } = makeCtx({ unslop: skill('unslop', 'FULL BODY') });
  apply(ctx, {});
  const out = await preStep(handlers, wire(makeSession(events)));
  assert.equal(out.messages.length, 1);
  const message = out.messages[0];
  assert.equal(message.role, 'user');
  assert.equal(message.source.kind, 'skill-pin');
  assert.deepEqual(message.source.skills, ['unslop']);
  assert.match(message.content[0].text, /<skill-pin name="unslop"/);
  assert.match(message.content[0].text, /<skill_content name="unslop">/);
  assert.match(message.content[0].text, /FULL BODY/);
  assert.match(message.content[0].text, /C:\/skills\/unslop/);
});

test('re-injects when the tool result was pruned instead of compacted', async () => {
  const events = [
    toolCall(0, 'skill', { name: 'unslop' }),
    toolResult(1, '<skill_content name="unslop">\n[... tool result middle pruned ...]\n</skill_content>'),
  ];
  const { ctx, handlers } = makeCtx({ unslop: skill('unslop', 'FULL BODY') });
  apply(ctx, {});
  const out = await preStep(handlers, wire(makeSession(events)));
  assert.equal(out.messages.length, 1);
});

test('ignores sessions that never loaded a skill', async () => {
  const events = [toolCall(0, 'read', { file_path: 'a.md' }), userMessage(1, 'hello')];
  const { ctx, handlers } = makeCtx({ unslop: skill('unslop', 'BODY') });
  apply(ctx, {});
  const out = await preStep(handlers, wire(makeSession(events)));
  assert.equal(out.messages.length, 0);
});

test('passes a rejected decision through untouched', async () => {
  const events = [toolCall(0, 'skill', { name: 'unslop' })];
  const { ctx, handlers } = makeCtx({ unslop: skill('unslop', 'BODY') });
  apply(ctx, {});
  const rejected = { kind: 'reject', reason: 'nope' };
  const out = await preStep(handlers, wire(makeSession(events)), rejected);
  assert.equal(out, rejected);
});

test('does not stack a second pin inside the same step batch', async () => {
  const events = [toolCall(0, 'skill', { name: 'unslop' })];
  const { ctx, handlers } = makeCtx({ unslop: skill('unslop', 'BODY') });
  apply(ctx, {});
  const decision = { kind: 'enter', messages: [{ source: { kind: 'skill-pin' }, role: 'user', content: [] }] };
  const out = await preStep(handlers, wire(makeSession(events)), decision);
  assert.equal(out.messages.length, 1);
});

test('honours allowSkills and denySkills', async () => {
  const events = [
    toolCall(0, 'skill', { name: 'unslop' }),
    toolCall(1, 'skill', { name: 'office' }),
  ];
  const skills = { unslop: skill('unslop', 'A'), office: skill('office', 'B') };

  const allowCtx = makeCtx(skills);
  apply(allowCtx.ctx, { allowSkills: ['office'] });
  const allowOut = await preStep(allowCtx.handlers, wire(makeSession(events)));
  assert.equal(allowOut.messages.length, 1);
  assert.match(allowOut.messages[0].content[0].text, /name="office"/);

  const denyCtx = makeCtx(skills);
  apply(denyCtx.ctx, { denySkills: ['office'] });
  const denyOut = await preStep(denyCtx.handlers, wire(makeSession(events)));
  assert.equal(denyOut.messages.length, 1);
  assert.match(denyOut.messages[0].content[0].text, /name="unslop"/);
});

test('truncates an oversized body and says so', async () => {
  const events = [toolCall(0, 'skill', { name: 'unslop' })];
  const { ctx, handlers } = makeCtx({ unslop: skill('unslop', 'x'.repeat(500)) });
  apply(ctx, { maxCharsPerSkill: 120 });
  const out = await preStep(handlers, wire(makeSession(events)));
  const text = out.messages[0].content[0].text;
  assert.match(text, /truncated at 120 chars/);
  const body = text.split('<skill_instructions>')[1].split('</skill_instructions>')[0];
  assert.equal((body.match(/x/g) ?? []).length, 120);
});

test('respects the total budget across several skills', async () => {
  const events = [
    toolCall(0, 'skill', { name: 'unslop' }),
    toolCall(1, 'skill', { name: 'office' }),
  ];
  const skills = { unslop: skill('unslop', 'a'.repeat(200)), office: skill('office', 'b'.repeat(200)) };
  const { ctx, handlers } = makeCtx(skills);
  apply(ctx, { maxCharsPerSkill: 200, maxTotalChars: 250 });
  const out = await preStep(handlers, wire(makeSession(events)));
  assert.equal(out.messages.length, 1);
  assert.match(out.messages[0].content[0].text, /name="unslop"/);
});

test('skips a skill the registry no longer knows', async () => {
  const events = [toolCall(0, 'skill', { name: 'ghost' })];
  const { ctx, handlers } = makeCtx({});
  apply(ctx, {});
  const out = await preStep(handlers, wire(makeSession(events)));
  assert.equal(out.messages.length, 0);
});

test('enabled: false turns the plugin off', async () => {
  const events = [toolCall(0, 'skill', { name: 'unslop' })];
  const { ctx, handlers } = makeCtx({ unslop: skill('unslop', 'BODY') });
  apply(ctx, { enabled: false });
  const out = await preStep(handlers, wire(makeSession(events)));
  assert.equal(out.messages.length, 0);
});

test('re-injects again after a later compaction removes the pin', async () => {
  const content = 'FULL BODY';
  const events = [toolCall(0, 'skill', { name: 'unslop' })];
  const { ctx, handlers } = makeCtx({ unslop: skill('unslop', content) });
  apply(ctx, {});
  const session = makeSession(events);

  const first = await preStep(handlers, wire(session));
  assert.equal(first.messages.length, 1);

  // The pin was committed: it is now visible, so a second step stays quiet.
  const pinEvent = userMessage(1, first.messages[0].content[0].text, { kind: 'skill-pin' });
  session.log.push(pinEvent);
  session.surface.nodes.push(pinEvent.seq);
  assert.equal((await preStep(handlers, wire(session))).messages.length, 0);

  // A new compaction shadows both the pin and the original result.
  session.surface.nodes = [0];
  const third = await preStep(handlers, wire(session));
  assert.equal(third.messages.length, 1);
});
