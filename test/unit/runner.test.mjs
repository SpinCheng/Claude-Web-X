// test/unit/runner.test.mjs - the close-handler exit-code booking: a
// watchdog kill (transcript complete, CLI lingering) must book a CLEAN end,
// never surface the kill's exit code as a failure to the phone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { closeExitCode } from '../../bridge/runner.js';

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
