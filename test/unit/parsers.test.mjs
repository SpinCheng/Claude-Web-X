// test/unit/parsers.test.mjs - pure-function coverage for the transcript
// judgment pitfalls documented in CLAUDE.md (转录格式 section).
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyLine, fenceTitle, synthesizeFileDiff, taskPart, applyBoard, bindCreated, boardSnapshot, GOAL_CANCEL_DIRECTIVE } from '../../bridge/parsers-cc.js';

const run = (lines, rec = {}) => { // rec defaults to a seeded (empty) record like _ensureSession creates
  const events = []; const patch = { est: { tools: 0, think: 0, prose: 0 } };
  for (const o of lines) { const e = applyLine('s', o, patch, events, rec); if (e) events.push(e); }
  return { events, patch };
};
const user = (over = {}) => ({ type: 'user', timestamp: 't', cwd: 'D:\\x', origin: { kind: 'human' }, message: { role: 'user', content: 'hi' }, ...over });
const assistant = (parts) => ({ type: 'assistant', timestamp: 't', message: { role: 'assistant', model: 'glm-5.3', content: parts } });
const toolResultLine = (id, text, isError = false) => ({ type: 'user', timestamp: 't', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: [{ type: 'text', text }] }] } });
const costState = (i, o, usd) => ({ type: 'cost-state', modelUsage: { m: { inputTokens: i, outputTokens: o, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: usd } } });

test('human vs machine: tool_result with origin=null is machine (2.1.308)', () => {
  const { events } = run([user(), toolResultLine('t1', 'out'), user({ origin: null, message: { role: 'user', content: 'typed' } })]);
  assert.equal(events.filter((e) => e.k === 'user').length, 2);       // human + origin-null typed
  assert.equal(events.filter((e) => e.k === 'toolres').length, 1);    // result paired
});

test('phone-sent prompts (no origin, no tool_result) stay human', () => {
  const { events } = run([user({ origin: undefined, promptSource: 'sdk' })]);
  assert.equal(events[0].k, 'user');
  assert.equal(events[0].text, 'hi');
});

test('compaction summary folds to {k:compact,n}', () => {
  const { events } = run([user({ isCompactSummary: true, message: { role: 'user', content: 'x'.repeat(5000) } })]);
  assert.equal(events[0].k, 'compact');
  assert.equal(events[0].n, 5000);
});

test('skill body folds to {k:skill,name,n} - name = last path segment', () => {
  const body = 'Base directory for this skill: C:\\Users\\x\\.claude\\skills\\archify\n\n# Archify\nx';
  const { events } = run([user({ message: { role: 'user', content: [{ type: 'text', text: body }] } })]);
  assert.equal(events[0].k, 'skill');
  assert.equal(events[0].name, 'archify');
});

test('slash-command envelope normalizes to /name args', () => {
  const { events } = run([user({ message: { role: 'user', content: '<command-message>goal</command-message>\n<command-name>/goal</command-name>\n<command-args>do it</command-args>' } })]);
  assert.equal(events[0].text, '/goal do it');
});

test('local-command-caveat line folds out; caveat prefix is stripped (v110)', () => {
  const CAVEAT = '<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request. It' + String.fromCharCode(39) + 's recorded here as context.</local-command-caveat>';
  const a = run([user({ message: { role: 'user', content: CAVEAT } })]);
  assert.equal(a.events.length, 0, 'caveat-only line folds out entirely');
  const b = run([user({ message: { role: 'user', content: CAVEAT + 'real text' } })]);
  assert.equal(b.events[0].text, 'real text', 'caveat stripped when real text follows');
});

test('command stdout surfaces as cmdout; goal hook injection folds (v111)', () => {
  const a = run([user({ message: { role: 'user', content: '<local-command-stdout>Set model to ' + String.fromCharCode(96) + 'x' + String.fromCharCode(96) + '</local-command-stdout>' } })]);
  assert.equal(a.events[0].k, 'cmdout', 'user-line stdout carrier -> cmdout');
  assert.equal(a.events[0].text, 'Set model to ' + String.fromCharCode(96) + 'x' + String.fromCharCode(96));
  const b = run([{ type: 'system', subtype: 'local_command', timestamp: '2026-10-29T00:00:00.000Z', content: '<local-command-stdout>Goal set: do it</local-command-stdout>' }]);
  assert.equal(b.events[0].k, 'goal', 'v165: Goal set envelope -> goal event (cmdout-channel rendering upstream)');
  assert.equal(b.events[0].st, 'set');
  assert.equal(b.events[0].cond, 'do it');
  const c = run([user({ message: { role: 'user', content: 'A session-scoped Stop hook is now active with condition: "ok". Acknowledge.' } })]);
  assert.equal(c.events.length, 0, 'hook injection line never a human bubble');
});

