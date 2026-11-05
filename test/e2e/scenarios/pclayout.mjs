// pclayout: v195 PC 双栏（roadmap 13 · B 方案）- wide shell: both panes mounted,
// empty state, selection flip via replaceState (stack never grows), 860px
// content column, ft third pane (242px static), modal constraining, and the
// #html-prev fullscreen geometry at a wide viewport.
import fs from 'node:fs';
import path from 'node:path';
import { withEnv, writeSession, assert, waitSession } from '../harness.mjs';
import { PORT, TOK } from '../harness.mjs';
import { user, assistant, text, stop, previewLines } from '../fixtures.mjs';

const rowByTitle = (t) =>
  '(function(){var r=[].slice.call(document.querySelectorAll("#groups .srow")).find(function(x){return /' + t + '/.test(x.textContent)}); r&&r.click(); return !!r;})()';

await withEnv(async (h, page) => {
  fs.writeFileSync(path.join(h.tmp, 'ok.txt'), 'preview-body-123');
  writeSession(h, 'T--e2e', 'pl1', [user(1, '宽屏甲', h.tmp), assistant(2, [text('ok1')]), stop(3)]);
  writeSession(h, 'T--e2e', 'pl2', [user(1, '宽屏乙', h.tmp), assistant(2, [text('ok2')]), stop(3)]);
  writeSession(h, 'T--e2e', 'pv9', previewLines(h.tmp, 'ok.txt'));
  assert(await waitSession('pl1'), 'pl1 visible');
  assert(await waitSession('pl2'), 'pl2 visible');
  assert(await waitSession('pv9'), 'pv9 visible');

  // boot WITHOUT #open: list page only; then go wide -> both panes + empty state
  await page.navigate(`http://127.0.0.1:${PORT}/?token=${TOK}`);
  assert(await page.waitFor('document.querySelectorAll(".srow").length >= 3'), 'list rendered');
  await page.resize(1280, 800);
  assert(await page.waitFor('document.body.classList.contains("wide")'), 'body.wide on breakpoint');
  assert(await page.waitFor('!document.getElementById("list").classList.contains("hidden") && !document.getElementById("detail").classList.contains("hidden")'), 'both panes mounted');
  assert(await page.waitFor('!document.getElementById("detail-empty").classList.contains("hidden")'), 'right pane shows the empty state');
  assert(await page.waitFor('getComputedStyle(document.getElementById("back")).display === "none"'), 'back button hidden in wide');

  // open via left row: selection highlight + empty state gone
  await page.ev(rowByTitle('宽屏甲'));
  assert(await page.waitFor('/宽屏甲/.test(document.getElementById("d-title").textContent)'), 'pl1 opened');
  assert(await page.waitFor('(function(){var s=document.querySelector(".srow.on"); return s && /宽屏甲/.test(s.textContent)})()'), 'selected row highlighted');
  assert(await page.waitFor('document.getElementById("detail-empty").classList.contains("hidden")'), 'empty state gone');

  // switching sessions = replaceState: stack never grows, highlight flips live
  const len1 = await page.ev('history.length');
  await page.ev(rowByTitle('宽屏乙'));
  assert(await page.waitFor('/宽屏乙/.test(document.getElementById("d-title").textContent)'), 'pl2 opened');
  assert(await page.waitFor('(function(){var s=document.querySelector(".srow.on"); return s && /宽屏乙/.test(s.textContent)})()'), 'highlight flipped to pl2');
  assert((await page.ev('history.length')) === len1, 'replaceState: history depth unchanged');

  // content column cap (bar/background stay full-bleed, transcript column 860px)
  assert(await page.waitFor('getComputedStyle(document.getElementById("chat")).maxWidth === "860px"'), 'content column 860px');
  // v196 regression: the composer is viewport-level fixed in narrow - in wide it
  // MUST re-anchor to #detail-main, else its column centers on the whole window
  // (misaligned with the chat column)
  assert(await page.waitFor('(function(){var c=document.getElementById("chat").getBoundingClientRect(); var m=document.getElementById("composer").getBoundingClientRect(); return Math.round(c.left)===Math.round(m.left) && Math.round(c.width)===Math.round(m.width)})()'), 'composer column aligned with chat (anchored to detail-main)');
  // v196 regression: inputs must NOT carry the focus-visible outline (white-ish
  // box around the textarea while typing - caret is the focus affordance)
  assert(await page.waitFor('(function(){var i=document.getElementById("msg-input"); i.focus(); return getComputedStyle(i).outlineStyle==="none"})()'), 'no focus outline on the textarea');
  await page.ev('document.getElementById("msg-input").blur(); true;');

  // ft third pane: 242px static column, no scrim shape, pref persisted
  await page.ev('document.getElementById("ft-toggle").click(); true;');
  assert(await page.waitFor('!document.getElementById("ft-drawer").classList.contains("hidden")'), 'ft pane opens');
  assert(await page.waitFor('(function(){var s=getComputedStyle(document.getElementById("ft-drawer")); return s.position==="static" && s.width==="242px"})()'), 'pane is a static 242px column');
  assert(await page.waitFor('document.body.classList.contains("ft-open")'), 'ft-open body class');
  assert((await page.ev('localStorage.getItem("cr_ft_panel")')) === '1', 'panel pref persisted');
  await page.ev('document.getElementById("ft-toggle").click(); true;');
  assert(await page.waitFor('document.getElementById("ft-drawer").classList.contains("hidden")'), 'pane closes');
  assert((await page.ev('localStorage.getItem("cr_ft_panel")')) === '0', 'pref cleared');

  // full-width modals constrain in wide (never span both columns)
  await page.ev('document.getElementById("del").click(); true;');
  assert(await page.waitFor('!document.getElementById("confirm-modal").classList.contains("hidden")'), 'confirm modal opens');
  assert(await page.waitFor('(function(){var s=document.querySelector("#confirm-modal .sheet"); return s.getBoundingClientRect().width <= 620})()'), 'modal sheet constrained');
  await page.ev('document.getElementById("cf-cancel").click(); true;');
  assert(await page.waitFor('document.getElementById("confirm-modal").classList.contains("hidden")'), 'modal dismissed');

  // #html-prev stays a true fullscreen page at wide viewport (fixed inset 0)
  await page.ev(rowByTitle('预览测试'));
  assert(await page.waitFor('/预览测试/.test(document.getElementById("d-title").textContent)'), 'pv9 opened');
  await page.ev('var t=document.querySelector(".turn .trigger"); t && t.click(); true;');
  await page.ev('(function(){var a=[].slice.call(document.querySelectorAll(".flink")).find(function(x){return /ok\\.txt$/i.test(x.textContent)}); a && a.click(); return true;})()');
  assert(await page.waitFor('!document.getElementById("html-prev").classList.contains("hidden")'), 'preview page opened');
  assert(await page.waitFor('(function(){var r=document.getElementById("html-prev").getBoundingClientRect(); return Math.round(r.width)===1280})()'), 'preview covers the full wide viewport');
  await page.ev('document.getElementById("hp-back").click(); true;');
  assert(await page.waitFor('document.getElementById("html-prev").classList.contains("hidden")'), 'preview closed');

  // v196 regression: provisional detail (new task) must clear the empty overlay
  // (it used to sit on top of the composer) and keep the left pane mounted
  await page.ev('(function(){var orig=window.fetch; window.fetch=function(u,o){ if(String(u).indexOf("/api/sessions/new")>=0) return Promise.resolve({ok:true,json:function(){return Promise.resolve({ok:true,runId:"dbg-run"})}}); return orig(u,o); }; return true;})()');
  await page.ev('document.getElementById("new-session").click(); true;');
  await page.waitFor('!document.getElementById("new-modal").classList.contains("hidden")');
  await page.ev('(function(){var t=document.getElementById("new-text"); t.value="宽屏新建"; return true;})()');
  await page.ev('document.getElementById("new-go").click(); true;');
  await new Promise((r) => setTimeout(r, 300));
  assert(await page.waitFor('document.getElementById("detail-empty").classList.contains("hidden")'), 'provisional clears the empty overlay');
  assert(await page.waitFor('(function(){var o=document.getElementById("detail-empty"); var m=document.getElementById("composer").getBoundingClientRect(); var r=o.getBoundingClientRect(); return r.width===0 || !function(){var x=m.left; return x>=r.left && x<=r.right}()})()'), 'overlay no longer covers the composer');

  // v196 regression: crossing narrow->wide WITH a session open must restore the
  // left pane (narrow's detail-open had hidden #list; wide keeps it mounted)
  await page.resize(800, 800);
  assert(await page.waitFor('!document.body.classList.contains("wide")'), 'back to narrow');
  await new Promise((r) => setTimeout(r, 150));
  assert(await page.waitFor('document.getElementById("list").classList.contains("hidden")'), 'narrow: detail full-screen, list hidden');
  await page.resize(1280, 800);
  assert(await page.waitFor('document.body.classList.contains("wide")'), 'wide again');
  assert(await page.waitFor('(function(){var l=document.getElementById("list").getBoundingClientRect(); return l.width>300})()'), 'left pane restored on breakpoint cross');
  assert(true, 'done');
});
