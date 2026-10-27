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
});