test('prompt-type command expand body folds; local stdout disarms (v114)', () => {
  const ENV = '<command-message>x</command-message>\n<command-name>/x</command-name>\n<command-args></command-args>';
  const um = (t) => user({ timestamp: t, message: { role: 'user', content: t === 't2a' ? 'Say exactly: RAN' : t === 't2b' ? '<local-command-stdout>Set model to x</local-command-stdout>' : 'human msg ' + t } });
  // prompt-type (custom .md / init): envelope -> expanded template body
  const rec = {};
  const a = applyLine('s', user({ timestamp: 't1', message: { role: 'user', content: ENV } }), {}, [], rec);
  assert.equal(a.text, '/x', 'envelope normalized');
  assert.equal(rec._cmdEnv, true, 'armed');
  assert.equal(applyLine('s', um('t2a'), {}, [], rec), null, 'expanded body folds');
  assert.equal(applyLine('s', um('t3'), {}, [], rec).text, 'human msg t3', 'next human message survives');
  // local-type via USER stdout carrier (/model shape): stdout disarms
  const rec2 = {};
  applyLine('s', user({ timestamp: 't1', message: { role: 'user', content: ENV } }), {}, [], rec2);
  const so = applyLine('s', um('t2b'), {}, [], rec2);
  assert.equal(so.k, 'cmdout', 'stdout still surfaces');
  assert.equal(rec2._cmdEnv, false, 'stdout disarms the fold');
  assert.equal(applyLine('s', um('t3'), {}, [], rec2).text, 'human msg t3', 'human message not swallowed');
  // assistant also disarms
  const rec3 = {};
  applyLine('s', user({ timestamp: 't1', message: { role: 'user', content: ENV } }), {}, [], rec3);
  applyLine('s', assistant([{ type: 'text', text: 'done' }]), {}, [], rec3);
  assert.equal(applyLine('s', um('t9'), {}, [], rec3).text, 'human msg t9', 'assistant disarms');
});

test('CLI-injected [Image: source] turn is folded out', () => {
  const { events } = run([user({ message: { role: 'user', content: '[Image: source: C:\\t\\x.png]' } })]);
  assert.equal(events.length, 0);
});

test('2.1.308 [Image: original …] echo line (beside image tool_result) is folded out', () => {
  const marker = '[Image: original 1225x2322, displayed at 1055x2000. Multiply coordinates by 1.16 to map to original image.]';
  const { events } = run([user({ origin: null, message: { role: 'user', content: marker } })]);
  assert.equal(events.filter((e) => e.k === 'user').length, 0);
});

test('inline [Image: original …] marker in human text stays VERBATIM (v190 用户裁定：我的输入是文本)', () => {
  const marker = '[Image: original 1463x3000, displayed at 975x2000. Multiply coordinates by 1.50 to map to original image.]';
  const { events } = run([user({ origin: null, message: { role: 'user', content: '看看这张截图 ' + marker } })]);
  assert.equal(events[0].k, 'user');
  assert.equal(events[0].text, '看看这张截图 ' + marker);
  assert.equal(events[0].images, undefined);
});

test('marker-ONLY line folds even mid-word variants stay safe (anchored full machine format)', () => {
  const { events } = run([user({ message: { role: 'user', content: '这个格式是 [Image: original 1225x2322...] 对吧' } })]);
  assert.equal(events[0].k, 'user');
  assert.equal(events[0].text, '这个格式是 [Image: original 1225x2322...] 对吧');
});

// ---------- v191 结算速率（roadmap 05：Σout ÷ Σ间隔，分模型，随 cost-state 下发） ----------
const asstRate = (ts, model, out) => ({ type: 'assistant', timestamp: ts, message: { role: 'assistant', model, usage: { input_tokens: 10, output_tokens: out }, content: [{ type: 'text', text: 'ok' }] } });
const tsUser = (ts) => ({ type: 'user', timestamp: ts, origin: { kind: 'human' }, message: { role: 'user', content: 'go' } });
const tsToolRes = (ts, id) => ({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'r' }] }] } });
const ISO = (s) => '2026-11-05T00:00:' + String(s).padStart(2, '0') + '.000Z';

test('v191 settle rate: Σout ÷ Σinterval, chained base, rides cost-state stats', () => {
  const rec = {};
  const { events } = run([
    tsUser(ISO(0)),
    asstRate(ISO(10), 'm1', 120),      // 10s from the user line
    tsToolRes(ISO(30), 't1'),          // resets the base (tool_result carries ts)
    asstRate(ISO(45), 'm1', 180),      // 15s from the tool_result
    costState(1, 1, 0.01),
  ], rec);
  assert.deepEqual(rec._rate, { m1: { out: 300, ms: 25000 } });
  const st = events[events.length - 1];
  assert.equal(st.k, 'stats');
  assert.deepEqual(st.stats.rate, { out: 300, ms: 25000, models: { m1: { out: 300, ms: 25000 } } });
});

test('v191 settle rate: per-model buckets', () => {
  const rec = {};
  const { events } = run([
    tsUser(ISO(0)),
    asstRate(ISO(10), 'm1', 100),
    tsUser(ISO(20)),
    asstRate(ISO(35), 'm2', 200),
    costState(1, 1, 0.01),
  ], rec);
  assert.deepEqual(rec._rate, { m1: { out: 100, ms: 10000 }, m2: { out: 200, ms: 15000 } });
  const st = events[events.length - 1];
  assert.deepEqual(st.stats.rate.models, { m1: { out: 100, ms: 10000 }, m2: { out: 200, ms: 15000 } });
  assert.equal(st.stats.rate.out, 300);
  assert.equal(st.stats.rate.ms, 25000);
});

