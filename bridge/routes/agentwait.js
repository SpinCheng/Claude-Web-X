// routes/agentwait.mjs - the agent-guard Stop hook's callback (v158): the
// runner-injected per-run --settings Stop hook (hook-agent-wait.mjs) POSTs
// here on every turn end; the bridge answers block (with a wait instruction
// reason) while the session still has running background agents, so a phone
// one-shot run outlives its agents. Absolute 30-minute cap per session (the
// agents should be dead by then even in the worst case; the user's stop
// button and the runner watchdog remain the escapes).
const WAIT_CAP_MS = 30 * 60 * 1000;
const REASON = (n) => '[agent-wait] 还有 ' + n + ' 个后台代理在运行。不要结束本轮：用 TaskOutput 轮询等待它们全部完成（不要提前结束、不要输出总结），全部完成后再继续任务。';

export function register(router, ctx) {
  const { adapter } = ctx;
  const firstBlock = new Map(); // sessionId -> first block ts (absolute cap)

  router.post('/internal/agent-wait', async (req, res, r) => {
    const ra = req.socket.remoteAddress || '';
    const local = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
    if (!local) { res.writeHead(403); res.end('{"error":"localhost only"}'); return; }
    const body = await new Promise((resolve) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > 64 * 1024) { req.destroy(); resolve(''); return; } chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => resolve(''));
    });
    let sessionId = '';
    try { sessionId = String(JSON.parse(body || '{}').sessionId || ''); } catch { /* empty */ }
    const verdict = {};
    if (sessionId && adapter.agents) {
      const running = (adapter.agents.summariesFor(sessionId) || []).filter((a) => !a.finished);
      if (running.length) {
        const t0 = firstBlock.get(sessionId) || (firstBlock.set(sessionId, Date.now()), Date.now());
        if (Date.now() - t0 < WAIT_CAP_MS) {
          verdict.decision = 'block';
          verdict.reason = REASON(running.length);
        } else {
          firstBlock.delete(sessionId); // give up: let the turn end
        }
      } else {
        firstBlock.delete(sessionId); // agents done -> clean slate for the next run
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(verdict));
  });
}
