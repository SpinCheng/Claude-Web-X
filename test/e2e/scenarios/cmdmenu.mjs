// cmdmenu: v109 slash-command discovery endpoint + composer menu + chip flow
import fs from 'node:fs';
import path from 'node:path';
import { withEnv, writeSession, assert, api, waitSession } from '../harness.mjs';
import { user, assistant, text, stop, caveatLine, cmdStdoutUser, cmdOutSystem, goalHookLine } from '../fixtures.mjs';

async function waitSessionLong(sid) {
  for (let i = 0; i < 80; i++) {
    try { const r = await api('/api/sessions/' + encodeURIComponent(sid) + '/messages'); if (r.ok) return true; } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

await withEnv(async (h, page) => {
  // project custom command with frontmatter, in the session's cwd
  fs.mkdirSync(path.join(h.tmp, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(h.tmp, '.claude', 'commands', 'deploy.md'),
    '---\ndescription: Deploy to env\nargument-hint: <env>\n---\nDeploy to $ARGUMENTS');
  writeSession(h, 'T--e2e', 'cm1', [user(1, 'cmdmenu 测试', h.tmp), assistant(2, [text('ok')]), stop(3)]);
  assert(await waitSession('cm1'), 'session visible');

  // endpoint: builtins + project custom with frontmatter meta
  const j = await (await api('/api/sessions/cm1/commands')).json();
  const names = (j.commands || []).map((c) => c.name);
  assert(names.includes('context') && names.includes('compact'), 'builtins present');
  const dep = (j.commands || []).find((c) => c.name === 'deploy');
  assert(dep && dep.src === '项目' && dep.desc === 'Deploy to env' && dep.argHint === '<env>', 'custom command discovered with frontmatter');

  // v111: a full command execution block (caveat -> envelope -> stdout user
  // line; /goal shape with system carrier + hook injection) renders as
  // command bubble + cmdout panels, hook text NEVER a human bubble
  writeSession(h, 'T--e2e', 'cm2', [
    user(1, '命令块测试', h.tmp),
    caveatLine(2),
    { type: 'user', timestamp: new Date(Date.now() - 110_000).toISOString(), cwd: h.tmp,
      message: { role: 'user', content: '<command-name>/usage</command-name>\n<command-message>usage</command-message>\n<command-args></command-args>' } },
    cmdStdoutUser(3, 'Total cost: $1.23'),
    assistant(4, [text('done')]),
    stop(5),
  ]);
  assert(await waitSession('cm2'), 'cmdout session visible');
  await page.open('cm2');
  assert(await page.waitFor('document.querySelectorAll(".cmdout").length === 1'), 'stdout renders as one cmdout panel');
  assert((await page.ev('document.querySelector(".cmdout").textContent')).indexOf('Total cost') >= 0, 'cmdout carries the stdout text');
  assert(await page.waitFor('(function(){var b=[].slice.call(document.querySelectorAll(".bubble.user")); return b.every(function(x){return x.textContent.indexOf("local-command-caveat") < 0 && x.textContent.indexOf("Stop hook") < 0})})()'), 'no caveat/hook leakage into human bubbles');

  // /goal shape: system carrier + hook line (hook folds, Goal-set shows)
  writeSession(h, 'T--e2e', 'cm3', [
    user(1, 'goal 测试', h.tmp),
    { type: 'user', timestamp: new Date(Date.now() - 110_000).toISOString(), cwd: h.tmp,
      message: { role: 'user', content: '<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>回复ok</command-args>' } },
    cmdOutSystem(2, 'Goal set: 回复ok'),
    goalHookLine(3, '回复ok'),
    assistant(4, [text('收到目标，开始执行')]),
    stop(5),
  ]);
  assert(await waitSession('cm3'), 'goal session visible');
  await page.open('cm3');
  assert(await page.waitFor('document.querySelectorAll(".cmdout").length === 1'), 'goal stdout via system carrier renders');
  assert(await page.waitFor('(function(){var b=[].slice.call(document.querySelectorAll(".bubble.user")); return b.every(function(x){return x.textContent.indexOf("Stop hook") < 0})})()'), 'hook injection never a human bubble');
  await page.open('cm1');

  // v114: custom command dispatch shape - envelope + EXPANDED body line;
  // the body must fold (no second bubble), the envelope shows /deploy
  writeSession(h, 'T--e2e', 'cm4', [
    user(1, '自定义命令测试', h.tmp),
    { type: 'user', timestamp: new Date(Date.now() - 110_000).toISOString(), cwd: h.tmp,
      message: { role: 'user', content: '<command-message>deploy</command-message>\n<command-name>/deploy</command-name>\n<command-args>prod</command-args>' } },
    { type: 'user', timestamp: new Date(Date.now() - 109_000).toISOString(), cwd: h.tmp,
      message: { role: 'user', content: 'Say exactly: DEPLOY-RAN [prod]' } },
    assistant(4, [text('DEPLOY-RAN [prod]')]),
    stop(5),
  ]);
  assert(await waitSession('cm4'), 'custom-cmd session visible');
  await page.open('cm4');
  assert(await page.waitFor('(function(){var b=[].slice.call(document.querySelectorAll(".bubble.user")); return b.some(function(x){return /deploy/.test(x.textContent)})})()'), 'envelope bubble shows /deploy');
  assert(await page.waitFor('(function(){var b=[].slice.call(document.querySelectorAll(".bubble.user")); return !b.some(function(x){return x.textContent.indexOf("DEPLOY-RAN [prod]") >= 0 && x.textContent.indexOf("deploy") < 0})})()'), 'expanded body never a second bubble');
  await page.open('cm1');

  // UI: wait for the app to boot (transcript rendered), then interact
  assert(await page.waitFor('document.querySelectorAll(".turn").length >= 1'), 'app booted (transcript rendered)');
  await page.ev('(function(){var i=document.getElementById("msg-input"); i.value="/"; i.dispatchEvent(new Event("input",{bubbles:true})); return true;})()');
  assert(await page.waitFor('(document.querySelectorAll(".cm-row").length || 0) >= 14'), 'menu rows render (builtins+custom)');
  assert(await page.waitFor('!!document.querySelector(".cm-row .cm-src")'), 'flat rows carry source badges');

  // filter narrows to the custom command
  await page.ev('(function(){var i=document.getElementById("msg-input"); i.value="/dep"; i.dispatchEvent(new Event("input",{bubbles:true})); return true;})()');
  assert(await page.waitFor('(function(){var r=document.querySelectorAll(".cm-row"); return r.length===1 && /deploy/.test(r[0].textContent)})()'), 'filter narrows to deploy');

  // pick -> chip in dock, input cleared, menu closed
  await page.ev('(function(){document.querySelector(".cm-row").click(); return true;})()');
  assert(await page.waitFor('!document.getElementById("cmd-chips").classList.contains("hidden")'), 'chip visible after pick');
  assert(await page.waitFor('/deploy/.test(document.getElementById("cmd-chips").textContent)'), 'chip carries command name');
  assert((await page.ev('document.getElementById("msg-input").value')) === '', 'input cleared on pick');
  assert(await page.waitFor('document.getElementById("cmd-menu").classList.contains("hidden")'), 'menu closed after pick');

  // empty-box backspace removes the whole chip
  await page.ev('(function(){var i=document.getElementById("msg-input"); i.dispatchEvent(new KeyboardEvent("keydown",{key:"Backspace",bubbles:true})); return true;})()');
  assert(await page.waitFor('document.getElementById("cmd-chips").classList.contains("hidden")'), 'backspace removes chip');

  // re-pick, then tap chip reopens the menu (replace flow)
  await page.ev('(function(){var i=document.getElementById("msg-input"); i.value="/"; i.dispatchEvent(new Event("input",{bubbles:true})); return true;})()');
  await page.waitFor('document.querySelectorAll(".cm-row").length >= 14');
  await page.ev('(function(){var r=[].slice.call(document.querySelectorAll(".cm-row")).find(function(x){return /context/.test(x.textContent)}); r && r.click(); return true;})()');
  await page.waitFor('!document.getElementById("cmd-chips").classList.contains("hidden")');
  await page.ev('(function(){document.querySelector(".cmd-tag").click(); return true;})()');
  assert(await page.waitFor('!document.getElementById("cmd-menu").classList.contains("hidden")'), 'tapping chip reopens menu');

  // tap outside closes the menu (no scrim)
  await page.ev('(function(){document.getElementById("chat").click(); return true;})()');
  assert(await page.waitFor('document.getElementById("cmd-menu").classList.contains("hidden")'), 'tap outside closes menu');
  assert(true, 'done');
});
