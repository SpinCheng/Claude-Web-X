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
import { buildTurns, renderAllTurns, scrollBottom, updateJumpFab, parseOlderTurns, prependTurns, pushOptimisticUser } from './transcript.js';
import { ensureModels, renderModelChip, updateTokenRing, openCostPanel, costDisplay } from './ctxring.js';
import { updateComposer, renderAttachChips, fetchQueue, setDraft, disarmFork } from './composer.js';

/* ---------------- history (system back = leave detail) ---------------- */
function openDetail(id) {
  state.provisional = false;
  state.currentId = id;
  state.atBottom = true;
  state.userCollapsedLive = false;
  state.histBefore = 0; state.histTotal = 0; state.histLoading = false;
  updateHistoryPill(); // hidden until the first page lands
  state.attach = [];
  renderAttachChips();
  disarmFork(); // branch arming never crosses a session switch
  setDraft(id); // v40: refill this session's unsent draft
  $('list').classList.add('hidden');
  $('detail').classList.remove('hidden');
  $('chat').innerHTML = '';
  state.agentView = null; // v112: the agent bubble never crosses a session switch
  renderMeta();
  refreshDriver();
  ensureModels(); // context-window lookup for the ring
  sendWs({ type: 'subscribe', id });
  api('/api/sessions/' + encodeURIComponent(id) + '/messages')
    .then((r) => r.json())
    .then((d) => {
      if (state.currentId !== id) return;
      // v112: agent summaries seed the agent nodes BEFORE the first render -
      // finished agents get their 全文 entry without ever seeing a live frame
      if (d.agents) for (const a of d.agents) if (a.toolUseId) state.agents[a.toolUseId] = a;
      buildTurns(d.events || []);
      renderAllTurns();
      // v64: new-session race - the transcript user line lands within
      // milliseconds of the adoption run frame, so the first page can miss
      // it (append broadcast beats our subscribe). Seed the prompt we sent
      // as an optimistic bubble; the same-text fold machinery confirms it
      // in place when the real event arrives (v20/v37 semantics).
      if (state.pendingNewText) {
        if (!state.turns.some((t) => t.role === 'user')) {
          pushOptimisticUser(state.pendingNewText);
          // v66: the confirm append can be broadcast BEFORE our subscribe
          // (adoption race) - nobody would ever flip optimistic:false and
          // the bubble stays gray while results stream in. Re-fetch the
          // first page once, late; a user event present means rebuild and
          // the real (solid) turn replaces the seed. No-op when the fold
          // already confirmed it.
          setTimeout(() => reconcileFirstPage(id), 3000);
        }
        state.pendingNewText = '';
      }
      // v44 pagination bookkeeping (both counted in events from the tail)
      state.histTotal = d.total || 0;
      state.histBefore = (d.events || []).length;
      updateHistoryPill();
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
  state.provisional = false; // adoption auto-opens the real session (v64 seed)
  sendWs({ type: 'unsubscribe' });
  disarmFork();
  state.currentId = null;
  state.turns = [];
  state.histBefore = 0; state.histTotal = 0; state.histLoading = false;
  state.orphanToolRes.clear();
  state.agentView = null; // v112
  $('agent-sheet').classList.add('hidden');
  const hm = $('hist-more'); if (hm) hm.classList.remove('show', 'busy');
  $('detail').classList.add('hidden');
  $('list').classList.remove('hidden');
}

// v65: provisional detail - submit jumps STRAIGHT into the conversation with
// the prompt as an optimistic bubble. The session id only exists once the CLI
// writes its init line (3+ min cold start measured); adoption then calls the
// ordinary openDetail, whose fetch rebuilds the chat and the v64 seed re-shows
// the bubble synchronously in the same tick (no flicker). Same UX grammar as
// optimistic bubbles inside a live conversation (user ruling).
function truncTitle(t) {
  const f = (t || '').split('\n').map((x) => x.trim()).filter(Boolean)[0] || '';
  return f.slice(0, 24) + (f.length > 24 ? '…' : '');
}
function openDetailProvisional(text, cwd) {
  state.provisional = true;
  state.currentId = null;
  state.atBottom = true;
  state.userCollapsedLive = false;
  state.histBefore = 0; state.histTotal = 0; state.histLoading = false;
  updateHistoryPill();
  state.attach = [];
  renderAttachChips();
  disarmFork();
  state.turns = [];
  $('list').classList.add('hidden');
  $('detail').classList.remove('hidden');
  $('chat').innerHTML = '';
  $('d-title').textContent = truncTitle(text);
  $('d-meta').textContent = (cwd ? shortPath(cwd) + ' · ' : '') + '创建中…';
  renderDriverChip();
  ensureModels();
  pushOptimisticUser(text);
  scrollBottom(true);
}

function reconcileFirstPage(id) {
  if (state.currentId !== id) return;
  if (!state.turns.some((t) => t.role === 'user' && t.optimistic)) return; // confirmed already
  api('/api/sessions/' + encodeURIComponent(id) + '/messages')
    .then((r) => r.json())
    .then((d) => {
      if (state.currentId !== id) return;
      if (!(d.events || []).some((e) => e.k === 'user')) return; // still nothing on disk
      const atB = state.atBottom;
      buildTurns(d.events);
      renderAllTurns();
      if (atB) scrollBottom(true);
    })
    .catch(() => { /* transient - the fold may still confirm later */ });
}

/* ---------------- history pagination (v44/v46): header row + pull gesture ---------------- */
// The loader is a ROW UNDER THE HEADER (v46 用户裁定:悬浮 pill 存在感太强),
// revealed with a height/opacity transition only while pinned at the top; it
// lives OUTSIDE #chat on purpose - a leading chat child would break
// renderTail's 1:1 children/turns invariant. Two triggers: tap the row, OR
// pull down past 70px while pinned at the very top.
// v54: the loader row follows the scroll gesture 1:1 - height/opacity/text
// offset ramp linearly over the last HIST_RAMP px of upward scroll (direct
// manipulation; NO CSS transition - it would lag the finger). Monotonic by
// construction: the row lives outside #chat, so its height only shrinks
// #chat's box and never feeds back into scrollTop. A load in flight pins it
// fully open (feedback), exhaustion collapses it to zero.
const HIST_RAMP = 64;
function setHistRow(el, f) {
  el.style.height = f > 0 ? Math.round(38 * f) + 'px' : '0';
  el.style.opacity = f.toFixed(3);
  el.style.marginBottom = (4 * f).toFixed(2) + 'px';
  const inner = el.firstElementChild;
  if (inner) inner.style.transform = 'translateY(' + (-9 * (1 - f)).toFixed(2) + 'px)';
}
function updateHistoryPill() {
  const el = $('hist-more');
  if (!el) return;
  if (!state.currentId) { el.classList.remove('show', 'busy'); setHistRow(el, 0); return; }
  el.classList.toggle('busy', state.histLoading);
  el.firstElementChild.textContent = state.histLoading ? '加载中…'
    : '加载更早 · 还有 ' + (state.histTotal - state.histBefore) + ' 条';
  const hasMore = state.histBefore < state.histTotal;
  const f = state.histLoading ? 1
    : hasMore ? Math.max(0, Math.min(1, (HIST_RAMP - $('chat').scrollTop) / HIST_RAMP)) : 0;
  setHistRow(el, f);
  el.classList.toggle('show', f > 0.1); // interactive once it is really there
}
function loadOlder() {
  if (!state.currentId || state.histLoading || state.histBefore >= state.histTotal) return;
  const id = state.currentId;
  state.histLoading = true;
  updateHistoryPill();
  api('/api/sessions/' + encodeURIComponent(id) + '/messages?before=' + state.histBefore)
    .then((r) => r.json())
    .then((d) => {
      state.histLoading = false;
      if (state.currentId !== id) return;
      prependTurns(parseOlderTurns(d.events || []));
      state.histBefore += (d.events || []).length;
      updateHistoryPill();
    })
    .catch(() => { state.histLoading = false; updateHistoryPill(); });
}
// pull-to-older: armed only when genuinely pinned at the top with history
// left; fires once per touch, never blocks the native scroll (passive)
let pullY = 0, pullOn = false, pullFired = false;
$('chat').addEventListener('touchstart', (e) => {
  pullY = e.touches[0].clientY;
  pullOn = $('chat').scrollTop <= 0 && state.histBefore < state.histTotal;
  pullFired = false;
}, { passive: true });
$('chat').addEventListener('touchmove', (e) => {
  if (!pullOn || pullFired) return;
  if (e.touches[0].clientY - pullY > 70) { pullFired = true; loadOlder(); }
}, { passive: true });
$('chat').addEventListener('touchend', () => { pullOn = false; }, { passive: true });
$('hist-more').onclick = loadOlder;
// reveal/hide the loader row as the user crosses the top threshold
$('chat').addEventListener('scroll', updateHistoryPill, { passive: true });

/* ---------------- meta / driver chip ---------------- */
// header cost text is the v48 cost-panel entry (.cost-entry, coral + dotted
// underline; pulses when the number moves - dynamic discoverability)
// (already listed in the export statement at the bottom)
function renderMeta() {
  const s = state.sessions.find((x) => x.id === state.currentId);
  if (!s) return;
  $('d-title').textContent = s.title || s.id.slice(0, 8);
  const meta = $('d-meta');
  meta.textContent = '';
  if (s.cwd) meta.append(shortPath(s.cwd));
  const usd = costDisplay(s.cost);
  if (usd != null) {
    if (s.cwd) meta.append(' · ');
    const c = document.createElement('span');
    c.className = 'cost-entry';
    c.textContent = '$' + usd.toFixed(2);
    c.onclick = openCostPanel;
    if (meta.dataset.cost != null && meta.dataset.cost !== c.textContent) c.classList.add('pulse');
    meta.dataset.cost = c.textContent;
    meta.append(c);
  } else delete meta.dataset.cost;
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

export { openDetail, openDetailProvisional, closeDetail, renderMeta, renderDriverChip, refreshDriver, updateRunStatus, renderWaitBanner, loadOlder, updateHistoryPill };
