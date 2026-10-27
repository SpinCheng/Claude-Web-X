// sessops: list-level session operations (v34/v35) - the action bubble opens
// via the trailing ⋯ button (touch primary) and via contextmenu (desktop,
// with the selection guard), rename round-trips through the custom-title
// append and SURVIVES a reload (replayed from the transcript), stop row
// appears only for phone-driven runs, delete removes the row (confirm modal
// auto-accepted by the harness CDP driver).
import fs from 'node:fs';
import path from 'node:path';
import { withEnv, writeSession, fakeRun, assert } from '../harness.mjs';
import { user, assistant, text, stop } from '../fixtures.mjs';

const ctxmenu = (sel) => `document.querySelector('${sel}').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`;
const findAct = (t) => `[...document.querySelectorAll('#row-actions .act-row')].find(b => b.textContent.includes('${t}'))`;

await withEnv(async (h, page) => {
  writeSession(h, 'D--e2e', 'sid-ops', [user(1, 'ops 测试'), assistant(2, [text('完成')]), stop(3)]);
  await page.navigate(`http://127.0.0.1:3799/?token=e2etok`);
  assert(await page.waitFor(`document.querySelectorAll('.srow').length === 1`), 'row rendered');
  assert(await page.waitFor(`!!document.querySelector('.srow .srow-more')`), 'trailing more button present');

  // idle session: no stop row (nothing phone-driven to interrupt);
  // open the bubble via the ⋯ button (the touch primary path)
  await page.ev(`document.querySelector('.srow .srow-more').click()`);
  assert(await page.waitFor(`!document.getElementById('row-actions').classList.contains('hidden')`), 'bubble open via more');
  assert(await page.ev(`!!${findAct('重命名')}`), 'rename row present');
  assert(await page.ev(`!!${findAct('删除会话')}`), 'delete row present');
  assert(await page.ev(`!${findAct('停止运行')}`), 'no stop row while idle');

  // rename round-trip: bubble -> modal -> save -> optimistic title on the row
  await page.ev(`${findAct('重命名')}.click()`);
  assert(await page.waitFor(`!document.getElementById('rename-modal').classList.contains('hidden')`), 'rename modal open');
  assert(await page.waitFor(`document.getElementById('row-actions').classList.contains('hidden')`), 'bubble closed by modal');
  await page.ev(`document.getElementById('rename-input').value = 'ops 新名字'`);
  await page.ev(`document.getElementById('rename-save').click()`);
  assert(await page.waitFor(`document.querySelector('.srow-title').textContent === 'ops 新名字'`), 'row title updated');
  assert(await page.waitFor(`document.getElementById('rename-modal').classList.contains('hidden')`), 'modal closed after save');

  // persistence: reload and the title must come back from the transcript
  await page.navigate(`http://127.0.0.1:3799/?token=e2etok`);
  assert(await page.waitFor(`document.querySelector('.srow-title') && document.querySelector('.srow-title').textContent === 'ops 新名字'`), 'rename persisted across reload');

  // v39 fence: Desktop flushes its CACHED (pre-rename) title back into the
  // transcript (metadata bundle: last-prompt + custom-title with sessionId);
  // the pinned rename must survive it. The '6 行' wait proves the drain
  // actually processed the appended lines (non-vacuous assert): 3 fixture
  // lines + 1 rename append + 2 flush lines.
  fs.appendFileSync(path.join(h.tmp, 'projects', 'D--e2e', 'sid-ops.jsonl'),
    JSON.stringify({ type: 'last-prompt' }) + '\n' +
    JSON.stringify({ type: 'custom-title', customTitle: 'ops 测试', sessionId: 'sid-ops' }) + '\n');
  assert(await page.waitFor(`(document.querySelector('.srow-info') || {}).textContent.includes('6 行')`, 8000), 'drain consumed the flush');
  assert(await page.waitFor(`document.querySelector('.srow-title').textContent === 'ops 新名字'`), 'stale desktop title flush is fenced');

  // a genuinely NEW title (a real desktop rename) disarms the pin and wins
  fs.appendFileSync(path.join(h.tmp, 'projects', 'D--e2e', 'sid-ops.jsonl'),
    JSON.stringify({ type: 'custom-title', customTitle: '桌面端新名', sessionId: 'sid-ops' }) + '\n');
  assert(await page.waitFor(`document.querySelector('.srow-title').textContent === '桌面端新名'`, 8000), 'desktop rename disarms the pin');

  // stop row appears for a phone-driven running session (fake run frame)
  fakeRun(h, 'sid-ops', 'running', 'ops-run-1');
  assert(await page.waitFor(`(document.querySelector('.srow .st-word') || {}).textContent === '运行中'`), 'running word shown');
  await page.ev(ctxmenu('.srow'));
  assert(await page.waitFor(`!!${findAct('停止运行')}`), 'stop row appears while running');
  await page.ev(`${findAct('停止运行')}.click()`);
  assert(await page.waitFor(`(document.querySelector('#toast') || {}).textContent === '已发送停止信号'`, 6000), 'stop acknowledged');

  // delete round-trip (in-app confirm modal, #cf-ok)
  await page.ev(ctxmenu('.srow'));
  assert(await page.waitFor(`!document.getElementById('row-actions').classList.contains('hidden')`), 'bubble re-open');
  await page.ev(`${findAct('删除会话')}.click()`);
  assert(await page.waitFor(`!document.getElementById('confirm-modal').classList.contains('hidden')`), 'confirm modal opens');
  await page.ev(`document.getElementById('cf-ok').click()`);
  assert(await page.waitFor(`document.querySelectorAll('.srow').length === 0`), 'row gone after delete');
  assert(await page.waitFor(`(document.querySelector('#toast') || {}).textContent === '已移入回收站'`, 6000), 'delete acknowledged');
});
