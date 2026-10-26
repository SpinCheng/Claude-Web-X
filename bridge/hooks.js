// hooks.js - receives Claude Code hook callbacks (Stop / Notification / ...)
// POST /hooks/<event>?token=... with the hook JSON payload on the body.
// Fires WS 'notify' events and (optionally) an ntfy push.
import crypto from 'node:crypto';

export async function handleHook(req, res, cfg, store, broadcast, event = 'unknown') {
  const body = await readBody(req, 1024 * 1024);
  let payload = {};
  try { payload = body ? JSON.parse(body) : {}; } catch { payload = { raw: String(body).slice(0, 200) }; }

  const sessionId = payload.session_id || payload.sessionId || '';
  const rec = sessionId ? store.get(sessionId) : null;
  const title = (rec && rec.title) || sessionId || 'Claude Code';
  const summary = summarize(event, payload, title);

  const note = {
    type: 'notify', event, sessionId,
    title, summary, ts: new Date().toISOString(),
  };
  broadcast(note);
  await pushNtfy(cfg, note);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true }));
}

function summarize(event, p, title) {
  if (event === 'stop') return `[${title}] finished`;
  if (event === 'notification') return `[${title}] ${p.message || 'needs attention'}`;
  return `[${title}] hook: ${event}`;
}

async function pushNtfy(cfg, note) {
  const topic = cfg.notify && cfg.notify.ntfyTopic;
  if (!topic) return; // not configured - WS only
  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { Title: 'claude-remote', Priority: 'default' },
      body: note.summary.slice(0, 200),
    });
  } catch { /* push failures must never break the bridge */ }
}

function readBody(req, limit) {
  return new Promise((resolve) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); resolve(''); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

// binary variant for attachment uploads (raw bytes, capped)
function readRawBody(req, limit) {
  return new Promise((resolve) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

export { readBody, readRawBody };

export function authOk(req, url, cfg) {
  const q = url.searchParams.get('token') || '';
  const h = req.headers.authorization || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7) : '';
  const given = q || bearer;
  if (!given || given.length !== cfg.token.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(cfg.token));
  } catch { return false; }
}
