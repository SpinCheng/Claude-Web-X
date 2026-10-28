// test/unit/parsers.test.mjs - pure-function coverage for the transcript
// judgment pitfalls documented in CLAUDE.md (转录格式 section).
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyLine, fenceTitle } from '../../bridge/parsers-cc.js';

const run = (lines, rec = {}) => { // rec defaults to a seeded (empty) record like _ensureSession creates
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

test('cost-state keeps the per-model breakdown (v48 cost panel); aggregates unchanged', () => {
  const line = { type: 'cost-state', modelUsage: {
    sonnet: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 500, cacheCreationInputTokens: 20, costUSD: 0.4 },
    opus: { inputTokens: 200, outputTokens: 30, cacheReadInputTokens: 700, cacheCreationInputTokens: 40, costUSD: 1.6 },
  } };
  const { patch } = run([line]);
  assert.equal(patch.cost.inTok, 300);
  assert.equal(patch.cost.usd, 2);
  assert.equal(patch.cost.models.sonnet.usd, 0.4);
  assert.equal(patch.cost.models.opus.inTok, 200);
  assert.equal(patch.cost.models.opus.cacheRead, 700);
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

test('first human message seeds the fallback title (first line, 24-cap, ellipsis)', () => {
  const { patch } = run([user({ message: { role: 'user', content: 'line one keeps going well past twenty-four chars\nline two ignored' } })]);
  assert.equal(patch.titleFallback, true);
  assert.equal(patch.title, 'line one keeps going wel…');
  const { patch: p2 } = run([user({ message: { role: 'user', content: 'short q' } })]);
  assert.equal(p2.title, 'short q');
});

// regression: the step-4 extraction left an undefined rec0 in the usage
// derivation below - fixtures without message.usage never executed it and
// the crash only surfaced on real transcripts (production bridge down)
test('assistant usage derives usageFirst/fixedTok without crashing', () => {
  const asstUsage = (parts) => ({ type: 'assistant', timestamp: 't', message: { role: 'assistant', model: 'glm-5.3', content: parts, usage: { input_tokens: 1000, cache_read_input_tokens: 2000, cache_creation_input_tokens: 500, output_tokens: 50 } } });
  const { patch } = run([user({ message: { role: 'user', content: 'hello world question' } }), asstUsage([{ type: 'text', text: 'a' }])]);
  assert.equal(patch.usage.in, 1000);
  assert.equal(patch.usage.cacheRead, 2000);
  assert.equal(patch.usageFirst, 3500);
  assert.ok(patch.fixedTok > 0);
});

test('usage derivation also works with a pre-seeded record (second run)', () => {
  const asstUsage = { type: 'assistant', timestamp: 't', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'a' }], usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } };
  const { patch } = run([asstUsage], { usageFirst: 999, firstUserChars: 10 }); // rec snapshot
  assert.equal(patch.usageFirst, undefined); // already known: not re-derived
});

// v39: blank/malformed custom-title records must not blank the current title
test('custom-title with a blank value is ignored', () => {
  const { patch } = run([user({ message: { role: 'user', content: 'seed question here' } }), { type: 'custom-title' }, { type: 'custom-title', customTitle: '' }]);
  assert.equal(patch.title, 'seed question here');
});

// v39: phone-rename write-fence classification (Desktop re-emits its cached
// pre-rename title in metadata flushes and reverts phone renames)
test('fenceTitle: stale prev is swallowed, real news disarms, matches pass', () => {
  const pin = { title: '新名字', prev: '旧名字' };
  assert.equal(fenceTitle(pin, '旧名字'), 'stale');
  assert.equal(fenceTitle(pin, '桌面端起的名'), 'disarm');
  assert.equal(fenceTitle(pin, '新名字'), null);   // desktop caught up: no action
  assert.equal(fenceTitle(null, '旧名字'), null);  // no pin armed
  assert.equal(fenceTitle(pin, undefined), null);  // not a title record
  assert.equal(fenceTitle(pin, ''), null);         // malformed blank
});

// v41c: cwd rides on ANY line type (system/local_command sidecars carry it
// too) - a transcript without user lines must still group by its project
test('cwd is harvested from non-user lines (ctxprobe sidecar shape)', () => {
  const { patch } = run([
    { type: 'mode', sessionId: 's' },
    { type: 'permission-mode', sessionId: 's', permissionMode: 'default' },
    { type: 'system', subtype: 'local_command', isSidechain: true, cwd: 'D:\\x\\y', timestamp: 't' },
    { type: 'cost-state', modelUsage: {} },
  ]);
  assert.equal(patch.cwd, 'D:\\x\\y');
});