test('v191 settle rate: no-ts / zero-interval lines contribute nothing (no divide blowups)', () => {
  const rec = {};
  run([
    tsUser(ISO(0)),
    { type: 'assistant', message: { role: 'assistant', model: 'm1', usage: { input_tokens: 1, output_tokens: 999 }, content: [{ type: 'text', text: 'x' }] } }, // no ts
    asstRate(ISO(0), 'm1', 50),        // same ts as base -> zero interval, skip
    tsUser(ISO(1)),
    asstRate(ISO(11), 'm1', 70),       // the only contributor: 10s
    costState(1, 1, 0.01),
  ], rec);
  assert.deepEqual(rec._rate, { m1: { out: 70, ms: 10000 } });
});

test('v191 settle rate: no accumulation -> stats carry no rate key', () => {
  const { events } = run([user(), costState(1, 1, 0.01)]);
  const st = events[events.length - 1];
  assert.equal(st.stats.rate, undefined);
});

test('tool_use carries id (pairing key); toolres items extract text/err/images', () => {
  const { events } = run([
    assistant([{ type: 'tool_use', id: 'tu9', name: 'Bash', input: { command: 'ls' } }]),
    toolResultLine('tu9', 'fileA\nfileB', true),
  ]);
  const toolEv = events.find((e) => e.k === 'assistant');
  const toolPart = toolEv.parts.find((p) => p.t === 'tool');
  assert.equal(toolPart.id, 'tu9');
  const tr = events.find((e) => e.k === 'toolres');
  assert.equal(tr.items[0].id, 'tu9');
  assert.equal(tr.items[0].err, true);
  assert.ok(tr.items[0].text.includes('fileA'));
});

test('edit tool_use parts carry the changed-file delta f (v145)', () => {
  const big = 'x\n'.repeat(200); // input JSON far beyond the 300-char brief
  const { events } = run([
    assistant([
      { type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: 'D:\\e2e\\big.txt', content: big } },
      { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: 'D:\\e2e\\a.js', old_string: 'x\ny', new_string: 'x1' } },
      { type: 'tool_use', id: 'm1', name: 'MultiEdit', input: { file_path: 'D:\\e2e\\b.js', edits: [{ old_string: 'a', new_string: 'b\nc' }, { old_string: 'd\ne', new_string: 'f' }] } },
      { type: 'tool_use', id: 'n1', name: 'NotebookEdit', input: { notebook_path: 'D:\\e2e\\n.ipynb', new_source: 'q\nr\ns' } },
    ]),
  ]);
  const parts = events[0].parts.filter((p) => p.t === 'tool');
  assert.deepEqual(parts[0].f, [{ path: 'D:\\e2e\\big.txt', add: 201, del: 0 }], 'big Write counted despite truncated v');
  assert.ok(parts[0].v.length <= 305 && parts[0].v.endsWith('...'), 'chip text stays brief');
  assert.ok(!events[0].parts.some((p) => p.t === 'tool' && p.name === 'Bash' && p.f), 'Bash never carries f (sanity)');
  assert.deepEqual(parts[1].f, [{ path: 'D:\\e2e\\a.js', add: 1, del: 2 }]);
  assert.deepEqual(parts[2].f, [{ path: 'D:\\e2e\\b.js', add: 3, del: 3 }]);
  assert.deepEqual(parts[3].f, [{ path: 'D:\\e2e\\n.ipynb', add: 3, del: 0 }], 'notebook new_source counted');
});

test('synthesizeFileDiff builds chronological hunks from raw tool_use inputs (v146)', () => {
  const lines = [
    assistant([{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: 'D:\\e2e\\a.ts', old_string: 'x\ny', new_string: 'x1' } }]),
    { type: 'user', message: { role: 'user', content: 'noise line' } },
    assistant([
      { type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: 'D:\\E2E\\A.TS', content: 'full\nnew' } },
      { type: 'tool_use', id: 'o1', name: 'Edit', input: { file_path: 'D:\\e2e\\other.ts', old_string: 'q', new_string: 'r' } },
    ]),
  ];
  const txt = synthesizeFileDiff(lines, 'd:\\e2e\\a.ts');
  assert.ok(txt.startsWith('--- a/a.ts\n+++ b/a.ts'), 'file header');
  assert.ok(txt.indexOf('@@ Edit @@\n-x\n-y\n+x1') >= 0, 'edit hunk old->new');
  assert.ok(txt.indexOf('@@ Write · 全文 2 行 @@\n+full\n+new') >= 0, 'write = whole content as adds (case-insensitive match)');
  assert.ok(!txt.includes('other.ts'), 'other files excluded');
  assert.equal(synthesizeFileDiff(lines, 'd:\\e2e\\none.ts'), '', 'no match -> empty');
});

test('tool_result text is capped at 4000 chars', () => {
  const { events } = run([toolResultLine('t1', 'x'.repeat(9000))]);
  assert.ok(events[0].items[0].text.length < 4100);
  assert.ok(events[0].items[0].text.includes('截断'));
});

