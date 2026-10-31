// scripts/shots.mjs - README screenshots from the ISOLATED e2e environment
// (bridge :3799 + synthetic T:\e2e fixtures) so no real session data leaks.
// Usage: node scripts/shots.mjs -> docs/screenshots/*.png
//   list / detail / detail-open  - list, collapsed detail, expanded process capsule
//   new-task                     - new-task modal
//   approval / cost / cmd-menu    - phone approval card, cost panel, slash menu
//   preview-md / preview-diff     - v139/v142-v143 preview pages (render tabs)
import fs from 'node:fs';
import path from 'node:path';
import { withEnv, writeSession } from '../test/e2e/harness.mjs';
import { timelineLines, previewLines, user, assistant, stop, toolUse, toolResult, text } from '../test/e2e/fixtures.mjs';

const OUT = path.resolve('docs/screenshots');
fs.mkdirSync(OUT, { recursive: true });

const shot = async (page, name) => {
  const r = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
  console.log('shot:', name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (p, opts = {}) => fetch('http://127.0.0.1:3799' + p, { ...opts, headers: { Authorization: 'Bearer e2etok', 'Content-Type': 'application/json', ...(opts.headers || {}) } });
const flink = (page, mark) => page.ev('(function(){var a=[].slice.call(document.querySelectorAll(".flink")).find(function(x){return /' + mark + '$/i.test(x.textContent)}); a && a.click(); return true;})()');

// a second project's session so the list shows two groups
const otherLines = [
  user(1, '帮我看下构建为什么失败', 'T:\\shop-api'),
  assistant(2, [toolUse('t1', 'Bash', { command: 'npm run build' }), text('构建脚本在压缩阶段内存不足，已调大 Node 堆并锁定修复。')], 'glm-5.3'),
].concat([stop(4)]);

// cost-bearing session for the cost-panel shot
const costLines = [
  user(1, '这轮花了多少', 'T:\\e2e'),
  assistant(2, [text('按官方价表结算，明细见下方费用面板。')]),
  { type: 'cost-state', modelUsage: {
    'claude-sonnet-4-5': { inputTokens: 84210, outputTokens: 15230, cacheReadInputTokens: 312000, cacheCreationInputTokens: 90400, costUSD: 1.84 },
  } },
  stop(3),
];

const MD = [
  '# 部署指南', '',
  '## 环境要求', '',
  '- Node **≥ 20**、npm ≥ 10', '- 桥与本机 CLI 同一用户', '',
  '## 步骤', '',
  '| 步骤 | 命令 | 说明 |', '|---|---|---|', '| 安装 | `npm i` | 仅 ws 一个依赖 |', '| 启动 | `npm start` | 端口 3742 |', '',
  '> 手机扫码配对后即可远程查看与接管。', '',
  '```powershell', 'npm install', 'npm start', '```', '',
  '详见 [文档](https://example.com/deploy)。',
].join('\n');

const DIFF = [
  '--- a/src/pay.ts', '+++ b/src/pay.ts', '@@ -12,7 +12,9 @@ export function checkout(cart) {',
  '   const raw = cart.total();', '-  const amount = raw;', '-  charge(amount);',
  '+  // 金额统一到分，避免浮点误差', '+  const amount = Math.round(raw * 100) / 100;', '+  charge(amount);', '   return receipt(cart);',
  '@@ -40,3 +42,4 @@', '   log(\'checkout done\');', '+  metrics.increment(\'checkout.ok\');',
].join('\n');

await withEnv(async (h, page) => {
  writeSession(h, 'T--e2e', 'tl1', timelineLines());
  writeSession(h, 'T--shop-api', 'sh1', otherLines);
  writeSession(h, 'T--e2e', 'cs1', costLines);
  fs.writeFileSync(path.join(h.tmp, 'deploy.md'), MD);
  fs.writeFileSync(path.join(h.tmp, 'pay.diff'), DIFF);
  writeSession(h, 'T--e2e', 'md1', previewLines(h.tmp, 'deploy.md'));
  writeSession(h, 'T--e2e', 'df1', previewLines(h.tmp, 'pay.diff'));
  // DPR 3.75 capture: 390x800 CSS -> 1463x3000 physical. README shots must
  // rasterize at retina density or they look blurry on modern displays; the
  // user's reference device renders at 3.75x (e.g. 1440x3200 class screens).
  // The harness resize() pins deviceScaleFactor 1 - override it here.
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 3.75, mobile: true });

  // 1. list page (two project groups, synthetic data only)
  await page.navigate('http://127.0.0.1:3799/?token=e2etok');
  await page.waitFor('!!document.querySelector(".pgroup-head")');
  await sleep(600);
  await shot(page, 'list.png');

  // 2. session detail (timeline: trigger pill, nodes, final card + rollup)
  await page.ev('document.querySelectorAll(".srow")[0].click()');
  await page.waitFor('!!document.querySelector(".final-card")');
  await sleep(400);
  await shot(page, 'detail.png');

  // 3. phone approval card: seed an in-process run record (the /internal
  // endpoint validates runId against runner.runs), then fire the ask - the
  // card pops over the open detail view
  h.runner.runs.set('shotrun', { runId: 'shotrun', sessionId: 'tl1', state: 'running', startedAt: Date.now() });
  fetch('http://127.0.0.1:3799/internal/approval?run=shotrun', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool_name: 'Edit', input: { file_path: 'T:\\shop-api\\src\\pay.ts', old_string: 'const amount = raw;', new_string: 'const amount = Math.round(raw * 100) / 100;' } }),
  }).catch(() => {});
  await page.waitFor('!document.getElementById("approval").classList.contains("hidden")');
  await sleep(400);
  await shot(page, 'approval.png');
  const pending = await (await api('/api/approvals/pending')).json();
  if (pending.approvals[0]) await api('/api/approvals/' + encodeURIComponent(pending.approvals[0].id), { method: 'POST', body: '{"decision":"deny"}' });
  await page.waitFor('document.getElementById("approval").classList.contains("hidden")');

  // 3b. detail with the process capsule EXPANDED: trigger tap reveals the
  // full timeline (think/tool/text nodes), then open the tool node body and
  // anchor the capsule at the viewport top so the shot shows it from its start
  await page.ev('var t=document.querySelector(".turn .trigger"); t && t.click()');
  await page.waitFor('!!document.querySelector(".node .node-head")');
  await page.ev('(function(){var h=document.querySelector(".node:not(.plain) .node-head"); h && h.click(); return true;})()');
  await sleep(400);
  await page.ev('(function(){var w=document.querySelector(".turn.open")||document.querySelector(".turn"); var c=document.getElementById("chat"); c.scrollTop=Math.max(0,w.offsetTop-56); c.dispatchEvent(new Event("scroll")); return true;})()');
  await sleep(300);
  await shot(page, 'detail-open.png');
  await page.ev('var t=document.querySelector(".turn .trigger"); t && t.click()');

  // 4. cost panel (session with a cost-state snapshot; header $ -> sheet)
  await page.navigate('http://127.0.0.1:3799/?token=e2etok#open=cs1');
  await page.waitFor('!!document.querySelector(".final-card")');
  await page.waitFor('!!document.querySelector(".cost-entry")');
  await sleep(300);
  await page.ev('document.querySelector(".cost-entry").click()');
  await page.waitFor('!document.getElementById("cost-sheet").classList.contains("hidden")');
  await sleep(400);
  await shot(page, 'cost.png');
  await page.ev('document.getElementById("cost-sheet").click()');

  // 5. slash-command menu (builtins list; type "/" into the composer)
  await page.ev('(function(){var i=document.getElementById("msg-input");i.value="/";i.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
  await page.waitFor('!document.getElementById("cmd-menu").classList.contains("hidden")');
  await sleep(400);
  await shot(page, 'cmd-menu.png');
  await page.ev('(function(){var i=document.getElementById("msg-input");i.value="";i.dispatchEvent(new Event("input",{bubbles:true}));return true})()');

  // 6. md render preview (v139: dual tab, frontmatter-free sample)
  await page.navigate('http://127.0.0.1:3799/?token=e2etok#open=md1');
  await page.waitFor('document.querySelectorAll(".flink").length >= 1');
  await flink(page, 'deploy\\.md');
  await page.waitFor('!document.getElementById("html-prev").classList.contains("hidden")');
  await sleep(500);
  await shot(page, 'preview-md.png');
  await page.ev('document.getElementById("hp-back").click()');
  await page.waitFor('document.getElementById("html-prev").classList.contains("hidden")');

  // 7. diff preview in side-by-side mode (v143 toggle -> v142 renderer)
  await page.navigate('http://127.0.0.1:3799/?token=e2etok#open=df1');
  await page.waitFor('document.querySelectorAll(".flink").length >= 1');
  await flink(page, 'pay\\.diff');
  await page.waitFor('!document.getElementById("html-prev").classList.contains("hidden")');
  await sleep(300);
  await page.ev('document.getElementById("dmode").click()'); // CSS-only toggle -> 并排
  await sleep(300);
  await shot(page, 'preview-diff.png');
  await page.ev('document.getElementById("hp-back").click()');

  // 8. new-task modal (section cards + track pills)
  await page.navigate('http://127.0.0.1:3799/?token=e2etok');
  await page.waitFor('!!document.getElementById("new-session")');
  await page.ev('document.getElementById("new-session").click()');
  await page.waitFor('!document.getElementById("new-modal").classList.contains("hidden")');
  await sleep(400);
  await shot(page, 'new-task.png');
});
console.log('done');
