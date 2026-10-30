// js/ws.js - websocket transport: connect, backoff reconnect, frame
// dispatch. Frame SEMANTICS live in the app (injected once via initWs) so
// this module owns wiring, not behavior.
import { state } from './state.js';

let handlers = {}; // frame type -> fn(d)
export function initWs(h) { handlers = h; }

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return proto + '://' + location.host + '/ws?token=' + encodeURIComponent(state.token);
}

export function connectWs() {
  // detach handlers before closing: a deliberately-closed socket's onclose
  // must not flip the dot to cream nor schedule a ghost reconnect that would
  // later kill the healthy replacement (self-perpetuating flicker loop)
  const old = state.ws;
  if (old) {
    old.onopen = old.onmessage = old.onclose = old.onerror = null;
    try { old.close(); } catch (e) { /* noop */ }
  }
  // v84: connection state lives IN the brand mark now - cream->coral breath
  // while connecting (reduced-motion: static coral)
  const dot = document.getElementById('conn-dot');
  if (dot) dot.className = 'mark conn';
  const ws = new WebSocket(wsUrl());
  state.ws = ws;
  ws.onopen = () => {
    state.wsRetry = 1000;
    document.getElementById('conn-dot').className = 'mark on';
    if (state.currentId) sendWs({ type: 'subscribe', id: state.currentId });
    if (handlers.onOpen) handlers.onOpen(); // e.g. catch approval cards missed offline
  };
  ws.onmessage = (m) => {
    let d; try { d = JSON.parse(m.data); } catch { return; }
    const fn = handlers[d.type];
    if (fn) fn(d);
  };
  ws.onclose = () => {
    document.getElementById('conn-dot').className = 'mark';
    clearTimeout(state.wsTimer);
    state.wsTimer = setTimeout(connectWs, state.wsRetry);
    state.wsRetry = Math.min(state.wsRetry * 2, 8000);
  };
  ws.onerror = () => { try { ws.close(); } catch (e) { /* noop */ } };
}

export function sendWs(obj) { if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(obj)); }
