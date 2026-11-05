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
import { BUBBLES, queueApproval, showApproval, fetchPendingApprovals, showConfirm, closeHtmlPreview } from './js/views/overlays.js';
import { sessionLive, applyEventToTurns, markLiveTurn, closeLiveTurn,
  markCapped, renderTurn, renderTail, scrollBottom, updateJumpFab, pushOptimisticUser, retractOptimisticUser,
  updateAgentNode, updateAgentClocks, tickTurnDur } from './js/views/transcript.js';
import { onAgentFrame, tickAgentHead, closeAgentView } from './js/views/agentview.js';
import { seedActivity, onTasksFrame, onAgentUpdate, tickActivity, resetActivity, refreshActivity } from './js/views/activity.js';
import { openArchive, closeArchive, renderArchive } from './js/views/archive.js';
import { closeFileTree, syncFtMode } from './js/views/filetree.js';
import { openDetail, closeDetail, renderMeta, refreshDriver, updateRunStatus, renderWaitBanner, updateDetailEmpty } from './js/views/detail.js';
import { renderList, syncSel } from './js/views/list.js';
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
  applyWide(); // v195：宽屏则右栏同时上屏（无会话=空态）
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
  $('arch').classList.add('hidden'); // v185
  state.archOpen = false;
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

/* ---------------- v195 PC 双栏壳层（roadmap 13 · B 方案）----------------
   ≥1024px：#list/#arch 左栏常驻 + #detail 右栏同屏共挂；断点由 matchMedia
   单点驱动（CSS 只认 body.wide，不重复媒体查询）。跨断点 resize 对可见节点
   重跑 markCapped（限高测量依赖布局尺寸）。 */
const WIDE_MQ = window.matchMedia('(min-width:1024px)');
function applyWide() {
  const wide = WIDE_MQ.matches;
  if (state.wide === wide && document.body.classList.contains('wide') === wide) return;
  state.wide = wide;
  document.body.classList.toggle('wide', wide);
  syncFtMode(); // v195：文件树第三栏形态钩子（body.ft-open）
  const busy = !!(state.currentId || state.provisional);
  if (wide) {
    $('detail').classList.remove('hidden'); // 右栏常驻（无会话=空态）
    // 跨断点修复：窄屏里开会话/新建曾把左栏隐藏，宽屏必须恢复常驻
    // （左槽内容跟 state.archOpen：归档页开着就显示归档，否则列表）
    $('arch').classList.toggle('hidden', !state.archOpen);
    $('list').classList.toggle('hidden', !!state.archOpen);
  } else if (busy) {
    // 回窄屏且有会话：恢复互斥（详情独占）
    $('list').classList.add('hidden');
    $('arch').classList.add('hidden');
  } else {
    // 回窄屏且无会话：列表页独占
    $('detail').classList.add('hidden');
    $('list').classList.remove('hidden');
    $('arch').classList.add('hidden');
  }
  updateDetailEmpty();
  if (state.currentId) markCapped(); // 跨断点：可见节点重跑限高测量
}
WIDE_MQ.addEventListener ? WIDE_MQ.addEventListener('change', applyWide) : WIDE_MQ.addListener(applyWide);
applyWide(); // boot 即定壳（gate 阶段只挂 class，token 后 enterApp 补空态）

