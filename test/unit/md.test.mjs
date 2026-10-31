// test/unit/md.test.mjs - v139 md preview helpers: frontmatter strip guard
// rails + mdDoc envelope (escaped-only markup, https-only links). miniMd
// itself is covered by the markdown e2e (conclusion cards render the same
// output); here we assert the file-preview-specific behavior.
import { test } from 'node:test';
import assert from 'node:assert';
import { mdFrontmatter, mdDoc, csvDoc, jsonDoc, diffDoc, diffRows } from '../../public/js/md.js';

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

test('csvDoc parses rfc4180: quoted delimiters, escaped quotes, embedded newline, CRLF, BOM', () => {
  const src = '﻿name,desc\r\nalpha,"hello, ""x"""\r\nbeta,"line1\nline2"\r\n';
  const doc = csvDoc(src, ',');
  assert.ok(doc.includes('<th>name</th>'), 'header row');
  assert.ok(doc.includes('hello, "x"'), 'quoted comma + escaped quotes intact');
  assert.ok(doc.includes('line1\nline2'), 'embedded newline kept (pre-wrap cell)');
  assert.ok(!doc.includes('<script'), 'no raw markup');
});

test('csvDoc: tsv delimiter + 500-row cap with a truncation note', () => {
  const doc = csvDoc('a\tb\n1\t2', '\t');
  assert.ok(doc.includes('<th>a</th>'), 'tsv split on tab');
  const big = Array.from({ length: 600 }, (_, i) => 'r' + i + ',x').join('\n');
  const capped = csvDoc(big, ',');
  assert.ok(capped.includes('共 600 行，仅显示前 500 行'), 'cap note');
  assert.ok(!capped.includes('<td>r599<'), 'row 600 not rendered');
});

test('jsonDoc: pretty + token colors + payload escaping; invalid falls back raw', () => {
  const doc = jsonDoc('{"k":"<script>alert(1)</script>","n":1.5e2,"t":true,"z":null}');
  assert.ok(doc.includes('<span class="jk">"k"</span>'), 'key colored');
  assert.ok(doc.includes('&lt;script&gt;'), 'string payload escaped');
  assert.ok(doc.includes('<span class="jnum">150</span>'), 'number normalized+colored');
  assert.ok(doc.includes('<span class="jlit">true</span>'), 'literal colored');
  assert.ok(!doc.includes('<script>'), 'no executable script tag');
  const bad = jsonDoc('{"k": oops}');
  assert.ok(bad.includes('JSON 解析失败') && bad.includes('{"k": oops}'), 'invalid: note + raw text');
});

test('diffDoc: line classes, ±stats, escaping', () => {
  const src = ['--- a/x', '+++ b/x', '@@ -1,2 +1,2 @@', '-old <b>line</b>', '+new "q"', ' ctx', ''].join('\n');
  const doc = diffDoc(src);
  assert.ok(doc.includes('class="dl dfile"'), 'file header lines');
  assert.ok(doc.includes('class="dl hunk"'), 'hunk marker');
  assert.ok(doc.includes('class="dl del"') && doc.includes('class="dl add"'), 'del/add rows');
  assert.ok(doc.includes('+1</span>') && doc.includes('−1</span>'), 'stats');
  assert.ok(doc.includes('&lt;b&gt;'), 'context/add payloads escaped');
});

test('diffRows: ctx pairs naturally, del/add runs pair index-wise with spill', () => {
  const src = [
    '@@ -1,5 +1,5 @@',
    ' keep1',
    '-gone1',
    '-gone2',
    '+fresh1',
    ' keep2',
    '+fresh2',
    '+fresh3',
  ].join('\n');
  const kinds = diffRows(src).filter((r) => r.k !== 'hunk').map((r) => r.k + (r.k === 'ctx' ? ':' + r.l : ''));
  assert.deepEqual(kinds, ['ctx: keep1', 'mod', 'del', 'ctx: keep2', 'add', 'add'], 'pairing + spill');
  const rows = diffRows(src);
  assert.equal(rows.find((r) => r.k === 'mod').l, '-gone1');
  assert.equal(rows.find((r) => r.k === 'mod').r, '+fresh1');
  assert.ok(rows.some((r) => r.k === 'del' && r.l === '-gone2'), 'longer del run spills one-sided');
});

test('diffRows: git patch prose (From/index/diffstat/bare ---) stays full-width, never a del', () => {
  const src = [
    'From 0000000 Mon Sep 17 00:00:00 2001',
    'From: mini',
    'Subject: [PATCH] feat',
    '---',
    ' bridge/x.js | 2 ++',
    ' 1 file changed, 2 insertions(+)',
    'diff --git a/x.js b/x.js',
    'index 111..222 100644',
    '--- a/x.js',
    '+++ b/x.js',
    '@@ -1,2 +1,3 @@',
    ' old',
    '-x',
    '+new',
    '+new2',
    '-- ',
    '2.1.308.windows',
  ].join('\n');
  const rows = diffRows(src);
  const prose = rows.filter((r) => r.k === 'text' || r.k === 'file').map((r) => r.l);
  assert.ok(prose.includes('From: mini') && prose.includes('index 111..222 100644'), 'prose rows kept');
  assert.ok(prose.includes('---') && prose.includes('-- '), 'git separator + signature not dels');
  assert.ok(rows.some((r) => r.k === 'mod'), 'hunk still pairs');
  assert.ok(!rows.some((r) => r.k === 'del' && r.l === '-- '), 'signature never classified del');
});

test('diffDoc: dual layouts + CSS-only toggle ride the doc', () => {
  const doc = diffDoc('@@ -1,1 +1,1 @@\n-a\n+b\n');
  assert.ok(doc.includes('id="dmode"'), 'toggle checkbox present');
  assert.ok(doc.includes('class="dlist"') && doc.includes('class="dsplit"'), 'both layouts rendered');
  assert.ok(doc.includes('class="drow"'), 'split grid rows present');
  assert.ok(doc.includes('.dm-cb:checked ~ .dlist{display:none}'), 'toggle CSS keys off the checkbox');
  assert.ok(!doc.includes('<script'), 'no script in the sandbox doc');
});
