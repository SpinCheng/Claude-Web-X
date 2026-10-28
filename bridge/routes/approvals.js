// routes/approvals.js - phone permission cards: the headless CLI's
// approve-mcp server POSTs /internal/approval (localhost); the phone polls
// pending cards and answers via POST /api/approvals/:id
import { authOk, readBody } from '../lib/auth.js';

export function register(router, ctx) {
  const { cfg, runner, hub } = ctx;

  router.post('/internal/approval', async (req, res, r) => {
    const ra = req.socket.remoteAddress || '';
    const local = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
    if (!local) { res.writeHead(403); res.end('{"error":"localhost only"}'); return; }
    const runId = r.url.searchParams.get('run') || '';
    const run = runner.getRun(runId);
    if (!runId || !run) { res.writeHead(404); res.end('{"behavior":"deny","message":"unknown run"}'); return; }
    const body = await readBody(req, 64 * 1024);
    let json = {}; try { json = body ? JSON.parse(body) : {}; } catch { /* deny below */ }
    if (!json.tool_name) { res.writeHead(400); res.end('{"behavior":"deny","message":"missing tool_name"}'); return; }
    const decision = await hub.askApproval(runId, run.sessionId, json.tool_name, json.input || {});
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(decision));
  });

  router.get('/api/approvals/pending', (req, res, r) => {
    if (!authOk(req, r.url, cfg)) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ approvals: [...hub.approvals.entries()].map(([id, a]) => ({
      id, runId: a.runId, sessionId: a.sessionId, tool: a.tool, input: a.input,
    })) }));
  });

  router.post('/api/approvals/:id', async (req, res, r) => {
    if (!authOk(req, r.url, cfg)) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
    const body = await readBody(req, 4096);
    let json = {}; try { json = body ? JSON.parse(body) : {}; } catch { json = {}; }
    // v44 session-level always-allow: record (session, tool) BEFORE finishing,
    // then the current ask resolves as a normal allow
    if (json.decision === 'allow' && json.allowSession) {
      const rec = hub.approvals.get(r.params.id);
      if (rec) hub.allowSessionTool(rec.sessionId, rec.tool);
    }
    const decision = json.decision === 'allow'
      ? { behavior: 'allow', updatedInput: {} }
      : { behavior: 'deny', message: json.reason || '手机端拒绝' };
    const ok = hub.finishApproval(r.params.id, decision);
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok }));
  });
}
