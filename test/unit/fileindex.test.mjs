// test/unit/fileindex.test.mjs - v192 @ picker data plane + send-time
// @-attachment scan (roadmap 11): token word-boundary, cwd guard, per-class
// disposition (inline text / stdin image / path-only degrade), cap 4, and the
// git ls-files index incl. the file-index-include whitelist lane.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  scanAtTokens, collectAtAttachments, insideRoot, browseDir,
  repoFileList, clearIndexCache, MAX_AT_ATTACH,
} from '../../bridge/lib/fileindex.js';
import { bashToolEnv } from '../../bridge/lib/platform.js';

const GIT_ENV = { ...process.env, ...bashToolEnv(process.env) };
const git = (args, cwd) => execFileSync('git', args, { cwd, env: GIT_ENV });
const tmpRepo = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-fidx-'));
  // neutralize the machine's GLOBAL gitignore: --others --exclude-standard
  // consults it, so listing assertions must not depend on the host's config
  const empty = path.join(dir, '.e2e-no-global-ignore');
  fs.writeFileSync(empty, '');
  git(['init', '-q'], dir);
  git(['config', 'core.excludesFile', empty], dir);
  return dir;
};

// ---------- scanAtTokens: word boundary ----------
test('scanAtTokens: start-of-line, after-space, after-punctuation all hit', () => {
  assert.deepEqual(scanAtTokens('@a.md 看 @b.js（@c.txt').map((t) => t.path), ['a.md', 'b.js', 'c.txt']);
  assert.deepEqual(scanAtTokens('@a/b.md tail'), [{ start: 0, end: 7, path: 'a/b.md' }]);
});

test('scanAtTokens: user@host / CJK-before-@ never trigger (word boundary)', () => {
  assert.deepEqual(scanAtTokens('mail me user@host.com'), [], 'latin word char before @');
  assert.deepEqual(scanAtTokens('看这个@文件'), [], 'CJK letter before @');
  assert.deepEqual(scanAtTokens('a_b@x y1@z'), [], 'underscore/digit are word chars');
});

test('scanAtTokens: token stops at whitespace and second @; CJK path chars ride along', () => {
  assert.deepEqual(scanAtTokens('@a/b.md tail'), [{ start: 0, end: 7, path: 'a/b.md' }]);
  assert.deepEqual(scanAtTokens('@x@y'), [{ start: 0, end: 2, path: 'x' }], 'first @ wins; the second is blocked by the word-char before it');
});

test('scanAtTokens: prose punctuation truncates the token (CJK input companions)', () => {
  assert.deepEqual(scanAtTokens('@a.md，看看'), [{ start: 0, end: 5, path: 'a.md' }], 'fullwidth comma ends the ref');
  assert.deepEqual(scanAtTokens('查 @bridge/app.js；再'), [{ start: 2, end: 16, path: 'bridge/app.js' }], 'fullwidth semicolon ends the ref');
  assert.deepEqual(scanAtTokens('@，哈哈'), [], '@ followed by punctuation is not a ref');
  assert.deepEqual(scanAtTokens('看@中文文件名'), [], 'CJK word char before @ still blocks');
  assert.deepEqual(scanAtTokens('@file(1).txt'), [{ start: 0, end: 12, path: 'file(1).txt' }], 'ASCII parens stay (real filename shape)');
});

test('scanAtTokens: backslash and absolute-looking tokens are extracted verbatim (guard later)', () => {
  assert.deepEqual(scanAtTokens('看 @sub\\b.md 的问题'), [{ start: 2, end: 11, path: 'sub\\b.md' }]);
  assert.deepEqual(scanAtTokens('@/abs.js'), [{ start: 0, end: 8, path: '/abs.js' }]);
});

// ---------- insideRoot / browseDir ----------
test('insideRoot: prefix + .. traversal, case handling by platform', () => {
  const root = path.resolve('C:\\proj');
  assert.ok(insideRoot(root, path.resolve('C:\\proj\\sub\\x.js')));
  assert.ok(!insideRoot(root, path.resolve('C:\\proj2\\x.js')), 'sibling prefix is not inside');
  assert.ok(!insideRoot(root, path.resolve('C:\\outside\\x.js')));
});

test('browseDir: lists dirs+files, guards escapes, caps and sorts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-brow-'));
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'z.txt'), 'x');
  const b = browseDir(dir, '');
  assert.deepEqual(b.dirs, ['sub']);
  assert.deepEqual(b.files, ['a.txt', 'z.txt']);
  assert.equal(browseDir(dir, '..'), null, 'escape rejected');
  assert.equal(browseDir(dir, 'missing'), null, 'missing dir -> null');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- collectAtAttachments: disposition matrix ----------
