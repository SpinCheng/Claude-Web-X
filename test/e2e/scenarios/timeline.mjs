// timeline: chronological steps + tool_result pairing + done-state via stop marker
import { withEnv, writeSession, assert } from '../harness.mjs';
import { timelineLines } from '../fixtures.mjs';

await withEnv(async (h, page) => {
  writeSession(h, 'T--e2e', 'tl1', timelineLines());
  await page.open('tl1');
  assert(await page.waitFor('!!document.querySelector(".final-card")'), 'detail rendered');
  await page.ev('var t=document.querySelector(".turn .trigger"); t && t.click()');

  const badges = await page.ev('[].slice.call(document.querySelectorAll(".node .badge")).map(function(b){return b.textContent}).join(",")');
  assert(badges === '输出,工具,结论,修改,结论', `badge order (got "${badges}")`);

  const out = await page.ev('(function(){var o=document.querySelector(".tool-out"); return o?o.textContent:""})()');
  assert(out.indexOf('timeline-order-ok') >= 0, 'tool.out paired text');

  const concl = await page.ev('document.querySelector(".final-card").textContent');
  assert(concl.indexOf('命令输出：timeline-order-ok') >= 0, 'conclusion text');
  assert(!(await page.ev('!!document.querySelector(".final-card .caret")')), 'turn is done (no live caret)');

  // v45: changed-files rollup under the second turn's conclusion
  const fsum = await page.ev('(function(){var s=document.querySelector(".fsum summary"); return s?s.textContent:""})()');
  assert(fsum.indexOf('改动 1 个文件') >= 0 && fsum.indexOf('+3') >= 0 && fsum.indexOf('−2') >= 0, 'fsum rollup row (got "' + fsum + '")');
  // v146: basename on top, dimmed directory under it
  const frow = await page.ev('(function(){var r=document.querySelector(".fsum .frow .fname"); return r?r.textContent:""})()');
  assert(frow.toLowerCase() === 'a.txt', 'fsum row shows the basename (got "' + frow + '")');
  const fpath = await page.ev('(function(){var r=document.querySelector(".fsum .frow .fpath"); return r?r.textContent:""})()');
  assert(fpath.toLowerCase() === 'd:\\e2e', 'fsum row dims the directory (got "' + fpath + '")');
  // v146: the +/- stats open the synthesized per-file diff view
  await page.ev('(function(){var s=document.querySelector(".fsum .frow .fd"); s && s.click(); return true;})()');
  assert(await page.waitFor('!document.getElementById("html-prev").classList.contains("hidden")'), 'filediff preview opens');
  const fdAttr = await page.ev('document.getElementById("hp-frame").getAttribute("srcdoc") || ""');
  assert(fdAttr.indexOf('x1') >= 0 && fdAttr.indexOf('class="dl del"') >= 0, 'synthesized old->new rides the diff view');
  await page.ev('document.getElementById("hp-back").click()');
  assert(await page.waitFor('document.getElementById("html-prev").classList.contains("hidden")'), 'filediff preview closed');
});
