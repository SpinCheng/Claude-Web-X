/* claude-remote PWA — cockpit app (vanilla, no build)
   转录以"轮次"渲染：用户消息 → 机器轮（思考/工具折叠区 + 最终结论）。
   运行中的轮次思考区展开并带光标；结束后收起。
   v32 (refactor step 5): app.js is the assembly root — boot, token gate,
   view routing and WS frame semantics. Views live in js/views/. */
import { state } from './js/state.js';
import { auth, api, tryToken, setUnauthorized } from './js/api.js';
import { initWs, connectWs, sendWs } from './js/ws.js';
import { $ } from './js/util.js';
import { toast } from './js/views/toast.js';
import { BUBBLES, queueApproval, showApproval, fetchPendingApprovals, showConfirm } from './js/views/overlays.js';
import { sessionLive, applyEventToTurns, markLiveTurn, closeLiveTurn,
  markCapped, renderTurn, renderTail, scrollBottom, updateJumpFab, pushOptimisticUser, retractOptimisticUser } from './js/views/transcript.js';
import { renderList } from './js/views/list.js';
import { openDetail, closeDetail, renderMeta, refreshDriver, updateRunStatus, renderWaitBanner } from './js/views/detail.js';
import { renderModelChip, updateTokenRing } from './js/views/ctxring.js';
import { updateComposer, renderQueuePanel } from './js/views/composer.js';

/* ---------------- token gate ---------------- */
async function saveToken() {
  const t = $('token-input').value.trim();
  $('gate-err').textContent = '';
  if (!t) return;
  if (await tryToken(t)) {
    state.token = t;
    localStorage.setItem('cr_token', t);
    enterApp();
  } else {
    $('gate-err').textContent = '令牌无效，或 bridge 没在运行';
  }
}
function enterApp() {
  $('gate').classList.add('hidden');
  $('list').classList.remove('hidden');
  connectWs();
  fetchSessions(); // HTTP bootstrap so the list shows even before WS settles
  setInterval(() => { if (state.currentId) updateTokenRing(); }, 15000);
  renderModelChip();
}
let gateReason = '';
function showGate(reason) {
  // token died (rotated on PC): back to pairing
  state.token = '';
  localStorage.removeItem('cr_token');
  try { if (state.ws) state.ws.close(); } catch (e) { /* noop */ }
  gateReason = reason || '';
  $('gate-err').textContent = gateReason;
  $('list').classList.add('hidden');
  $('detail').classList.add('hidden');
  $('gate').classList.remove('hidden');
  $('token-input').focus();
}
function fetchSessions() {
  api('/api/sessions')
    .then((r) => r.json())
    .then((d) => {
      state.sessions = d.sessions || [];
      state.waits = {};
      for (const s of state.sessions) if (s.waiting) state.waits[s.id] = s.waiting;
      renderList(); renderMeta(); renderWaitBanner();
      // v102: an open detail view also refreshes its transcript - a
      // background turn may have finished while the PWA was suspended
      const cur = state.currentId;
      if (cur) {
        api('/api/sessions/' + encodeURIComponent(cur) + '/messages')
          .then((r) => r.json())
          .then((d) => {
            if (state.currentId !== cur) return;
            buildTurns(d.events || []);
            renderAllTurns();
            if (state.atBottom) scrollBottom();
          })
          .catch(() => {});
      }
    })
    .catch(() => {});
}

/* ---------------- view routing ---------------- */
window.addEventListener('popstate', (e) => {
  // an open bubble absorbs back (close it, stay in the detail view)
  const open = BUBBLES.find((id) => !$(id).classList.contains('hidden'));
  if (open) {
    $(open).classList.add('hidden');
    if (state.currentId) history.pushState({ cr: 'detail' }, '', '#s'); // restore the consumed detail entry
    return;
  }
  // system back inside detail returns to the list
  if (state.currentId) {
    sendWs({ type: 'unsubscribe' });
    state.currentId = null;
    state.turns = [];
    $('detail').classList.add('hidden');
    $('list').classList.remove('hidden');
  }
});

/* ---------------- delete ---------------- */
function deleteSession() {
  const id = state.currentId;
  if (!id) return;
  showConfirm({ title: '删除该会话', body: '转录移入电脑回收站，可找回。', ok: '删除', danger: true, onOk: doDeleteSession });
}
function doDeleteSession() {
  const id = state.currentId;
  if (!id) return;
  fetch('/api/sessions/' + encodeURIComponent(id), { method: 'DELETE', headers: auth() })
    .then((r) => r.json())
    .then((j) => {
      if (!j.ok) { toast('删除失败：' + (j.error || '')); return; }
      state.currentId = null;
      $('detail').classList.add('hidden');
      $('list').classList.remove('hidden');
      if (history.state && history.state.cr) history.back();
    })
    .catch(() => toast('网络错误'));
}

