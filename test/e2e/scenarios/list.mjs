// list: the session list itself must scroll (flex child needs
// overflow+min-height, else .page's overflow:hidden clips it dead)
import { withEnv, writeSession, assert } from '../harness.mjs';
import { timelineLines } from '../fixtures.mjs';

await withEnv(async (h, page) => {
  for (let i = 0; i < 14; i++) writeSession(h, 'T--e2e', 'ls' + i, timelineLines());
  await page.navigate(`http://127.0.0.1:3799/?token=e2etok`);
  assert(await page.waitFor('document.querySelectorAll(".srow").length >= 14'), 'rows rendered');

  const info = await page.ev('(function(){var g=document.getElementById("groups");return {sh:g.scrollHeight,ch:g.clientHeight,st:(function(){g.scrollTop=200;return g.scrollTop})()}})()');
  assert(info.sh > info.ch + 300, `list overflows viewport (sh=${info.sh} ch=${info.ch})`);
  assert(info.st === 200, `list scrolls (scrollTop=${info.st})`);
  assert(await page.ev('(function(){var g=document.getElementById("groups");return g.scrollTop>0 && !!g.querySelector(".srow:last-of-type")})()'), 'last row reachable');

  // v38: group head = folder icon + title + full path as a dim sub-line
  assert(await page.waitFor('!!document.querySelector(".pgroup-head .pgroup-ico")'), 'folder icon on group head');
  assert(await page.waitFor('(function(){var p=document.querySelector(".pgroup-path");' +
    'return !!p && p.textContent.indexOf("D:") === 0 && /e2e$/.test(p.textContent)})()'), 'path sub-line under title');

  // v40 fix: "+" must open the new-session modal RIGHT on the list page.
  // The modal used to live INSIDE the hidden #detail page, so the tap looked
  // dead and the modal only popped up after entering a session.
  await page.ev('document.getElementById("new-session").click()');
  assert(await page.waitFor(`!document.getElementById("new-modal").classList.contains("hidden")`), 'new modal opens on list');
  await page.ev('document.getElementById("new-cancel").click()');
  assert(await page.waitFor(`document.getElementById("new-modal").classList.contains("hidden")`), 'new modal closes');

  // v41: group-head + opens the modal preset to THIS project's cwd, and must
  // not toggle the group collapse (stopPropagation)
  assert(await page.waitFor('!!document.querySelector(".pgroup-head .pgroup-new")'), 'new-session icon on group head');
  await page.ev('document.querySelector(".pgroup-head .pgroup-new").click()');
  assert(await page.waitFor(`!document.getElementById("new-modal").classList.contains("hidden")`), 'group-head + opens modal');
  assert(await page.waitFor('(function(){var s=document.querySelector(".pgroup-head .pgroup-path");' +
    'return s && document.getElementById("new-cwd").value === s.textContent})()'), 'cwd preset to the group project');
  assert(await page.waitFor('!document.querySelector(".pgroup").classList.contains("closed")'), 'group stays expanded after + click');
  await page.ev('document.getElementById("new-cancel").click()');
  assert(await page.waitFor(`document.getElementById("new-modal").classList.contains("hidden")`), 'modal closes again');

  // v43: search - query matches every fixture path (T:\e2e), results are flat
  const setSearch = (v) => page.ev(`(function(){var i=document.getElementById("list-search");i.value="${v}";i.dispatchEvent(new Event("input"))})()`);
  await setSearch('E2E');
  assert(await page.waitFor('document.querySelectorAll("#groups .srow").length >= 14'), 'search by path keeps all rows');
  assert(await page.waitFor('document.querySelectorAll(".pgroup-head").length === 0'), 'search results render flat');
  await setSearch('zzz-no-match');
  assert(await page.waitFor('(function(){var t=document.querySelector("#groups .le-t");return !!t && t.textContent.indexOf("没有匹配") === 0})()'), 'no-match hint shows');
  await setSearch('');
  assert(await page.waitFor('document.querySelectorAll(".pgroup-head").length > 0'), 'clearing search restores groups');

  // v43: batch select + delete (in-app confirm modal, #cf-ok)
  await page.ev('document.getElementById("list-manage").click()');
  assert(await page.waitFor('!document.getElementById("batch-bar").classList.contains("hidden")'), 'batch bar shows');
  await page.ev('document.querySelectorAll("#groups .srow")[0].click()');
  await page.ev('document.querySelectorAll("#groups .srow")[1].click()');
  assert(await page.waitFor('document.getElementById("b-count").textContent.indexOf("2") >= 0'), 'count shows 2');
  assert(await page.waitFor('document.querySelectorAll("#groups .srow.sel").length === 2'), 'selected rows highlighted');
  await page.ev('document.getElementById("b-del").click()');
  assert(await page.waitFor('!document.getElementById("confirm-modal").classList.contains("hidden")'), 'confirm modal opens');
  await page.ev('document.getElementById("cf-ok").click()');
  assert(await page.waitFor('(function(){var n=document.querySelectorAll("#groups .srow").length;return n===12})()'), 'two rows deleted');
  assert(await page.waitFor('document.getElementById("b-count").textContent.indexOf("0") >= 0'), 'selection cleared after delete');
  await page.ev('document.getElementById("b-done").click()');
  assert(await page.waitFor('document.getElementById("batch-bar").classList.contains("hidden")'), 'done exits batch mode');
});
