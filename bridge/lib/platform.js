// lib/platform.js - the single home for OS-specific behavior. Windows logic
// is moved here verbatim; POSIX branches are additive. No other module should
// branch on process.platform.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const IS_WIN = process.platform === 'win32';
// NTFS and APFS (default) resolve names regardless of letter case, so path
// prefix guards must compare case-insensitively; ext4 must not.
export const CI_PATHS = process.platform !== 'linux';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

// claude CLI discovery: config override -> newest bundled copy under
// %LOCALAPPDATA%\Claude-3p|Claude\claude-code\<ver>\<hash>\claude.exe (the
// 3rd-party desktop client keeps its own copies there; upgrades create new
// dirs) -> PATH lookup (spawns fail visibly if missing).
export function findClaudeBinary(override) {
  if (override && fs.existsSync(override)) return override;
  if (IS_WIN) {
    let best = null; // newest claude.exe by mtime
    for (const app of ['Claude-3p', 'Claude']) {
      const root = path.join(process.env.LOCALAPPDATA || '', app, 'claude-code');
      let versionDirs = [];
      try { versionDirs = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
      for (const vd of versionDirs) {
        if (!vd.isDirectory()) continue;
        let hashDirs = [];
        try { hashDirs = fs.readdirSync(path.join(root, vd.name), { withFileTypes: true }); } catch { continue; }
        for (const hd of hashDirs) {
          if (!hd.isDirectory()) continue;
          const exe = path.join(root, vd.name, hd.name, 'claude.exe');
          try {
            const st = fs.statSync(exe);
            if (st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = { exe, mtimeMs: st.mtimeMs };
          } catch { /* not there */ }
        }
      }
    }
    if (best) return best.exe;
  } else {
    for (const p of [
      path.join(os.homedir(), '.local', 'bin', 'claude'), // native installer
      path.join(os.homedir(), '.claude', 'local', 'claude'), // local npm install
    ]) {
      try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
    }
  }
  return 'claude';
}

// Claude Code's Bash tool needs a discoverable Git Bash. This machine keeps
// git under a user-local manager (hermes), NOT Program Files, so a bridge
// started from a lean context (boot autostart / wscript chain, no user PATH)
// spawns CLIs that silently lose the Bash tool ("Git Bash not found;
// BashTool will be unavailable" in ~/.claude/debug). Resolve git's install
// once and prepend its dirs to every spawned child's PATH.
let _gitRoot;
function findGitRoot() {
  if (_gitRoot !== undefined) return _gitRoot;
  _gitRoot = null;
  if (IS_WIN) {
    const cands = [];
    const hermes = path.join(os.homedir(), 'AppData', 'Local', 'hermes');
    cands.push(path.join(hermes, 'git')); // hermes "current" link
    try {
      for (const d of fs.readdirSync(path.join(hermes, 'tools'))) {
        if (/^git-/.test(d)) cands.push(path.join(hermes, 'tools', d));
      }
    } catch { /* no hermes/tools */ }
    cands.push('C:\\Program Files\\Git', 'C:\\Program Files (x86)\\Git');
    for (const root of cands) {
      try {
        if (fs.statSync(path.join(root, 'bin', 'bash.exe')).isFile()) { _gitRoot = root; break; }
      } catch { /* next */ }
    }
  }
  return _gitRoot;
}
// extra env entries for spawned CLIs so the Bash tool always seats,
// whatever context the bridge itself was started from
export function bashToolEnv(baseEnv) {
  const root = findGitRoot();
  if (!root) return {};
  const dirs = [path.join(root, 'cmd'), path.join(root, 'bin')].join(path.delimiter);
  const base = (baseEnv && (baseEnv.PATH || baseEnv.Path)) || '';
  return { PATH: dirs + path.delimiter + base };
}

// Hook callback script written into ~/.claude/settings.json. Windows routes
// through cmd.exe via hook-post.cmd (PowerShell breaks curl's
// "--data-binary @-"); POSIX runs hook-post.sh directly. Forward slashes
// everywhere: escape-safe in both shells.
export function hookCmdPath() {
  const name = IS_WIN ? 'hook-post.cmd' : 'hook-post.sh';
  return path.join(PROJECT_ROOT, 'bridge', name).split(path.sep).join('/');
}

// Autostart: Windows drops a GENERATED .vbs into the Startup folder with
// absolute paths baked in (the repo template scripts/start-bridge.vbs
// self-locates and only works from the repo layout). Other platforms:
// intentionally unimplemented - the panel just reports "not installed".
export function installAutostart() {
  if (!IS_WIN) return { ok: false, error: `autostart not implemented on ${process.platform}` };
  try {
    const startup = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    const dest = path.join(startup, 'claude-bridge.vbs');
    const gen = [
      "' claude-bridge.vbs - GENERATED by claude-remote pairing panel. Do not edit; reinstall from http://localhost:3742/pair",
      'Dim sh, NODE, BASE',
      'Set sh = CreateObject("WScript.Shell")',
      `NODE = ${JSON.stringify(process.execPath)}`,
      `BASE = ${JSON.stringify(path.join(PROJECT_ROOT, 'bridge', 'index.js'))}`,
      'sh.Run """" & NODE & """ """ & BASE & """", 0, False',
      '',
    ].join('\r\n');
    fs.writeFileSync(dest, gen, 'utf8');
    return { ok: true, installedTo: dest };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

export function autostartInstalled() {
  if (!IS_WIN) return false;
  try {
    return fs.existsSync(path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'claude-bridge.vbs'));
  } catch { return false; }
}
