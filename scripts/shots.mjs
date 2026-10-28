// scripts/shots.mjs - README screenshots from the ISOLATED e2e environment
// (bridge :3799 + synthetic T:\e2e fixtures) so no real session data leaks.
// Usage: node scripts/shots.mjs  -> docs/screenshots/{list,detail,new-task}.png
import fs from 'node:fs';
import path from 'node:path';
import { withEnv, writeSession } from '../test/e2e/harness.mjs';
import { timelineLines, user, assistant, stop, toolUse, toolResult, text } from '../test/e2e/fixtures.mjs';

const OUT = path.resolve('docs/screenshots');
fs.mkdirSync(OUT, { recursive: true });

const shot = async (page, name) => {
  const r = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
  console.log('shot:', name);
};

// a second project's session so the list shows two groups
const otherLines = [
  user(1, '帮我看下构建为什么失败', 'T:\\shop-api'),
  assistant(2, [toolUse('t1', 'Bash', { command: 'npm run build' }), text('构建脚本在压缩阶段内存不足，已调大 Node 堆并锁定修复。')], 'glm-5.3'),
  user(3, '', 'T:\\shop-api'), // placeholder replaced below
].slice(0, 2).concat([stop(4)]);

await withEnv(async (h, page) => {
  writeSession(h, 'T--e2e', 'tl1', timelineLines());
  writeSession(h, 'T--shop-api', 'sh1', otherLines);
  await page.resize(390, 800);

  // 1. list page (two project groups, synthetic data only)
  await page.navigate('http://127.0.0.1:3799/?token=e2etok');
  await page.waitFor('!!document.querySelector(".pgroup-head")');
  await new Promise((r) => setTimeout(r, 600));
  await shot(page, 'list.png');

  // 2. session detail (timeline: trigger pill, nodes, final card)
  await page.ev('document.querySelectorAll(".srow")[0].click()');
  await page.waitFor('!!document.querySelector(".final-card")');
  await new Promise((r) => setTimeout(r, 400));
  await shot(page, 'detail.png');

  // 3. new-task modal (section cards + track pills)
  await page.navigate('http://127.0.0.1:3799/?token=e2etok');
  await page.waitFor('!!document.getElementById("new-session")');
  await page.ev('document.getElementById("new-session").click()');
  await page.waitFor('!document.getElementById("new-modal").classList.contains("hidden")');
  await new Promise((r) => setTimeout(r, 400));
  await shot(page, 'new-task.png');
});
console.log('done');