test('collectAtAttachments: text<=24KB inline / image stdin / rest degrade to path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ata-'));
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  fs.writeFileSync(path.join(dir, 'sub', 'b.md'), '# b');
  fs.writeFileSync(path.join(dir, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(dir, 'big.log'), 'x'.repeat(25 * 1024));
  fs.writeFileSync(path.join(dir, 'bin.exe'), 'MZ');
  const out = collectAtAttachments('看 @a.md @img.png @bin.exe @big.log @missing.js', dir);
  // a.md does not exist (a.txt does) -> only img.png is a real hit here
  assert.equal(out.length, 1);
  assert.equal(out[0].file, 'img.png');
  assert.equal(out[0].type, 'image/png');
  assert.ok(out[0].abs.startsWith(dir));

  const out2 = collectAtAttachments('看 @a.txt 和 @sub/b.md', dir);
  assert.equal(out2.length, 2, 'both text files attach');
  assert.equal(out2[0].type, 'text/plain');
  assert.equal(out2[1].file, 'sub/b.md', 'nested rel path, forward slashes');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('collectAtAttachments: dirs / trailing-slash / escapes / absolute shapes never attach', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-atb-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-atb-o-'));
  fs.mkdirSync(path.join(dir, 'd'));
  fs.writeFileSync(path.join(dir, 'f.txt'), 'x');
  fs.writeFileSync(path.join(outside, 'o.txt'), 'x');
  assert.deepEqual(collectAtAttachments('@d', dir), [], 'dir ref: path text only (model explores)');
  assert.deepEqual(collectAtAttachments('@d/', dir), [], 'explicit dir slash');
  assert.deepEqual(collectAtAttachments('@../' + path.basename(outside) + '/o.txt', path.join(dir, 'd')), [], 'guard: escape via .. rejected');
  assert.deepEqual(collectAtAttachments('@/f.txt @C:\\f.txt @~/f.txt', dir), [], 'absolute/home shapes not project-relative');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('collectAtAttachments: cap 4 (first four attachable win), backslash rel normalizes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-atc-'));
  for (const n of ['1', '2', '3', '4', '5']) fs.writeFileSync(path.join(dir, n + '.txt'), 'x');
  const out = collectAtAttachments('@1.txt @2.txt @3.txt @4.txt @5.txt', dir);
  assert.equal(out.length, MAX_AT_ATTACH);
  assert.deepEqual(out.map((a) => a.file), ['1.txt', '2.txt', '3.txt', '4.txt']);
  assert.equal(collectAtAttachments('@sub\\b.md', dir).length, 0, 'nonexistent backslash path: no attach, no throw');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- repoFileList: git index ----------
test('repoFileList: untracked-unignored listed (forward slashes); non-git -> null; TTL cache', async () => {
  const dir = tmpRepo();
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'README.md'), 'x');
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'x');
  clearIndexCache();
  const files = await repoFileList(dir);
  assert.ok(files, 'git lane');
  assert.ok(files.includes('README.md') && files.includes('src/app.js'), 'untracked files indexed');
  const again = await repoFileList(dir);
  assert.equal(again, files, 'TTL cache: same object, no respawn');

  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-nogit-'));
  clearIndexCache();
  assert.equal(await repoFileList(plain), null, 'non-git dir -> null (client degrades to browse)');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(plain, { recursive: true, force: true });
});

test('repoFileList: file-index-include negation re-admits an ignored dir', async () => {
  const dir = tmpRepo();
  fs.mkdirSync(path.join(dir, 'skipme'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.gitignore'), 'skipme/\n');
  fs.writeFileSync(path.join(dir, 'skipme', 'x.txt'), 'x');
  const inc = path.join(dir, 'inc-include');
  clearIndexCache();
  const plain = await repoFileList(dir);
  assert.ok(plain && !plain.some((f) => f.startsWith('skipme/')), 'ignored dir filtered by git semantics');
  clearIndexCache();
  fs.writeFileSync(inc, '!skipme/\n');
  const withInc = await repoFileList(dir, inc);
  assert.ok(withInc && withInc.includes('skipme/x.txt'), 'include-file negation re-admits (selector index only)');
  clearIndexCache();
  fs.rmSync(dir, { recursive: true, force: true });
});
