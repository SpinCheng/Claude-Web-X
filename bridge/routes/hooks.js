// routes/hooks.js - Claude Code hook callbacks (Stop / Notification / ...).
// Permission notifications become a persistent per-session waiting state;
// the prompt itself never reaches the transcript.
import { authOk } from '../lib/auth.js';
import { handleHook } from '../hooks.js';

export function register(router, ctx) {
  const { cfg, store, hub } = ctx;

  router.post('/hooks/:event', async (req, res, r) => {
    if (!authOk(req, r.url, cfg)) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
    const rr = await handleHook(req, res, cfg, store, hub.broadcast, r.params.event);
    if (rr && rr.sessionId) {
      if (rr.waiting) hub.waitSet(rr.sessionId, rr.waiting);
      else if (r.params.event === 'stop') hub.waitClear(rr.sessionId);
    }
  });
}
