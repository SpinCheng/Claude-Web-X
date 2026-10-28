// routes/message.js - write-side: send/queue/cancel/takeover
import { authOk, readBody } from '../lib/auth.js';
import { normAttachments } from './attachments.js';

export function register(router, ctx) {
  const { cfg, runner, handoff, hub } = ctx;
  const guard = (req, res, r) => {
    if (authOk(req, r.url, cfg)) return true;
    res.writeHead(401); res.end('{"error":"unauthorized"}');
    return false;
  };
  const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  const readJson = async (req, limit = 256 * 1024) => {
    const body = await readBody(req, limit);
    try { return body ? JSON.parse(body) : {}; } catch { return {}; }
  };

  router.post('/api/sessions/:id/message', async (req, res, r) => {
    if (!guard(req, res, r)) return;
    const jsonIn = await readJson(req);
    const id = r.params.id;
    const text = String(jsonIn.text || '').trim();
    if (!text) { json(res, 400, { error: 'text required' }); return; }
    // our own run writing the transcript is not a foreign writer: skip the
    // mtime arbitration and let the busy path queue the follow-up instead
    const arb = runner.activeRunFor(id)
      ? { ok: true }
      : handoff.checkPhoneSend(id, !!jsonIn.force);
    if (!arb.ok) {
      json(res, 409, { error: arb.reason, lastWriteMs: arb.lastWriteMs, sinceMs: arb.sinceMs, claimedAt: arb.claimedAt });
      return;
    }
    // v40 branch: branchFrom must be THIS session (the thread being forked);
    // the CLI forks it into a new session id via --fork-session
    const forkFrom = jsonIn.branchFrom === id ? id : '';
    const out = runner.send(id, text, { perm: jsonIn.perm === 'ask' ? 'ask' : 'auto', model: String(jsonIn.model || ''), effort: String(jsonIn.effort || ''), forkFrom, attachments: normAttachments(id, jsonIn.attachments, ctx) });
    if (out.queued) { json(res, 202, { ok: true, queued: true, position: out.position }); return; }
    if (out.error === 'queue-full') { res.writeHead(503); res.end('{"error":"queue-full"}'); return; }
    if (out.error === 'busy') { res.writeHead(409); res.end('{"error":"busy"}'); return; }
    if (out.error) { res.writeHead(out.error === 'overloaded' ? 503 : 400); res.end(JSON.stringify({ error: out.error })); return; }
    json(res, 202, { ok: true, runId: out.runId });
  });

  router.post('/api/sessions/new', async (req, res, r) => {
    if (!guard(req, res, r)) return;
    const jsonIn = await readJson(req);
    const text = String(jsonIn.text || '').trim();
    if (!text) { json(res, 400, { error: 'text required' }); return; }
    const out = runner.start(text, jsonIn.cwd || cfg.defaultCwd || '', { perm: jsonIn.perm === 'ask' ? 'ask' : 'auto', model: String(jsonIn.model || ''), effort: String(jsonIn.effort || '') });
    if (out.error) { res.writeHead(out.error === 'overloaded' ? 503 : 400); res.end(JSON.stringify({ error: out.error })); return; }
    json(res, 202, { ok: true, runId: out.runId });
  });

  router.post('/api/runs/:runId/cancel', async (req, res, r) => {
    if (!guard(req, res, r)) return;
    hub.denyAllForRun(r.params.runId, 'run cancelled');
    const ok = runner.cancel(r.params.runId);
    json(res, ok ? 200 : 404, { ok });
  });

  // clear pending queued messages for a session
  router.del('/api/sessions/:id/queue', (req, res, r) => {
    if (!guard(req, res, r)) return;
    const cleared = runner.clearQueue(r.params.id);
    json(res, 200, { ok: true, cleared });
  });

  // remove one queued message
  router.del('/api/sessions/:id/queue/:qid', (req, res, r) => {
    if (!guard(req, res, r)) return;
    const ok = runner.removeQueued(r.params.id, r.params.qid);
    json(res, ok ? 200 : 404, { ok });
  });

  // drag reorder: full id order (visible rows + hidden tail)
  router.post('/api/sessions/:id/queue/reorder', async (req, res, r) => {
    if (!guard(req, res, r)) return;
    const jsonIn = await readJson(req);
    const ok = runner.reorderQueue(r.params.id, jsonIn.order);
    json(res, ok ? 200 : 400, { ok });
  });

  // "run now": jump this queued item to the front + interrupt the active run
  router.post('/api/sessions/:id/queue/:qid/runnow', async (req, res, r) => {
    if (!guard(req, res, r)) return;
    const run = runner.activeRunFor(r.params.id);
    if (run) hub.denyAllForRun(run.runId, 'run interrupted by queued item');
    const ok = runner.runNow(r.params.id, r.params.qid);
    json(res, ok ? 200 : 404, { ok });
  });

  router.post('/api/sessions/:id/driver', async (req, res, r) => {
    if (!guard(req, res, r)) return;
    const jsonIn = await readJson(req);
    if (jsonIn.action === 'claim-pc') { res.end(JSON.stringify(handoff.claimPc(r.params.id))); return; }
    if (jsonIn.action === 'release') { res.end(JSON.stringify(handoff.release(r.params.id))); return; }
    res.writeHead(400); res.end('{"error":"action required"}');
  });
}
