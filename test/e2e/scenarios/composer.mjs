// composer: three-state send button driven by fake run frames through the
// REAL server wiring (runner 'update' event -> WS run frame)
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
});
