#!/usr/bin/env node
// hook-agent-wait.mjs - agent-guard Stop hook (v158). Spawned by the CLI via
// the runner's per-run --settings injection; on EVERY turn end it asks the
// bridge whether this session still has running background agents. If yes,
// the hook blocks the stop (decision:block) with a reason that tells the
// model to wait on the agents via TaskOutput - so a phone one-shot run stays
// alive until its agents finish, without the user writing any prompt magic.
// Without this, the CLI exits at turn end and its in-process agents are
// killed mid-work (v154 real-data find).
//
// Diagnostics to stderr; stdout gets ONLY the hook JSON verdict.
const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : ''; };
const PORT = arg('port') || '3742';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', async () => {
  let sessionId = '';
  try {
    const j = JSON.parse(input || '{}');
    sessionId = j.session_id || j.sessionId || '';
  } catch { /* malformed stdin -> allow the stop */ }
  if (!sessionId) { process.stdout.write('{}\n'); process.exit(0); }
  try {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(`http://localhost:${PORT}/internal/agent-wait`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
      signal: ctl.signal,
    });
    if (!r.ok) { process.stdout.write('{}\n'); process.exit(0); }
    const v = await r.json();
    process.stdout.write(JSON.stringify(v) + '\n');
  } catch {
    process.stdout.write('{}\n'); // bridge unreachable -> never trap the turn
  }
  process.exit(0);
});
