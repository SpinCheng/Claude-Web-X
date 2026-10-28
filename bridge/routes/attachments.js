// routes/attachments.js - phone-side uploads (v19): raw upload + token-authed
// static serving locked inside the uploads dir + the message.attachments gate
import fs from 'node:fs';
import path from 'node:path';
import { authOk, readRawBody } from '../lib/auth.js';
import { MIME } from '../lib/mime.js';

// message.attachments gate: only files this session uploaded, sane names
export function normAttachments(sessionId, list, ctx) {
  const UPLOADS_DIR = ctx.UPLOADS_DIR;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list.slice(0, 4)) {
    if (!a || typeof a.file !== 'string' || typeof a.name !== 'string') continue;
    if (!a.file.startsWith(sessionId + '/') || /[\\/]|\.\./.test(a.file.slice(sessionId.length + 1))) continue;
    const full = path.join(UPLOADS_DIR, a.file);
    if (!full.startsWith(UPLOADS_DIR)) continue;
    let st; try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    out.push({ file: a.file, name: String(a.name).slice(0, 120), type: String(a.type || '') });
  }
  return out;
}

export function register(router, ctx) {
  const { cfg, store } = ctx;

  // attachment upload: RAW body, up to 10 MB; stored under
  // data/uploads/<sessionId>/ and referenced by message.attachments
  router.post('/api/sessions/:id/attach', async (req, res, r) => {
    if (!authOk(req, r.url, cfg)) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
    const sid = r.params.id;
    if (!store.get(sid)) { res.writeHead(404); res.end('{"error":"no such session"}'); return; }
    const raw = await readRawBody(req, 10 * 1024 * 1024);
    if (!raw || !raw.length) { res.writeHead(400); res.end('{"error":"empty body"}'); return; }
    const base = (r.url.searchParams.get('name') || 'file.bin').split(/[\\/]/).pop().replace(/[^\w.\- ()一-龥]/g, '_').slice(0, 80) || 'file.bin';
    const dir = path.join(ctx.UPLOADS_DIR, sid);
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    const saved = Date.now().toString(36) + '-' + base;
    try { fs.writeFileSync(path.join(dir, saved), raw); } catch { res.writeHead(500); res.end('{"error":"write failed"}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, file: sid + '/' + saved, name: base, size: raw.length }));
  });

  // token-authed static serving of uploaded files, locked inside uploads dir
  router.get('/files/*', (req, res, r) => {
    if (!authOk(req, r.url, cfg)) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
    const file = path.normalize(path.join(ctx.UPLOADS_DIR, decodeURIComponent(r.url.pathname.slice('/files/'.length))));
    if (!file.startsWith(ctx.UPLOADS_DIR)) { res.writeHead(403); res.end(); return; }
    let st; try { st = fs.statSync(file); } catch { res.writeHead(404); res.end('not found'); return; }
    if (!st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.end(data);
    });
  });
}
