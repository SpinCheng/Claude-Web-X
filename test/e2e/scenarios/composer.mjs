// composer: three-state send button driven by fake run frames through the
// REAL server wiring (runner 'update' event -> WS run frame); plus v36
// toolbar geometry (long model label must not push the send button out) and
// the merged model+effort sheet semantics
import { withEnv, writeSession, assert, fakeRun } from '../harness.mjs';
import { timelineLines } from '../fixtures.mjs';

await withEnv(async (h, page) => {
  writeSession(h, 'T--e2e', 'cp1', timelineLines());
  await page.open('cp1');
  assert(await page.waitFor('!!document.querySelector(".final-card")'), 'detail rendered');

  const st = () => page.ev('(function(){var s=document.getElementById("send"),t=document.getElementById("stop");' +
    'return {send:!s.classList.contains("hidden"),queue:s.classList.contains("queue"),stop:!t.classList.contains("hidden")}})()');
  const type = (v) => page.ev(`(function(){var i=document.getElementById("msg-input");i.value=${JSON.stringify(v)};i.dispatchEvent(new Event("input",{bubbles:true}));return true})()`);

  let s = await st();
  assert(s.send && !s.queue && !s.stop, 'idle: send visible');

  // v36: absurdly long model label - the chip shrinks, the send button stays
  // on screen (text injected straight into the span: CSS geometry is the
  // thing under test; renderModelChip never re-runs mid-scenario)
  await page.ev(`document.getElementById('c-model-name').textContent = 'claude超长模型名-opus-4-5-20251101-abcdefghijklmnopqrstuvwxyz'`);
  await page.ev(`document.getElementById('c-model').click()`);
  assert(await page.waitFor(`!document.getElementById('model-sheet').classList.contains('hidden')`), 'model sheet open');
  assert(await page.waitFor(`document.querySelectorAll('#effort-row .seg-btn').length === 6`), 'six effort pills in sheet');
  await page.ev(`[...document.querySelectorAll('#effort-row .seg-btn')].find(b => b.textContent === '高').click()`);
  assert(await page.waitFor(`!document.getElementById('model-sheet').classList.contains('hidden')`), 'effort tap keeps sheet open');
  assert(await page.waitFor(`localStorage.getItem('cr_effort') === 'high'`), 'effort persisted');
  assert(await page.waitFor(`!document.getElementById('c-effort-tag').hidden && document.getElementById('c-effort-tag').textContent === '·高'`), 'chip tag armed');
  await page.ev(`[...document.querySelectorAll('#effort-row .seg-btn')].find(b => b.textContent === '默认').click()`);
  assert(await page.waitFor(`document.getElementById('c-effort-tag').hidden`), 'default disarms tag');
  // close via scrim (the close handler requires the click target to be the overlay itself)
  await page.ev(`document.getElementById('model-sheet').click()`);
  assert(await page.waitFor(`document.getElementById('model-sheet').classList.contains('hidden')`), 'sheet closed');

  // geometry at PHONE width (headless desktop viewport never overflows)
  await page.resize(375);
  const geo = await page.ev('(function(){var t=document.getElementById("toolbar"),s=document.getElementById("send"),m=document.getElementById("c-model");' +
    'var tr=t.getBoundingClientRect(),sr=s.getBoundingClientRect(),mr=m.getBoundingClientRect();' +
    'return {tw:tr.width, sendIn: sr.right <= tr.right + 1 && sr.left >= tr.left - 1, mShrunk: mr.width < 200}})()');
  assert(geo.sendIn, `send button inside toolbar (geo=${JSON.stringify(geo)})`);
  assert(geo.mShrunk, `model chip shrank under the long label (geo=${JSON.stringify(geo)})`);

  fakeRun(h, 'cp1', 'running');
  await page.waitFor('(function(){var t=document.getElementById("stop");return !t.classList.contains("hidden")})()');
  s = await st();
  assert(!s.send && s.stop, 'running+empty: stop visible');

  await type('排队后续');
  s = await st();
  assert(s.send && s.queue && !s.stop, 'running+typed: amber queue-send');

  await type('');
  s = await st();
  assert(!s.send && s.stop, 'text cleared: back to stop');

  fakeRun(h, 'cp1', 'end');
  await page.waitFor('(function(){var s=document.getElementById("send");return !s.classList.contains("hidden") && !s.classList.contains("queue")})()');
  s = await st();
  assert(s.send && !s.queue && !s.stop, 'run end: back to idle');

  // v145: pasted files ride the attachment pipeline - synthetic ClipboardEvent
  // with a real DataTransfer (works in Chromium); a text paste without files
  // keeps the browser default and never opens the chips row
  await page.ev(`(function(){
    var dt = new DataTransfer();
    dt.items.add(new File(['paste-body-1'], 'pasted.txt', { type: 'text/plain' }));
    document.getElementById('msg-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;
  })()`);
  assert(await page.waitFor('!document.getElementById("attach-chips").classList.contains("hidden")'), 'paste: chips row opens');
  assert(await page.waitFor('(document.querySelector("#attach-chips .ac-name") || {textContent:""}).textContent.indexOf("pasted.txt") >= 0'), 'paste: chip named');
  assert(await page.waitFor('(document.querySelector("#attach-chips .ac-name") || {textContent:""}).textContent.indexOf("…") < 0'), 'paste: upload settled');
  await page.ev('(function(){var x=document.querySelector("#attach-chips .ac-x"); x && x.click(); return true;})()');
  assert(await page.waitFor('document.getElementById("attach-chips").classList.contains("hidden")'), 'paste: chip removed');
  await page.ev(`(function(){
    var dt = new DataTransfer();
    document.getElementById('msg-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;
  })()`);
  assert(true, 'done');
});
