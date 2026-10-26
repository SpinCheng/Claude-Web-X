// js/views/detail.js - the detail page shell: open/close + history entry,
// header meta & driver chip, run-status line and the wait banner (v21).
// Transcript rendering lives in transcript.js; the composer & queue panel
// live in composer.js.
// NOTE: function-level import cycle with composer.js (openDetail ->
// updateComposer/renderAttachChips/fetchQueue vs updateComposer ->
// renderDriverChip) - safe because no cross-module call happens at
// module-evaluation time (ESM live bindings).

import { $, shortPath } from '../util.js';
import { state } from '../state.js';
import { auth, api } from '../api.js';
import { sendWs } from '../ws.js';
import { buildTurns, renderAllTurns, scrollBottom, updateJumpFab } from './transcript.js';
import { ensureModels, renderModelChip, updateTokenRing } from './ctxring.js';
import { updateComposer, renderAttachChips, fetchQueue } from './composer.js';

/* ---------------- history (system back = leave detail) ---------------- */
function openDetail(id) {
  state.currentId = id;
  state.atBottom = true;
  state.userCollapsedLive = false;
  state.attach = [];
  renderAttachChips();
  $('list').classList.add('hidden');
  $('detail').classList.remove('hidden');
  $('chat').innerHTML = '';
  renderMeta();
  refreshDriver();
  ensureModels(); // context-window lookup for the ring
  sendWs({ type: 'subscribe', id });
  api('/api/sessions/' + encodeURIComponent(id) + '/messages')
    .then((r) => r.json())
    .then((d) => {
      if (state.currentId !== id) return;
      buildTurns(d.events || []);
      renderAllTurns();
      state.atBottom = true;          // entering a session always lands on the latest
      scrollBottom(true);
      updateJumpFab();
    })
    .catch(() => {});
  updateComposer();
  fetchQueue(id);
  renderWaitBanner();
  updateRunStatus();
  history.pushState({ cr: 'detail' }, '', '#s');
}
function closeDetail() { // via the ← button only
  sendWs({ type: 'unsubscribe' });
  state.currentId = null;
  state.turns = [];
  $('detail').classList.add('hidden');
  $('list').classList.remove('hidden');
}

/* ---------------- meta / driver chip ---------------- */
function renderMeta() {
  const s = state.sessions.find((x) => x.id === state.currentId);
  if (!s) return;
  $('d-title').textContent = s.title || s.id.slice(0, 8);
  const bits = [];
  if (s.cwd) bits.push(shortPath(s.cwd));
  if (s.cost && s.cost.usd != null) bits.push('$' + Number(s.cost.usd).toFixed(2));
  $('d-meta').textContent = bits.join(' · ');
  const m = $('c-model-name');
  if (m) renderModelChip();
  updateTokenRing();
  renderDriverChip();
}
function renderDriverChip() {
  const chip = $('d-driver');
  if (!state.currentId) return;
  const run = state.runs[state.currentId];
  if (run && run.state === 'running') { chip.textContent = '手机'; chip.className = 'chip run'; }
  else if (state.driver && state.driver.driver === 'pc') { chip.textContent = '电脑'; chip.className = 'chip pc'; }
  else { chip.textContent = '空闲'; chip.className = 'chip'; }
}
function refreshDriver() {
  if (!state.currentId) return;
  fetch('/api/sessions/' + encodeURIComponent(state.currentId) + '/driver', { headers: auth() })
    .then((r) => r.json())
    .then((d) => { state.driver = d; renderDriverChip(); })
    .catch(() => {});
}

/* ---------------- run status line ---------------- */
function lastLiveToolName() {
  for (let i = state.turns.length - 1; i >= 0; i--) {
    const t = state.turns[i];
    if (t.role !== 'bot') break;
    if (t.tools.length) return t.tools[t.tools.length - 1].name;
  }
  return '';
}
function updateRunStatus() {
  const el = $('run-status');
  if (!state.currentId) { el.classList.add('hidden'); return; }
  const rec = state.sessions.find((x) => x.id === state.currentId);
  const run = state.runs[state.currentId];
  const running = (run && run.state === 'running') || (rec && rec.running);
  if (!running) { el.classList.add('hidden'); return; }
  let s;
  if (run && run.state === 'running' && run.startedAt) {
    const sec = Math.max(0, Math.floor((Date.now() - run.startedAt) / 1000));
    const mm = Math.floor(sec / 60), ss = sec % 60;
    s = '已运行 ' + (mm > 0 ? mm + ' 分 ' : '') + String(ss).padStart(2, '0') + ' 秒';
  } else {
    s = '转录更新中';
  }
  const tool = lastLiveToolName();
  $('run-status-text').textContent = s + (tool ? ' · 正在调用 ' + tool : '');
  el.classList.remove('hidden');
}

/* ---------------- wait banner (v21): PC stuck on a prompt ---------------- */
function renderWaitBanner() {
  const el = $('wait-banner');
  if (!el) return;
  const w = state.waits[state.currentId];
  if (!w) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  $('wait-text').textContent = w.kind === 'input'
    ? '正在等待你在电脑端输入——会话已暂停'
    : '等待权限确认' + (w.tool ? ' · ' + w.tool : '') + '——在电脑端批准后自动继续';
}

export { openDetail, closeDetail, renderMeta, renderDriverChip, refreshDriver, updateRunStatus, renderWaitBanner };
