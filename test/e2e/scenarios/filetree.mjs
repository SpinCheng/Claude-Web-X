// filetree: v194 project file tree drawer (roadmap 12) - tree endpoint
// (annotations: staged/untracked/ignored) + drawer UX: open via header icon,
// lazy expand, seg filter, file actions bubble (insert @ ref into composer),
// scrim close.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { withEnv, writeSession, assert, api, waitSession } from '../harness.mjs';
import { user, assistant, text, stop } from '../fixtures.mjs';
import { bashToolEnv } from '../../../bridge/lib/platform.js';

await withEnv(async (h, page) => {
  // fixture repo: staged src/app.js + untracked src/extra.txt + untracked
  // skipme/ + ignored node_modules/; e2e noise (edgeprof/, projects/) ignored
  fs.mkdirSync(path.join(h.tmp, 'src'), { recursive: true });
  fs.mkdirSync(path.join(h.tmp, 'skipme'), { recursive: true });
  fs.mkdirSync(path.join(h.tmp, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(h.tmp, 'src', 'app.js'), 'x');
  fs.writeFileSync(path.join(h.tmp, 'src', 'extra.txt'), 'x');
  fs.writeFileSync(path.join(h.tmp, 'skipme', 'x.txt'), 'x');
  fs.writeFileSync(path.join(h.tmp, 'node_modules', 'p.js'), 'x');
  fs.writeFileSync(path.join(h.tmp, '.gitignore'), 'node_modules/\nedgeprof/\nprojects/\n');
  const emptyInc = path.join(h.tmp, '.no-global-ignore');
  fs.writeFileSync(emptyInc, '');
  const GENV = { ...process.env, ...bashToolEnv(process.env) };
  execFileSync('git', ['init', '-q'], { cwd: h.tmp, env: GENV });
  execFileSync('git', ['config', 'core.excludesFile', emptyInc], { cwd: h.tmp, env: GENV });
  execFileSync('git', ['add', 'src/app.js', '.gitignore', '.no-global-ignore'], { cwd: h.tmp, env: GENV });

  writeSession(h, 'T--e2e', 'ft1', [user(1, '文件树测试', h.tmp), assistant(2, [text('ok')]), stop(3)]);
  assert(await waitSession('ft1'), 'session visible');

  // endpoint: disk truth with annotation layer
  const j = await (await api('/api/sessions/ft1/tree')).json();
  assert(j.ok, 'tree ok');
  const byName = Object.fromEntries(j.entries.map((e) => [e.n, e]));
  assert(byName.src.d === 1, 'src is a dir');
  assert(byName.src.t === true, 'src has staged descendants');
  assert(byName.skipme.g === 'unt', 'untracked dir badge');
  assert(byName.node_modules.g === 'ign', 'ignored dir badge');
  assert(j.stats.t === 3, 'staged count');
  const sub = await (await api('/api/sessions/ft1/tree?p=src')).json();
  const b2 = Object.fromEntries(sub.entries.map((e) => [e.n, e]));
  assert(b2['app.js'].t === true, 'staged file');
  assert(b2['extra.txt'].g === 'unt', 'untracked file badge');
  assert((await api('/api/sessions/ft1/tree?p=..')).status === 403, 'escape rejected');

  // UI: header icon opens the drawer; root rows + badges render
  await page.open('ft1');
  assert(await page.waitFor('document.querySelectorAll(".turn").length >= 1'), 'app booted');
  await page.ev('document.getElementById("ft-toggle").click(); true;');
  assert(await page.waitFor('!document.getElementById("ft-drawer").classList.contains("hidden")'), 'drawer opens');
  assert(await page.waitFor('(function(){var r=[].slice.call(document.querySelectorAll(".frow")).map(function(x){return x.textContent}); return r.some(function(t){return /src/.test(t)}) && r.some(function(t){return /skipme/.test(t)})})()'), 'root rows render');
  assert(await page.waitFor('!!document.querySelector(".gitb.unt")'), 'untracked badge renders');
  // v199 ruling: ignored rows carry NO text badge - the .un dim IS the signal
  assert(await page.waitFor('(function(){var r=[].slice.call(document.querySelectorAll(".frow")).find(function(x){return /node_modules/.test(x.textContent)}); return r && r.classList.contains("un") && !r.querySelector(".gitb")})()'), 'ignored row dimmed, no badge');
  assert(await page.waitFor('!document.querySelector(".gitb.ign")'), 'no ign badges anywhere');
  assert(await page.waitFor('!document.getElementById("ft-bar").classList.contains("hidden")'), 'stat bar shows');
  assert(await page.waitFor('/3 跟踪/.test(document.getElementById("ft-stats").textContent)'), 'tracked count in stat bar');

  // lazy expand: tap src -> children load with depth indent
  await page.ev('(function(){var r=[].slice.call(document.querySelectorAll(".frow")).find(function(x){return /src/.test(x.textContent)}); r.click(); return true;})()');
  assert(await page.waitFor('(function(){var r=[].slice.call(document.querySelectorAll(".frow")); return r.some(function(x){return /app\\.js/.test(x.textContent)}) && r.some(function(x){return /extra\\.txt/.test(x.textContent)})})()'), 'src children lazy-load');
  assert(await page.waitFor('(function(){var r=document.querySelector(".frow"); return getComputedStyle(r).getPropertyValue("--ft-depth")==="0"})()'), 'depth var drives indent');

  // seg filter: 已跟踪 hides untracked/ignored rows but keeps the staged file
  await page.ev('document.querySelector("#ft-seg button[data-f=tracked]").click(); true;');
  assert(await page.waitFor('(function(){var t=[].slice.call(document.querySelectorAll(".frow")).map(function(x){return x.textContent}); return !t.some(function(x){return /skipme|node_modules/.test(x)}) && t.some(function(x){return /app\\.js/.test(x)}) && !t.some(function(x){return /extra\\.txt/.test(x)})})()'), 'tracked filter keeps only staged lineage');
  await page.ev('document.querySelector("#ft-seg button[data-f=all]").click(); true;');

  // file actions: ⋯ -> insert @ ref pins a dock TAG (v197 chip semantics), drawer closes
  await page.ev('(function(){var r=[].slice.call(document.querySelectorAll(".frow")).find(function(x){return /app\\.js/.test(x.textContent)}); r.querySelector(".more").click(); return true;})()');
  assert(await page.waitFor('!document.getElementById("row-actions").classList.contains("hidden")'), 'actions bubble opens');
  await page.ev('(function(){var b=[].slice.call(document.querySelectorAll("#row-actions .act-row")).find(function(x){return /插入 @ 引用/.test(x.textContent)}); b.click(); return true;})()');
  assert(await page.waitFor('(function(){var c=document.getElementById("at-chips"); return !c.classList.contains("hidden") && /@src\\/app\\.js/.test(c.textContent)})()'), 'insert pins the @src/app.js tag in the dock');
  assert(await page.waitFor('document.getElementById("ft-drawer").classList.contains("hidden")'), 'drawer closes after insert');

  // reopen + scrim tap closes
  await page.ev('document.getElementById("ft-toggle").click(); true;');
  assert(await page.waitFor('!document.getElementById("ft-drawer").classList.contains("hidden")'), 'reopened');
  await page.ev('document.getElementById("ft-scrim").click(); true;');
  assert(await page.waitFor('document.getElementById("ft-drawer").classList.contains("hidden")'), 'scrim tap closes');
  assert(true, 'done');
});
