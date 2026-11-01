// test/unit/agents.test.mjs - v112 subagent tracker: FIFO attribution (and
// the late-drain adoption path), completion signals (meta finished + parent
// tool_result), readEvents parsing with api-request-blob lines skipped, and
// the adapter ghost-session guard (agent transcripts must never register as
// sessions in the store).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentTracker } from '../../bridge/agents.js';
import { CcAdapter } from '../../bridge/adapter-cc.js';
import { Store } from '../../bridge/store.js';

const mkd = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ag-'));
const ts = (off) => new Date(Date.now() - 60_000 + off * 1000).toISOString();
const W = (p, objs) => fs.writeFileSync(p, objs.map((o) => JSON.stringify(o)).join('\n') + '\n');

const spawnUse = (id, desc) => ({ k: 'assistant', ts: ts(1), parts: [{ t: 'tool', name: 'Agent', id, v: JSON.stringify({ description: desc, prompt: 'p' }) }] });
const res = (id) => ({ k: 'toolres', ts: ts(9), items: [{ id, text: 'done', err: false, images: [] }] });

const agUser = (t) => ({ type: 'user', timestamp: t, message: { role: 'user', content: 'task prompt' } });
const agToolUse = (t, id, name, input) => ({ type: 'assistant', timestamp: t, message: { role: 'assistant', model: 'm', content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } });
const agToolRes = (t, id) => ({ type: 'user', timestamp: t, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'ok' }] }] } });

