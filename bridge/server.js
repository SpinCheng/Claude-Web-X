// server.js - HTTP + WebSocket server for the bridge.
// Routes:
//   GET  /                      static PWA (public/)
//   GET  /api/ping              auth check
//   GET  /api/sessions          session list
//   GET  /api/sessions/:id/messages   full transcript events
//   GET  /api/sessions/:id/driver     current driver / takeover status
//   POST /api/sessions/:id/driver     {action:'claim-pc'|'release'} (cr.ps1)
//   POST /api/sessions/:id/message    {text, force} -> runner resume (phone send)
//   POST /api/sessions/new            {text, cwd}    -> runner new session
//   POST /api/runs/:runId/cancel      kill a running turn
//   POST /hooks/:event          Claude Code hook callbacks (token via query)
//   WS   /ws?token=...          live push: sessions / append / notify / run
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { authOk, handleHook, readBody, readRawBody } from './hooks.js';
import { rotateToken, installAutostart, autostartInstalled, lanUrls } from './pairing.js';

// model catalog from ~/.claude/settings.json env aliases (shared by
// /api/models and the context-probe endpoint)
function readModelCatalog() {
  const models = [];
  try {
    const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
    const env = s.env || {};
    const ctxOf = (id) => (/\[1m\]/i.test(String(id)) || /(^|[-.])1m$/i.test(String(id)) ? 1_000_000 : 200_000);
    const seen = new Set();
    if (env.ANTHROPIC_MODEL) {
      seen.add(env.ANTHROPIC_MODEL);
      models.push({ id: env.ANTHROPIC_MODEL, label: env.ANTHROPIC_MODEL, ctx: ctxOf(env.ANTHROPIC_MODEL) });
    }
    for (const tier of ['opus', 'sonnet', 'haiku']) {
      const id = env['ANTHROPIC_DEFAULT_' + tier.toUpperCase() + '_MODEL'];
      const label = env['ANTHROPIC_DEFAULT_' + tier.toUpperCase() + '_MODEL_NAME'];
      if (!id || !label || seen.has(label)) continue;
      seen.add(label);
      models.push({ id, label, ctx: ctxOf(id) });
    }
  } catch { /* fall through with empty list */ }
  return models;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
};

