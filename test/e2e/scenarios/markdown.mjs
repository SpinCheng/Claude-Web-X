// markdown: conclusion-card md rendering incl. inline-code chip + security
import { withEnv, writeSession, assert } from '../harness.mjs';
import { mdLines } from '../fixtures.mjs';

await withEnv(async (h, page) => {
  writeSession(h, 'T--e2e', 'md1', mdLines());
  await page.open('md1');
  assert(await page.waitFor('!!document.querySelector(".final-card")'), 'detail rendered');

  assert((await page.ev('(function(){var e=document.querySelector(".final-card .mdh2"); return e?e.textContent:""})()')) === '部署结果', 'h2');
  assert(await page.ev('document.querySelectorAll(".final-card li").length') === 4, 'li count (2 ul + 2 ol)');
  assert(await page.ev('!!document.querySelector(".final-card th")') && await page.ev('!!document.querySelector(".final-card ol")'), 'table + ol');
  const chipBg = await page.ev('(function(){var c=document.querySelector(".final-card code"); return c?getComputedStyle(c).backgroundColor:""})()');
  assert(chipBg && chipBg !== 'rgba(0, 0, 0, 0)', 'inline code chip has background');
  assert(await page.ev('!!document.querySelector(".final-card pre code")'), 'fenced code block');
  const rel = await page.ev('(function(){var a=document.querySelector(".final-card a"); return a?a.rel:""})()');
  assert(rel === 'noopener noreferrer', 'link rel');
  assert(!(await page.ev('document.querySelector(".final-card").textContent.indexOf("**")>=0')), 'no raw ** residue');

  // v40: meta rows - time labels extracted OUT of the bubbles, copy icons
  // below user bubble + final card, branch icon on the final card
  assert(await page.ev('!document.querySelector(".bubble.user .ts")'), 'time no longer inside the user bubble');
  assert(await page.ev('!!document.querySelector(".turn.user .bmeta .ts")'), 'time under the user bubble');
  assert(await page.ev('!!document.querySelector(".turn.user .bmeta .bicon")'), 'copy icon under the user bubble');
  assert(await page.ev('!!document.querySelector(".final-meta .ts")'), 'time under the final card');
  assert(await page.ev('document.querySelectorAll(".final-meta .bicon").length === 2'), 'copy + branch icons on final card');
  assert(!(await page.ev('!!document.querySelector(".final-card .ts")')), 'final card itself carries no time');

  // branch arming: tap the fork icon -> chip in the composer; X disarms
  await page.ev('document.querySelector(".final-meta .bicon:last-child").click()');
  assert(await page.waitFor(`!document.getElementById("fork-chip").classList.contains("hidden")`), 'fork chip armed');
  await page.ev('document.getElementById("fork-x").click()');
  assert(await page.waitFor(`document.getElementById("fork-chip").classList.contains("hidden")`), 'fork chip disarmed');
});
