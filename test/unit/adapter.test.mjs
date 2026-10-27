// test/unit/adapter.test.mjs - rename write-fence live-gating (v40c): the pin
// must survive boot/readTranscript replays of HISTORICAL custom-title lines
// (older renames, CLI test values); only lines arriving on a live drain may
// disarm it. Production bug this locks in: the 16:54 boot replay disarmed the
// 16:49 pin via a day-old "new" line and the title reverted again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CcAdapter } from '../../bridge/adapter-cc.js';

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
