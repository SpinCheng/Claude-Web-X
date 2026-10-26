// test/unit/parsers.test.mjs - pure-function coverage for the transcript
// judgment pitfalls documented in docs/history.md (v22/v24/v26/v28).
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyLine } from '../../bridge/parsers-cc.js';

const run = (lines, rec = undefined) => {
  const events = []; const patch = { est: { tools: 0, think: 0, prose: 0 } };
  for (const o of lines) { const e = applyLine('s', o, patch, events, rec); if (e) events.push(e); }
  return { events, patch };
};
const user = (over = {}) => ({ type: 'user', timestamp: 't', cwd: 'D:\\x', origin: { kind: 'human' }, message: { role: 'user', content: 'hi' }, ...over });
const assistant = (parts) => ({ type: 'assistant', timestamp: 't', message: { role: 'assistant', model: 'glm-5.3', content: parts } });
const toolResultLine = (id, text, isError = false) => ({ type: 'user', timestamp: 't', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: [{ type: 'text', text }] }] } });
const costState = (i, o, usd) => ({ type: 'cost-state', modelUsage: { m: { inputTokens: i, outputTokens: o, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: usd } } });

test('human vs machine: tool_result with origin=null is machine (2.1.308)', () => {
  const { events } = run([user(), toolResultLine('t1', 'out'), user({ origin: null, message: { role: 'user', content: 'typed' } })]);
  assert.equal(events.filter((e) => e.k === 'user').length, 2);       // human + origin-null typed
  assert.equal(events.filter((e) => e.k === 'toolres').length, 1);    // result paired
});

test('phone-sent prompts (no origin, no tool_result) stay human', () => {
  const { events } = run([user({ origin: undefined, promptSource: 'sdk' })]);
  assert.equal(events[0].k, 'user');
  assert.equal(events[0].text, 'hi');
});

test('compaction summary folds to {k:compact,n}', () => {
  const { events } = run([user({ isCompactSummary: true, message: { role: 'user', content: 'x'.repeat(5000) } })]);
  assert.equal(events[0].k, 'compact');
  assert.equal(events[0].n, 5000);
});

test('skill body folds to {k:skill,name,n} - name = last path segment', () => {
  const body = 'Base directory for this skill: C:\\Users\\x\\.claude\\skills\\archify\n\n# Archify\nx';
  const { events } = run([user({ message: { role: 'user', content: [{ type: 'text', text: body }] } })]);
  assert.equal(events[0].k, 'skill');
  assert.equal(events[0].name, 'archify');
});

test('slash-command envelope normalizes to /name args', () => {
  const { events } = run([user({ message: { role: 'user', content: '<command-message>goal</command-message>\n<command-name>/goal</command-name>\n<command-args>do it</command-args>' } })]);
  assert.equal(events[0].text, '/goal do it');
});

test('CLI-injected [Image: source] turn is folded out', () => {
  const { events } = run([user({ message: { role: 'user', content: '[Image: source: C:\\t\\x.png]' } })]);
  assert.equal(events.length, 0);
});

test('tool_use carries id (pairing key); toolres items extract text/err/images', () => {
  const { events } = run([
    assistant([{ type: 'tool_use', id: 'tu9', name: 'Bash', input: { command: 'ls' } }]),
    toolResultLine('tu9', 'fileA\nfileB', true),
  ]);
  const toolEv = events.find((e) => e.k === 'assistant');
  const toolPart = toolEv.parts.find((p) => p.t === 'tool');
  assert.equal(toolPart.id, 'tu9');
  const tr = events.find((e) => e.k === 'toolres');
  assert.equal(tr.items[0].id, 'tu9');
  assert.equal(tr.items[0].err, true);
  assert.ok(tr.items[0].text.includes('fileA'));
});

test('tool_result text is capped at 4000 chars', () => {
  const { events } = run([toolResultLine('t1', 'x'.repeat(9000))]);
  assert.ok(events[0].items[0].text.length < 4100);
  assert.ok(events[0].items[0].text.includes('截断'));
});

test('adjacent cost-state snapshots collapse to the LAST one; separated stay', () => {
  const adj = run([costState(100, 10, 1), costState(200, 20, 2)]);
  assert.equal(adj.events.length, 1);
  assert.equal(adj.events[0].stats.inTok, 200);
  const sep = run([costState(1, 1, 1), assistant([{ type: 'text', text: 'mid' }]), costState(2, 2, 2)]);
  assert.equal(sep.events.filter((e) => e.k === 'stats').length, 2);
});

test('stop-ish system subtypes emit the stop marker + map outcomes', () => {
  for (const [subtype, outcome] of [['interrupt', 'stopped'], ['error', 'failed'], ['stop', 'ok']]) {
    const { events, patch } = run([{ type: 'system', subtype }]);
    assert.equal(events[0].k, 'stop');
    assert.equal(patch.lastOutcome, outcome);
  }
});

test('assistant line is the ONLY source of the display model label; cost-state never overwrites', () => {
  const { patch } = run([
    assistant([{ type: 'text', text: 'a' }]),
    costState(1, 1, 1),
  ]);
  assert.equal(patch.model, 'glm-5.3');
});

test('first human message seeds the fallback title', () => {
  const { patch } = run([user({ message: { role: 'user', content: 'this is a long first question about bridges' } })]);
  assert.equal(patch.titleFallback, true);
  assert.ok(patch.title.startsWith('this is a long'));
});
