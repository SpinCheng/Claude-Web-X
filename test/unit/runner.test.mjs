// test/unit/runner.test.mjs - the close-handler exit-code booking: a
// watchdog kill (transcript complete, CLI lingering) must book a CLEAN end,
// never surface the kill's exit code as a failure to the phone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeExitCode, yoloBlockedReason, Runner } from '../../bridge/runner.js';

test('watchdog-fired kill books exitCode 0 (task completed, kill is noise)', () => {
  assert.equal(closeExitCode({ watchdogFired: true, cancelled: false }, 1), 0);
  assert.equal(closeExitCode({ watchdogFired: true, cancelled: false }, 15), 0);
});

test('normal close keeps its code (real failures stay failures)', () => {
  assert.equal(closeExitCode({ watchdogFired: false, cancelled: false }, 1), 1);
  assert.equal(closeExitCode({ watchdogFired: false, cancelled: false }, 0), 0);
});

test('null code: cancelled vs clean', () => {
  assert.equal(closeExitCode({ cancelled: true }, null), 'cancelled');
  assert.equal(closeExitCode({ cancelled: false }, null), 0);
  assert.equal(closeExitCode({}, undefined), 0);
});

test('yoloBlockedReason: root + yolo refused; ask / non-root / yolo-off pass', () => {
  assert.ok(yoloBlockedReason(true, 'auto', true), 'root + auto + yolo => readable refusal');
  assert.equal(yoloBlockedReason(true, 'ask', true), null, 'root + ask is a legal shape');
  assert.equal(yoloBlockedReason(false, 'auto', true), null, 'non-root yolo fine');
  assert.equal(yoloBlockedReason(true, 'auto', false), null, 'root without skip-permissions fine');
});

test('settingsEnv: mtime-keyed cache - missing file, then created, then edited', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-runner-'));
  const p = path.join(dir, 'settings.json');
  const r = new Runner({ settingsPath: p });
  assert.deepEqual(r.settingsEnv(), {}, 'missing file => empty, no throw');
  fs.writeFileSync(p, JSON.stringify({ env: { A: '1' } }), 'utf8');
  assert.deepEqual(r.settingsEnv(), { A: '1' }, 'file appears later => picked up (was: cached-forever lockup)');
  fs.writeFileSync(p, JSON.stringify({ env: { A: '2', B: 'x' } }), 'utf8');
  const t = new Date(Date.now() + 5000); // force a distinct mtime (same-tick writes can share one)
  fs.utimesSync(p, t, t);
  assert.deepEqual(r.settingsEnv(), { A: '2', B: 'x' }, 'env edit => reloaded without a bridge restart');
  fs.rmSync(dir, { recursive: true, force: true });
});
