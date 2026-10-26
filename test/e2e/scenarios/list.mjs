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
});
