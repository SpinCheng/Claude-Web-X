// atpicker: v192 @ remote file picker (roadmap 11 · 方案A) - index endpoint
// (git lane + browse lane + guard) and the composer bubble: open on @, filter
// while typing, tap inserts `@path␣` / `@dir/␣` verbatim text, dismissals.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { withEnv, writeSession, assert, api, waitSession } from '../harness.mjs';
import { user, assistant, text, stop } from '../fixtures.mjs';
import { bashToolEnv } from '../../../bridge/lib/platform.js';

await withEnv(async (h, page) => {
  // project files in the session cwd; git init so the index lane is exercised
  // (machine global gitignore neutralized - listing must be deterministic).
  // The headless-Edge profile (edgeprof/) and the synthetic-transcript root
  // (projects/) live in the same tmp dir - gitignore them out of the index
  // (also proves the picker honours repo ignore semantics end to end).
  fs.mkdirSync(path.join(h.tmp, 'bridge'), { recursive: true });
  fs.writeFileSync(path.join(h.tmp, 'README.md'), '# e2e\n');
  fs.writeFileSync(path.join(h.tmp, 'bridge', 'app.js'), 'x');
  fs.writeFileSync(path.join(h.tmp, '.gitignore'), 'edgeprof/\nprojects/\n');
  const emptyInc = path.join(h.tmp, '.no-global-ignore');
  fs.writeFileSync(emptyInc, '');
  const GIT_ENV = { ...process.env, ...bashToolEnv(process.env) };
  execFileSync('git', ['init', '-q'], { cwd: h.tmp, env: GIT_ENV });
  execFileSync('git', ['config', 'core.excludesFile', emptyInc], { cwd: h.tmp, env: GIT_ENV });

  writeSession(h, 'T--e2e', 'at1', [user(1, 'at 测试', h.tmp), assistant(2, [text('ok')]), stop(3)]);
  assert(await waitSession('at1'), 'session visible');

  // endpoint: git index lane (untracked-unignored, forward slashes)
  const j = await (await api('/api/sessions/at1/files')).json();
  assert(j.ok && j.repo === true, 'git lane');
  assert(j.files.includes('README.md') && j.files.includes('bridge/app.js'), 'index lists project files');

  // browse lane: ?p= lists a dir, ?p=.. is refused by the cwd guard
  const b = await (await api('/api/sessions/at1/files?p=bridge')).json();
  assert(b.ok && b.files.includes('app.js'), 'browse lane lists the dir');
  assert((await api('/api/sessions/at1/files?p=..')).status === 403, 'browse guard rejects escape');

  // UI: @ opens the root listing (dirs + root files)
  await page.open('at1');
  assert(await page.waitFor('document.querySelectorAll(".turn").length >= 1'), 'app booted');
  const typeAt = (v) => page.ev('(function(){var i=document.getElementById("msg-input"); i.value=' + JSON.stringify(v)
    + '; i.setSelectionRange(i.value.length, i.value.length); i.dispatchEvent(new Event("input",{bubbles:true})); return true;})()');
  await typeAt('看 @');
  assert(await page.waitFor('document.querySelectorAll(".at-row").length >= 3'), 'root listing rows (bridge + projects dirs, README.md …)');
  assert(await page.waitFor('/git 索引/.test(document.getElementById("at-idx").textContent)'), 'index badge shows git lane');
  assert(await page.waitFor('document.querySelector(".at-row.dir") !== null'), 'dir rows render with folder icon');

  // typing filters (hit highlight rides along); tapping a FILE pins a dock TAG
  // (v197 ruling: /-command chip semantics) - the typed @token is stripped
  await typeAt('看 @read');
  assert(await page.waitFor('(function(){var r=document.querySelectorAll(".at-row"); return r.length===1 && /README\\.md/.test(r[0].textContent)})()'), 'filter narrows to README.md');
  await page.ev('document.querySelector(".at-row").click(); true;');
  assert(await page.waitFor('document.getElementById("msg-input").value === "看 "'), 'typed @token stripped on pick');
  assert(await page.waitFor('(function(){var c=document.getElementById("at-chips"); return !c.classList.contains("hidden") && /README\\.md/.test(c.textContent)})()'), 'file pinned as a dock tag');
  assert(await page.waitFor('document.getElementById("at-menu").classList.contains("hidden")'), 'menu closes after pick');

  // a DIR pick pins @dir/ (path text only - model explores, roadmap ruling)
  await typeAt('看 @bri');
  assert(await page.waitFor('(function(){var r=document.querySelector(".at-row"); return r && r.classList.contains("dir") && /bridge/.test(r.textContent)})()'), 'dirs rank first in hits');
  await page.ev('document.querySelector(".at-row").click(); true;');
  assert(await page.waitFor('(function(){var c=document.getElementById("at-chips"); return /@bridge\\//.test(c.textContent)})()'), 'dir pick pins @bridge/ tag');

  // tag x removes it (target the bridge tag specifically - README stays)
  await page.ev('(function(){var t=[].slice.call(document.querySelectorAll("#at-chips .cmd-tag")).find(function(x){return /bridge/.test(x.textContent)}); t.querySelector(".x").click(); return true;})()');
  assert(await page.waitFor('(function(){var c=document.getElementById("at-chips"); return !/bridge/.test(c.textContent) && /README\\.md/.test(c.textContent)})()'), 'tag x removes the bridge ref, README stays');
  await typeAt('看 @bri');
  await page.waitFor('(function(){var r=document.querySelector(".at-row"); return r && r.classList.contains("dir")})()');
  await page.ev('document.querySelector(".at-row").click(); true;');
  await page.waitFor('(function(){var c=document.getElementById("at-chips"); return /@bridge\\//.test(c.textContent)})()');

  // no-hit empty state (token stays plain text - bridge leaves it verbatim)
  await typeAt('看 @zzz');
  assert(await page.waitFor('(function(){var e=document.querySelector(".at-empty"); return e && /原文发送/.test(e.textContent)})()'), 'graceful no-hit state');

  // v197 send composition + fail restore: tags prefix the text on the wire and
  // come back with it when the POST fails
  await page.ev('(function(){var orig=window.fetch, cap=null; window.fetch=function(u,o){ if(String(u).indexOf("/message")>=0){ cap=o?o.body:null; return Promise.resolve({ok:false,status:500,json:function(){return Promise.resolve({error:"dbg"})}}); } return orig(u,o); }; window.__capBody=function(){return cap}; return true;})()');
  await typeAt('说明X');
  await page.ev('document.getElementById("send").click(); true;');
  assert(await page.waitFor('(function(){var b=window.__capBody(); return b && JSON.parse(b).text === "@README.md @bridge/ 说明X"})()'), 'send composes tags before the prose');
  assert(await page.waitFor('document.getElementById("msg-input").value === "说明X"'), 'fail path restores the prose');
  assert(await page.waitFor('(function(){var c=document.getElementById("at-chips"); return !c.classList.contains("hidden") && /README\\.md/.test(c.textContent) && /bridge/.test(c.textContent)})()'), 'fail path restores the tags');

  // dismissals: Esc key, tap outside
  await page.ev('document.getElementById("msg-input").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})); true;');
  assert(await page.waitFor('document.getElementById("at-menu").classList.contains("hidden")'), 'Esc closes');
  await typeAt('看 @re');
  assert(await page.waitFor('!document.getElementById("at-menu").classList.contains("hidden")'), 'reopened by typing');
  await page.ev('document.getElementById("chat").click(); true;');
  assert(await page.waitFor('document.getElementById("at-menu").classList.contains("hidden")'), 'tap outside closes');

  // v197 echo fold: a transcript line carrying the runner appendix renders as
  // the clean bubble + a folded marker row, never a giant echo bubble
  writeSession(h, 'T--e2e', 'at2', [
    { type: 'user', timestamp: new Date(Date.now() - 110_000).toISOString(), cwd: h.tmp, origin: { kind: 'human' },
      message: { role: 'user', content: '@README.md 看看\n\n[引用 @README.md]\n```\nfile body\n```' } },
    assistant(4, [text('ok')]),
    stop(5),
  ]);
  assert(await waitSession('at2'), 'echo session visible');
  await page.open('at2');
  assert(await page.waitFor('(function(){var b=[].slice.call(document.querySelectorAll(".bubble.user")); return b.some(function(x){return x.textContent.indexOf("@README.md 看看")>=0 && x.textContent.indexOf("file body")<0})})()'), 'bubble shows tags+prose only, no appendix');
  assert(await page.waitFor('(function(){return [].slice.call(document.querySelectorAll(".sysline")).some(function(x){return x.textContent.indexOf("已随消息附上 1 份")>=0})})()'), 'appendix folded into the marker row');
  assert(true, 'done');
});
