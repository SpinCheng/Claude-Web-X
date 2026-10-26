// timeline: chronological steps + tool_result pairing + done-state via stop marker
import { withEnv, writeSession, assert } from '../harness.mjs';
import { timelineLines } from '../fixtures.mjs';

await withEnv(async (h, page) => {
  writeSession(h, 'T--e2e', 'tl1', timelineLines());
  await page.open('tl1');
  assert(await page.waitFor('!!document.querySelector(".final-card")'), 'detail rendered');
  await page.ev('var t=document.querySelector(".turn .trigger"); t && t.click()');

  const badges = await page.ev('[].slice.call(document.querySelectorAll(".node .badge")).map(function(b){return b.textContent}).join(",")');
  assert(badges === '输出,工具,结论', `badge order (got "${badges}")`);

  const out = await page.ev('(function(){var o=document.querySelector(".tool-out"); return o?o.textContent:""})()');
  assert(out.indexOf('timeline-order-ok') >= 0, 'tool.out paired text');

  const concl = await page.ev('document.querySelector(".final-card").textContent');
  assert(concl.indexOf('命令输出：timeline-order-ok') >= 0, 'conclusion text');
  assert(!(await page.ev('!!document.querySelector(".final-card .caret")')), 'turn is done (no live caret)');
});