function trackerWithAgentFile() {
  const tmp = mkd();
  const sub = path.join(tmp, 'sess1', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const tr = new AgentTracker();
  const frames = [];
  tr.on('agent', (f) => frames.push(f));
  const agPath = path.join(sub, 'agent-aaa111.jsonl');
  W(agPath, [
    agUser(ts(2)),
    agToolUse(ts(3), 'st1', 'Read', { file_path: 'D:\\x\\README.md' }),
  ]);
  return { tmp, sub, tr, frames, agPath, metaPath: path.join(sub, 'agent-aaa111.meta.json') };
}

test('FIFO attribution: parent tool_use queued first, file takes it', () => {
  const { tr, frames, agPath } = trackerWithAgentFile();
  tr.onParentEvents('sess1', [spawnUse('call_1', '审查文档')]);
  assert.equal(tr.pending.get('sess1').length, 1);
  tr.touch(agPath);
  assert.equal(tr.pending.get('sess1').length, 0);
  const f = frames[frames.length - 1];
  assert.equal(f.toolUseId, 'call_1');
  assert.equal(f.desc, '审查文档');
  assert.equal(f.state, 'run');
  assert.equal(f.steps, 1);
  assert.ok(f.act.startsWith('Read'), 'act carries the tool name (got ' + f.act + ')');
  assert.equal(f.act, 'Read README.md', 'file paths collapse to the basename (got ' + f.act + ')');
  assert.ok(f.startedAt > 0, 'startedAt from the first line timestamp');
  assert.equal(f.finishedAt, 0, 'no completion moment while running');
});

test('late parent drain: file registered before the spawn id still gets adopted', () => {
  const { tr, frames, agPath } = trackerWithAgentFile();
  tr.touch(agPath); // file event beat the parent drain: no toolUseId yet
  assert.equal(frames[frames.length - 1].toolUseId, '');
  tr.onParentEvents('sess1', [spawnUse('call_1', '审查文档')]);
  const f = frames[frames.length - 1];
  assert.equal(f.toolUseId, 'call_1');
  assert.equal(f.desc, '审查文档');
});

test('meta.json with finished:true flips the agent to done', () => {
  const { tr, frames, agPath, metaPath } = trackerWithAgentFile();
  tr.onParentEvents('sess1', [spawnUse('call_1', '审查文档')]);
  tr.touch(agPath);
  W(metaPath, [{ agentType: 'general-purpose', description: '审查文档', toolUseId: 'call_1', spawnDepth: 1, requestShape: 'background', finished: true }]);
  tr.touch(metaPath);
  const f = frames[frames.length - 1];
  assert.equal(f.state, 'done');
  assert.equal(f.bg, true, 'requestShape background rides along');
  assert.ok(f.finishedAt > 0, 'completion moment recorded (timers freeze at it)');
  const s = tr.summariesFor('sess1');
  assert.ok(s[0].finishedAt > 0, 'summaries carry finishedAt too');
  // a second meta touch must not re-emit done
  const n = frames.length;
  tr.touch(metaPath);
  assert.equal(frames.filter((x) => x.state === 'done').length, 1);
  assert.ok(frames.length <= n + 1);
});

test('parent tool_result completes the agent even without meta', () => {
  const { tr, frames, agPath } = trackerWithAgentFile();
  tr.onParentEvents('sess1', [spawnUse('call_1', '审查文档')]);
  tr.touch(agPath);
  // replay of an OLD pair must net to zero (boot replay): queue+dequeue
  tr.onParentEvents('sess1', [spawnUse('call_old', '旧任务'), res('call_old')]);
  assert.equal(frames[frames.length - 1].state, 'run');
  tr.onParentEvents('sess1', [res('call_1')]);
  assert.equal(frames[frames.length - 1].state, 'done');
  assert.ok(frames[frames.length - 1].finishedAt > 0, 'toolres completion also records the moment');
});

test('readEvents: display events parsed, blob lines skipped, meta rides along', () => {
  const { tr, agPath } = trackerWithAgentFile();
  tr.onParentEvents('sess1', [spawnUse('call_1', '审查文档')]);
  tr.touch(agPath);
  fs.appendFileSync(agPath, [
    JSON.stringify({ type: 'api-request-blob', timestamp: ts(4), message: { role: 'user', content: 'x'.repeat(5000) } }),
    JSON.stringify(agToolRes(ts(5), 'st1')),
  ].join('\n') + '\n');
  const out = tr.readEvents('sess1', 'aaa111');
  assert.ok(out, 'readEvents resolves');
  assert.equal(out.agent.toolUseId, 'call_1');
  const kinds = out.events.map((e) => e.k).join(',');
  assert.equal(kinds, 'user,assistant,toolres', 'blob line produced no event (got ' + kinds + ')');
  assert.equal(out.total, 3);
  // wrong session or unknown agent -> null (route 404s)
  assert.equal(tr.readEvents('other', 'aaa111'), null);
  assert.equal(tr.readEvents('sess1', 'nope'), null);
});

test('summariesFor: only attributed agents, keyed for the messages fetch', () => {
  const { tr, agPath } = trackerWithAgentFile();
  tr.onParentEvents('sess1', [spawnUse('call_1', '审查文档')]);
  tr.touch(agPath);
  const s = tr.summariesFor('sess1');
  assert.equal(s.length, 1);
  assert.equal(s[0].toolUseId, 'call_1');
  assert.deepEqual(tr.summariesFor('nobody'), []);
});

test('adapter: subagent transcript never registers as a session (ghost guard)', async () => {
  const tmp = mkd();
  const root = path.join(tmp, 'projects');
  const proj = path.join(root, 'P--x');
  fs.mkdirSync(proj, { recursive: true });
  W(path.join(proj, 'sess1.jsonl'), [{ type: 'user', timestamp: ts(1), cwd: 'D:\\x', origin: { kind: 'human' }, message: { role: 'user', content: 'hi' } }]);
  const sub = path.join(proj, 'sess1', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  W(path.join(sub, 'agent-ghost1.jsonl'), [agUser(ts(2))]);

  const store = new Store();
  const ad = new CcAdapter(store, root, path.join(tmp, 'trash'), '');
  ad.start();
  await new Promise((r) => setTimeout(r, 1200)); // drain debounce 200ms + watch latency
  ad.stop();
  const ids = [...store.sessions.keys()];
  assert.ok(ids.includes('sess1'), 'parent session registered');
  assert.ok(!ids.some((i) => i.startsWith('agent-')), 'no ghost session (got ' + ids.join(',') + ')');
  assert.ok(ad.agents.agents.has('ghost1'), 'tracker holds the agent file');
  assert.equal(ad.agents.bySession.get('sess1')?.size, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------- v154: run_in_background launch-ack + meta-first ordering ----------
test('bg launch ack ("Async agent launched successfully") must NOT finish the agent', () => {
  const { tr, frames, agPath } = trackerWithAgentFile();
  tr.onParentEvents('sess1', [spawnUse('call_bg', '盘点端点')]);
  tr.touch(agPath);
  // the CLI acks the LAUNCH of a run_in_background agent with an immediate
  // tool_result - that is not a completion (v154 real-data find)
  tr.onParentEvents('sess1', [{ k: 'toolres', ts: ts(4), items: [{ id: 'call_bg', text: 'Async agent launched successfully. (This tool result is truncated...)', err: false, images: [] }] }]);
  let f = frames[frames.length - 1];
  assert.equal(f.state, 'run', 'launch ack keeps the agent running');
  assert.equal(f.finished, undefined, 'summary path: not finished either');
  const e = tr.agents.get('aaa111');
  assert.equal(e.finished, false);
  // real completion: meta.json rewrite with finished:true
  fs.writeFileSync(path.join(path.dirname(agPath), 'agent-aaa111.meta.json'),
    JSON.stringify({ description: '盘点端点', toolUseId: 'call_bg', requestShape: 'background' }));
  tr.touch(path.join(path.dirname(agPath), 'agent-aaa111.meta.json'));
  assert.equal(e.finished, false, 'launch-time meta (no finished key) still running');
  fs.writeFileSync(path.join(path.dirname(agPath), 'agent-aaa111.meta.json'),
    JSON.stringify({ description: '盘点端点', toolUseId: 'call_bg', requestShape: 'background', finished: true }));
  tr.touch(path.join(path.dirname(agPath), 'agent-aaa111.meta.json'));
  assert.equal(e.finished, true, 'meta rewrite finishes the bg agent');
  f = frames[frames.length - 1];
  assert.equal(f.state, 'done');
});

test('meta-first ordering: sibling meta read at _ensure fills desc/bg/toolUseId', () => {
  const { tr, frames, agPath, metaPath } = trackerWithAgentFile();
  // real failure shape: the parent chip v is briefJson-truncated past
  // description (long prompt) -> JSON.parse fails -> FIFO adopts with desc ''
  const truncUse = { k: 'assistant', ts: ts(1), parts: [{ t: 'tool', name: 'Agent', id: 'call_x', v: '{"description":"盘点 bri' }] };
  tr.onParentEvents('sess1', [truncUse]);
  // meta.json event arrives BEFORE the .jsonl event: _readMeta hits "no entry"
  fs.writeFileSync(metaPath, JSON.stringify({ description: '盘点 bridge/routes 端点', toolUseId: 'call_x', requestShape: 'background' }));
  tr.touch(metaPath);
  assert.equal(tr.agents.size, 0, 'meta alone registers nothing');
  // now the transcript lands: _ensure must re-read the sibling meta
  tr.touch(agPath);
  const e = tr.agents.get('aaa111');
  assert.equal(e.desc, '盘点 bridge/routes 端点', 'meta description recovered (chip was unparseable)');
  assert.equal(e.bg, true, 'requestShape background recovered');
  const f = frames[frames.length - 1];
  assert.equal(f.desc, '盘点 bridge/routes 端点');
});

test('parent turn stop finishes still-running bg agents (killed at CLI exit)', () => {
  const { tr, frames, agPath, metaPath } = trackerWithAgentFile();
  const truncUse = { k: 'assistant', ts: ts(1), parts: [{ t: 'tool', name: 'Agent', id: 'call_bg', v: '{"description":"盘点 bri' }] };
  tr.onParentEvents('sess1', [truncUse]);
  fs.writeFileSync(metaPath, JSON.stringify({ description: '盘点端点', toolUseId: 'call_bg', requestShape: 'background' }));
  tr.touch(agPath); // registers + reads sibling meta (bg=true)
  tr.onParentEvents('sess1', [{ k: 'toolres', ts: ts(4), items: [{ id: 'call_bg', text: 'Async agent launched successfully. agentId: aaa111', err: false, images: [] }] }]);
  let e = tr.agents.get('aaa111');
  assert.equal(e.finished, false, 'launch ack skipped for bg agent');
  // parent transcript stop marker (turn ended => CLI exited => agents killed)
  tr.onParentStop('sess1');
  assert.equal(e.finished, true, 'parent stop finishes the killed agent');
  assert.ok(e.finishedAt > 0);
  assert.equal(frames[frames.length - 1].state, 'done');
  // idempotent: a second stop must not re-emit
  const n = frames.length;
  tr.onParentStop('sess1');
  assert.equal(frames.length, n);
});
