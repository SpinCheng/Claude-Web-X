// routes/sessions.js - read-side session APIs + reversible delete + rename
import fs from 'node:fs';
import path from 'node:path';
import { authOk, readBody } from '../lib/auth.js';
import { PREVIEW_MIME } from '../lib/mime.js';
import { readModelCatalog } from '../lib/models.js';
import { CI_PATHS } from '../lib/platform.js';
import { collectCommands } from '../lib/commands.js';

export function register(router, ctx) {
  const { cfg, store, adapter, runner, ctxprobe, hub } = ctx;

  const guard = (req, res, r) => {
    if (authOk(req, r.url, cfg)) return true;
    res.writeHead(401); res.end('{"error":"unauthorized"}');
    return false;
  };
  const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

  router.get('/api/models', (req, res, r) => { if (guard(req, res, r)) json(res, 200, { models: readModelCatalog() }); });

  // v109 slash-command menu: built-in whitelist + custom commands discovered
  // from ~/.claude/commands and <cwd>/.claude/commands (scanned per request;
  // dirs are small). No cwd -> builtins only.
  router.get('/api/sessions/:id/commands', (req, res, r) => {
    if (!guard(req, res, r)) return;
    const rec = store.get(r.params.id);
    if (!rec) { json(res, 404, { error: 'not found' }); return; }
    let commands;
    try { commands = collectCommands(rec.cwd); } catch { commands = collectCommands(null); }
    json(res, 200, { commands });
  });

  router.get('/api/ping', (req, res, r) => { if (guard(req, res, r)) json(res, 200, { ok: true, version: '0.1.0' }); });

  router.get('/api/sessions', (req, res, r) => { if (guard(req, res, r)) json(res, 200, { sessions: hub.mergedSessions() }); });

  router.get('/api/sessions/:id/messages', (req, res, r) => {
    if (!guard(req, res, r)) return;
    const before = parseInt(r.url.searchParams.get('before') || '0', 10) || 0;
    const out = adapter.readTranscript(r.params.id, 400, before);
    if (!out) { json(res, 404, { error: 'not found' }); return; }
    // v112: agent summaries ride along (seeds finished agent nodes' 全文)
    out.agents = adapter.agents.summariesFor(r.params.id);
    json(res, 200, out);
  });

  // v112: one subagent's full display events (the 方案A bubble). Same applyLine
  // parsing as the parent transcript; api-request* blob lines never surface.
  router.get('/api/sessions/:id/agents/:agentId/events', (req, res, r) => {
    if (!guard(req, res, r)) return;
    if (!store.get(r.params.id)) { json(res, 404, { error: 'not found' }); return; }
    const out = adapter.agents.readEvents(r.params.id, r.params.agentId);
    if (!out) { json(res, 404, { error: 'no agent transcript' }); return; }
    json(res, 200, out);
  });

  // v44: export the transcript as Markdown (scope=full|summary). Built from
  // the same parsed events the detail view uses; thinking is omitted (noise),
  // tool calls render as one-line quotes. Attachment disposition so phones
  // hit the download/share path directly.
  router.get('/api/sessions/:id/export', (req, res, r) => {
    if (!guard(req, res, r)) return;
    const rec = store.get(r.params.id);
    const out = adapter.readTranscript(r.params.id, 1e9, 0);
    if (!rec || !out) { json(res, 404, { error: 'not found' }); return; }
    const scope = r.url.searchParams.get('scope') === 'summary' ? 'summary' : 'full';
    const md = buildMarkdown(rec, out.events, scope);
    const base = (rec.title && rec.title !== '(loading)' ? rec.title : rec.id.slice(0, 8))
      .replace(/[\\/:*?"<>|#\[\]]+/g, '').trim().slice(0, 60) || rec.id.slice(0, 8);
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': 'attachment; filename="export.md"; filename*=UTF-8\'\'' + encodeURIComponent(base) + '.md',
      'Cache-Control': 'no-cache',
    });
    res.end(md);
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
    const ci = (s) => (CI_PATHS ? s.toLowerCase() : s);
    if (!ci(abs).startsWith(ci(root) + path.sep)) {
      json(res, 403, { error: 'outside project dir' }); return;
    }
    const ext = path.extname(abs).toLowerCase();
    const mt = PREVIEW_MIME[ext];
    if (!mt) { json(res, 415, { error: 'not previewable' }); return; }
    let st; try { st = fs.statSync(abs); } catch { json(res, 404, { error: 'not found' }); return; }
    if (!st.isFile()) { json(res, 404, { error: 'not found' }); return; }
    if (st.size > 2 * 1024 * 1024) { json(res, 413, { error: 'too large' }); return; }
    // render=1 (v103): .html only — served as markup behind a CSP sandbox so
    // even direct navigation runs it in an opaque origin; every other request
    // (and every other extension) keeps the inert text/plain default
    const heads = { 'Content-Type': mt, 'Cache-Control': 'no-cache' };
    if (r.url.searchParams.get('render') === '1' && (ext === '.html' || ext === '.htm')) {
      heads['Content-Type'] = 'text/html; charset=utf-8';
      heads['Content-Security-Policy'] = 'sandbox allow-scripts';
      heads['X-Content-Type-Options'] = 'nosniff';
    }
    res.writeHead(200, heads);
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

  // rename (v34): append a native custom-title line - the same record the
  // Desktop CLI writes on rename - so the change lives IN the transcript
  // (persists across boots, replays on every drain). No timestamp on the
  // line => the parser never bumps lastActive/status. Safe mid-run: both
  // sides write whole lines appends-only.
  router.post('/api/sessions/:id/rename', async (req, res, r) => {
    if (!guard(req, res, r)) return;
    const rec = store.get(r.params.id);
    if (!rec || !rec.transcriptPath) { json(res, 404, { error: 'not found' }); return; }
    let jsonIn = {};
    try { jsonIn = JSON.parse(await readBody(req) || '{}'); } catch { /* empty */ }
    const title = String(jsonIn.title || '').trim().slice(0, 120);
    if (!title) { json(res, 400, { error: 'title required' }); return; }
    try {
      // adapter.appendTitle repairs the newline boundary (crash-truncated
      // tail) before appending the native custom-title line
      if (!adapter.appendTitle(r.params.id, title)) { json(res, 500, { error: 'fs: append failed' }); return; }
    } catch (e) {
      json(res, 500, { error: 'fs: ' + (e && e.code || e) });
      return;
    }
    // v39: pin the rename - Desktop flushes its cached pre-rename title back
    // into the transcript and would revert us within seconds otherwise
    adapter.pinRename(r.params.id, title);
    json(res, 200, { ok: true });
  });
}

// v44 markdown export. Conclusions (scope=summary): each user prompt with the
// LAST text of its assistant run - the same "final card" the PWA shows. Full:
// every text + one-line tool quotes; thinking is omitted (model noise).
function buildMarkdown(rec, events, scope) {
  const clean = (t) => String(t == null ? '' : t).replace(/\r\n/g, '\n').trim();
  const L = ['# ' + (rec.title && rec.title !== '(loading)' ? rec.title : rec.id.slice(0, 8))];
  const meta = [];
  if (rec.cwd) meta.push(rec.cwd);
  if (rec.model) meta.push(rec.model);
  if (rec.cost && rec.cost.usd != null) meta.push('$' + Number(rec.cost.usd).toFixed(2));
  meta.push(new Date().toISOString().slice(0, 10));
  L.push('', '> ' + meta.join(' · '), '');

  if (scope === 'summary') {
    let user = '', lastText = '';
    const flush = () => {
      if (user) L.push('## 用户', '', clean(user), '');
      if (lastText) L.push('## 助手', '', clean(lastText), '');
      user = ''; lastText = '';
    };
    for (const ev of events) {
      if (ev.k === 'user') { flush(); user = ev.text || (ev.images && ev.images.length ? '[图片]' : ''); }
      else if (ev.k === 'assistant') {
        for (const p of ev.parts || []) if (p.t === 'text' && p.v && p.v.trim()) lastText = p.v;
      }
    }
    flush();
    return L.join('\n');
  }
  for (const ev of events) {
    if (ev.k === 'user') {
      L.push('## 用户', '', clean(ev.text || (ev.images && ev.images.length ? '[图片附件]' : '')), '');
      if (ev.images && ev.images.length) L.push('> [附件图片 ×' + ev.images.length + ']', '');
    } else if (ev.k === 'assistant') {
      let opened = false;
      for (const p of ev.parts || []) {
        if (p.t === 'text' && p.v && p.v.trim()) { L.push('**助手**', '', clean(p.v), ''); opened = false; }
        else if (p.t === 'tool') {
          if (!opened) { L.push('> 工具调用：'); opened = true; }
          const one = clean(p.v).split('\n')[0].slice(0, 120);
          L.push('> - `' + (p.name || '?') + '` ' + one);
        }
      }
      if (opened) L.push('');
    }
  }
  return L.join('\n');
}