test('adjacent cost-state snapshots collapse to the LAST one; separated stay', () => {
  const adj = run([costState(100, 10, 1), costState(200, 20, 2)]);
  assert.equal(adj.events.length, 1);
  assert.equal(adj.events[0].stats.inTok, 200);
  const sep = run([costState(1, 1, 1), assistant([{ type: 'text', text: 'mid' }]), costState(2, 2, 2)]);
  assert.equal(sep.events.filter((e) => e.k === 'stats').length, 2);
});

test('cost-state keeps the per-model breakdown (v48 cost panel); aggregates unchanged', () => {
  const line = { type: 'cost-state', modelUsage: {
    sonnet: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 500, cacheCreationInputTokens: 20, costUSD: 0.4 },
    opus: { inputTokens: 200, outputTokens: 30, cacheReadInputTokens: 700, cacheCreationInputTokens: 40, costUSD: 1.6 },
  } };
  const { patch } = run([line]);
  assert.equal(patch.cost.inTok, 300);
  assert.equal(patch.cost.usd, 2);
  assert.equal(patch.cost.models.sonnet.usd, 0.4);
  assert.equal(patch.cost.models.opus.inTok, 200);
  assert.equal(patch.cost.models.opus.cacheRead, 700);
});

test('stop-ish system subtypes emit the stop marker + map outcomes', () => {
  for (const [subtype, outcome] of [['interrupt', 'stopped'], ['error', 'failed'], ['stop', 'ok']]) {
    const { events, patch } = run([{ type: 'system', subtype }]);
    assert.equal(events[0].k, 'stop');
    assert.equal(patch.lastOutcome, outcome);
  }
});

test('assistant line is the ONLY source of the display model label; cost-state never overwrites', () => {
  const { patch } = run([
    assistant([{ type: 'text', text: 'a' }]),
    costState(1, 1, 1),
  ]);
  assert.equal(patch.model, 'glm-5.3');
});

test('first human message seeds the fallback title (first line, 24-cap, ellipsis)', () => {
  const { patch } = run([user({ message: { role: 'user', content: 'line one keeps going well past twenty-four chars\nline two ignored' } })]);
  assert.equal(patch.titleFallback, true);
  assert.equal(patch.title, 'line one keeps going wel…');
  const { patch: p2 } = run([user({ message: { role: 'user', content: 'short q' } })]);
  assert.equal(p2.title, 'short q');
});

// regression: the step-4 extraction left an undefined rec0 in the usage
// derivation below - fixtures without message.usage never executed it and
// the crash only surfaced on real transcripts (production bridge down)
test('assistant usage derives usageFirst/fixedTok without crashing', () => {
  const asstUsage = (parts) => ({ type: 'assistant', timestamp: 't', message: { role: 'assistant', model: 'glm-5.3', content: parts, usage: { input_tokens: 1000, cache_read_input_tokens: 2000, cache_creation_input_tokens: 500, output_tokens: 50 } } });
  const { patch } = run([user({ message: { role: 'user', content: 'hello world question' } }), asstUsage([{ type: 'text', text: 'a' }])]);
  assert.equal(patch.usage.in, 1000);
  assert.equal(patch.usage.cacheRead, 2000);
  assert.equal(patch.usageFirst, 3500);
  assert.ok(patch.fixedTok > 0);
});

test('usage derivation also works with a pre-seeded record (second run)', () => {
  const asstUsage = { type: 'assistant', timestamp: 't', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'a' }], usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } };
  const { patch } = run([asstUsage], { usageFirst: 999, firstUserChars: 10 }); // rec snapshot
  assert.equal(patch.usageFirst, undefined); // already known: not re-derived
});

// v39: blank/malformed custom-title records must not blank the current title
test('custom-title with a blank value is ignored', () => {
  const { patch } = run([user({ message: { role: 'user', content: 'seed question here' } }), { type: 'custom-title' }, { type: 'custom-title', customTitle: '' }]);
  assert.equal(patch.title, 'seed question here');
});

// v39: phone-rename write-fence classification (Desktop re-emits its cached
// pre-rename title in metadata flushes and reverts phone renames)
test('fenceTitle: stale prev is swallowed, real news disarms, matches pass', () => {
  const pin = { title: '新名字', prev: '旧名字' };
  assert.equal(fenceTitle(pin, '旧名字'), 'stale');
  assert.equal(fenceTitle(pin, '桌面端起的名'), 'disarm');
  assert.equal(fenceTitle(pin, '新名字'), null);   // desktop caught up: no action
  assert.equal(fenceTitle(null, '旧名字'), null);  // no pin armed
  assert.equal(fenceTitle(pin, undefined), null);  // not a title record
  assert.equal(fenceTitle(pin, ''), null);         // malformed blank
});

// v41c: cwd rides on ANY line type (system/local_command sidecars carry it
// too) - a transcript without user lines must still group by its project
test('cwd is harvested from non-user lines (ctxprobe sidecar shape)', () => {
  const { patch } = run([
    { type: 'mode', sessionId: 's' },
    { type: 'permission-mode', sessionId: 's', permissionMode: 'default' },
    { type: 'system', subtype: 'local_command', isSidechain: true, cwd: 'D:\\x\\y', timestamp: 't' },
    { type: 'cost-state', modelUsage: {} },
  ]);
  assert.equal(patch.cwd, 'D:\\x\\y');
});

