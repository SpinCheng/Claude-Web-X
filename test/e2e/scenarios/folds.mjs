// folds: compaction summary + skill body folded to markers, /command normalized
import { withEnv, writeSession, assert } from '../harness.mjs';
import { foldsLines } from '../fixtures.mjs';

await withEnv(async (h, page) => {
  writeSession(h, 'T--e2e', 'fd1', foldsLines());
  await page.open('fd1');
  assert(await page.waitFor('!!document.querySelector(".final-card")'), 'detail rendered');

  const sys = await page.ev('[].slice.call(document.querySelectorAll(".sysline")).map(function(x){return x.textContent}).join(" | ")');
  assert(sys.indexOf('上下文已压缩') >= 0, 'compact marker present: ' + sys);
  assert(sys.indexOf('技能 sample-skill') >= 0, 'skill marker present');
  const bubbles = await page.ev('document.getElementById("chat").textContent');
  assert(bubbles.indexOf('ran out of context') < 0, 'no compaction leak');
  assert(bubbles.indexOf('instruction line') < 0, 'no skill-body leak');
  assert(bubbles.indexOf('/goal 请进行优化') >= 0, 'slash command normalized');
  assert(bubbles.indexOf('<command-') < 0, 'no tag soup');
});
