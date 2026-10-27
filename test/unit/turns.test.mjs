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

const { applyEventToTurns } = await import('../../public/js/views/transcript.js');
const { state } = await import('../../public/js/state.js');

const userTurns = () => state.turns.filter((t) => t.role === 'user');

test('same-text user event without the flag is a replay: no-op', () => {
  state.turns = [];
  applyEventToTurns({ k: 'user', ts: '1', text: '继续' });
  applyEventToTurns({ k: 'assistant', ts: '2', parts: [{ t: 'text', v: 'ok' }] });
  applyEventToTurns({ k: 'user', ts: '3', text: '继续' }); // double-fired append
  assert.equal(userTurns().length, 1, 'replayed duplicate must not push');
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
  applyEventToTurns({ k: 'user', ts: '4', text: '继续' }); // double-fired copy
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
