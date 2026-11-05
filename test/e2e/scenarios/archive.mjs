// test/e2e/scenarios/archive.mjs - v185 session archive: the ⋯ item sits
// above delete (hidden while running), archiving removes the row from the
// main list onto the archive page (its own .page, back returns to the list),
// search still finds archived sessions (muted badge + flipped 取消归档 item),
// batch archive needs no confirm modal, and a fresh transcript append
// AUTO-UNARCHIVES (活跃反归档) with a notify toast.
import fs from 'node:fs';
import path from 'node:path';
import { withEnv, writeSession, fakeRun, assert, api } from '../harness.mjs';
import { user, assistant, text, stop } from '../fixtures.mjs';

const ctxmenu = (sel) => `${sel}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`;
const rowByTitle = (t) => `[...document.querySelectorAll('#groups .srow')].find(r => r.textContent.includes('${t}'))`;
const findAct = (t) => `[...document.querySelectorAll('#row-actions .act-row')].find(b => b.textContent.includes('${t}'))`;
const labels = '([...document.querySelectorAll("#row-actions .o-label")].map(x => x.textContent))';
const toastText = `((document.querySelector('#toast') || {}).textContent || '')`;

await withEnv(async (h, page) => {
  writeSession(h, 'D--e2e', 'sid-ar1', [user(1, '归档甲会话'), assistant(2, [text('甲完成')]), stop(3)]);
  writeSession(h, 'D--e2e', 'sid-ar2', [user(4, '归档乙会话'), assistant(5, [text('乙完成')]), stop(6)]);
  await page.navigate(`http://127.0.0.1:3799/?token=e2etok`);
  assert(await page.waitFor(`document.querySelectorAll('#groups .srow').length === 2`), 'two rows rendered');
  assert(await page.ev(`!!document.getElementById('list-archive')`), 'top bar archive entry present');

  // menu: 归档会话 present, strictly ABOVE 删除会话 (low-destructive first)
  await page.ev(`${rowByTitle('归档甲')}.querySelector('.srow-more').click()`);
  assert(await page.waitFor(`!document.getElementById('row-actions').classList.contains('hidden')`), 'bubble open');
  assert(await page.ev(`(() => { const l = ${labels}; return l.indexOf('归档会话') !== -1 && l.indexOf('删除会话') !== -1 && l.indexOf('归档会话') < l.indexOf('删除会话'); })()`), 'archive item above delete');

  // archive it: row leaves the main list, toast points at the archive area
  await page.ev(`${findAct('归档会话')}.click()`);
  assert(await page.waitFor(`document.querySelectorAll('#groups .srow').length === 1`), 'archived row left the list');
  assert(await page.waitFor(`${toastText} === '已归档 · 归档区可恢复'`, 6000), 'archive toast');

  // bridge truth: the flag rides mergedSessions
  const snap = await (await api('/api/sessions')).json();
  const a1 = (snap.sessions || []).find((s) => s.id === 'sid-ar1');
  assert(a1 && a1.archived === true, 'mergedSessions carries archived flag');

  // archive page: entry -> own page, one row, count line, project-led info
  await page.ev(`document.getElementById('list-archive').click()`);
  assert(await page.waitFor(`!document.getElementById('arch').classList.contains('hidden') && document.getElementById('list').classList.contains('hidden')`), 'archive page shown, list hidden');
  assert(await page.waitFor(`document.querySelectorAll('#arch-groups .srow').length === 1`), 'archived row on the archive page');
  assert(await page.ev(`document.querySelector('#arch-groups .srow-title').textContent === '归档甲会话'`), 'right row on the archive page');
  assert(await page.ev(`document.getElementById('arch-count').textContent.includes('1 个会话')`), 'count line');

  // its ⋯ menu flips the item to 取消归档 (this page's primary action)
  await page.ev(`document.querySelector('#arch-groups .srow .srow-more').click()`);
  assert(await page.waitFor(`!!${findAct('取消归档')}`), 'menu flips to unarchive');
  await page.ev(`document.getElementById('row-actions').click()`); // scrim close (an open bubble would absorb back)

  // back out of the archive page lands on the list
  await page.ev(`history.back()`);
  assert(await page.waitFor(`document.getElementById('arch').classList.contains('hidden') && !document.getElementById('list').classList.contains('hidden')`), 'back lands on the list');

  // search sees the archived session: badge present, open target unchanged
  await page.ev(`document.getElementById('list-search').value = '归档甲'`);
  await page.ev(`document.getElementById('list-search').dispatchEvent(new Event('input', { bubbles: true }))`);
  assert(await page.waitFor(`document.querySelectorAll('#groups .srow').length === 1 && !!document.querySelector('#groups .st-word.arc')`), 'search hit shows the archived badge');

  // 取消归档 from the search hit: badge drops, row back in the plain list
  await page.ev(`document.querySelector('#groups .srow .srow-more').click()`);
  await page.ev(`${findAct('取消归档')}.click()`);
  assert(await page.waitFor(`${toastText} === '已恢复到列表'`, 6000), 'unarchive toast');
  await page.ev(`document.getElementById('search-clear').click()`);
  assert(await page.waitFor(`document.querySelectorAll('#groups .srow').length === 2 && !document.querySelector('#groups .st-word.arc')`), 'both rows back, badge gone');

  // running sessions hide the archive item (auto-unarchive is a net, not an invite).
  // fakeRun's WS frame races the immediate ctxmenu (openRowActions reads
  // state.runs - a frame still in flight leaves the item out forever): re-fire
  // the menu until the frame has landed (suite-load flake, 2x full-run misses)
  fakeRun(h, 'sid-ar2', 'running', 'ar-run');
  let menuHasStop = false;
  for (let i = 0; i < 8 && !menuHasStop; i++) {
    await page.ev(ctxmenu(rowByTitle('归档乙')));
    menuHasStop = await page.waitFor(`!!${findAct('停止运行')}`, 1500);
  }
  assert(menuHasStop, 'running row menu open');
  assert(await page.ev(`!${findAct('归档会话')}`), 'archive item hidden while running');
  await page.ev(`document.getElementById('row-actions').click()`);
  fakeRun(h, 'sid-ar2', 'end', 'ar-run');

  // batch archive: NO confirm modal (reversible action), summary toast
  await page.ev(`document.getElementById('list-manage').click()`);
  await page.waitFor(`document.querySelectorAll('#groups .ck').length === 2`);
  await page.ev(`[...document.querySelectorAll('#groups .srow')].forEach(r => r.click())`);
  await page.ev(`document.getElementById('b-arch').click()`);
  assert(await page.waitFor(`${toastText} === '已归档 2 个'`, 6000), 'batch archive toast');
  assert(await page.waitFor(`document.querySelectorAll('#groups .srow').length === 0`), 'list empty after batch archive');
  assert(await page.waitFor(`document.getElementById('confirm-modal').classList.contains('hidden')`), 'no confirm dialog for archive');

  // 活跃反归档: the desktop/CLI writes to an archived transcript again ->
  // auto-unarchive + notify; the row must come back on its own
  fs.appendFileSync(path.join(h.tmp, 'projects', 'D--e2e', 'sid-ar1.jsonl'),
    JSON.stringify(user(9, '桌面端又来了一轮')) + '\n');
  assert(await page.waitFor(`document.querySelectorAll('#groups .srow').length === 1`, 8000), 'auto-unarchive returned the row');
  assert(await page.waitFor(`${toastText}.includes('已自动恢复')`, 8000), 'auto-unarchive notify toast');
});
