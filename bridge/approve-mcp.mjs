#!/usr/bin/env node
// approve-mcp.mjs - minimal MCP stdio server (zero deps, raw JSON-RPC over
// newline-delimited JSON) exposing ONE tool: phone_approve.
//
// Claude Code runs with --permission-prompt-tool mcp__crapprove__phone_approve;
// when a headless run needs a permission decision it calls this tool, we POST
// to the bridge (localhost), the bridge pushes an approval card to the phone,
// and we long-poll until the owner answers (or timeout -> deny).
//
// Spawned per-run via --mcp-config. All diagnostics go to stderr: stdout is
// the protocol channel and must stay clean.
const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : ''; };
const RUN = arg('run');
const PORT = arg('port') || '3742';
const TIMEOUT_MS = 190_000; // slightly above the bridge's 180s deny timeout

if (!RUN) { console.error('approve-mcp: --run required'); process.exit(1); }

let seq = 0;
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function askBridge(toolName, input) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`http://localhost:${PORT}/internal/approval?run=${encodeURIComponent(RUN)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool_name: toolName, input }),
      signal: ctl.signal,
    });
    if (!r.ok) return { behavior: 'deny', message: 'bridge error: HTTP ' + r.status };
    return await r.json();
  } catch (e) {
    return { behavior: 'deny', message: 'approval channel failed: ' + (e && e.name === 'AbortError' ? 'timeout' : e.message) };
  } finally { clearTimeout(t); }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { console.error('approve-mcp: bad line'); continue; }
    handle(msg).catch((e) => console.error('approve-mcp:', e && e.message));
  }
});
process.stdin.on('end', () => process.exit(0));

async function handle(msg) {
  if (msg.method === 'initialize') {
    reply(msg.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'claude-remote-approve', version: '0.1.0' },
    });
  } else if (msg.method === 'tools/list') {
    reply(msg.id, { tools: [{
      name: 'phone_approve',
      description: 'Forward a permission prompt to the phone owner for approval',
      inputSchema: {
        type: 'object',
        properties: {
          tool_name: { type: 'string', description: 'the tool requesting permission' },
          input: { type: 'object', description: 'the tool call input' },
        },
        required: ['tool_name'],
      },
    }] });
  } else if (msg.method === 'tools/call') {
    const args = (msg.params && msg.params.arguments) || {};
    const decision = await askBridge(String(args.tool_name || '?'), args.input || {});
    // permission-prompt-tool contract: parsed text JSON drives the decision
    reply(msg.id, { content: [{ type: 'text', text: JSON.stringify(decision) }] });
  }
  // notifications (initialized etc.) get no response
}
