// paged: history pagination (v46) - header loader row reveals at the top,
// prepends the older page, hides when exhausted; turn count stays integral
import { withEnv, writeSession, assert } from '../harness.mjs';
import { pagedLines } from '../fixtures.mjs';

await withEnv(async (h, page) => {
  writeSession(h, 'T--e2e', 'pg1', pagedLines());
  await page.open('pg1');
  assert(await page.waitFor('!!document.querySelector(".final-card")'), 'detail rendered');

  // away from the top: loader hidden; first page = events 21..420 = 266 turns
  assert(!(await page.ev('document.getElementById("hist-more").classList.contains("show")')), 'loader hidden away from top');
  const first = await page.ev('document.getElementById("chat").childNodes.length');
  assert(first === 266, 'first page turns (got ' + first + ')');

  // pinned at the top: the row reveals (v46 transition row under the header)
  await page.ev('var c=document.getElementById("chat"); c.scrollTop=0; c.dispatchEvent(new Event("scroll"))');
  assert(await page.waitFor('document.getElementById("hist-more").classList.contains("show")'), 'loader reveals at top');
  const label = await page.ev('document.getElementById("hist-more").textContent');
  assert(label.indexOf('还有 20 条') >= 0, 'remaining count (got "' + label + '")');

  // tap -> older page prepends; counts add up; exhausted row hides again
  await page.ev('document.getElementById("hist-more").click()');
  assert(await page.waitFor('document.getElementById("chat").childNodes.length === 280'), 'older page prepended (280 turns)');
  assert(await page.waitFor('!document.getElementById("hist-more").classList.contains("show")'), 'loader hides when exhausted');
  const top = await page.ev('document.getElementById("chat").firstChild.textContent');
  assert(top.indexOf('第0轮提问') >= 0, 'oldest turn on top (got "' + top.slice(0, 40) + '")');

  // scroll listener keeps the row honest after the load: back down -> stays hidden
  await page.ev('var c=document.getElementById("chat"); c.scrollTop=200; c.dispatchEvent(new Event("scroll"))');
  assert(!(await page.ev('document.getElementById("hist-more").classList.contains("show")')), 'stays hidden when exhausted');
});
