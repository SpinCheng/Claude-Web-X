// preview: artifact links click through + endpoint security envelope
import fs from 'node:fs';
import path from 'node:path';
import { withEnv, writeSession, assert, api, waitSession } from '../harness.mjs';
import { previewLines } from '../fixtures.mjs';

await withEnv(async (h, page) => {
  fs.writeFileSync(path.join(h.tmp, 'ok.txt'), 'preview-body-123');
  fs.writeFileSync(path.join(h.tmp, 'dot.png'), Buffer.from('89504e470d0a1a0a0000', 'hex'));
  fs.writeFileSync(path.join(h.tmp, 'bad.exe'), 'MZ');
  writeSession(h, 'T--e2e', 'pv1', previewLines(h.tmp, 'ok.txt'));
  assert(await waitSession('pv1'), 'session visible');

  // API envelope first (no auth / outside / unknown ext / missing)
  const P = '/api/sessions/pv1/preview?p=';
  assert((await fetch(`http://127.0.0.1:3799${P}ok.txt`)).status === 401, 'preview 401 without token');
  assert((await api(P + encodeURIComponent(String.raw`C:\Windows\win.ini`))).status === 403, '403 outside cwd');
  assert((await api(P + encodeURIComponent('bad.exe'))).status === 415, '415 non-previewable');
  assert((await api(P + encodeURIComponent('nope.txt'))).status === 404, '404 missing');
  const img = await api(P + encodeURIComponent('dot.png'));
  assert(img.status === 200 && (img.headers.get('content-type') || '').startsWith('image/png'), 'png served as image/png');

  // UI: linkify + click-through
  await page.open('pv1');
  assert(await page.waitFor('document.querySelectorAll(".flink").length >= 2'), 'paths linkified');
  await page.ev('var t=document.querySelector(".turn .trigger"); t && t.click()');
  await page.ev('(function(){var a=[].slice.call(document.querySelectorAll(".flink")).find(function(x){return /ok\\.txt$/i.test(x.textContent)}); a && a.click(); return true;})()');
  assert(await page.waitFor('!document.getElementById("file-prev").classList.contains("hidden")'), 'text preview opened');
  assert((await page.ev('document.getElementById("fp-body").textContent')).indexOf('preview-body-123') >= 0, 'preview body content');
  await page.ev('document.getElementById("file-prev").click();');
  await page.ev('(function(){var a=[].slice.call(document.querySelectorAll(".flink")).find(function(x){return /ok\\.txt$/i.test(x.textContent)}); a && a.click(); return true;})()');
  assert(true, 'done');
});