/* ---------------- v102: resume-from-background resync ---------------- */
// Locking the phone suspends the PWA: the WS dies without a close frame, run
// frames are missed, and on return the UI would show stale running lamps
// (and a stale transcript) until some unrelated frame arrived. Force a full
// resync: WS reconnect + sessions/detail refetch; the v100 run-memory
// reconciliation runs on the fresh sessions frame.
let lastResume = 0;
function resyncOnResume() {
  const now = Date.now();
  if (now - lastResume < 2000) return; // visibilitychange + pageshow both fire
  lastResume = now;
  if (!state.token) return;
  connectWs(); // closes any dead socket and reconnects with backoff reset
  fetchSessions();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') resyncOnResume();
});
window.addEventListener('pageshow', (e) => {
  if (e.persisted) resyncOnResume(); // bfcache restore
});

/* ---------------- websocket frame semantics (transport in js/ws.js) ---------------- */
function handleAppend(d) {
  if (d.id !== state.currentId) return;
  const prevLen = state.turns.length;
  // optimistic-fold can edit a turn EARLIER than the tail; track the first
  // index touched so renderTail re-renders from there (children stay aligned)
  let editStart = prevLen - 1;
  for (const ev of d.events || []) {
    const ef = applyEventToTurns(ev);
    if (ef != null && ef < editStart) editStart = ef;
  }
  // a stop marker means the turn ENDED (any driver): close the live view so
  // the finished turn re-renders collapsed
  if ((d.events || []).some((e) => e.k === 'stop')) {
    state.liveTurnOpen = false;
    state.userCollapsedLive = false;
  } else {
    markLiveTurn();
  }
  renderTail(editStart + 1);
  scrollBottom();
  updateJumpFab();
  updateRunStatus(); // tool name may have advanced
}
function handleRunFrame(d) {
  if (!d.sessionId) {
    // spawn-level failure (bad cwd, CLI missing): no session will ever appear
    if (state.pendingNew === d.runId && (d.state === 'error' || d.state === 'end')) {
      state.pendingNew = null;
      state.pendingNewText = '';
      if (state.provisional && !document.getElementById('detail').classList.contains('hidden')) closeDetail();
      toast('任务没启动起来：' + (d.stderrTail || d.error || '查看工作目录是否正确').slice(0, 80));
    }
    if (state.pendingBranchRun === d.runId && (d.state === 'error' || d.state === 'end')) {
      state.pendingBranch = false;
      state.pendingBranchRun = null;
      toast('分支线程没启动起来：' + (d.stderrTail || d.error || '未知原因').slice(0, 80));
    }
    return;
  }
  state.runs[d.sessionId] = { runId: d.runId, state: d.state, startedAt: d.startedAt };
  // v88: a run that ends with an unconfirmed optimistic twin (stopped before
  // the CLI wrote the user line) flips its dot red+static instead of
  // breathing forever; the twin stays foldable if the line lands later
  if ((d.state === 'end' || d.state === 'error') && d.sessionId === state.currentId) {
    let min = -1;
    state.turns.forEach((t, i) => {
      if (t.role === 'user' && t.optimistic) { t.stopped = true; if (min < 0) min = i; }
    });
    if (min >= 0) renderTail(min);
  }
  if (d.sessionId === state.currentId) {
    updateComposer();
    updateRunStatus();
    if (d.state === 'end' || d.state === 'error') {
      closeLiveTurn();
      if (d.stderrTail) toast('运行异常，详见会话');
      // collapse the finished turn's machine zone in place
      const chat = $('chat');
      const T = state.turns;
      if (T.length && T[T.length - 1].role === 'bot' && chat.lastChild) {
        chat.replaceChild(renderTurn(T[T.length - 1]), chat.lastChild);
        markCapped();
      }
      if ((d.state === 'error' || (d.exitCode != null && d.exitCode !== 0 && d.exitCode !== 'cancelled'))) {
        const text = d.state === 'error'
          ? '— 运行出错：' + (d.error || '') + ' —'
          : '— 已结束，退出码 ' + d.exitCode + ' —';
        const line = document.createElement('div');
        line.className = 'sysline';
        line.textContent = text;
        chat.appendChild(line);
        state.turns.push({ role: 'sys', text });
      }
      scrollBottom();
      refreshDriver();
    }
  }
  if (state.pendingNew === d.runId && d.state === 'running') {
    state.pendingNew = null;
    // adopted - plain openDetail re-binds in place: the chat rebuilds and
    // the v64 seed re-shows the optimistic bubble in the same tick
    if (state.currentId !== d.sessionId) openDetail(d.sessionId);
  }
  // v40 branch adoption: the fork's real session id arrived (init line).
  // pendingBranchRun may still be null (WS beat the 202) - then accept any
  // running frame for a different session within this tiny arming window.
  if (state.pendingBranch && d.state === 'running' && d.sessionId !== state.currentId &&
      (!state.pendingBranchRun || state.pendingBranchRun === d.runId)) {
    state.pendingBranch = false;
    state.pendingBranchRun = null;
    openDetail(d.sessionId);
  }
}

