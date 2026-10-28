// routes/pairing.js - pairing panel API: localhost ONLY, no token (its
// whole job is to hand the token to the person already sitting at this
// machine)
import { rotateToken, lanUrls } from '../pairing.js';
import { installAutostart, autostartInstalled } from '../lib/platform.js';

export function register(router, ctx) {
  const { cfg, paths, hub } = ctx;

  // same-machine only (not just loopback): opening the panel via the LAN
  // IP on the PC itself is fine; other devices still get 403
  const sameMachine = (req) => {
    const norm = (a) => (a || '').replace(/^::ffff:/, '');
    const ra = norm(req.socket.remoteAddress);
    const la = norm(req.socket.localAddress);
    return ra === '127.0.0.1' || ra === '::1' || (la && ra === la);
  };
  const refuse = (res) => { res.writeHead(403); res.end('{"error":"same-machine only"}'); };

  router.get('/api/pair/info', (req, res) => {
    if (!sameMachine(req)) { refuse(res); return; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      token: cfg.token, port: cfg.port,
      urls: lanUrls(cfg.port).map((u) => u + cfg.token),
      autostart: autostartInstalled(),
    }));
  });

  router.post('/api/pair/rotate', (req, res) => {
    if (!sameMachine(req)) { refuse(res); return; }
    const r = rotateToken(cfg, paths);
    if (!r.ok) { res.writeHead(500); res.end(JSON.stringify({ error: r.error })); return; }
    // token changed: drop every live WS client so nothing rides the old token
    hub.kickAll('token rotated');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true, token: r.token, backup: r.backup,
      urls: lanUrls(cfg.port).map((u) => u + r.token),
    }));
  });

  router.post('/api/pair/autostart', (req, res) => {
    if (!sameMachine(req)) { refuse(res); return; }
    const r = installAutostart();
    res.writeHead(r.ok ? 200 : 500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(r));
  });
}