// ---------- v154: 待办板（Task* / TodoWrite） ----------
const tbTool = (name, input, id = 'tu1') => assistant([{ type: 'tool_use', id, name, input }]);

test('taskPart: family shapes pinned to the 2.1.308 binary schema', () => {
  assert.deepEqual(taskPart('TodoWrite', { todos: [{ content: 'a', status: 'completed', activeForm: '正在 a' }, { content: 'b' }] }),
    { g: 'w', items: [{ s: 'a', st: 'completed', af: '正在 a' }, { s: 'b', st: 'pending', af: '' }] });
  assert.deepEqual(taskPart('TaskCreate', { subject: 'x', description: 'd', activeForm: 'f' }),
    { g: 'c', s: 'x', d: 'd', af: 'f' });
  assert.deepEqual(taskPart('TaskUpdate', { taskId: 3, status: 'in_progress' }),
    { g: 'u', id: '3', st: 'in_progress', s: '', af: '' });
  assert.equal(taskPart('TaskList', {}), null, 'TaskList 不解析');
  assert.equal(taskPart('TaskGet', { taskId: 1 }), null, 'TaskGet 不解析');
  assert.equal(taskPart('TodoWrite', { todos: 'x' }), null);
  assert.equal(taskPart('TaskCreate', { description: 'no subject' }), null);
});

test('applyLine: tb rides the tool part (v145 f:[] precedent)', () => {
  const { events } = run([tbTool('TodoWrite', { todos: [{ content: 'a', status: 'pending' }] })]);
  const part = events[0].parts[0];
  assert.deepEqual(part.tb, { g: 'w', items: [{ s: 'a', st: 'pending', af: '' }] });
  assert.equal(part.f, undefined, '非编辑工具无 f');
  assert.ok(part.v.length > 0);
});

test('board: TodoWrite overwrite -> TaskCreate -> bindCreated -> TaskUpdate lifecycle', () => {
  const b = { items: [], n: 0, total: 0, _pend: [] };
  assert.equal(applyBoard(b, taskPart('TodoWrite', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] })), true);
  assert.equal(b.n + '/' + b.total, '1/2');
  assert.equal(applyBoard(b, taskPart('TaskCreate', { subject: 'c' }), 'tu9'), true);
  assert.equal(b.total, 3);
  assert.equal(bindCreated(b, 'tu9', 'Created task #3: c'), true);
  assert.equal(b.items[2].id, '3', 'create 的 id 从 tool_result 文本绑回');
  assert.equal(applyBoard(b, taskPart('TaskUpdate', { taskId: 3, status: 'in_progress' })), true);
  assert.equal(b.items[2].st, 'in_progress');
  assert.equal(applyBoard(b, taskPart('TaskUpdate', { taskId: 3, status: 'completed' })), true);
  assert.equal(b.n, 2);
  // 真实枚举无 cancelled：deleted=移出板
  assert.equal(applyBoard(b, taskPart('TaskUpdate', { taskId: 3, status: 'deleted' })), true);
  assert.equal(b.total, 2);
  // 未绑定 id -> 占位行；未知状态 -> 灰显（计入分母）
  assert.equal(applyBoard(b, taskPart('TaskUpdate', { taskId: 9, status: 'in_progress' })), true);
  assert.equal(b.items[b.items.length - 1].s, '任务 #9');
  applyBoard(b, taskPart('TaskUpdate', { taskId: 9, status: 'weird' }));
  assert.equal(b.items[b.items.length - 1].st, 'weird');
  // 快照剥内部字段
  const snap = boardSnapshot(b);
  assert.equal(snap.total, b.total);
  assert.equal('_pend' in snap, false);
  assert.deepEqual(snap.items[0], { id: '', s: 'a', st: 'completed', af: '' });
});

test('v203 board: all-completed batch then new TaskCreate starts a fresh cycle', () => {
  const b = { items: [], n: 0, total: 0, _pend: [] };
  applyBoard(b, taskPart('TaskCreate', { subject: 'old1' }), 'tu1');
  applyBoard(b, taskPart('TaskCreate', { subject: 'old2' }), 'tu2');
  bindCreated(b, 'tu1', 'Created task #1: old1');
  bindCreated(b, 'tu2', 'Created task #2: old2');
  applyBoard(b, taskPart('TaskUpdate', { taskId: 1, status: 'completed' }));
  applyBoard(b, taskPart('TaskUpdate', { taskId: 2, status: 'completed' }));
  assert.equal(b.n + '/' + b.total, '2/2', 'batch fully done');
  // new batch: history completed items leave the board
  applyBoard(b, taskPart('TaskCreate', { subject: 'new1' }), 'tu3');
  assert.equal(b.total, 1, 'old completed items cleared');
  assert.equal(b.n, 0);
  assert.equal(b.items[0].s, 'new1');
  // partial batch (one still pending): new create = same batch, nothing cleared
  const b2 = { items: [], n: 0, total: 0, _pend: [] };
  applyBoard(b2, taskPart('TaskCreate', { subject: 'x1' }), 'a1');
  applyBoard(b2, taskPart('TaskCreate', { subject: 'x2' }), 'a2');
  bindCreated(b2, 'a1', 'Created task #1: x1');
  bindCreated(b2, 'a2', 'Created task #2: x2');
  applyBoard(b2, taskPart('TaskUpdate', { taskId: 1, status: 'completed' }));
  applyBoard(b2, taskPart('TaskCreate', { subject: 'x3' }), 'a3');
  assert.equal(b2.total, 3, 'partial batch keeps its items');
  assert.equal(b2.n, 1);
});