/* ---------------- view routing ---------------- */
window.addEventListener('popstate', (e) => {
  // an open bubble absorbs back (close it, stay in the detail view)
  const open = BUBBLES.find((id) => !$(id).classList.contains('hidden'));
  if (open) {
    $(open).classList.add('hidden');
    if (open === 'agent-sheet') state.agentView = null; // v112 bubble state
    if (state.currentId) { // restore the consumed detail entry (unique state+url: see detail.js)
      state.detailSeq++;
      history.pushState({ cr: 'detail', n: state.detailSeq }, '', '#s/' + state.detailSeq);
    }
    return;
  }
  // v104/v107: in-app html preview page absorbs back (it pushed its own
  // entry with a unique #hp/N url so traversal always fires popstate);
  // a stale htmlprev entry (preview already closed) is a no-op, never a
  // fall-through to the detail-exit branch
  if (!$('html-prev').classList.contains('hidden')) { closeHtmlPreview(); return; }
  if (e.state && e.state.cr === 'htmlprev') return;
  // system back inside detail returns to wherever it opened from (list or
  // archive) - the landed history entry decides (v185)
  if (state.currentId) {
    sendWs({ type: 'unsubscribe' });
    state.currentId = null;
    state.turns = [];
    syncSel(null); // v195
    updateDetailEmpty(); // v195
    closeFileTree(); // v195：无会话即无 cwd，树随反选收起（不擦面板偏好）
    if (state.wide) {
      $('detail').classList.remove('hidden'); // 宽屏右栏常驻：反选=空态，左栏保持原状
      return;
    }
    $('detail').classList.add('hidden');
    state.archOpen = !!(e.state && e.state.cr === 'arch');
    if (state.archOpen) { $('arch').classList.remove('hidden'); renderArchive(); }
    else $('list').classList.remove('hidden');
    return;
  }
  // v185: landed on/off the archive entry - sync page visibility with it
  // (covers gesture back out of the archive page and stray #arch entries)
  const onArch = !!(e.state && e.state.cr === 'arch');
  if (onArch !== state.archOpen) {
    state.archOpen = onArch;
    $('arch').classList.toggle('hidden', !onArch);
    $('list').classList.toggle('hidden', onArch);
    if (onArch) renderArchive();
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
      syncSel(null); // v195
      updateDetailEmpty(); // v195
      if (state.wide) {
        // 宽屏右栏常驻：回空态；宽屏 detail 条目是 replaceState 上来的，
        // back() 会离开应用根条目——原地反选即可
        closeFileTree(); // v195：无会话即无 cwd（不擦面板偏好）
        $('detail').classList.remove('hidden');
        return;
      }
      $('detail').classList.add('hidden');
      // v185: a detail opened from the archive page returns there
      if (state.archOpen) $('arch').classList.remove('hidden');
      else $('list').classList.remove('hidden');
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
  const hasGoalEv = (d.events || []).some((e) => e && (e.k === 'goal' || e.k === 'goalhold'));
  // optimistic-fold can edit a turn EARLIER than the tail; track the first
  // index touched so renderTail re-renders from there (children stay aligned)
  let editStart = prevLen - 1;
  for (const ev of d.events || []) {
    const ef = applyEventToTurns(ev);
    if (ef != null && ef < editStart) editStart = ef;
    // title live-update, path #2: the sessions-frame path (renderMeta) is the
    // primary, but a dropped/failed frame would leave the open detail's
    // header stale until re-entry - the append event carries the title itself
    // and only reaches the subscriber looking at this page
    if (ev.k === 'title' && ev.title) $('d-title').textContent = ev.title;
  }
  // v183: goal 活性在 applyEventToTurns 循环内才更新（旧值渲染=停止后胶囊不消失
  // 的真因——此前 refresh 在循环前跑，读到的是还活着的目标）——刷新必须在其后
  if (hasGoalEv) refreshActivity();
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
  if (history.state && history.state.cr === 'detail') {
    const n0 = history.state.n; // entry identity: the bubble-close branch pushes
    history.back();             // a NEW restore entry (fresh n) - not a drop
    // hardening: Chromium can drop a traversal under a poisoned joint-session
    // stack (pending traversal / deduped entries) - the pointer never moves
    // and the press looks dead. Fire only when we are still on the SAME entry
    // with the detail still open; a late popstate after a manual close is a
    // no-op (currentId already null).
    setTimeout(() => {
      if (state.currentId && history.state && history.state.cr === 'detail' && history.state.n === n0) closeDetail();
    }, 250);
  } else closeDetail();
};
$('del').onclick = deleteSession;
// v185: archive page entry + its back button (same traversal-swallow guard
// as #back - after back(), 250ms on the same entry means Chromium dropped
// the traversal and we close directly)
$('list-archive').onclick = openArchive;
$('arch-back').onclick = () => {
  if (history.state && history.state.cr === 'arch') {
    const n0 = history.state.n;
    history.back();
    setTimeout(() => {
      if (state.archOpen && history.state && history.state.cr === 'arch' && history.state.n === n0) closeArchive();
    }, 250);
  } else closeArchive();
};
setInterval(() => { if (state.currentId) { updateRunStatus(); updateAgentClocks(); tickAgentHead(); tickTurnDur(); tickActivity(); } }, 1000);

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
  agent: (d) => {
    // v112 方案A: subagent summary frame -> state + in-place node patch. The
    // bubble refresh keys off agentId (works even pre-attribution).
    if (d.id !== state.currentId || !d.toolUseId) { onAgentFrame(d); return; }
    const prev = state.agents[d.toolUseId] || {};
    state.agents[d.toolUseId] = {
      agentId: d.agentId, desc: d.desc || prev.desc || '', agentType: d.agentType || '',
      bg: !!d.bg, finished: d.state === 'done' || !!prev.finished, state: d.state,
      steps: d.steps || prev.steps || 0, act: d.act || '', startedAt: d.startedAt || prev.startedAt || 0,
      // completion moment freezes every timer (v115); a toolres-done without
      // a bridge finishedAt still freezes locally at frame time
      finishedAt: d.finishedAt || prev.finishedAt || (d.state === 'done' ? Date.now() : 0),
    };
    updateAgentNode(d);
    onAgentFrame(d);
    onAgentUpdate(d); // 活动胶囊跟随（新代理入集合 / 运行数 / 完成转「已完成」）
  },
  tasks: (d) => onTasksFrame(d),
  approval: queueApproval,
  'approval-result': (d) => {
    // a decision landed (this client or another); drop it if still queued
    state.approvals = state.approvals.filter((a) => a.id !== d.id);
    showApproval();
  },
  notify: (d) => {
    // v185 活跃反归档：归档会话又有新写入被自动恢复——被动通知必须给来由，
    // 否则用户以为归档坏了
    if (d.event === 'auto-unarchive') {
      toast('「' + (d.title || '会话').slice(0, 20) + '」有新活动，已自动恢复');
      return;
    }
    toast('[' + (d.title || '').slice(0, 20) + '] ' + (d.event === 'stop' ? '已完成' : d.event));
  },
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
