// test/unit/handoff.test.mjs - v175: our own bookkeeping writes (goal
// tombstone + cancel directive) must not trip the foreign-writer 8s window.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Handoff } from '../../bridge/handoff.js';

const mk = () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ho-'));
  const tp = path.join(tmp, 's.jsonl');
  fs.writeFileSync(tp, '{}\n');
  const store = { get: () => ({ transcriptPath: tp }) };
  const h = new Handoff({ store, locksDir: path.join(tmp, 'locks') });
  return { h, tp };
};

test('v175: cancel bookkeeping registered via noteSelfWrite does not 409', () => {
  const { h, tp } = mk();
  // simulate: an old run ended long ago; our tombstone write JUST happened
  h.lastPhoneRun.set('s', Date.now() - 60_000);
  h.noteSelfWrite('s');
  fs.utimesSync(tp, new Date(), new Date()); // transcript touched NOW (our write)
  const r = h.checkPhoneSend('s');
  assert.equal(r.ok, true, 'own bookkeeping is exempt from the grace window');
});

test('a genuinely foreign fresh write still 409s', () => {
  const { h, tp } = mk();
  h.lastPhoneRun.set('s', Date.now() - 60_000);
  fs.utimesSync(tp, new Date(), new Date()); // foreign writer touching NOW
  const r = h.checkPhoneSend('s');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'recent-local-write');
});