test('v158: synthetic "No response requested." sentinel folds out', () => {
  // kill-path bookkeeping: assistant line whose only content is the sentinel
  const a = run([assistant([{ type: 'text', text: 'No response requested.' }])]);
  assert.equal(a.events.length, 0, 'sentinel-only assistant line folds entirely');
  // resume-patch shape seen in real transcripts: sentinel carries usage too
  const b = run([{ type: 'assistant', timestamp: 't', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }], usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } } }]);
  assert.equal(b.events.length, 0);
  // a real reply that merely contains the phrase still renders
  const c = run([assistant([{ type: 'text', text: 'The user said "No response requested." to me.' }])]);
  assert.equal(c.events.length, 1);
  assert.equal(c.events[0].parts[0].v, 'The user said "No response requested." to me.');
  // sentinel + real thinking in one turn: thinking survives, text part dropped
  const d = run([assistant([{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'No response requested.' }])]);
  assert.equal(d.events.length, 1);
  assert.deepEqual(d.events[0].parts.map((p) => p.t), ['think']);
});

test('v158: agent-wait block-reason injection folds out', () => {
  const a = run([user({ message: { role: 'user', content: '[agent-wait] 还有 2 个后台代理在运行。不要结束本轮：用 TaskOutput 轮询等待它们全部完成（不要提前结束、不要输出总结），全部完成后再继续任务。' } })]);
  assert.equal(a.events.length, 0, 'hook block reason is machine text, folded');
  const b = run([user({ message: { role: 'user', content: '[agent-wait] 前缀相同的普通消息也可能存在吗？' } })]);
  assert.equal(b.events.length, 0, 'prefix fold is intentional (fixed sentinel wording)');
  const c = run([user({ message: { role: 'user', content: '普通消息提到 agent-wait 但不是行首标记' } })]);
  assert.equal(c.events.length, 1, 'human message untouched');
});

test('v162: /goal Stop-hook feedback envelope folds out', () => {
  const fb = 'Stop hook feedback:\n[安排2个subagent搜索新闻并汇总html报告]: 条件未满足：两个 subagent 的启动均被中断。目标中的搜索、汇总、HTML 报告、核实交付均未发生。';
  const a = run([user({ message: { role: 'user', content: fb } })]);
  assert.equal(a.events.length, 0, 'goal-keeper verdict is machine text, folded');
  const b = run([user({ message: { role: 'user', content: 'Stop hook feedback 讨论一下这个词的翻译' } })]);
  assert.equal(b.events.length, 1, 'human message mentioning the phrase stays');
});

// ---------- v165: goal 生命周期（cmdout 通道版） ----------
const goalAtt = (over = {}) => ({ type: 'attachment', timestamp: 't', attachment: { type: 'goal_status', met: false, condition: '汇总新闻为报告', ...over } });
const goalCmd = () => ({ type: 'system', subtype: 'local_command', timestamp: 't', content: '<local-command-stdout>Goal set: 汇总新闻为报告</local-command-stdout>' });
const holdLine = (cond, verdict) => user({ message: { role: 'user', content: 'Stop hook feedback:\n[' + cond + ']: ' + verdict } });

test('v165: goal set via cmdout envelope; sentinel behind it dedupes to null', () => {
  const rec = {};
  const a = applyLine('s', goalCmd(), {}, [], rec);
  assert.deepEqual(a, { k: 'goal', ts: 't', st: 'set', cond: '汇总新闻为报告' });
  const b = applyLine('s', goalAtt({ sentinel: true }), {}, [], rec);
  assert.equal(b, null, 'v165b: sentinel after the cmdout envelope only sets state (no duplicate bubble)');
});

