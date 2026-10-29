// navback: the detail back button must work on the FIRST press across every
// navigation shape. Root causes fixed: detail entries now carry a unique
// (state,url) - adjacent identical entries are silently traversed by Chromium
// and eat a press; closeHtmlPreview converts its htmlprev entry in place so
// stale #hp entries never sit behind a detail entry; the #back handler
// verifies the traversal landed and closes directly if Chromium dropped it.
import { withEnv, writeSession, assert } from '../harness.mjs';
import { timelineLines } from '../fixtures.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await withEnv(async (h, page) => {
  writeSession(h, 'T--e2e', 's1', timelineLines());
  writeSession(h, 'T--e2e', 's2', timelineLines());
  await page.navigate('http://127.0.0.1:3799/?token=e2etok');
  await page.waitFor('document.querySelectorAll(".srow").length >= 2');

  const closed = () => page.waitFor('document.getElementById("detail").classList.contains("hidden")', 3000);
  const open = () => page.waitFor('!document.getElementById("detail").classList.contains("hidden")', 3000);
  const back1 = () => page.ev('document.getElementById("back").click()');
  const openRow = (i) => page.ev(`document.querySelectorAll(".srow")[${i}].click()`);
  // #html-prev pushed entry mimicked at history level: the popstate logic
  // reads only classList + history.state, exactly what openHtmlPreview sets
  const showPreview = (n) => page.ev(`(function(){document.getElementById("html-prev").classList.remove("hidden");` +
    `history.pushState({cr:"htmlprev",n:${n}},"","#hp/${n}")})()`);

  // 1: plain open -> first press returns to the list
  await openRow(0); await open();
  await back1(); await sleep(500);
  assert(await closed(), 'plain: first back press exits detail');

  // 2: double-tap open (two adjacent detail entries) -> first press works
  await openRow(0); await open(); await openRow(0); await sleep(300);
  await back1(); await sleep(500);
  assert(await closed(), 'double-open: first back press exits detail');
  await page.ev('if(!document.getElementById("detail").classList.contains("hidden"))document.getElementById("back").click()');
  await sleep(400);

  // 3: open A, system-back out, open B -> first press works
  await openRow(0); await open();
  await page.ev('history.back()'); await sleep(500);
  await openRow(1); await open();
  await back1(); await sleep(500);
  assert(await closed(), 'reopen: first back press exits detail');
  await page.ev('if(!document.getElementById("detail").classList.contains("hidden"))document.getElementById("back").click()');
  await sleep(400);

  // 4: preview closed via its own button -> its entry converts in place
  await openRow(0); await open();
  await showPreview(1); await sleep(200);
  await page.ev('document.getElementById("hp-back").click()'); await sleep(300);
  assert(await page.ev('(history.state&&history.state.cr)==="detail"'), 'preview close converts entry to detail');
  await back1(); await sleep(500);
  assert(await closed(), 'preview btn-close: first back press exits detail');
  await page.ev('if(!document.getElementById("detail").classList.contains("hidden"))document.getElementById("back").click()');
  await sleep(400);

  // 5: preview closed via SYSTEM back, then app back (the poisoned-stack repro)
  await openRow(0); await open();
  await showPreview(2); await sleep(200);
  await page.ev('history.back()'); await sleep(600);
  assert(await page.ev('document.getElementById("html-prev").classList.contains("hidden")'), 'system back closes preview');
  await back1(); await sleep(600);
  assert(await closed(), 'preview sys-close: first back press exits detail');
  await page.ev('if(!document.getElementById("detail").classList.contains("hidden"))document.getElementById("back").click()');
  await sleep(400);

  // 6: bubble absorbs the FIRST back, second press leaves the detail
  await openRow(0); await open();
  await page.ev('document.getElementById("agent-sheet").classList.remove("hidden")');
  await back1(); await sleep(500);
  assert(await page.ev('document.getElementById("agent-sheet").classList.contains("hidden")'), 'bubble closed by first press');
  assert(!await closed(), 'bubble press stays in detail');
  await back1(); await sleep(500);
  assert(await closed(), 'second press exits detail after bubble');
});
