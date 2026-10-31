// pairing.js - PC-side pairing panel logic: live token rotation (no bridge
// restart) and LAN pairing URLs. Autostart lives in lib/platform.js.
//
// Security posture: these handlers are only wired to localhost-only routes
// (/api/pair/*); the token they return must never be exposed to the LAN.
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';

// Rewrite the token in bridge config + the two hook commands inside
// ~/.claude/settings.json (they embed the token as argv). Backups first.
// Returns { ok, token } or { ok:false, error }. On any failure the in-memory
// token is left untouched and the settings backup is restored.
export function rotateToken(cfg, paths) {
  const { configPath, settingsPath, hookCmd } = paths;
  const fresh = crypto.randomBytes(24).toString('hex');
  let backup = '';
  try {
    // 1. settings.json: backup, then rewrite hook commands with the fresh token
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    backup = settingsPath + '.bak-rotate-' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(settingsPath, backup);
    const hook = (ev) => [{ hooks: [{ type: 'command', command: hookCmd + ' ' + ev + ' ' + fresh }] }];
    s.hooks = s.hooks || {};
    s.hooks.Stop = hook('stop');
    s.hooks.Notification = hook('notification');
    fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2));
    // 2. bridge config: persist the fresh token (all other keys preserved)
    const disk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    disk.token = fresh;
    fs.writeFileSync(configPath, JSON.stringify(disk, null, 2));
    // 3. live swap - only after both files are safely on disk
    cfg.token = fresh;
    return { ok: true, token: fresh, backup };
  } catch (e) {
    try { if (backup && fs.existsSync(backup)) fs.copyFileSync(backup, settingsPath); } catch { /* keep backup */ }
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// LAN pairing URLs, best first (home LAN beats virtual adapters/Tailscale).
// The &_b busts HTML navigation caches: scanning the QR always loads a fresh
// shell (which then pulls versioned assets), ending stale-asset mixes.
const BUILD = '135';
export function lanUrls(port) {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
    }
  }
  ips.sort((a, b) => Number(b.startsWith('192.168.')) - Number(a.startsWith('192.168.')));
  return ips.map((ip) => `http://${ip}:${port}/?_b=${BUILD}&token=`);
}
