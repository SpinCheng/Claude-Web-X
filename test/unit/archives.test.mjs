// test/unit/archives.test.mjs - v185: the archive registry (view-filter
// store). Same contract family as Pins: set/has/get/drop + boot persistence,
// with unarchive physically REMOVING the entry (an absent key = not archived,
// the file never carries tombstones).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Archives } from '../../bridge/archives.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ar-')), 'archived.json');

test('set/has/get round-trips and persists across boots', () => {
  const file = tmpFile();
  const a = new Archives(file);
  assert.equal(a.has('s1'), false, 'fresh registry is empty');
  a.set('s1', true);
  assert.equal(a.has('s1'), true);
  assert.ok(a.get('s1') > 0, 'archivedAt is a timestamp');
  // the file is written on change (boot reload sees the same state)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { s1: a.get('s1') });
  const b = new Archives(file);
  assert.equal(b.has('s1'), true, 'survives a reload');
});

test('unarchive deletes the entry from disk (no tombstones)', () => {
  const file = tmpFile();
  const a = new Archives(file);
  a.set('s1', true);
  a.set('s1', false);
  assert.equal(a.has('s1'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {}, 'key physically removed');
  assert.equal(a.set('s1', false), false, 'unarchiving a non-archived id is a no-op');
});

test('drop removes a single entry (delete route path)', () => {
  const a = new Archives('');
  a.set('s1', true);
  a.set('s2', true);
  a.drop('s1');
  assert.equal(a.has('s1'), false);
  assert.equal(a.has('s2'), true);
  a.drop('nope'); // never throws
});

test('corrupt file starts empty instead of crashing the bridge', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{not json');
  const a = new Archives(file);
  assert.equal(a.has('s1'), false);
  a.set('s1', true); // and can still write a clean file after
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { s1: a.get('s1') });
});
