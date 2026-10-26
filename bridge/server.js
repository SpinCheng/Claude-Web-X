// server.js - composition root: router + ws hub + static PWA + event wiring.
// Route semantics live in routes/*, shared plumbing in lib/* (refactor step 3).
//   GET  /                      static PWA (public/)
//   GET  /api/ping              auth check
//   GET  /api/sessions          session list (mergedSessions - the ONE source)
//   GET  /api/sessions/:id/messages|preview|queue|driver|context
//   POST /api/sessions/:id/message|driver|attach   phone send / takeover / upload
//   POST /api/sessions/new      runner new session
//   POST /api/runs/:runId/cancel
//   queue item ops: GET/DELETE /api/sessions/:id/queue[/qid], reorder, runnow
//   POST /hooks/:event          Claude Code hook callbacks (token via query)
//   POST /internal/approval     approve-mcp callback (localhost)
//   /api/pair/*                 pairing panel (same-machine, no token)
//   WS   /ws?token=...          live push: sessions / append / notify / run
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHub } from './lib/wshub.js';
import { createRouter } from './lib/router.js';
import { MIME } from './lib/mime.js';
import * as routesPairing from './routes/pairing.js';
import * as routesApprovals from './routes/approvals.js';
import * as routesHooks from './routes/hooks.js';
import * as routesAttachments from './routes/attachments.js';
import * as routesSessions from './routes/sessions.js';
import * as routesMessage from './routes/message.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

export function createServer(cfg, store, adapter, runner, handoff, paths = {}, ctxprobe = null) {
  const UPLOADS_DIR = paths.uploadsDir || path.join(__dirname, 'data', 'uploads');
  const hub = createHub({ cfg, store, runner });
  const ctx = { cfg, store, adapter, runner, handoff, paths, ctxprobe, hub, UPLOADS_DIR };

  const router = createRouter();
  routesPairing.register(router, ctx);     // panel first: same-machine, no token
  routesApprovals.register(router, ctx);
  routesHooks.register(router, ctx);
  routesAttachments.register(router, ctx);
  routesSessions.register(router, ctx);
  routesMessage.register(router, ctx);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (await router.dispatch(req, res, url)) return;
    } catch (e) {
      // route errors must never take the bridge down
      console.error('[bridge] route error:', req.method, url.pathname, (e && e.message) || e);
      try { res.writeHead(500); res.end('{"error":"internal"}'); } catch { /* socket gone */ }
      return;
    }
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    serveStatic(url.pathname, res, req.headers);
  });

  hub.attach(server);

  // ------- wire adapter events -------
  store.on('session', hub.broadcastSessionsSoon);
  adapter.on('append', (a) => {
    hub.broadcast({ type: 'append', ...a });
    // transcript writing again = the PC answered the prompt; drop the banner
    hub.waitClear(a.id);
  });

  // ------- wire runner events (Phase 2) -------
  runner.on('update', (u) => {
    if (u.state === 'running' && u.sessionId) handoff.phoneRunStarted(u.sessionId);
    if (u.state === 'end' || u.state === 'error') {
      handoff.phoneRunEnded(u.sessionId);
      hub.denyAllForRun(u.runId, 'run ended');
    }
    hub.broadcast({ type: 'run', ...u });
    hub.broadcastSessionsSoon();
  });
  runner.on('queued-dispatch', (q) => {
    hub.broadcast({ type: 'queue-dispatched', sessionId: q.sessionId, remaining: q.remaining });
    hub.broadcastSessionsSoon();
  });
  // any queue mutation (enqueue/remove/reorder/clear/drain) pushes a snapshot
  runner.on('queue-changed', (q) => {
    hub.broadcast({ type: 'queue', sessionId: q.sessionId, queue: q.queue });
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

  return { server, broadcast: hub.broadcast };
}
