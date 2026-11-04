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

  // typing filters (hit highlight rides along); tap a FILE inserts @path + space
  await typeAt('看 @read');
  assert(await page.waitFor('(function(){var r=document.querySelectorAll(".at-row"); return r.length===1 && /README\\.md/.test(r[0].textContent)})()'), 'filter narrows to README.md');
  await page.ev('document.querySelector(".at-row").click(); true;');
  assert(await page.waitFor('(function(){var i=document.getElementById("msg-input"); return i.value==="看 @README.md "})()'), 'pick inserts @path + trailing space at the caret');
  assert(await page.waitFor('document.getElementById("at-menu").classList.contains("hidden")'), 'menu closes after pick');

  // a DIR pick inserts @dir/ (path text only - model explores, roadmap ruling)
  await typeAt('看 @bri');
  assert(await page.waitFor('(function(){var r=document.querySelector(".at-row"); return r && r.classList.contains("dir") && /bridge/.test(r.textContent)})()'), 'dirs rank first in hits');
  await page.ev('document.querySelector(".at-row").click(); true;');
  assert(await page.waitFor('document.getElementById("msg-input").value === "看 @bridge/ "'), 'dir pick inserts @dir/ ');

  // no-hit empty state (token stays plain text - bridge leaves it verbatim)
  await typeAt('看 @zzz');
  assert(await page.waitFor('(function(){var e=document.querySelector(".at-empty"); return e && /原文发送/.test(e.textContent)})()'), 'graceful no-hit state');

  // dismissals: Esc key, tap outside
  await page.ev('document.getElementById("msg-input").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})); true;');
  assert(await page.waitFor('document.getElementById("at-menu").classList.contains("hidden")'), 'Esc closes');
  await typeAt('看 @re');
  assert(await page.waitFor('!document.getElementById("at-menu").classList.contains("hidden")'), 'reopened by typing');
  await page.ev('document.getElementById("chat").click(); true;');
  assert(await page.waitFor('document.getElementById("at-menu").classList.contains("hidden")'), 'tap outside closes');
  assert(true, 'done');
});
