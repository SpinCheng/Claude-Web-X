// cli/cr.mjs - cross-platform PC-side takeover helper (replaces cr.ps1).
// Usage: node cli/cr.mjs list | attach <n|id> | release <n|id> | url
//
// `attach` claims the session (advisory lock via the bridge), injects the
// relay env block from ~/.claude/settings.json into the child (in-memory
// only), and opens an interactive `claude --resume` in this terminal; the
// claim auto-releases when the CLI exits. Node >= 20, zero deps.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findClaudeBinary } from '../bridge/lib/platform.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfgPath = path.resolve(__dirname, '..', 'bridge', 'data', 'config.json');
if (!fs.existsSync(cfgPath)) {
  console.error(`[FAIL] bridge config not found: ${cfgPath}\n       start the bridge first (npm start).`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const base = `http://localhost:${cfg.port}`;
const hdr = { Authorization: 'Bearer ' + cfg.token };

async function api(p, opts = {}) {
  const r = await fetch(base + p, { ...opts, headers: { ...hdr, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => '')}`.slice(0, 160));
  return r.json();
}

async function getSessions() {
  try {
    const d = await api('/api/sessions');
    return (d.sessions || []).filter((s) => s.kind === 'cc');
  } catch (e) {
    console.error(`[FAIL] cannot reach bridge at ${base} : ${e.message}`);
    process.exit(1);
  }
}

function resolveTarget(sel, sessions) {
  if (/^\d+$/.test(sel)) {
    const i = Number(sel);
    if (i < 1 || i > sessions.length) { console.error(`[FAIL] no session number ${i}`); process.exit(1); }
    return sessions[i - 1];
  }
  const s = sessions.find((x) => x.id === sel || x.id.startsWith(sel));
  if (!s) { console.error(`[FAIL] no session matches "${sel}"`); process.exit(1); }
  return s;
}

// relay credentials ride with the child only - never written anywhere
function settingsEnv() {
  try {
    const env = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')).env;
    return env && typeof env === 'object' ? env : {};
  } catch { return {}; }
}

const cmd = process.argv[2] || 'help';
const arg = process.argv[3];

if (cmd === 'list') {
  const ss = await getSessions();
  ss.forEach((s, i) => {
    const st = s.running ? 'running' : (s.lastOutcome || s.status || '');
    console.log(`${String(i + 1).padStart(3)}  ${st.padEnd(8)} ${(s.title || s.id.slice(0, 8)).slice(0, 46).padEnd(48)} ${s.id.slice(0, 12)}`);
  });
  if (!ss.length) console.log('(no sessions yet)');
} else if (cmd === 'attach') {
  if (!arg) { console.error('usage: node cli/cr.mjs attach <number|sessionId>'); process.exit(1); }
  const s = resolveTarget(arg, await getSessions());
  try { await api(`/api/sessions/${encodeURIComponent(s.id)}/driver`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'claim-pc' }) }); }
  catch (e) { console.error(`[WARN] could not claim session (bridge off?): ${e.message}`); }

  const exe = findClaudeBinary(cfg.claudePath || '');
  const cwd = s.cwd && fs.existsSync(s.cwd) ? s.cwd : process.cwd();
  console.log(`resuming ${s.id} in ${cwd}`);
  console.log('(exit with /exit when done; phone shows PC as driver until released)');
  const child = spawn(exe, ['--resume', s.id], {
    cwd,
    env: { ...process.env, ...settingsEnv() },
    stdio: 'inherit',
  });
  // release on ANY child exit (clean /exit, crash, Ctrl+C reaching the group)
  child.on('exit', async (code) => {
    try {
      await api(`/api/sessions/${encodeURIComponent(s.id)}/driver`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'release' }) });
      console.log('\nclaim released - phone can drive this session again.');
    } catch { console.error('[WARN] auto-release failed (bridge off?): run release later'); }
    process.exit(code == null ? 0 : code);
  });
} else if (cmd === 'release') {
  if (!arg) { console.error('usage: node cli/cr.mjs release <number|sessionId>'); process.exit(1); }
  const s = resolveTarget(arg, await getSessions());
  await api(`/api/sessions/${encodeURIComponent(s.id)}/driver`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'release' }) });
  console.log(`released ${s.id}`);
} else if (cmd === 'url') {
  const { lanUrls } = await import('../bridge/pairing.js');
  for (const u of lanUrls(cfg.port)) console.log(u + cfg.token);
} else {
  console.log('cr - PC-side takeover helper for claude-web');
  console.log('usage:');
  console.log('  node cli/cr.mjs list               show Claude Code sessions');
  console.log('  node cli/cr.mjs attach <n|id>      interactive claude --resume (claims the session)');
  console.log('  node cli/cr.mjs release <n|id>     drop the PC claim');
  console.log('  node cli/cr.mjs url                print phone pairing link(s)');
}