test('v165: interrupt on stop-while-live; resume on next human message arms the first-round hold', () => {
  const rec = {};
  applyLine('s', goalCmd(), {}, [], rec);
  // 常规检查行：静默
  assert.equal(applyLine('s', goalAtt({}), {}, [], rec), null);
  // 拦停反馈（未恢复过）：静默折叠（用户裁定：仅恢复后首轮显示）
  assert.equal(applyLine('s', holdLine('汇总新闻为报告', '搜集未完成'), {}, [], rec), null);
  // 停机 → 中断
  const evs = [];
  const r = applyLine('s', { type: 'system', subtype: 'stop_hook_summary', timestamp: 't2' }, {}, evs, rec);
  assert.equal(evs[0] && evs[0].k, 'stop');
  assert.equal(r.st, 'interrupted');
  // 恢复（新契约）：goal 活着时来了新的人话消息 → resumed + 武装
  const evs2 = [];
  const u = applyLine('s', user({ message: { role: 'user', content: '你好' } }), {}, evs2, rec);
  assert.equal(u.k, 'user', 'the human bubble still returns normally');
  const r2 = evs2.find((e) => e.k === 'goal');
  assert.ok(r2 && r2.st === 'resumed', 'resume rides the events array before the user bubble');
  // 首轮拦停：显示一次
  const h = applyLine('s', holdLine('汇总新闻为报告', '此前代理启动被中断'), {}, [], rec);
  assert.equal(h.k, 'goalhold');
  assert.equal(h.cond, '汇总新闻为报告');
  // 后续拦停：回到静默
  assert.equal(applyLine('s', holdLine('汇总新闻为报告', '仍在进行'), {}, [], rec), null);
});

test('v165: tombstone=stopped; met; failed; cond 全文透传（不折叠）', () => {
  const rec = {};
  applyLine('s', goalCmd(), {}, [], rec);
  const s = applyLine('s', goalAtt({ met: true, note: 'cancelled by user (claude-web stop)' }), {}, [], rec);
  assert.equal(s.st, 'stopped');
  applyLine('s', goalCmd(), {}, [], rec);
  const m = applyLine('s', goalAtt({ met: true }), {}, [], rec);
  assert.equal(m.st, 'met');
  const f = applyLine('s', goalAtt({ failed: true }), {}, [], rec);
  assert.equal(f.st, 'failed');
});

test('v165b: sentinel dedupes behind the cmdout envelope; silent-kill resume via user message', () => {
  const rec = {};
  const run2 = (lines) => { const evs = []; const patch = { est: { tools: 0, think: 0, prose: 0 } }; for (const o of lines) { const e = applyLine('s', o, patch, evs, rec); if (e) evs.push(e); } return evs; };
  // cmdout 信封在前、sentinel 在后：只发一条 set
  const a = run2([goalCmd(), goalAtt({ sentinel: true })]);
  assert.equal(a.filter((e) => e.k === 'goal' && e.st === 'set').length, 1, 'cmdout envelope owns the set event');
  // sentinel 单独出现（无 cmdout，异常驱动）：v178 起只置状态不展示
  const rec2 = {};
  const b = (() => { const evs = []; const patch = { est: { tools: 0, think: 0, prose: 0 } }; const e = applyLine('s', goalAtt({ sentinel: true }), patch, evs, rec2); if (e) evs.push(e); return evs; })();
  assert.equal(b.length, 0, 'v178: sentinel alone tracks state, no display event');
  // /goal 信封行本身：不触发恢复
  const c = run2([user({ message: { role: 'user', content: '/goal 汇总新闻为报告' } })]);
  assert.equal(c.filter((e) => e.k === 'goal' && e.st === 'resumed').length, 0);
  // 静默被杀（无 stop 行）后新的人话消息：恢复 + 武装首轮拦停
  const d = run2([user({ message: { role: 'user', content: '你好' } })]);
  assert.equal(d.filter((e) => e.k === 'goal' && e.st === 'resumed').length, 1, 'silent-kill resume fires on the next human message');
  const h = run2([user({ message: { role: 'user', content: 'Stop hook feedback:\n[汇总新闻为报告]: 此前中断' } })]);
  // 注意：拦停反馈行不是人话（已折目标 hold 分支）——但此处它先被 hold 匹配：
  assert.equal(h.filter((e) => e.k === 'goalhold').length, 1, 'armed hold shows once');
});

test('v173: Stop hook feedback folds at PREFIX level (agent-wait shape included)', () => {
  const rec = {};
  applyLine('s', { type: 'system', subtype: 'local_command', timestamp: 't', content: '<local-command-stdout>Goal set: g</local-command-stdout>' }, {}, [], rec);
  const evs = [];
  applyLine('s', user({ message: { role: 'user', content: 'hi' } }), {}, evs, rec); // resume -> armed
  const leak = 'Stop hook feedback:\n[agent-wait] 还有 2 个后台代理在运行。不要结束本轮：用 TaskOutput 轮询等待它们全部完成。';
  const r = applyLine('s', user({ message: { role: 'user', content: leak } }), {}, [], rec);
  assert.equal(r, null, 'agent-wait shape (no bracket-colon) folds - never a bubble');
  const structured = 'Stop hook feedback:\n[g]: 条件未满足';
  const r2 = applyLine('s', user({ message: { role: 'user', content: structured } }), {}, [], rec);
  assert.equal(r2.k, 'goalhold', 'armed + structured shape still upgrades');
});

test('v175: user-voice cancel directive folds by exact full-string match', () => {
  const a = run([user({ message: { role: 'user', content: GOAL_CANCEL_DIRECTIVE } })]);
  assert.equal(a.events.length, 0, 'the authored constant folds - never a bubble');
  const b = run([user({ message: { role: 'user', content: '先到这里：开头相似但不完全相同的消息正常显示' } })]);
  assert.equal(b.events.length, 1, 'only the exact authored string folds');
});

