// test/unit/cost.test.mjs - v48 cost panel pricing math (the pure half of
// ctxring.js costDisplay). cost-state usd is OFFICIAL-table pricing by the
// CLI; the panel can rescale ('mult') or re-price token aggregates with
// per-model rates ('cust'). Preferences are localStorage display state.
import { test } from 'node:test';
import assert from 'node:assert';

const fakeEl = () => ({
  addEventListener: () => {},
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  dataset: {}, // composer.js runs setPerm at module scope (ctxring -> detail -> composer)
  style: {},
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

const { costDisplay } = await import('../../public/js/views/ctxring.js');

// session that switched models mid-way (sonnet first half, opus second half)
const stats = {
  usd: 1.24, inTok: 48200, outTok: 12600, cacheRead: 892000, cacheCreate: 31000,
  models: {
    'claude-sonnet-5-5': { inTok: 21000, outTok: 5100, cacheRead: 402000, cacheCreate: 12000, usd: 0.42 },
    'claude-opus-5-5': { inTok: 27200, outTok: 7500, cacheRead: 490000, cacheCreate: 19000, usd: 0.82 },
  },
};

test('official mode shows the cost-state number as-is', () => {
  assert.equal(costDisplay(stats, 'off', 1, {}), 1.24);
});

test('multiplier mode scales the official number', () => {
  assert.ok(Math.abs(costDisplay(stats, 'mult', 1.5, {}) - 1.86) < 1e-9);
});

test('custom rates price each model separately; default covers unlisted ones', () => {
  const prices = {
    def: { in: 1, out: 2, cr: 0.1, cw: 1 },
    byModel: { 'claude-opus-5-5': { in: 10, out: 20, cr: 1, cw: 10 } },
  };
  const sonnet = (21000 * 1 + 5100 * 2 + 402000 * 0.1 + 12000 * 1) / 1e6;
  const opus = (27200 * 10 + 7500 * 20 + 490000 * 1 + 19000 * 10) / 1e6;
  assert.ok(Math.abs(costDisplay(stats, 'cust', 1, prices) - (sonnet + opus)) < 1e-9);
});

test('custom rates fall back to aggregate pricing when no models map (old bridge)', () => {
  const prices = { def: { in: 3, out: 15, cr: 0.3, cw: 3.75 } };
  const agg = (48200 * 3 + 12600 * 15 + 892000 * 0.3 + 31000 * 3.75) / 1e6;
  assert.ok(Math.abs(costDisplay({ ...stats, models: {} }, 'cust', 1, prices) - agg) < 1e-9);
});

test('missing cost data renders nothing in official/multiplier modes', () => {
  assert.equal(costDisplay(null, 'off', 1, {}), null);
  assert.equal(costDisplay({ usd: null, inTok: 5 }, 'mult', 2, {}), null);
});
