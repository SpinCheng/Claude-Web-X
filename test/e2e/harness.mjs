// test/e2e/harness.mjs - shared infrastructure for the E2E smoke suite.
// Boots an ISOLATED bridge on :3799 (temp data dirs, never the production
// bridge - red line 6) serving the real public/ dir, plus a headless-Edge
// CDP page driver. Sequential scenarios only (fixed ports).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../../bridge/store.js';
import { CcAdapter } from '../../bridge/adapter-cc.js';
import { Runner } from '../../bridge/runner.js';
import { Handoff } from '../../bridge/handoff.js';
import { createServer } from '../../bridge/server.js';
import WebSocket from 'ws';

export const PORT = 3799;
export const TOK = 'e2etok';
const CDP = 9299;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe']
  .find((p) => fs.existsSync(p));

export function assert(cond, msg) { if (!cond) throw new Error('ASSERT: ' + msg); }

// isolated bridge: temp projects root, temp uploads/locks, no ctxprobe.
// The projects dir is created BEFORE adapter.start so fs.watch works
// event-driven (watching a missing dir throws -> silent 1.5s polling).
export async function bootBridge() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-e2e-'));
  fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });
  const cfg = { token: TOK, port: PORT, host: '127.0.0.1', claudePath: '', defaultCwd: '', yolo: true, notify: { ntfyTopic: '' } };
  const store = new Store();
  const adapter = new CcAdapter(store, path.join(tmp, 'projects'), path.join(tmp, 'trash'));
  const runner = new Runner({ store, claudePath: '', yolo: true, port: PORT, uploadsDir: path.join(tmp, 'uploads') });
  const handoff = new Handoff({ store, locksDir: path.join(tmp, 'locks') });
  const { server } = createServer(cfg, store, adapter, runner, handoff,
    { uploadsDir: path.join(tmp, 'uploads'), configPath: 'x', settingsPath: 'x', hookCmd: 'x', vbsPath: 'x' }, null);
  adapter.start();
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  return {
    tmp, store, adapter, runner, handoff, server,
    stop: async () => { adapter.stop(); server.close(); await sleep(300); fs.rmSync(tmp, { recursive: true, force: true }); },
  };
}

// synthetic transcript: drop a <sid>.jsonl into the watched temp root
export function writeSession(h, projSlug, sid, lineObjs) {
  const dir = path.join(h.tmp, 'projects', projSlug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sid + '.jsonl'), lineObjs.map((o) => JSON.stringify(o)).join('\n') + '\n');
}

// drive the REAL server wiring with fake run frames (no CLI spawn needed):
// emits the same runner events the runner itself emits on state changes
export function fakeRun(h, sid, state, runId = 'e2e-run') {
  h.runner.emit('update', { runId, sessionId: sid, state, startedAt: Date.now() });
}

// headless Edge + minimal CDP client
// block until a session is parsed into the store (deep links and routes
// 404 while the fixture is still being discovered)
export async function waitSession(sid) {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/api/sessions/${encodeURIComponent(sid)}/messages`, { headers: { Authorization: 'Bearer ' + TOK } }); if (r.ok) return true; } catch { /* not yet */ }
    await sleep(250);
  }
  return false;
}

export async function bootPage(profileDir) {
  if (!EDGE) throw new Error('msedge not found');
  const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${path.join(profileDir, 'edgeprof')}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let wsUrl = null;
  for (let i = 0; i < 30 && !wsUrl; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json(); wsUrl = (l.find((t) => t.type === 'page') || {}).webSocketDebuggerUrl; } catch { /* booting */ }
    if (!wsUrl) await sleep(300);
  }
  if (!wsUrl) { edge.kill(); throw new Error('no CDP target'); }
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.on('open', r));
  let seq = 0; const pending = new Map();
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
    // headless auto-DISMISSES window.confirm (returns false); the delete-flow
    // scenarios need the confirm accepted, so answer dialogs as OK
    if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true });
  });
  const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  await send('Page.enable'); await send('Runtime.enable');
  const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  const navigate = async (url) => { await send('Page.navigate', { url }); };
  // mobile viewport: layout/geometry assertions must run at phone width
  // (headless defaults to a wide desktop window where nothing overflows)
  const resize = async (w, h = 760) => {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: true });
  };
  const waitFor = async (expression, timeoutMs = 15000) => {
    for (let i = 0; i < timeoutMs / 250; i++) { if (await ev(expression)) return true; await sleep(250); }
    return false;
  };
  return {
    ev, navigate, waitFor, resize,
    open: async (sid) => { await waitSession(sid); await navigate(`http://127.0.0.1:${PORT}/?token=${TOK}#open=${sid}`); },
    stop: async () => { try { ws.close(); } catch { /* already closed */ } edge.kill(); await sleep(400); },
  };
}

// one scenario = fresh bridge + fresh page, torn down after
export async function withEnv(fn) {
  const h = await bootBridge();
  const page = await bootPage(h.tmp);
  try { await fn(h, page); } finally { await page.stop(); await h.stop(); }
}

// NOTE: opts spread must not replace the auth header - merge instead
export const api = (p, opts = {}) => fetch(`http://127.0.0.1:${PORT}${p}`, { ...opts, headers: { Authorization: 'Bearer ' + TOK, ...(opts.headers || {}) } });
