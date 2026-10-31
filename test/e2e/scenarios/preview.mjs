// preview: artifact links click through + endpoint security envelope
import fs from 'node:fs';
import path from 'node:path';
import { withEnv, writeSession, assert, api, waitSession } from '../harness.mjs';
import { previewLines, user, assistant, text, stop } from '../fixtures.mjs';

await withEnv(async (h, page) => {
  fs.writeFileSync(path.join(h.tmp, 'ok.txt'), 'preview-body-123');
  fs.writeFileSync(path.join(h.tmp, 'dot.png'), Buffer.from('89504e470d0a1a0a0000', 'hex'));
  fs.writeFileSync(path.join(h.tmp, 'bad.exe'), 'MZ');
  fs.writeFileSync(path.join(h.tmp, 'page.html'), '<!doctype html><html><head><title>pv</title></head><body><h1>e2e-render-ok</h1></body></html>');
  writeSession(h, 'T--e2e', 'pv1', previewLines(h.tmp, 'ok.txt'));
  writeSession(h, 'T--e2e', 'pv2', previewLines(h.tmp, 'page.html'));
  writeSession(h, 'T--e2e', 'pv3', [
    user(1, 'md 链接测试'),
    assistant(2, [text('设计稿 [打开](http://127.0.0.1:3799/mockup-slash-menu.html)')]),
    stop(3),
  ]);
  const pv4Path = path.join(h.tmp, 'page.html');
  writeSession(h, 'T--e2e', 'pv4', [
    user(1, 'bare path conclusion', h.tmp),
    assistant(2, [text('artifact at ' + pv4Path + ' opens in-app')]),
    stop(3),
  ]);
  assert(await waitSession('pv1'), 'session visible');

  // API envelope first (no auth / outside / unknown ext / missing)
  const P = '/api/sessions/pv1/preview?p=';
  assert((await fetch(`http://127.0.0.1:3799${P}ok.txt`)).status === 401, 'preview 401 without token');
  assert((await api(P + encodeURIComponent(String.raw`C:\Windows\win.ini`))).status === 403, '403 outside cwd');
  assert((await api(P + encodeURIComponent('bad.exe'))).status === 415, '415 non-previewable');
  assert((await api(P + encodeURIComponent('nope.txt'))).status === 404, '404 missing');
  const img = await api(P + encodeURIComponent('dot.png'));
  assert(img.status === 200 && (img.headers.get('content-type') || '').startsWith('image/png'), 'png served as image/png');

  // v103 html render envelope: default inert text/plain; render=1 text/html + CSP
  // sandbox; render=1 on non-html stays inert
  const rawHtml = await api(P + encodeURIComponent('page.html'));
  assert(rawHtml.status === 200 && (rawHtml.headers.get('content-type') || '').startsWith('text/plain'), 'html defaults to text/plain');
  const ren = await api(P + encodeURIComponent('page.html') + '&render=1');
  assert(ren.status === 200 && (ren.headers.get('content-type') || '').startsWith('text/html'), 'render=1 serves text/html');
  assert((ren.headers.get('content-security-policy') || '').includes('sandbox'), 'render=1 carries CSP sandbox');
  const renTxt = await api(P + encodeURIComponent('ok.txt') + '&render=1');
  assert((renTxt.headers.get('content-type') || '').startsWith('text/plain'), 'render=1 ignored for non-html');

  // UI: linkify + click-through (v105: artifacts open the fullscreen page)
  await page.open('pv1');
  assert(await page.waitFor('document.querySelectorAll(".flink").length >= 2'), 'paths linkified');
  await page.ev('var t=document.querySelector(".turn .trigger"); t && t.click()');
  await page.ev('(function(){var a=[].slice.call(document.querySelectorAll(".flink")).find(function(x){return /ok\\.txt$/i.test(x.textContent)}); a && a.click(); return true;})()');
  assert(await page.waitFor('!document.getElementById("html-prev").classList.contains("hidden")'), 'text preview page opened');
  assert((await page.ev('document.getElementById("hp-src").textContent')).indexOf('preview-body-123') >= 0, 'preview body content');
  await page.ev('document.getElementById("hp-back").click()');
  assert(await page.waitFor('document.getElementById("html-prev").classList.contains("hidden")'), 'back closes preview page');
  await page.ev('(function(){var a=[].slice.call(document.querySelectorAll(".flink")).find(function(x){return /ok\\.txt$/i.test(x.textContent)}); a && a.click(); return true;})()');
  assert(await page.waitFor('!document.getElementById("html-prev").classList.contains("hidden")'), 'pv1 preview reopened (async open settled)');
  await page.ev('document.getElementById("hp-back").click()');
  assert(await page.waitFor('document.getElementById("html-prev").classList.contains("hidden")'), 'preview closed before next stage');


  // UI: html artifact opens the sandboxed render frame (v103)
  assert(await waitSession('pv2'), 'html session visible');
  await page.open('pv2');
  assert(await page.waitFor('document.querySelectorAll(".flink").length >= 1'), 'html path linkified');
  await page.ev('var t=document.querySelector(".turn .trigger"); t && t.click()');
  await page.ev('(function(){var a=[].slice.call(document.querySelectorAll(".flink")).find(function(x){return /page\\.html$/i.test(x.textContent)}); a && a.click(); return true;})()');
  assert(await page.waitFor('!document.getElementById("hp-frame").classList.contains("hidden")'), 'render frame shown');
  assert((await page.ev('document.getElementById("hp-frame").getAttribute("sandbox")')) === 'allow-scripts', 'iframe sandbox allow-scripts only');
  assert(await page.waitFor('(document.getElementById("hp-frame").getAttribute("srcdoc") || "").indexOf("e2e-render-ok") >= 0'), 'frame rides srcdoc');
  // v108: the page MUST cover the viewport (fixed), not sit clipped in #detail flow
  assert(await page.waitFor('(function(){var b=document.getElementById("html-prev").getBoundingClientRect(); return Math.round(b.width) >= innerWidth && Math.round(b.height) >= innerHeight - 2;})()'), 'preview page covers viewport');
  await page.ev('(function(){document.getElementById("hp-tab-src").click(); return true;})()');
  assert(await page.waitFor('!document.getElementById("hp-src").classList.contains("hidden")'), 'source tab shows text');
  await page.ev('document.getElementById("hp-back").click()');
  assert(await page.waitFor('document.getElementById("html-prev").classList.contains("hidden")'), 'preview closed before next stage');


  // v104: same-origin markdown link opens the in-app preview page, back closes it
  assert(await waitSession('pv3'), 'md-link session visible');
  await page.open('pv3');
  assert(await page.waitFor('!!document.querySelector("#chat a[href^=\\"http://127.0.0.1:3799/mockup\\"]")'), 'md link rendered as anchor');
  await page.ev('(function(){document.querySelector("#chat a[href^=\\"http://127.0.0.1:3799/mockup\\"]").click(); return true;})()');
  assert(await page.waitFor('!document.getElementById("html-prev").classList.contains("hidden")'), 'in-app preview page opened');
  assert((await page.ev('document.getElementById("hp-frame").getAttribute("sandbox")')) === 'allow-scripts', 'preview page iframe sandboxed');
  assert(await page.waitFor('(document.getElementById("hp-frame").getAttribute("srcdoc") || "").indexOf("CMDS") >= 0'), 'link url fetched into srcdoc');
  await page.ev('document.getElementById("hp-back").click()');
  assert(await page.waitFor('document.getElementById("html-prev").classList.contains("hidden")'), 'back closes preview page');
  // v106: bare path inside the conclusion bubble linkifies and previews in-app
  assert(await waitSession('pv4'), 'bare-path session visible');
  await page.open('pv4');
  assert(await page.waitFor('document.querySelectorAll(".final-card .flink").length >= 1'), 'bare path linkified in conclusion');
  await page.ev('(function(){var a=document.querySelector(".final-card .flink"); a && a.click(); return true;})()');
  assert(await page.waitFor('!document.getElementById("html-prev").classList.contains("hidden")'), 'bare path opens preview page');
  assert(await page.waitFor('(document.getElementById("hp-frame").getAttribute("srcdoc") || "").indexOf("e2e-render-ok") >= 0'), 'conclusion path renders via srcdoc');
  await page.ev('document.getElementById("hp-back").click()');
  assert(await page.waitFor('document.getElementById("html-prev").classList.contains("hidden")'), 'preview closed before next stage');

  // v139: md artifact opens dual-tab - render tab default (miniMd in a
  // standalone srcdoc doc), frontmatter stripped there but intact on the
  // source tab, raw html/script escaped, md iframe rides allow-popups
  const mdSrc = [
    '---', 'title: fm-strip-key', 'order: 2', '---', '',
    '## 部署指南', '',
    '- 步骤一 `npm i`', '- 步骤二 [文档](https://example.com/docs)', '',
    '<span style="color:red">raw html</span>', '',
    '<script>alert(1)</script>',
  ].join('\n');
  fs.writeFileSync(path.join(h.tmp, 'doc.md'), mdSrc);
  writeSession(h, 'T--e2e', 'pv5', previewLines(h.tmp, 'doc.md'));
  assert(await waitSession('pv5'), 'md session visible');
  await page.open('pv5');
  assert(await page.waitFor('document.querySelectorAll(".flink").length >= 1'), 'md path linkified');
  await page.ev('(function(){var a=[].slice.call(document.querySelectorAll(".flink")).find(function(x){return /doc\\.md$/i.test(x.textContent)}); a && a.click(); return true;})()');
  assert(await page.waitFor('!document.getElementById("html-prev").classList.contains("hidden")'), 'md opens the preview page');
  assert(await page.waitFor('!document.getElementById("hp-frame").classList.contains("hidden")'), 'md opens on the render tab');
  assert(await page.waitFor('!document.getElementById("hp-tabs").classList.contains("hidden")'), 'md shows both tabs');
  assert((await page.ev('document.getElementById("hp-frame").getAttribute("sandbox")')) === 'allow-scripts allow-popups', 'md iframe allows popups (links)');
  const mdDocAttr = await page.ev('document.getElementById("hp-frame").getAttribute("srcdoc") || ""');
  assert(mdDocAttr.indexOf('部署指南') >= 0 && mdDocAttr.indexOf('mdh2') >= 0, 'rendered heading rides the doc');
  assert(mdDocAttr.indexOf('&lt;span') >= 0 && mdDocAttr.indexOf('&lt;script') >= 0, 'raw html + script escaped');
  assert(mdDocAttr.indexOf('<script') === -1, 'no executable script tag in the doc');
  assert(mdDocAttr.indexOf('fm-strip-key') === -1, 'frontmatter stripped from render');
  await page.ev('(function(){document.getElementById("hp-tab-src").click(); return true;})()');
  assert(await page.waitFor('!document.getElementById("hp-src").classList.contains("hidden")'), 'source tab shows raw text');
  const mdSrcTxt = await page.ev('document.getElementById("hp-src").textContent');
  assert(mdSrcTxt.indexOf('fm-strip-key') >= 0 && mdSrcTxt.indexOf('<span style=') >= 0, 'source tab keeps frontmatter + raw html');
  await page.ev('document.getElementById("hp-back").click()');
  assert(await page.waitFor('document.getElementById("html-prev").classList.contains("hidden")'), 'md preview closed');

  // after a md open (allow-popups), an html open must reset to the strict set
  await page.open('pv2');
  assert(await page.waitFor('document.querySelectorAll(".flink").length >= 1'), 'html path linkified again');
  await page.ev('var t=document.querySelector(".turn .trigger"); t && t.click()');
  await page.ev('(function(){var a=[].slice.call(document.querySelectorAll(".flink")).find(function(x){return /page\\.html$/i.test(x.textContent)}); a && a.click(); return true;})()');
  assert(await page.waitFor('!document.getElementById("html-prev").classList.contains("hidden")'), 'html reopened');
  assert((await page.ev('document.getElementById("hp-frame").getAttribute("sandbox")')) === 'allow-scripts', 'sandbox resets to allow-scripts for html');
  await page.ev('document.getElementById("hp-back").click()');
  assert(await page.waitFor('document.getElementById("html-prev").classList.contains("hidden")'), 'html preview closed');

  // v142 structured renderers: csv table (rfc4180), json coloring, diff
  // ±stats - all ride the same dual-tab srcdoc path; svg goes through the
  // image lightbox via a client-side blob re-type (img context never runs
  // svg scripts)
  fs.writeFileSync(path.join(h.tmp, 'data.csv'), 'name,desc\nalpha,"hello, ""x"""\nbeta,plain\n');
  fs.writeFileSync(path.join(h.tmp, 'pkg.json'), '{"name":"e2e","v":2,"ok":true,"none":null}');
  fs.writeFileSync(path.join(h.tmp, 'change.diff'), '--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old line\n+new line\n ctx\n');
  fs.writeFileSync(path.join(h.tmp, 'dot.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/><script>alert(1)</script></svg>');
  const renderCases = [
    ['pv6', 'data.csv', 'data\\.csv', (d) => d.indexOf('<th>name</th>') >= 0 && d.indexOf('hello, "x"') >= 0, 'csv table + quoted cell'],
    ['pv7', 'pkg.json', 'pkg\\.json', (d) => d.indexOf('<span class="jk">"name"</span>') >= 0 && d.indexOf('<span class="jlit">true</span>') >= 0, 'json keys + literals colored'],
    ['pv8', 'change.diff', 'change\\.diff', (d) => d.indexOf('class="dl add"') >= 0 && d.indexOf('class="dl del"') >= 0 && d.indexOf('+1</span>') >= 0, 'diff add/del rows + stats'],
  ];
  for (const [sid, fname, mark, check, label] of renderCases) {
    writeSession(h, 'T--e2e', sid, previewLines(h.tmp, fname));
    assert(await waitSession(sid), sid + ' visible');
    await page.open(sid);
    assert(await page.waitFor('document.querySelectorAll(".flink").length >= 1'), sid + ' flink ready');
    await page.ev('(function(){var a=[].slice.call(document.querySelectorAll(".flink")).find(function(x){return /' + mark + '$/i.test(x.textContent)}); a && a.click(); return true;})()');
    // container assert (starts hidden): the hp-frame assert would pass
    // vacuously on the static default while the async fetch is still in
    // flight and srcdoc is still empty
    assert(await page.waitFor('!document.getElementById("html-prev").classList.contains("hidden")'), sid + ' opens the preview page');
    assert(await page.waitFor('!document.getElementById("hp-frame").classList.contains("hidden")'), sid + ' opens on the render tab');
    const attr = await page.ev('document.getElementById("hp-frame").getAttribute("srcdoc") || ""');
    assert(check(attr), label);
    await page.ev('document.getElementById("hp-back").click()');
    assert(await page.waitFor('document.getElementById("html-prev").classList.contains("hidden")'), sid + ' closed');
  }
  writeSession(h, 'T--e2e', 'pv9', previewLines(h.tmp, 'dot.svg'));
  assert(await waitSession('pv9'), 'svg session visible');
  await page.open('pv9');
  assert(await page.waitFor('document.querySelectorAll(".flink").length >= 1'), 'svg path linkified');
  await page.ev('(function(){var a=[].slice.call(document.querySelectorAll(".flink")).find(function(x){return /dot\\.svg$/i.test(x.textContent)}); a && a.click(); return true;})()');
  assert(await page.waitFor('!document.getElementById("lightbox").classList.contains("hidden")'), 'svg opens the lightbox');
  assert((await page.ev('document.getElementById("lightbox-img").src.slice(0,5)')) === 'blob:', 'svg rides a blob url (client re-type)');
  await page.ev('document.getElementById("lightbox").click()');
  assert(true, 'done');
});