/* ---------------- boot & wiring ---------------- */
$('token-save').onclick = saveToken;
$('token-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveToken(); });
$('back').onclick = () => {
  if (history.state && history.state.cr === 'detail') history.back();
  else closeDetail();
};
$('del').onclick = deleteSession;
setInterval(() => { if (state.currentId) updateRunStatus(); }, 1000);

/* ---------------- wiring: transport <-> semantics ---------------- */
initWs({
  onOpen: () => fetchPendingApprovals(), // catch cards missed while disconnected
  sessions: (d) => {
    state.sessions = d.sessions || [];
    // v100: reconcile client run memory against bridge truth - a run-end
    // frame missed (WS drop, bridge restart, page was on the list page and
    // never subscribed) used to leave state.runs[id]='running' forever, and
    // the lamp reads it FIRST. The bridge is the authority: demote.
    const live = new Set((d.sessions || []).filter((s) => s.running).map((s) => s.id));
    for (const id of Object.keys(state.runs)) {
      const r = state.runs[id];
      // 10s grace: a just-started run can race a stale sessions frame (the
      // frame was snapshotted before the spawn registered)
      if (!live.has(id) && r.state === 'running' && Date.now() - (r.startedAt || 0) > 10_000) {
        r.state = 'ended';
      }
    }
    state.waits = {};
    for (const s of state.sessions) if (s.waiting) state.waits[s.id] = s.waiting;
    renderList();
    renderMeta();
    renderWaitBanner();
    updateTokenRing();
    updateRunStatus();
    updateComposer(); // opening mid-run: no run frame will come, the list is the signal
    // liveness flip via session status (e.g. bridge saw the idle broadcast):
    // close the live turn without waiting for the next append
    if (state.currentId && state.liveTurnOpen && !sessionLive(state.currentId)) {
      closeLiveTurn();
      renderTail(state.turns.length);
    }
  },
  append: handleAppend,
  'queue-dispatched': (d) => {
    // v37: the dispatched message's user line must SHOW when it lands - arm
    // the fold so a same-text elder isn't mistaken for a replayed duplicate.
    // v72: also push it optimistically right at dispatch (the transcript
    // line lands seconds later; the same-text fold confirms this twin in
    // place, spinner and all). Safety: if nothing lands in 30s (spawn
    // failure), pull the twin back - retract no-ops once confirmed.
    if (d.sessionId === state.currentId) {
      state.expectQueuedUser = true;
      toast('排队消息已自动发出');
      if (d.text) {
        const twin = pushOptimisticUser(d.text);
        setTimeout(() => retractOptimisticUser(twin), 30_000);
      }
    }
  },
  queue: (d) => {
    // authoritative queue snapshot after any mutation (enqueue/remove/
    // reorder/clear/drain): refresh cache + the open session's panel
    if (d.queue && d.queue.length) state.queue[d.sessionId] = d.queue;
    else delete state.queue[d.sessionId];
    if (d.sessionId === state.currentId) renderQueuePanel();
  },
  wait: (d) => {
    // PC session stuck on a permission prompt (v21)
    if (d.waiting) state.waits[d.sessionId] = d.waiting;
    else delete state.waits[d.sessionId];
    renderList();
    if (d.sessionId === state.currentId) renderWaitBanner();
  },
  run: handleRunFrame,
  approval: queueApproval,
  'approval-result': (d) => {
    // a decision landed (this client or another); drop it if still queued
    state.approvals = state.approvals.filter((a) => a.id !== d.id);
    showApproval();
  },
  notify: (d) => toast('[' + (d.title || '').slice(0, 20) + '] ' + (d.event === 'stop' ? '已完成' : d.event)),
});
setUnauthorized(() => showGate('令牌已失效（可能刚轮换过），请用新二维码重新配对'));

(async function boot() {
  // auto-pairing: ?token=... (QR); saved then stripped from the URL
  const q = new URLSearchParams(location.search).get('token');
  const openId = location.hash.startsWith('#open=') ? location.hash.slice(6) : null;
  if (q && await tryToken(q)) {
    state.token = q;
    localStorage.setItem('cr_token', q);
    history.replaceState(null, '', location.pathname);
    enterApp();
    if (openId) openDetail(openId);
    return;
  }
  if (state.token && await tryToken(state.token)) {
    enterApp();
    if (openId) openDetail(openId);
  } else {
    $('gate').classList.remove('hidden');
    $('token-input').focus();
  }
})();