test('v177: post-cancel ghost goal events are suppressed; a new /goal re-arms', () => {
  const rec = {};
  const seq = [
    goalCmd(),                                                  // set (cmdout)
    goalAtt({}),                                                // silent check line
    { type: 'system', subtype: 'stop_hook_summary', timestamp: 't2' }, // stop while live -> interrupted
    goalAtt({ met: true, note: 'cancelled by user (claude-web stop)' }), // tombstone -> stopped + arm suppression
    goalAtt({}),                                                // GHOST: hook's non-sentinel check -> silent
    user({ message: { role: 'user', content: '现在几点' } }),      // would-be resume -> no marker
    goalAtt({ met: true }),                                     // GHOST verdict met -> silent
    goalCmd(),                                                  // NEW /goal (cmdout path) -> re-armed set
  ];
  const evs = []; const patch = { est: { tools: 0, think: 0, prose: 0 } };
  for (const o of seq) { const e = applyLine('s', o, patch, evs, rec); if (e) evs.push(e); }
  const g = evs.filter((e) => e.k === 'goal');
  assert.deepEqual(g.map((e) => e.st), ['set', 'interrupted', 'stopped', 'set'],
    'ghost checks/resume/met suppressed; new sentinel re-arms');
  assert.equal(rec._goalCancelled, false, 'new goal cleared the flag');
});

test('v178: cmdout is the sole set display source - position rides the command bubble', () => {
  const rec = {};
  const evs = []; const patch = { est: { tools: 0, think: 0, prose: 0 } };
  const seq = [
    goalAtt({ sentinel: true }),   // CLI writes the sentinel BEFORE the command bubble
    user({ message: { role: 'user', content: '/goal 汇总新闻' } }), // the command bubble
    { type: 'system', subtype: 'local_command', timestamp: 't', content: '<local-command-stdout>Goal set: 汇总新闻</local-command-stdout>' }, // stdout right after
  ];
  for (const o of seq) { const e = applyLine('s', o, patch, evs, rec); if (e) evs.push(e); }
  // exactly ONE set event and it comes AFTER the user bubble (correct position)
  const setIdx = evs.findIndex((e) => e.k === 'goal');
  const userIdx = evs.findIndex((e) => e.k === 'user');
  assert.equal(evs.filter((e) => e.k === 'goal').length, 1, 'single set event');
  assert.ok(setIdx > userIdx, 'set event renders BELOW the /goal command bubble');
  // sentinel alone (no cmdout) tracks state but displays nothing
  const rec2 = {};
  const r2 = applyLine('s', goalAtt({ sentinel: true }), {}, [], rec2);
  assert.equal(r2, null, 'sentinel alone: state only, no display');
  assert.equal(rec2._goalLive, true, 'but goal is tracked live for the panel');
});

// ---------- v197: 代附/附件回显附录折叠（v208 起附录无围栏；围栏=旧形态兼容） ----------
test('v197: @-ref appendix folds to an attref marker; tags+prose stay the bubble text', () => {
  const { events } = run([user({ message: { role: 'user', content: '@foo.js @bar.md 看看\n\n[引用 @foo.js]\n```\nbody\n```\n\n[引用 @bar.md]\n```\nmore\n```' } })]);
  const u = events.find((e) => e.k === 'user');
  const m = events.find((e) => e.k === 'attref');
  assert.ok(u && m, 'user event + marker both present');
  assert.equal(events.indexOf(u) < events.indexOf(m), true, 'marker renders below the bubble');
  assert.equal(u.text, '@foo.js @bar.md 看看', 'exact tags+prose = optimistic-twin-precise');
  assert.deepEqual(m.files, ['@foo.js', '@bar.md']);
});

test('v208: fenceless appendix (label + blank line + raw text) folds identically', () => {
  const { events } = run([user({ message: { role: 'user', content: '@a.md 看看\n\n[引用 @a.md]\n\n# 标题\n\n- 列表项\n正文带 markdown，无围栏不破坏结构' } })]);
  const u = events.find((e) => e.k === 'user');
  const m = events.find((e) => e.k === 'attref');
  assert.ok(u && m, 'both events');
  assert.equal(u.text, '@a.md 看看');
  assert.deepEqual(m.files, ['@a.md']);
});

test('v197: upload labels ride along (incl. the saved-to variant, name trimmed)', () => {
  const { events } = run([user({ message: { role: 'user', content: '看图\n\n[附件 shot.png 已保存到 D:\\up\\x.png，可用 Read 查看]\n\n[引用 @notes.md]\n```\nn\n```' } })]);
  const m = events.find((e) => e.k === 'attref');
  assert.deepEqual(m.files, ['shot.png', '@notes.md']);
});

test('v197: marker inline in prose (no blank-line prefix) stays verbatim', () => {
  const { events } = run([user({ message: { role: 'user', content: '引用格式长这样\n[引用 @x]\n别折我' } })]);
  assert.equal(events.filter((e) => e.k === 'attref').length, 0, 'not machine appendix shape');
  assert.equal(events[0].text, '引用格式长这样\n[引用 @x]\n别折我');
});
