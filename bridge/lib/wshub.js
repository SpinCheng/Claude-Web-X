// lib/wshub.js - websocket hub: broadcast plumbing, per-session waiting
// state, phone approval cards, mergedSessions (the ONE source every
// sessions frame must use - list HTTP, WS initial, broadcast).
// Owns transport; frame semantics stay with the emitters (adapter/runner).
import { WebSocketServer } from 'ws';
import { authOk } from './auth.js';

export function createHub({ cfg, store, runner, pins }) {
  const clients = new Set(); // ws sockets; ws.subId = subscribed session id
  const waitings = new Map(); // sessionId -> waiting (permission prompt)
  const approvals = new Map(); // id -> {runId, sessionId, tool, input, resolve, timer}

  function broadcast(obj) {
    const raw = JSON.stringify(obj);
    for (const ws of clients) {
      if (ws.readyState !== 1) continue;
      // append events only go to the subscriber of that session; v112 agent
      // summary frames follow the same per-session routing
      if ((obj.type === 'append' || obj.type === 'agent') && ws.subId !== obj.id) continue;
      ws.send(raw);
    }
  }

  function mergedSessions() {
    return store.list().map((s) => {
      const live = runner.activeRunFor(s.id);
      const out = runner.recallOutcome(s.id);
      // runId rides along so a client that loads mid-run (no run frame seen)
      // can still cancel it - the list-page stop action and the composer
      // stop button both need it. pinned/pinnedAt (v125) drive the list's
      // 置顶 section.
      const pinnedAt = (pins && pins.get(s.id)) || 0;
      return { ...s, pinned: !!pinnedAt, pinnedAt, running: !!live, runId: live ? live.runId : null, queued: runner.queuedFor(s.id).length, waiting: waitings.get(s.id) || null, lastRun: out || null, lastOutcome: s.lastOutcome || (out ? out.state : '') };
    });
  }

  let sessionsDirty = false;
  function broadcastSessionsSoon() {
    if (sessionsDirty) return;
    sessionsDirty = true;
    setTimeout(() => {
      sessionsDirty = false;
      broadcast({ type: 'sessions', sessions: mergedSessions() });
    }, 250);
  }

  // remote permission approvals (phone approval cards): the headless CLI's
  // v44 session-level always-allow: the approval card's "本会话始终允许" tick
  // records (sessionId, tool) here; later asks for the SAME tool in the SAME
  // session resolve immediately without a phone card. Memory-only by design -
  // a bridge restart re-arms the prompts (session-scoped trust, not global).
  const sessionAllows = new Map();

  function allowSessionTool(sessionId, tool) {
    if (!sessionId || !tool) return;
    let s = sessionAllows.get(sessionId);
    if (!s) { s = new Set(); sessionAllows.set(sessionId, s); }
    s.add(tool);
  }

  // approve-mcp server POSTs /internal/approval; we hold that response open
  // until the phone answers (WS 'approval' frame -> POST /api/approvals/:id)
  // or deny after a timeout.
  function askApproval(runId, sessionId, tool, input) {
    const allow = sessionAllows.get(sessionId);
    if (allow && allow.has(tool)) return Promise.resolve({ behavior: 'allow', updatedInput: {}, auto: true });
    return new Promise((resolve) => {
      const id = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const rec = { runId, sessionId, tool, input, resolve, createdAt: Date.now() };
      approvals.set(id, rec);
      rec.timer = setTimeout(() => {
        finishApproval(id, { behavior: 'deny', message: '手机未响应（超时 3 分钟），已自动拒绝' });
      }, 180_000);
      broadcast({ type: 'approval', id, runId, sessionId, tool, input });
    });
  }
  function finishApproval(id, decision) {
    const rec = approvals.get(id);
    if (!rec) return false;
    clearTimeout(rec.timer);
    approvals.delete(id);
    rec.resolve(decision);
    broadcast({ type: 'approval-result', id, runId: rec.runId, decision: decision.behavior });
    return true;
  }
  function denyAllForRun(runId, message) {
    for (const [id, rec] of approvals) {
      if (rec.runId === runId) finishApproval(id, { behavior: 'deny', message: message || 'run ended' });
    }
  }

  function waitSet(sessionId, waiting) {
    waitings.set(sessionId, waiting);
    broadcast({ type: 'wait', sessionId, waiting });
  }
  function waitClear(sessionId) {
    if (!waitings.delete(sessionId)) return;
    broadcast({ type: 'wait', sessionId, waiting: null });
  }

  function attach(server) {
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://x');
      if (url.pathname !== '/ws' || !authOk(req, url, cfg)) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        clients.add(ws);
        ws.subId = null;
        ws.send(JSON.stringify({ type: 'sessions', sessions: mergedSessions() }));
        ws.on('message', (raw) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'subscribe') {
              ws.subId = msg.id || null;
              ws.send(JSON.stringify({ type: 'subscribed', id: ws.subId }));
            } else if (msg.type === 'unsubscribe') {
              ws.subId = null;
            }
          } catch { /* ignore malformed */ }
        });
        ws.on('close', () => clients.delete(ws));
      });
    });
  }

  function kickAll(reason) {
    for (const ws of clients) { try { ws.close(1008, reason); } catch { /* already gone */ } }
  }

  return { broadcast, broadcastSessionsSoon, mergedSessions, waitings, approvals,
    askApproval, finishApproval, denyAllForRun, allowSessionTool, waitSet, waitClear, attach, kickAll };
}
