// test/unit/turns.test.mjs - transcript turn-model semantics for user events:
// replay dedupe vs queued-dispatch fresh push (v37). applyEventToTurns is the
// pure model half of transcript.js (rendering is the caller's job), so it
// runs in node with browser globals stubbed for the import-time wiring only
// (state.js reads matchMedia/localStorage; transcript.js pulls overlays.js
// which binds its scrim-click listeners at module scope).
import { test } from 'node:test';
import assert from 'node:assert';

const fakeEl = () => ({
  addEventListener: () => {},
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
});
globalThis.matchMedia = globalThis.matchMedia || (() => ({ matches: false }));
globalThis.localStorage = globalThis.localStorage || {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
};
globalThis.document = globalThis.document || {
  getElementById: () => fakeEl(),
  querySelector: () => fakeEl(),
  querySelectorAll: () => [],
  addEventListener: () => {},
  createElement: () => fakeEl(),
};
globalThis.window = globalThis.window || { addEventListener: () => {} };

const { applyEventToTurns, fileChanges, mergeBotTurns, pairToolResults, drainOrphanRes } =
  await import('../../public/js/views/transcript.js');
const { state } = await import('../../public/js/state.js');

const userTurns = () => state.turns.filter((t) => t.role === 'user');

test('same-line re-delivery (equal ts) is a replay: no-op', () => {
  state.turns = [];
  applyEventToTurns({ k: 'user', ts: '1', text: '继续' });
  applyEventToTurns({ k: 'assistant', ts: '2', parts: [{ t: 'text', v: 'ok' }] });
  applyEventToTurns({ k: 'user', ts: '1', text: '继续' }); // the SAME line, re-fired
  assert.equal(userTurns().length, 1, 're-delivered duplicate must not push');
});

test('genuinely repeated identical question pushes a fresh bubble (v75)', () => {
  state.turns = [];
  applyEventToTurns({ k: 'user', ts: '1', text: '继续' });
  applyEventToTurns({ k: 'assistant', ts: '2', parts: [{ t: 'text', v: 'ok' }] });
  applyEventToTurns({ k: 'user', ts: '3', text: '继续' }); // asked AGAIN, later line
  assert.equal(userTurns().length, 2, 'a later same-text line is a new question');
});

test('ts-less events fall back to the structural rule', () => {
  state.turns = [];
  applyEventToTurns({ k: 'user', ts: '', text: 'hi' });
  applyEventToTurns({ k: 'user', ts: '', text: 'hi' }); // bot after elder still empty -> replay
  assert.equal(userTurns().length, 1);
  applyEventToTurns({ k: 'assistant', ts: '', parts: [{ t: 'text', v: 'ok' }] });
  applyEventToTurns({ k: 'user', ts: '', text: 'hi' }); // conversation moved past -> new
  assert.equal(userTurns().length, 2);
});

test('queued dispatch with same-text elder pushes a fresh turn', () => {
  state.turns = [];
  applyEventToTurns({ k: 'user', ts: '1', text: '继续' });
  applyEventToTurns({ k: 'assistant', ts: '2', parts: [{ t: 'text', v: 'ok' }] });
  state.expectQueuedUser = true; // queue-dispatched frame armed the fold
  applyEventToTurns({ k: 'user', ts: '3', text: '继续' });
  const users = userTurns();
  assert.equal(users.length, 2, 'queued dispatch must render despite same-text elder');
  assert.equal(users[1].text, '继续');
  assert.equal(state.expectQueuedUser, false, 'flag consumed on first user event');
});

test('double-fire after a queued dispatch is deduped again', () => {
  // continuing state from the previous test is NOT assumed; rebuild it
  state.turns = [];
  applyEventToTurns({ k: 'user', ts: '1', text: '继续' });
  applyEventToTurns({ k: 'assistant', ts: '2', parts: [{ t: 'text', v: 'ok' }] });
  state.expectQueuedUser = true;
  applyEventToTurns({ k: 'user', ts: '3', text: '继续' }); // dispatch lands
  applyEventToTurns({ k: 'user', ts: '3', text: '继续' }); // double-fired copy (same line, same ts)
  assert.equal(userTurns().length, 2, 'second copy is a replay again');
});

test('flag is consumed even when the event text is unique', () => {
  state.turns = [];
  applyEventToTurns({ k: 'user', ts: '1', text: 'a' });
  state.expectQueuedUser = true;
  applyEventToTurns({ k: 'user', ts: '2', text: 'b' }); // unique text
  assert.equal(state.expectQueuedUser, false, 'no stale flag for later events');
  assert.equal(userTurns().length, 2);
});

