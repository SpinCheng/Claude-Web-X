// hooks.js - receives Claude Code hook callbacks (Stop / Notification / ...)
// POST /hooks/<event>?token=... with the hook JSON payload on the body.
// Fires WS 'notify' events and (optionally) an ntfy push.
import { readBody } from './lib/auth.js';

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
  return { sessionId, waiting: extractWaiting(event, payload) };
}

// Claude Code's Notification hook fires for permission requests AND for
// idle-input nudges. Only permission prompts become a waiting state: the
// idle nudge ("waiting for your input") fires ~60s after EVERY turn of an
// interactive PC session, and nothing clears it until the next user message
// (Stop hook already ran before it, transcript is quiet while idle) - the
// banner would be the resting state of every PC session, crying wolf.
function extractWaiting(event, payload) {
  if (event !== 'notification') return null;
  const msg = String(payload.message || '');
  let kind = null, tool = '';
  const pm = msg.match(/permission to use (\S+)/i);
  if (pm) { kind = 'permission'; tool = pm[1]; }
  else if (/needs your approval/i.test(msg)) { kind = 'permission'; }
  else if (/permission/i.test(msg)) { kind = 'permission'; }
  return kind ? { kind, tool, msg: msg.slice(0, 120), at: Date.now() } : null;
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

