// js/views/agentview.js - v112 方案A: the subagent full-text bubble
// (#agent-sheet, .overlay.bub + .sheet.bubble - same grammar as ctx-sheet).
// Opened from a live agent node's live-line or a finished agent chip.
// Renders the subagent transcript with the SAME timeline nodes as the main
// view (renderStepsInto) and live-refreshes while the agent runs: summary
// frames trigger a debounced tail refetch; scroll is kept unless the user
// sits at the bottom, where it follows the growth.
import { $ } from '../util.js';
import { state } from '../state.js';
import { api } from '../api.js';
import { openBubble } from './overlays.js';
import { renderStepsInto, renderNode, markCapped, newBotTurn, addAssistantPart, pairToolResults } from './transcript.js';

let refreshTimer = null;

export function openAgentView(toolUseId) {
  const a = state.agents[toolUseId];
  if (!a || !a.agentId) return;
  state.agentView = { toolUseId, agentId: a.agentId };
  $('ag-title').textContent = a.desc || '子代理';
  $('ag-st').textContent = '加载中…';
  setLamp(a.finished ? 'idle' : 'running');
  $('ag-body').innerHTML = '';
  openBubble('agent-sheet');
  fetchView();
}

export function closeAgentView() {
  clearTimeout(refreshTimer);
  state.agentView = null;
  $('agent-sheet').classList.add('hidden');
}

// a summary frame landed for the agent this bubble shows -> refresh soon
export function onAgentFrame(d) {
  const av = state.agentView;
  if (!av || av.agentId !== d.agentId) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(fetchView, 400); // step bursts arrive 200ms-batched
}

// 1s ticker from app.js: keep the head's elapsed/steps fresh while open.
// v115: elapsed FREEZES at finishedAt once the agent completes (used to keep
// counting past completion).
export function tickAgentHead() {
  const av = state.agentView;
  if (!av || $('agent-sheet').classList.contains('hidden')) return;
  const a = state.agents[av.toolUseId];
  if (!a) return;
  setLamp(a.finished ? 'idle' : 'running');
  let dur = '';
  if (a.startedAt) {
    const end = a.finished ? (a.finishedAt || Date.now()) : Date.now();
    const sec = Math.max(0, Math.floor((end - a.startedAt) / 1000));
    dur = ' · ' + Math.floor(sec / 60) + 'm' + String(sec % 60).padStart(2, '0') + 's';
  }
  $('ag-st').textContent = (a.finished ? '已完成' : '运行中')
    + ' · ' + (a.steps || 0) + ' 步' + dur;
}

function setLamp(st) { $('ag-lamp').setAttribute('data-st', st); }

function fetchView() {
  const av = state.agentView;
  if (!av || !state.currentId) return;
  api('/api/sessions/' + encodeURIComponent(state.currentId) + '/agents/' + encodeURIComponent(av.agentId) + '/events')
    .then((r) => r.json())
    .then((d) => { if (state.agentView === av) renderView(d, av); })
    .catch(() => { if (state.agentView === av) $('ag-st').textContent = '读取失败'; });
}

// pure replay of agent display events into turns - same shapes the main view
// builds, but no optimistic folding and no state.turns writes. No orphan
// sink: one fetch returns the agent's whole event list.
function buildAgentTurns(events) {
  const T = [];
  for (const ev of events) {
    if (ev.k === 'user') {
      T.push({ role: 'user', text: ev.text || '', ts: ev.ts, images: ev.images || null });
      T.push(newBotTurn(''));
    } else if (ev.k === 'assistant') {
      if (!T.length || T[T.length - 1].role !== 'bot') T.push(newBotTurn(ev.ts));
      const turn = T[T.length - 1];
      turn.ts = turn.ts || ev.ts;
      for (const p of ev.parts || []) addAssistantPart(turn, p);
    } else if (ev.k === 'toolres') pairToolResults(T, ev, null);
  }
  if (T.length && T[T.length - 1].role === 'bot' && !(T[T.length - 1].steps || []).length) T.pop();
  return T;
}

function renderView(d, av) {
  const body = $('ag-body');
  const a = d.agent || state.agents[av.toolUseId] || {};
  const running = !a.finished;
  if (a.desc) $('ag-title').textContent = a.desc;
  // the bubble is its own scroller (overscroll auto per the nesting laws):
  // keep the position unless pinned at the bottom, where it follows growth
  const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 64;
  const prevH = body.scrollHeight;
  body.innerHTML = '';
  const tl = document.createElement('div');
  tl.className = 'timeline';
  const turns = buildAgentTurns(d.events || []);
  let firstUser = true;
  for (const t of turns) {
    if (t.role === 'user') {
      // the first user line is the agent's task prompt
      tl.appendChild(renderNode('mid', { badge: firstUser ? '任务' : '用户' }, (b) => {
        const dv = document.createElement('div');
        dv.className = 'mid';
        dv.textContent = t.text;
        b.appendChild(dv);
      }));
      firstUser = false;
    } else if (t.role === 'bot' && (t.steps || []).length) {
      renderStepsInto(tl, t.steps, running);
    }
  }
  body.appendChild(tl);
  markCapped(body);
  if (nearBottom) body.scrollTop = body.scrollHeight;
  else body.scrollTop += body.scrollHeight - prevH;
  tickAgentHead();
}

$('ag-close').onclick = closeAgentView;
