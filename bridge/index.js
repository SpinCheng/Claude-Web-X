// index.js - bridge entry point.
// Usage: node bridge/index.js
// First run generates bridge/data/config.json (token + port). Keep it secret.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { Store } from './store.js';
import { CcAdapter } from './adapter-cc.js';
import { Runner } from './runner.js';
import { CtxProbe } from './ctxprobe.js';
import { Handoff } from './handoff.js';
import { createServer } from './server.js';
import { hookCmdPath } from './lib/platform.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

// New config keys are merged into an existing config file without touching
// the token, so upgrades keep working.
function loadConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let cfg = null;
  if (fs.existsSync(CONFIG_PATH)) {
    try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* regenerate */ }
  }
  const defaults = {
    token: crypto.randomBytes(24).toString('hex'),
    port: 3742,
    host: '0.0.0.0', // LAN access; pair with Tailscale/VPN when off-home
    notify: { ntfyTopic: '' }, // optional: set a topic to enable ntfy.sh pushes
    claudePath: '', // optional: absolute path to claude.exe; empty = auto-resolve
    defaultCwd: '', // optional: cwd for phone-started sessions; empty = home
    yolo: true, // dispatched turns skip permission checks (headless can't approve)
  };
  if (!cfg) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  let changed = false;
  for (const [k, v] of Object.entries(defaults)) {
    if (cfg[k] === undefined) { cfg[k] = v; changed = true; }
  }
  if (changed) fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}

function lanIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

const cfg = loadConfig();
const store = new Store();
// CR_ROOT env override (testing); default: <home>/.claude/projects
const adapter = new CcAdapter(store, process.env.CR_ROOT || undefined, path.join(DATA_DIR, 'trash'), path.join(DATA_DIR, 'renames.json'));
const runner = new Runner({ store, claudePath: cfg.claudePath, yolo: cfg.yolo !== false, port: cfg.port, uploadsDir: path.join(DATA_DIR, 'uploads') });
const handoff = new Handoff({ store, locksDir: path.join(DATA_DIR, 'locks') });
const ctxprobe = new CtxProbe({ runner, adapter, cachePath: path.join(DATA_DIR, 'ctx-probe.json'), defaultCwd: cfg.defaultCwd });
const paths = {
  configPath: CONFIG_PATH,
  settingsPath: path.join(os.homedir(), '.claude', 'settings.json'),
  hookCmd: hookCmdPath(),
  uploadsDir: path.join(DATA_DIR, 'uploads'),
};
const { server } = createServer(cfg, store, adapter, runner, handoff, paths, ctxprobe);

adapter.start();
server.on('error', (err) => {
  // a second instance (autostart raced with a manual start) exits quietly
  if (err.code === 'EADDRINUSE') {
    console.log('[claude-remote bridge] port %d already in use - another instance is running, this one exits.', cfg.port);
    process.exit(0);
  }
  console.error('[claude-remote bridge] server error:', err);
  process.exit(1);
});
server.listen(cfg.port, cfg.host, () => {
  console.log('[claude-remote bridge] listening on %s:%d', cfg.host, cfg.port);
  for (const ip of lanIps()) {
    console.log('  phone URL : http://%s:%d  (token required)', ip, cfg.port);
  }
  console.log('  token     : %s', cfg.token);
  console.log('  config    : %s', CONFIG_PATH);
  console.log('  watching  : %s', adapter.root);
  console.log('  claude    : %s', runner.resolveClaude());
});
