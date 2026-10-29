// agents: v112 方案A - live subagent node (badge/title/live-line), the
// full-text bubble, live step advance, completion via meta + parent
// tool_result, and the ghost-session guard over the store.
import fs from 'node:fs';
import path from 'node:path';
import { withEnv, writeSession, assert, api } from '../harness.mjs';
import { user, assistant, toolUse, toolResult, stop } from '../fixtures.mjs';

const ts0 = Date.now() - 120_000;
const ts = (off) => new Date(ts0 + off * 1000).toISOString();
const line = (o) => JSON.stringify(o);
const agAssistant = (t, blocks) => ({ type: 'assistant', timestamp: t, message: { role: 'assistant', model: 'glm-5.3', content: blocks, usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } });

await withEnv(async (h, page) => {
  // parent: one RUNNING Agent tool_use (result not landed yet)
  writeSession(h, 'T--e2e', 'agsess', [
    user(1, '帮我审文档'),
    assistant(2, [toolUse('call_ag1', 'Agent', { description: '文档审查', prompt: 'Read the docs.' })]),
  ]);
  // the subagent transcript lands under <sid>/subagents/ - the recursive
  // watcher routes it to the tracker (never a session row)
  const sub = path.join(h.tmp, 'projects', 'T--e2e', 'agsess', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const agPath = path.join(sub, 'agent-e2eaaaa.jsonl');
  fs.writeFileSync(agPath, [
    line({ type: 'user', timestamp: ts(3), message: { role: 'user', content: 'Read the docs.' } }),
    line(agAssistant(ts(4), [{ type: 'tool_use', id: 'st1', name: 'Read', input: { file_path: 'D:\\e2e\\README.md' } }])),
  ].join('\n') + '\n');

  await page.open('agsess');
  assert(await page.waitFor('!!document.querySelector(".agent-live")'), 'agent live-line rendered');
  const badge = await page.ev('(function(){var n=document.querySelector(".node[data-agent]"); return n?n.querySelector(".badge").textContent:""})()');
  assert(badge === '代理', 'agent node badge (got "' + badge + '")');
  const title = await page.ev('(function(){var n=document.querySelector(".node[data-agent]"); return n?n.querySelector(".node-head .t").textContent:""})()');
  assert(title === '文档审查', 'agent node title = description (got "' + title + '")');
  const al = await page.ev('(function(){var a=document.querySelector(".agent-live .al-txt"); return a?a.textContent:""})()');
  assert(al.indexOf('Read') >= 0, 'live-line carries the agent step (got "' + al + '")');
  assert(al.indexOf('README.md') >= 0 && al.indexOf('D:') < 0, 'file paths collapse to basename (got "' + al + '")');
  assert(al.indexOf('第 1 步') >= 0, 'step count rides in the live text (got "' + al + '")');
  assert(await page.ev('!!document.querySelector(".agent-live .al-full")'), '全文 › affordance present');
  const dur = await page.ev('(function(){var d=document.querySelector(".node[data-agent] .node-head .dur"); return d?d.textContent:""})()');
  assert(/^· \d+m\d+s$/.test(dur), 'head dur is a live elapsed (got "' + dur + '")');
  assert(await page.ev('!!document.querySelector(".node[data-agent] .dot-tool.on")'), 'agent dot breathing');

  // live-line tap opens the full-text bubble
  await page.ev('document.querySelector(".agent-live").click()');
  assert(await page.waitFor('!document.getElementById("agent-sheet").classList.contains("hidden")'), 'agent bubble open');
  assert(await page.waitFor('!!document.querySelector("#ag-body .timeline")'), 'bubble body rendered');
  const bt = await page.ev('document.getElementById("ag-title").textContent');
  assert(bt === '文档审查', 'bubble title (got "' + bt + '")');
  const badges = await page.ev('[].slice.call(document.querySelectorAll("#ag-body .badge")).map(function(b){return b.textContent}).join(",")');
  assert(badges === '任务,工具', 'bubble nodes: prompt as 任务 + agent tool (got "' + badges + '")');

  // the agent keeps working -> live-line advances (WS agent frame path)
  fs.appendFileSync(agPath, [
    line({ type: 'user', timestamp: ts(5), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'st1', content: [{ type: 'text', text: 'ok' }] }] } }),
    line(agAssistant(ts(6), [{ type: 'tool_use', id: 'st2', name: 'Bash', input: { command: 'echo done' } }])),
  ].join('\n') + '\n');
  assert(await page.waitFor('(function(){var a=document.querySelector(".agent-live .al-txt"); return !!(a&&a.textContent.indexOf("Bash")>=0)})()'), 'live-line advanced to the new step');

  // completion: meta.json rewrite (finished) + parent tool_result + stop
  fs.writeFileSync(path.join(sub, 'agent-e2eaaaa.meta.json'),
    line({ agentType: 'general-purpose', description: '文档审查', toolUseId: 'call_ag1', spawnDepth: 1, requestShape: 'foreground', finished: true }));
  assert(await page.waitFor('(function(){var l=document.querySelector(".agent-live"); return !l||l.classList.contains("done")})()'), 'meta finished flips the live-line to done');
  fs.appendFileSync(path.join(h.tmp, 'projects', 'T--e2e', 'agsess.jsonl'),
    [line(toolResult(7, 'call_ag1', '审查完成：修复 3 处')), line(stop(8))].join('\n') + '\n');
  assert(await page.waitFor('(function(){return !document.querySelector(".agent-live")})()'), 'live-line gone once the result pairs');
  const out = await page.ev('(function(){var o=document.querySelector(".node[data-agent] .tool-out"); return o?o.textContent:""})()');
  assert(out.indexOf('审查完成') >= 0, 'agent result renders in the node (got "' + out + '")');

  // done agent keeps its 全文 entry: chip click reopens the bubble; the head
  // timer must read 已完成 and stay FROZEN (v115: it used to keep counting)
  await page.ev('(function(){var c=document.querySelector(".node[data-agent] .tool-chip"); c&&c.click()})()');
  assert(await page.waitFor('!document.getElementById("agent-sheet").classList.contains("hidden")'), 'chip reopens the bubble');
  assert(await page.waitFor('(function(){var s=document.getElementById("ag-st").textContent; return s.indexOf("已完成")>=0})()'), 'bubble head reads 已完成');
  const st1 = await page.ev('document.getElementById("ag-st").textContent');
  await new Promise((r) => setTimeout(r, 2300));
  const st2 = await page.ev('document.getElementById("ag-st").textContent');
  assert(st1 === st2, 'completed agent head timer frozen (got "' + st1 + '" then "' + st2 + '")');

  // ghost guard: the subagent file never became a session row
  const j = await (await api('/api/sessions')).json();
  assert(!j.sessions.some((s) => String(s.id).startsWith('agent-')), 'no ghost session row');
  assert(j.sessions.some((s) => s.id === 'agsess'), 'parent session present');
});