test('queued dispatch still folds into a pending optimistic twin', () => {
  // race: client thought idle and pushed optimistic, server queued it; the
  // dispatch's event must confirm the twin in place, not double-push
  state.turns = [];
  state.turns.push({ role: 'user', text: '继续', ts: '', optimistic: true });
  state.turns.push({ role: 'bot', think: [], tools: [], texts: [], steps: [], ts: '' });
  state.expectQueuedUser = true;
  const at = applyEventToTurns({ k: 'user', ts: '3', text: '继续' });
  assert.notEqual(at, null, 'fold returns the edited index');
  assert.equal(userTurns().length, 1, 'twin confirmed in place, no duplicate');
  assert.equal(userTurns()[0].optimistic, false);
});

test('fileChanges merges edits per file (case-insensitive) with ± lines', () => {
  const t = { steps: [
    { t: 'tool', tool: { name: 'Edit', v: JSON.stringify({ file_path: 'D:\\x\\A.ts', old_string: 'a\nb', new_string: 'a1\nb1\nc1' }) } },
    { t: 'tool', tool: { name: 'MultiEdit', v: JSON.stringify({ file_path: 'D:\\X\\a.ts', edits: [
      { old_string: 'p', new_string: 'q\nr' },
      { old_string: 's\nt', new_string: 'u' },
    ] }) } },
    { t: 'tool', tool: { name: 'Write', v: JSON.stringify({ file_path: 'D:\\x\\b.md', content: 'l1\nl2' }) } },
    { t: 'tool', tool: { name: 'Bash', v: JSON.stringify({ command: 'echo hi' }) } },
    { t: 'tool', tool: { name: 'Edit', v: 'not-json' } },
  ] };
  const files = fileChanges(t);
  assert.equal(files.length, 2, 'case-insensitive merge; non-edit tools / bad json ignored');
  const a = files.find((f) => /a\.ts$/i.test(f.path));
  assert.deepEqual([a.add, a.del], [6, 5], 'edit + multiedit hunks merged (+3-2 then +3-3)');
  const b = files.find((f) => /b\.md$/i.test(f.path));
  assert.deepEqual([b.add, b.del], [2, 0], 'write counts every line as an addition');
});

test('fileChanges prefers bridge-side f deltas (v145) and mixes with legacy v-parse', () => {
  const t = { steps: [
    // bridge precomputed: a huge Write whose briefJson v is truncated (and
    // thus unparseable) still counts via f
    { t: 'tool', tool: { name: 'Write', v: '{"file_path":"D:\\x\\big.txt","content":"' + 'x'.repeat(400), f: [{ path: 'D:\\x\\big.txt', add: 900, del: 0 }] } },
    // legacy part (older bridge): still parsed from v
    { t: 'tool', tool: { name: 'Edit', v: JSON.stringify({ file_path: 'D:\\x\\big.txt', old_string: 'a', new_string: 'b\nc' }) } },
    // f wins even when v happens to be parseable
    { t: 'tool', tool: { name: 'Write', v: JSON.stringify({ file_path: 'D:\\x\\c.md', content: 'zz' }), f: [{ path: 'D:\\x\\c.md', add: 7, del: 4 }] } },
  ] };
  const files = fileChanges(t);
  assert.equal(files.length, 2);
  const big = files.find((f) => /big\.txt$/i.test(f.path));
  assert.deepEqual([big.add, big.del], [902, 1], 'f (900+) + legacy edit (+2-1) merge on one file');
  const c = files.find((f) => /c\.md$/i.test(f.path));
  assert.deepEqual([c.add, c.del], [7, 4], 'f takes precedence over parseable v');
});

test('mergeBotTurns splices the two halves of a page-split turn', () => {
  const a = { role: 'bot', think: ['t1'], tools: [], texts: ['前半'],
    steps: [{ t: 'think', v: 't1' }, { t: 'text', v: '前半' }], ts: '1' };
  const b = { role: 'bot', think: [], tools: [], texts: ['后半'], steps: [{ t: 'text', v: '后半' }], ts: '' };
  const m = mergeBotTurns(a, b);
  assert.equal(m.texts.join('|'), '前半|后半', 'texts in order');
  assert.equal(m.steps.length, 3, 'steps concatenated');
  assert.equal(m.ts, '1', 'earlier ts wins');
});

test('orphan toolres parks, then drains into the later-loaded tool_use', () => {
  state.orphanToolRes = new Map();
  const T = [{ role: 'bot', think: [], tools: [], texts: [], steps: [], ts: '' }];
  // result arrives while the tool_use lives on an older page: parked
  assert.equal(pairToolResults(T, { k: 'toolres', items: [{ id: 'x9', text: '结果' }] }, state.orphanToolRes), null);
  assert.equal(state.orphanToolRes.get('x9').text, '结果', 'orphan parked');
  // the older page loads afterwards: drain pairs by id
  T[0].steps.push({ t: 'tool', tool: { name: 'Bash', id: 'x9', v: '{}', out: null } });
  drainOrphanRes(T);
  assert.equal(T[0].steps[0].tool.out.text, '结果', 'paired after prepend');
  assert.equal(state.orphanToolRes.size, 0, 'sink consumed');
});
