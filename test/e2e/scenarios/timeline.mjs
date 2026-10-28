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
  const frow = await page.ev('(function(){var r=document.querySelector(".fsum .frow .fname"); return r?r.textContent:""})()');
  assert(frow.toLowerCase() === 'd:\\e2e\\a.txt', 'fsum row filename (got "' + frow + '")');
});
