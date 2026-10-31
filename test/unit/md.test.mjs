// test/unit/md.test.mjs - v139 md preview helpers: frontmatter strip guard
// rails + mdDoc envelope (escaped-only markup, https-only links). miniMd
// itself is covered by the markdown e2e (conclusion cards render the same
// output); here we assert the file-preview-specific behavior.
import { test } from 'node:test';
import assert from 'node:assert';
import { mdFrontmatter, mdDoc } from '../../public/js/md.js';

test('mdFrontmatter strips a yamlish leading block', () => {
  const src = '---\ntitle: x\ndraft: false\n---\n\n# Head\n';
  assert.equal(mdFrontmatter(src), '\n# Head\n');
});

test('mdFrontmatter tolerates CRLF and ... close fence', () => {
  assert.equal(mdFrontmatter('---\r\na: 1\r\n...\r\nbody'), 'body');
});

test('mdFrontmatter leaves bare --- hr docs alone (no fence / no key)', () => {
  // leading hr, no closing fence: body is the whole doc
  assert.equal(mdFrontmatter('---\n# Head\n'), '---\n# Head\n');
  // two fences but nothing yamlish between: a `---` separator pair, keep it
  assert.equal(mdFrontmatter('---\nplain text\n---\n# Head\n'), '---\nplain text\n---\n# Head\n');
});

test('mdDoc escapes raw html and script payloads', () => {
  const doc = mdDoc('# T\n\n<span style="color:red">x</span>\n\n<script>alert(1)</script>\n');
  assert.match(doc, /&lt;span/);
  assert.match(doc, /&lt;script/);
  assert.ok(!doc.includes('<span '), 'no raw span tag rides the doc');
  assert.ok(!doc.includes('<script>'), 'no executable script tag');
});

test('mdDoc strips frontmatter and keeps it out of the render (source tab is caller-side)', () => {
  const doc = mdDoc('---\nfm-secret-key: 1\n---\n# Visible\n');
  assert.ok(!doc.includes('fm-secret-key'));
  assert.match(doc, /Visible/);
});

test('mdDoc emits the standalone envelope with escaped-only link grammar', () => {
  const doc = mdDoc('[ok](https://a.example/x)\n[bad](javascript:alert(1))');
  assert.match(doc, /^<!doctype html>/);
  assert.match(doc, /href="https:\/\/a\.example\/x"/);
  assert.ok(!doc.includes('href="javascript:'), 'javascript: links never become hrefs');
});
