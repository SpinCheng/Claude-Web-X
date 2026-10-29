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
