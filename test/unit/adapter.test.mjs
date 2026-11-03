// test/unit/adapter.test.mjs - rename write-fence live-gating (v40c): the pin
// must survive boot/readTranscript replays of HISTORICAL custom-title lines
// (older renames, CLI test values); only lines arriving on a live drain may
// disarm it. Production bug this locks in: the 16:54 boot replay disarmed the
// 16:49 pin via a day-old "new" line and the title reverted again.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CcAdapter } from '../../bridge/adapter-cc.js';
import { Store } from '../../bridge/store.js';
import { GOAL_CANCEL_DIRECTIVE } from '../../bridge/parsers-cc.js';

// renamesPath='' keeps pins in memory (no fs writes); store.get returns a
// minimal record like the one _ensureSession seeds.
const mkAdapter = () => new CcAdapter({ get: () => ({ title: '旧', lines: 1 }) }, 'Z:\\nonexistent', '', '');

const titleLine = (t) => ({ type: 'custom-title', customTitle: t });

test('fence: historical replay never disarms the pin and never wins the title', () => {
  const a = mkAdapter();
  a.renames.set('s', { title: '新', prev: '旧' });
  const patch = {};
  // a day-old test value that is neither pin.title nor pin.prev
  a._applyLine('s', titleLine('更老'), patch, [], false);
  assert.ok(a.renames.has('s'), 'pin must survive historical replay');
  assert.equal(patch.title, '新', 'historical value must not win the title');
});

test('fence: historical stale echo is swallowed (title pinned)', () => {
  const a = mkAdapter();
  a.renames.set('s', { title: '新', prev: '旧' });
  const patch = {};
  const ev = a._applyLine('s', titleLine('旧'), patch, [], false);
  assert.ok(a.renames.has('s'));
  assert.equal(patch.title, '新');
  assert.equal(ev.title, '新');
});

test('fence: live drain with a genuinely new value disarms (real desktop rename)', () => {
  const a = mkAdapter();
  a.renames.set('s', { title: '新', prev: '旧' });
  const patch = {};
  a._applyLine('s', titleLine('桌面新名'), patch, [], true);
  assert.ok(!a.renames.has('s'), 'live unknown value = genuine rename, pin released');
  assert.equal(patch.title, '桌面新名');
});

test('fence: live stale echo still swallowed', () => {
  const a = mkAdapter();
  a.renames.set('s', { title: '新', prev: '旧' });
  const patch = {};
  a._applyLine('s', titleLine('旧'), patch, [], true);
  assert.ok(a.renames.has('s'));
  assert.equal(patch.title, '新');
});

test('v162: appendGoalTombstone writes a met goal_status the restore logic yields to', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-goal-'));
  const tp = path.join(tmp, 's.jsonl');
  const anchor = '11111111-0000-4000-8000-0000000000aa';
  fs.writeFileSync(tp, JSON.stringify({ type: 'user', uuid: anchor, message: { role: 'user', content: 'hi' } }) + '\n'
    + JSON.stringify({ type: 'api-request-shape', payload: 'x'.repeat(70 * 1024) }) + '\n');
  const store = { get: () => ({ transcriptPath: tp }), upsert() {}, drop() {} };
  const a = new CcAdapter(store, 'Z:\\nonexistent', '', '');
  assert.equal(a.appendGoalTombstone('s'), true);
  const ls = fs.readFileSync(tp, 'utf8').split('\n').filter(Boolean);
  const o = JSON.parse(ls[ls.length - 2]); // v174: tombstone, then the directive
  assert.equal(o.type, 'attachment');
  assert.equal(o.attachment.type, 'goal_status');
  assert.equal(o.attachment.met, true, 'met=true makes the CLI goal-restore (xun) give up');
  assert.ok(o.uuid && o.uuid.length === 36, 'tombstone is linked into the CLI history');
  assert.equal(o.sessionId, 's');
  assert.equal(o.parentUuid, anchor, 'finds the UUID before a >64KB uuid-less transcript row');
  // no-newline tail gets repaired (appendTitle discipline)
  fs.writeFileSync(tp, JSON.stringify({ type: 'user', uuid: anchor, message: { role: 'user', content: 'x' } })); // no trailing \n
  a.appendGoalTombstone('s');
  const lines = fs.readFileSync(tp, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 3, 'previous line not concatenated (tombstone + directive appended)');
  assert.equal(JSON.parse(lines[1]).attachment.type, 'goal_status');
});