export function createServer(cfg, store, adapter, runner, handoff, paths = {}, ctxprobe = null) {
  const UPLOADS_DIR = paths.uploadsDir || path.join(__dirname, 'data', 'uploads');
  // per-session "PC is stuck on a prompt" state (Notification hook driven);
  // cleared by transcript activity or the Stop hook - see wire-adapter below
  const waitings = new Map();
  // message.attachments gate: only files this session uploaded, sane names
  function normAttachments(sessionId, list) {
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
  // ------- broadcast plumbing -------
  let sessionsDirty = false;
  const clients = new Set(); // ws sockets; ws.subId = subscribed session id

  function broadcast(obj) {
    const raw = JSON.stringify(obj);
    for (const ws of clients) {
      if (ws.readyState !== 1) continue;
      // append events only go to the subscriber of that session
      if (obj.type === 'append' && ws.subId !== obj.id) continue;
      ws.send(raw);
    }
  }

  function broadcastSessionsSoon() {
    if (sessionsDirty) return;
    sessionsDirty = true;
    setTimeout(() => {
      sessionsDirty = false;
      broadcast({ type: 'sessions', sessions: mergedSessions() });
    }, 250);
  }

  // ------- remote permission approvals (phone approval cards) -------
  // The headless CLI's approve-mcp server POSTs /internal/approval; we hold
  // that response open until the phone answers (WS 'approval' frame ->
  // POST /api/approvals/:id) or deny after a timeout.
  const approvals = new Map(); // id -> {runId, sessionId, tool, input, resolve, timer}

  function askApproval(runId, sessionId, tool, input) {
    return new Promise((resolve) => {
      const id = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const rec = { runId, sessionId, tool, input, resolve, createdAt: Date.now() };
      approvals.set(id, rec);
      rec.timer = setTimeout(() => {
        finishApproval(id, { behavior: 'deny', message: '手机未响应（超时 3 分钟），已自动拒绝' });
      }, 180_000);
      broadcast({ type: 'approval', id, runId, sessionId, tool, input });
    });
  }
  function finishApproval(id, decision) {
    const rec = approvals.get(id);
    if (!rec) return false;
    clearTimeout(rec.timer);
    approvals.delete(id);
    rec.resolve(decision);
    broadcast({ type: 'approval-result', id, runId: rec.runId, decision: decision.behavior });
    return true;
  }
  function denyAllForRun(runId, message) {
    for (const [id, rec] of approvals) {
      if (rec.runId === runId) finishApproval(id, { behavior: 'deny', message: message || 'run ended' });
    }
  }

  // ------- HTTP -------
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (req.method === 'POST' && p.startsWith('/hooks/')) {
      if (!authOk(req, url, cfg)) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
      const event = p.slice('/hooks/'.length).split('/')[0] || 'unknown';
      const rr = await handleHook(req, res, cfg, store, broadcast, event);
      // permission notifications become a persistent per-session waiting
      // state (the prompt itself never reaches the transcript)
      if (rr && rr.sessionId) {
        if (rr.waiting) {
          waitings.set(rr.sessionId, rr.waiting);
          broadcast({ type: 'wait', sessionId: rr.sessionId, waiting: rr.waiting });
        } else if (event === 'stop' && waitings.has(rr.sessionId)) {
          waitings.delete(rr.sessionId);
          broadcast({ type: 'wait', sessionId: rr.sessionId, waiting: null });
        }
      }
      return;
    }

    if (req.method === 'POST' && p === '/internal/approval') {
      const ra = req.socket.remoteAddress || '';
      const local = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
      if (!local) { res.writeHead(403); res.end('{"error":"localhost only"}'); return; }
      const runId = url.searchParams.get('run') || '';
      const run = runner.getRun(runId);
      if (!runId || !run) { res.writeHead(404); res.end('{"behavior":"deny","message":"unknown run"}'); return; }
      const body = await readBody(req, 64 * 1024);
      let json = {}; try { json = body ? JSON.parse(body) : {}; } catch { /* deny below */ }
      if (!json.tool_name) { res.writeHead(400); res.end('{"behavior":"deny","message":"missing tool_name"}'); return; }
      const decision = await askApproval(runId, run.sessionId, json.tool_name, json.input || {});
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(decision));
      return;
    }

    if (req.method === 'GET' && p === '/api/approvals/pending') {
      if (!authOk(req, url, cfg)) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ approvals: [...approvals.entries()].map(([id, a]) => ({
        id, runId: a.runId, sessionId: a.sessionId, tool: a.tool, input: a.input,
      })) }));
      return;
    }

    if (req.method === 'POST' && /^\/api\/approvals\/([^/]+)$/.test(p)) {
      if (!authOk(req, url, cfg)) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
      const id = decodeURIComponent(p.split('/')[3]);
      const body = await readBody(req, 4096);
      let json = {}; try { json = body ? JSON.parse(body) : {}; } catch { json = {}; }
      const decision = json.decision === 'allow'
        ? { behavior: 'allow', updatedInput: {} }
        : { behavior: 'deny', message: json.reason || '手机端拒绝' };
      const ok = finishApproval(id, decision);
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok }));
      return;
    }

    // pairing panel API: localhost ONLY, no token (its whole job is to hand
    // the token to the person already sitting at this machine)
    if (p.startsWith('/api/pair/')) {
      // same-machine only (not just loopback): opening the panel via the LAN
      // IP on the PC itself is fine; other devices still get 403
      const norm = (a) => (a || '').replace(/^::ffff:/, '');
      const ra = norm(req.socket.remoteAddress);
      const la = norm(req.socket.localAddress);
      const local = ra === '127.0.0.1' || ra === '::1' || (la && ra === la);
      if (!local) { res.writeHead(403); res.end('{"error":"same-machine only"}'); return; }
      if (p === '/api/pair/info' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          token: cfg.token, port: cfg.port,
          urls: lanUrls(cfg.port).map((u) => u + cfg.token),
          autostart: autostartInstalled(),
        }));
        return;
      }
      if (p === '/api/pair/rotate' && req.method === 'POST') {
        const r = rotateToken(cfg, paths);
        if (!r.ok) { res.writeHead(500); res.end(JSON.stringify({ error: r.error })); return; }
        // token changed: drop every live WS client so nothing rides the old token
        for (const ws of clients) { try { ws.close(1008, 'token rotated'); } catch { /* already gone */ } }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: true, token: r.token, backup: r.backup,
          urls: lanUrls(cfg.port).map((u) => u + r.token),
        }));
        return;
      }
      if (p === '/api/pair/autostart' && req.method === 'POST') {
        const r = installAutostart(paths.vbsPath || '');
        res.writeHead(r.ok ? 200 : 500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(r));
        return;
      }
      res.writeHead(404); res.end('{"error":"no such api"}');
      return;
    }

    if (req.method === 'GET' && p.startsWith('/api/')) {
      if (!authOk(req, url, cfg)) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }

      // model catalog for the picker: ANTHROPIC_DEFAULT_<TIER>_MODEL is the id
      // the CLI actually sends; the paired _MODEL_NAME holds the relay's real
      // name (glm-5.3 ...) - the only thing users should ever see.
      if (p === '/api/models') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ models: readModelCatalog() }));
        return;
      }
      if (p === '/api/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, version: '0.1.0' }));
        return;
      }
      if (p === '/api/sessions') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ sessions: mergedSessions() }));
        return;
      }
      let m = p.match(/^\/api\/sessions\/([^/]+)\/messages$/);
      if (m) {
        const events = adapter.readTranscript(decodeURIComponent(m[1]));
        if (!events) { res.writeHead(404); res.end('{"error":"not found"}'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ events }));
        return;
      }
      // pending queue snapshot (ids + texts) for the composer queue panel
      m = p.match(/^\/api\/sessions\/([^/]+)\/queue$/);
      if (m) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, queue: runner.queueSnapshot(decodeURIComponent(m[1])) }));
        return;
      }
      // ground-truth context breakdown for a session's (cwd, model): runs the
      // CLI's /context in a throwaway session, returns the same fixed-part
      // accounting the Desktop popover shows. Cached bridge-side after 1st hit.
      m = p.match(/^\/api\/sessions\/([^/]+)\/context$/);
      if (m && ctxprobe) {
        const rec = store.get(decodeURIComponent(m[1]));
        if (!rec) { res.writeHead(404); res.end('{"error":"not found"}'); return; }
        const modelId = (readModelCatalog().find((x) => x.label === (rec.model || '')) || {}).id || '';
        try {
          const r = await ctxprobe.get(rec.cwd || cfg.defaultCwd || '', modelId);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, ...r }));
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
        }
        return;
      }
      m = p.match(/^\/api\/sessions\/([^/]+)\/driver$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const st = handoff.status(id);
        st.phoneRun = !!runner.activeRunFor(id);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(st));
        return;
      }
      res.writeHead(404); res.end('{"error":"no such api"}');
      return;
    }

    // control-plane routes (Phase 2): JSON bodies, token-authed like /api
    if ((req.method === 'POST' || req.method === 'DELETE') && p.startsWith('/api/')) {
      if (!authOk(req, url, cfg)) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }

      // attachment upload (v19): RAW body, up to 10 MB; stored under
      // data/uploads/<sessionId>/ and referenced by message.attachments
      let am = p.match(/^\/api\/sessions\/([^/]+)\/attach$/);
      if (am && req.method === 'POST') {
        const sid = decodeURIComponent(am[1]);
        if (!store.get(sid)) { res.writeHead(404); res.end('{"error":"no such session"}'); return; }
        const raw = await readRawBody(req, 10 * 1024 * 1024);
        if (!raw || !raw.length) { res.writeHead(400); res.end('{"error":"empty body"}'); return; }
        const base = (url.searchParams.get('name') || 'file.bin').split(/[\\/]/).pop().replace(/[^\w.\- ()一-龥]/g, '_').slice(0, 80) || 'file.bin';
        const dir = path.join(UPLOADS_DIR, sid);
        try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
        const saved = Date.now().toString(36) + '-' + base;
        try { fs.writeFileSync(path.join(dir, saved), raw); } catch { res.writeHead(500); res.end('{"error":"write failed"}'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, file: sid + '/' + saved, name: base, size: raw.length }));
        return;
      }

      const body = await readBody(req, 256 * 1024);
      let json = {};
      try { json = body ? JSON.parse(body) : {}; } catch { json = {}; }

      let m = p.match(/^\/api\/sessions\/([^/]+)\/message$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const text = String(json.text || '').trim();
        if (!text) { res.writeHead(400); res.end('{"error":"text required"}'); return; }
        // our own run writing the transcript is not a foreign writer: skip the
        // mtime arbitration and let the busy path queue the follow-up instead
        const arb = runner.activeRunFor(id)
          ? { ok: true }
          : handoff.checkPhoneSend(id, !!json.force);
        if (!arb.ok) {
          res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: arb.reason, lastWriteMs: arb.lastWriteMs, sinceMs: arb.sinceMs, claimedAt: arb.claimedAt }));
          return;
        }
        const r = runner.send(id, text, { perm: json.perm === 'ask' ? 'ask' : 'auto', model: String(json.model || ''), effort: String(json.effort || ''), attachments: normAttachments(id, json.attachments) });
        if (r.queued) {
          res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, queued: true, position: r.position }));
          return;
        }
        if (r.error === 'queue-full') { res.writeHead(503); res.end('{"error":"queue-full"}'); return; }
        if (r.error === 'busy') { res.writeHead(409); res.end('{"error":"busy"}'); return; }
        if (r.error) { res.writeHead(r.error === 'overloaded' ? 503 : 400); res.end(JSON.stringify({ error: r.error })); return; }
        res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, runId: r.runId }));
        return;
      }

      if (p === '/api/sessions/new') {
        const text = String(json.text || '').trim();
        if (!text) { res.writeHead(400); res.end('{"error":"text required"}'); return; }
        const r = runner.start(text, json.cwd || cfg.defaultCwd || '', { perm: json.perm === 'ask' ? 'ask' : 'auto', model: String(json.model || ''), effort: String(json.effort || '') });
        if (r.error) { res.writeHead(r.error === 'overloaded' ? 503 : 400); res.end(JSON.stringify({ error: r.error })); return; }
        res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, runId: r.runId }));
        return;
      }

      m = p.match(/^\/api\/runs\/([^/]+)\/cancel$/);
      if (m) {
        const runId = decodeURIComponent(m[1]);
        denyAllForRun(runId, 'run cancelled');
        const ok = runner.cancel(runId);
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok }));
        return;
      }

      // clear pending queued messages for a session
      m = p.match(/^\/api\/sessions\/([^/]+)\/queue$/);
      if (m && req.method === 'DELETE') {
        const n = runner.clearQueue(decodeURIComponent(m[1]));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, cleared: n }));
        return;
      }

      // drag reorder: full id order (visible rows + hidden tail)
      m = p.match(/^\/api\/sessions\/([^/]+)\/queue\/reorder$/);
      if (m && req.method === 'POST') {
        const ok = runner.reorderQueue(decodeURIComponent(m[1]), json.order);
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok }));
        return;
      }

      // remove one queued message
      m = p.match(/^\/api\/sessions\/([^/]+)\/queue\/([^/]+)$/);
      if (m && req.method === 'DELETE') {
        const ok = runner.removeQueued(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok }));
        return;
      }

      // "run now": jump this queued item to the front + interrupt the active run
      m = p.match(/^\/api\/sessions\/([^/]+)\/queue\/([^/]+)\/runnow$/);
      if (m && req.method === 'POST') {
        const id = decodeURIComponent(m[1]);
        const qid = decodeURIComponent(m[2]);
        const run = runner.activeRunFor(id);
        if (run) denyAllForRun(run.runId, 'run interrupted by queued item');
        const ok = runner.runNow(id, qid);
        res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok }));
        return;
      }

      m = p.match(/^\/api\/sessions\/([^/]+)\/driver$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (json.action === 'claim-pc') {
          res.end(JSON.stringify(handoff.claimPc(id)));
          return;
        }
        if (json.action === 'release') {
          res.end(JSON.stringify(handoff.release(id)));
          return;
        }
        res.writeHead(400); res.end('{"error":"action required"}');
        return;
      }

      // DELETE /api/sessions/:id - reversible delete (transcript -> data/trash)
      m = p.match(/^\/api\/sessions\/([^/]+)$/);
      if (m && req.method === 'DELETE') {
        const id = decodeURIComponent(m[1]);
        if (runner.activeRunFor(id)) { res.writeHead(409); res.end('{"error":"busy"}'); return; }
        const r = adapter.archiveSession(id);
        if (!r.ok) { res.writeHead(404); res.end(JSON.stringify({ error: r.error })); return; }
        try { fs.rmSync(path.join(UPLOADS_DIR, id), { recursive: true, force: true }); } catch { /* nothing stored */ }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(r));
        return;
      }

      res.writeHead(404); res.end('{"error":"no such api"}');
      return;
    }

    // uploaded attachments: token-authed, locked inside the uploads dir
    if (req.method === 'GET' && p.startsWith('/files/')) {
      if (!authOk(req, url, cfg)) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
      const file = path.normalize(path.join(UPLOADS_DIR, decodeURIComponent(p.slice('/files/'.length))));
      if (!file.startsWith(UPLOADS_DIR)) { res.writeHead(403); res.end(); return; }
      let st; try { st = fs.statSync(file); } catch { res.writeHead(404); res.end('not found'); return; }
      if (!st.isFile()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.end(data);
      });
      return;
    }

    // static PWA
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    serveStatic(p, res, req.headers);
  });

  function serveStatic(p, res, reqHeaders = {}) {
    let rel = p === '/' ? '/index.html' : (p === '/pair' ? '/pair.html' : p);
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
    let st; try { st = fs.statSync(file); } catch { res.writeHead(404); res.end('not found'); return; }
    // always revalidate: stale JS/CSS after an update breaks the PWA silently
    const etag = '"' + st.size.toString(16) + '-' + st.mtimeMs.toString(16) + '"';
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('ETag', etag);
    if (reqHeaders['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  }

  // ------- WebSocket -------
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws' || !authOk(req, url, cfg)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.subId = null;
      ws.send(JSON.stringify({ type: 'sessions', sessions: mergedSessions() }));
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'subscribe') {
            ws.subId = msg.id || null;
            ws.send(JSON.stringify({ type: 'subscribed', id: ws.subId }));
          } else if (msg.type === 'unsubscribe') {
            ws.subId = null;
          }
        } catch { /* ignore malformed */ }
      });
      ws.on('close', () => clients.delete(ws));
    });
  });

  // ------- wire adapter events -------
  store.on('session', broadcastSessionsSoon);
  adapter.on('append', (a) => {
    broadcast({ type: 'append', ...a });
    // transcript writing again = the PC answered the prompt; drop the banner
    if (waitings.has(a.id)) {
      waitings.delete(a.id);
      broadcast({ type: 'wait', sessionId: a.id, waiting: null });
    }
  });

  function mergedSessions() {
    return store.list().map((s) => {
      const live = runner.activeRunFor(s.id);
      const out = runner.recallOutcome(s.id);
      return { ...s, running: !!live, queued: runner.queuedFor(s.id).length, waiting: waitings.get(s.id) || null, lastRun: out || null, lastOutcome: s.lastOutcome || (out ? out.state : '') };
    });
  }

  // ------- wire runner events (Phase 2) -------
  runner.on('update', (u) => {
    if (u.state === 'running' && u.sessionId) handoff.phoneRunStarted(u.sessionId);
    if (u.state === 'end' || u.state === 'error') {
      handoff.phoneRunEnded(u.sessionId);
      denyAllForRun(u.runId, 'run ended');
    }
    broadcast({ type: 'run', ...u });
    broadcastSessionsSoon();
  });
  runner.on('queued-dispatch', (q) => {
    broadcast({ type: 'queue-dispatched', sessionId: q.sessionId, remaining: q.remaining });
    broadcastSessionsSoon();
  });
  // any queue mutation (enqueue/remove/reorder/clear/drain) pushes a snapshot
  runner.on('queue-changed', (q) => {
    broadcast({ type: 'queue', sessionId: q.sessionId, queue: q.queue });
  });

  return { server, broadcast };
}
