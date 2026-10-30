// titlelive: the open detail's header follows a titlegen custom-title live
// (sessions frame AND the append title event), the html-preview source tab is
// opaque, and preview failures explain themselves per status.
import { withEnv, writeSession, fakeRun, assert } from '../harness.mjs';
import { timelineLines } from '../fixtures.mjs';
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await withEnv(async (h, page) => {
  await page.navigate('http://127.0.0.1:3799/?token=e2etok');
  await page.waitFor('!!document.getElementById("back")');

  // mock /api/sessions/new so no real CLI spawns
  await page.ev(`(function(){
    const of = window.fetch;
    window.fetch = function(u, o){
      if (String(u).indexOf('/api/sessions/new') >= 0) {
        return Promise.resolve(new Response(JSON.stringify({ok:true, runId:'e2e-run'}), {status:200, headers:{'Content-Type':'application/json'}}));
      }
      return of.apply(this, arguments);
    };
  })()`);

  // ---- full new-task flow: modal -> provisional -> adoption -> live title ----
  await page.ev('document.getElementById("new-session").click()');
  await page.waitFor('!document.getElementById("new-modal").classList.contains("hidden")');
  await page.ev('document.getElementById("new-text").value = "把配对页面改造成PC双栏布局"');
  await page.ev('document.getElementById("new-go").click()');
  await sleep(400);
  assert(await page.waitFor('!document.getElementById("detail").classList.contains("hidden")'), 'provisional detail open');

  writeSession(h, 'T--e2e', 'adopt1', timelineLines());
  await sleep(600);
  fakeRun(h, 'adopt1', 'running', 'e2e-run'); // adoption
  await sleep(1200);
  assert(await page.waitFor('document.getElementById("d-title").textContent.length > 0'), 'adopted with fallback title');

  fakeRun(h, 'adopt1', 'end', 'e2e-run');
  await sleep(300);
  const f = path.join(h.tmp, 'projects', 'T--e2e', 'adopt1.jsonl');
  fs.appendFileSync(f, JSON.stringify({ type: 'custom-title', customTitle: '配对页改PC双栏布局' }) + '\n');
  assert(await page.waitFor('document.getElementById("d-title").textContent === "配对页改PC双栏布局"', 5000),
    'd-title follows the custom-title live');

  // ---- process capsule shows elapsed (frozen once the turn is done) ----
  const durSel = `document.querySelector("#chat .turn.bot .trigger .t-dur").textContent`;
  assert(await page.waitFor(`/·\\s*\\d+(\\.\\d+)?(s|m)/.test(${durSel})`, 5000), 'capsule shows elapsed time');
  const d1 = await page.ev(durSel);
  await sleep(1500);
  const d2 = await page.ev(durSel);
  assert(d1 === d2, 'elapsed frozen after turn done (' + JSON.stringify(d1) + ' vs ' + JSON.stringify(d2) + ')');

  // ---- preview failure reasons + a real open, all against the session cwd ----
  // (cwd rides on any transcript line - the adapter harvests it, switching the
  // record to h.tmp so the preview endpoint resolves there)
  const gone = path.join(h.tmp, 'gone-file.txt');
  const real = path.join(h.tmp, 'notes.txt');
  const outside = 'C:\\Users\\someone\\outside.txt';
  fs.writeFileSync(real, 'source tab opacity fixture\n');
  fs.appendFileSync(f, JSON.stringify({
    type: 'assistant', timestamp: '2026-01-01T00:00:00Z', cwd: h.tmp,
    message: { role: 'assistant', model: 'm', content: [{ type: 'text',
      text: '产物与对照：' + real + ' 与 ' + gone + ' 与 ' + outside }] },
  }) + '\n');
  await sleep(1200);
  const clickLink = (t) => page.ev(`(function(){var a=[...document.querySelectorAll(".flink")].find(x=>x.textContent.indexOf(${JSON.stringify(t)})>=0);if(a){a.click();return true}return false})()`);
  assert(await clickLink('gone-file.txt'), 'gone-file link rendered');

  await clickLink('gone-file.txt');
  assert(await page.waitFor('(document.getElementById("toast")||{textContent:""}).textContent.indexOf("文件不存在") >= 0', 4000),
    'missing file toast explains 404');
  await sleep(400);
  await clickLink('outside.txt');
  assert(await page.waitFor('(document.getElementById("toast")||{textContent:""}).textContent.indexOf("会话目录外") >= 0', 4000),
    'outside-cwd toast explains 403');

  // ---- html preview source tab must be opaque over the transcript ----
  await sleep(400);
  assert(await clickLink('notes.txt'), 'real file link rendered');
  assert(await page.waitFor('!document.getElementById("html-prev").classList.contains("hidden")', 4000), 'preview page opens');
  assert(await page.waitFor('document.getElementById("hp-src").textContent.indexOf("opacity fixture") >= 0', 4000), 'source tab loaded');
  const opaque = await page.ev(`(function(){
    const bg = getComputedStyle(document.getElementById("hp-src")).backgroundColor;
    return bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
  })()`);
  assert(opaque, 'source tab background is opaque');
});
console.log("titlelive OK");
process.exit(0);