test('v174: appendGoalTombstone also writes the model-visible cancellation directive', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-gc-'));
  const tp = path.join(tmp, 's.jsonl');
  fs.writeFileSync(tp, JSON.stringify({ type: 'user', uuid: '11111111-0000-4000-8000-0000000000aa', message: { role: 'user', content: 'hi' } }) + '\n');
  const store = { get: () => ({ transcriptPath: tp }), upsert() {}, drop() {} };
  const a = new CcAdapter(store, 'Z:\nonexistent', '', '');
  a.appendGoalTombstone('s');
  const lines = fs.readFileSync(tp, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 3, 'original + tombstone + directive');
  assert.equal(JSON.parse(lines[1]).attachment.type, 'goal_status');
  assert.equal(JSON.parse(lines[1]).parentUuid, JSON.parse(lines[0]).uuid, 'tombstone chains to the preceding transcript row');
  const d = JSON.parse(lines[2]);
  assert.equal(d.type, 'user');
  assert.equal(d.message.content, GOAL_CANCEL_DIRECTIVE, 'v176: user-voice directive, exact authored constant');
  assert.ok(d.uuid && d.uuid.length === 36, 'v176: uuid present - uuid-less lines are DROPPED by the CLI context builder');
  assert.equal(d.parentUuid, JSON.parse(lines[1]).uuid, 'directive chains to the tombstone');
  assert.equal(d.sessionId, 's');
  assert.equal(d.isMeta, true, 'cancellation is injected as control metadata, not a new user utterance');
});

test('v180: goalLiveFor reads the parser flag on the record (window-proof)', () => {
  const recs = new Map();
  const store = { get: (id) => recs.get(id), upsert(p) { recs.set(p.id, { ...recs.get(p.id), ...p }); }, drop(id) { recs.delete(id); } };
  const a = new CcAdapter(store, 'Z:\\nonexistent', '', '');
  assert.equal(a.goalLiveFor('s'), false, 'no record -> not live');
  recs.set('s', { transcriptPath: 'x', _goalLive: true });
  assert.equal(a.goalLiveFor('s'), true, 'parser flag true -> live');
  recs.set('s', { transcriptPath: 'x', _goalLive: false });
  assert.equal(a.goalLiveFor('s'), false);
});

// v184: readTranscript replays the file from zero - it must run on a SCRATCH
// record, not the live one. The live record's cross-line flags describe the
// file's END state; inheriting them fired a ghost goal 'resumed' on the first
// user line predating the /goal (and armed _goalHoldArmed on the live record)
// every time the detail view re-read the transcript.
test('v184: readTranscript replays on a scratch record (no goal ghost, no live-flag writes)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ghost-'));
  const proj = path.join(tmp, 'projects', 'T--e2e');
  fs.mkdirSync(proj, { recursive: true });
  const tp = path.join(proj, 'cm3.jsonl');
  const now = new Date().toISOString();
  const lines = [
    // plain human line BEFORE the /goal: the ghost fired exactly here
    { type: 'user', timestamp: now, cwd: tmp, origin: { kind: 'human' }, message: { role: 'user', content: 'goal 测试' } },
    { type: 'user', timestamp: now, cwd: tmp, message: { role: 'user', content: '<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>回复ok</command-args>' } },
    { type: 'system', subtype: 'local_command', timestamp: now, content: '<local-command-stdout>Goal set: 回复ok</local-command-stdout>' },
    { type: 'user', timestamp: now, cwd: tmp, message: { role: 'user', content: 'A session-scoped Stop hook is now active with condition: "回复ok". Briefly acknowledge the goal.' } },
    { type: 'system', timestamp: now, subtype: 'stop' },
  ];
  fs.writeFileSync(tp, lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
  const store = new Store();
  const a = new CcAdapter(store, path.join(tmp, 'projects'), path.join(tmp, 'trash'), '');
  a._ensureSession(tp, 'T--e2e'); // boot backfill, same path watch discovery takes
  assert.equal(store.get('cm3')._goalLive, true, 'drains own the live flags');
  const out = a.readTranscript('cm3', 400, 0);
  assert.deepEqual(
    out.events.map((e) => e.k + (e.st ? ':' + e.st : '')),
    ['user', 'user', 'goal:set', 'stop', 'goal:interrupted'],
    'historical sequence only - set/interrupted render, no resumed ghost',
  );
  assert.equal(store.get('cm3')._goalHoldArmed, undefined, 'replay must not arm flags on the live record');
  assert.equal(store.get('cm3')._goalLive, true, 'replay leaves the drain-owned flag intact');
});
