// routes/sessions.js - read-side session APIs + reversible delete
import fs from 'node:fs';
import path from 'node:path';
import { authOk } from '../lib/auth.js';
import { PREVIEW_MIME } from '../lib/mime.js';
import { readModelCatalog } from '../lib/models.js';

export function register(router, ctx) {
  const { cfg, store, adapter, runner, ctxprobe, hub } = ctx;

  const guard = (req, res, r) => {
    if (authOk(req, r.url, cfg)) return true;
    res.writeHead(401); res.end('{"error":"unauthorized"}');
    return false;
  };
  const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

  router.get('/api/models', (req, res, r) => { if (guard(req, res, r)) json(res, 200, { models: readModelCatalog() }); });

  router.get('/api/ping', (req, res, r) => { if (guard(req, res, r)) json(res, 200, { ok: true, version: '0.1.0' }); });

  router.get('/api/sessions', (req, res, r) => { if (guard(req, res, r)) json(res, 200, { sessions: hub.mergedSessions() }); });

  router.get('/api/sessions/:id/messages', (req, res, r) => {
    if (!guard(req, res, r)) return;
    const events = adapter.readTranscript(r.params.id);
    if (!events) { json(res, 404, { error: 'not found' }); return; }
    json(res, 200, { events });
  });

  // mid-run artifact preview (v23): files a run touched, locked inside the
  // session's project dir, previewable extensions, <= 2 MB
  router.get('/api/sessions/:id/preview', (req, res, r) => {
    if (!guard(req, res, r)) return;
    const rec = store.get(r.params.id);
    const rel = r.url.searchParams.get('p') || '';
    if (!rec || !rec.cwd || !rel || /^\\\\/.test(rel)) { json(res, 403, { error: 'forbidden' }); return; }
    const root = path.resolve(rec.cwd);
    const abs = path.resolve(root, rel);
    if (!abs.toLowerCase().startsWith(root.toLowerCase() + path.sep)) {
      json(res, 403, { error: 'outside project dir' }); return;
    }
    const mt = PREVIEW_MIME[path.extname(abs).toLowerCase()];
    if (!mt) { json(res, 415, { error: 'not previewable' }); return; }
    let st; try { st = fs.statSync(abs); } catch { json(res, 404, { error: 'not found' }); return; }
    if (!st.isFile()) { json(res, 404, { error: 'not found' }); return; }
    if (st.size > 2 * 1024 * 1024) { json(res, 413, { error: 'too large' }); return; }
    res.writeHead(200, { 'Content-Type': mt, 'Cache-Control': 'no-cache' });
    fs.readFile(abs, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.end(data);
    });
  });

  // pending queue snapshot (ids + texts) for the composer queue panel
  router.get('/api/sessions/:id/queue', (req, res, r) => {
    if (guard(req, res, r)) json(res, 200, { ok: true, queue: runner.queueSnapshot(r.params.id) });
  });

  router.get('/api/sessions/:id/driver', (req, res, r) => {
    if (!guard(req, res, r)) return;
    const st = ctx.handoff.status(r.params.id);
    st.phoneRun = !!runner.activeRunFor(r.params.id);
    json(res, 200, st);
  });

  // ground-truth context breakdown for a session's (cwd, model): runs the
  // CLI's /context in a throwaway session, returns the same fixed-part
  // accounting the Desktop popover shows. Cached bridge-side after 1st hit.
  router.get('/api/sessions/:id/context', async (req, res, r) => {
    if (!guard(req, res, r)) return;
    const rec = store.get(r.params.id);
    if (!rec) { json(res, 404, { error: 'not found' }); return; }
    if (!ctxprobe) { json(res, 200, { ok: false, error: 'probe disabled' }); return; }
    const modelId = (readModelCatalog().find((x) => x.label === (rec.model || '')) || {}).id || '';
    try {
      const out = await ctxprobe.get(rec.cwd || cfg.defaultCwd || '', modelId);
      json(res, 200, { ok: true, ...out });
    } catch (e) {
      json(res, 200, { ok: false, error: String((e && e.message) || e) });
    }
  });

  // reversible delete: transcript -> data/trash
  router.del('/api/sessions/:id', (req, res, r) => {
    if (!guard(req, res, r)) return;
    if (runner.activeRunFor(r.params.id)) { json(res, 409, { error: 'busy' }); return; }
    const result = adapter.archiveSession(r.params.id);
    if (!result.ok) { json(res, 404, { error: result.error }); return; }
    try { fs.rmSync(path.join(ctx.UPLOADS_DIR, r.params.id), { recursive: true, force: true }); } catch { /* nothing stored */ }
    json(res, 200, result);
  });
}
