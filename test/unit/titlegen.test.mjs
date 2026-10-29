// test/unit/titlegen.test.mjs - pure title extraction/sanitizing + the
// maybeTitle guard chain (write only when the record still carries the
// truncation fallback; once per id; disabled via cfg).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickTitleInputs, buildTitlePrompt, sanitizeTitle, TitleGen } from '../../bridge/titlegen.js';

test('pickTitleInputs: first human bubble + LAST assistant text (not the first)', () => {
  const events = [
    { k: 'compact', n: 5 },
    { k: 'user', text: '帮我改 pair 页面布局' },
    { k: 'assistant', parts: [{ t: 'think', v: '先看代码' }, { t: 'text', v: '我来看看' }] },
    { k: 'assistant', parts: [{ t: 'tool', name: 'Edit' }, { t: 'text', v: '已改为双栏' }] },
  ];
  const r = pickTitleInputs(events);
  assert.equal(r.user, '帮我改 pair 页面布局');
  assert.equal(r.bot, '已改为双栏'); // tool parts dropped, final turn wins
});

test('pickTitleInputs: image-only user bubbles do not count as text', () => {
  const r = pickTitleInputs([{ k: 'user', images: [{}] }, { k: 'user', text: '这是什么' }]);
  assert.equal(r.user, '这是什么');
  assert.equal(pickTitleInputs([{ k: 'user', images: [{}] }, { k: 'assistant', parts: [{ t: 'text', v: 'x' }] }]).user, '');
});

test('buildTitlePrompt: carries inputs (capped) + no-tools rule', () => {
  const p = buildTitlePrompt('a'.repeat(5000), 'b'.repeat(5000));
  assert.ok(p.includes('a'.repeat(1600)) && !p.includes('a'.repeat(1601)));
  assert.ok(p.includes('b'.repeat(1000)) && !p.includes('b'.repeat(1001)));
  assert.ok(p.includes('不调用任何工具'));
  assert.ok(buildTitlePrompt('只给任务', '').includes('[任务]'));
  assert.ok(!buildTitlePrompt('', '').includes('[任务]')); // nothing to title from
});

test('sanitizeTitle: fence/quote/prefix/trailing-punct/cap', () => {
  assert.equal(sanitizeTitle('```\n改配对页为PC布局\n```'), '改配对页为PC布局');
  assert.equal(sanitizeTitle('标题：修复登录超时'), '修复登录超时');
  assert.equal(sanitizeTitle('## Refactor parser tests'), 'Refactor parser tests');
  assert.equal(sanitizeTitle('"修复登录超时"。'), '修复登录超时');
  assert.equal(sanitizeTitle('first line\nsecond line'), 'first line');
  assert.equal(sanitizeTitle('  多  余  空  格  '), '多 余 空 格');
  assert.equal(sanitizeTitle('x'.repeat(50)).length, 33); // 32 + ellipsis
  assert.equal(sanitizeTitle(''), '');
  assert.equal(sanitizeTitle(null), '');
});

// ---- maybeTitle guard chain (no spawn: _ask stubbed per instance) ----
function rig(recOverrides = {}) {
  const calls = { ask: [], append: [], pin: [] };
  const recs = {
    s1: { id: 's1', transcriptPath: 'x.jsonl', cwd: 'D:\\w', titleFallback: true, ...recOverrides },
  };
  const store = { get: (id) => recs[id] };
  const adapter = {
    readTranscript: () => ({ events: [{ k: 'user', text: '帮我优化构建脚本' }, { k: 'assistant', parts: [{ t: 'text', v: '已完成并行化' }] }] }),
    appendTitle: (id, t) => { calls.append.push([id, t]); return true; },
    pinRename: (id, t) => { calls.pin.push([id, t]) },
  };
  const tg = new TitleGen({ runner: {}, adapter, store });
  return { tg, calls, recs, store };
}

test('maybeTitle: writes sanitized title through append+pin path', async () => {
  const { tg, calls } = rig();
  tg._ask = async () => '标题：优化构建脚本并行化'; // _generate sanitizes again
  tg.maybeTitle('s1', 'm1');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls.append, [['s1', '优化构建脚本并行化']]);
  assert.deepEqual(calls.pin, [['s1', '优化构建脚本并行化']]);
});

test('maybeTitle: rename during the LLM call wins (titleFallback re-check at write)', async () => {
  const { tg, calls, store } = rig();
  tg._ask = async () => {
    store.get('s1').titleFallback = false; // user renamed while we asked
    return '优化构建脚本';
  };
  tg.maybeTitle('s1');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.append.length, 0);
  assert.equal(calls.pin.length, 0);
});

test('maybeTitle: skips real-titled sessions, fires once per id, respects off switch', async () => {
  const { tg, calls } = rig({ titleFallback: false });
  tg._ask = async () => '不该出现';
  tg.maybeTitle('s1');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.append.length, 0);

  const r2 = rig();
  r2.tg._ask = async () => 't';
  r2.tg.maybeTitle('s1');
  r2.tg.maybeTitle('s1'); // second call is a no-op (done set)
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(r2.calls.append.length, 1);

  const r3 = rig();
  r3.tg.enabled = false;
  r3.tg._ask = async () => 't';
  r3.tg.maybeTitle('s1');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(r3.calls.append.length, 0);
});

test('_ask passes the run model through (shape of argv is covered live; here: no crash on stub runner)', async () => {
  const { tg } = rig();
  tg._ask = async (prompt, rec, model) => ({ prompt, rec, model });
  const out = await tg._ask('p', { cwd: 'D:\\w' }, 'opus-x');
  assert.equal(out.model, 'opus-x');
});
