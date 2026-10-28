// js/views/composer.js - the dock: message input (three-state send/stop),
// attachments (pick -> downscale -> upload -> chips), the perm picker
// (model+effort picker lives in ctxring.js since v36), the queue panel
// (v17, rows above the input) and the new-session modal.
// Optimistic send (v18/v21) reaches into transcript.js for push/retract.
// NOTE: function-level import cycle with detail.js (updateComposer ->
// renderDriverChip / openDetail -> updateComposer) - safe because no
// cross-module call happens at module-evaluation time (ESM live bindings).

import { $, shortPath } from '../util.js';
import { state, IS_TOUCH, currentModel, currentEffort } from '../state.js';
import { auth, api } from '../api.js';
import { toast } from './toast.js';
import { openBubble, closeBubble, openLightbox, openFilePreview, showConfirm } from './overlays.js';
import { pushOptimisticUser, retractOptimisticUser } from './transcript.js';
import { renderDriverChip, openDetailProvisional, closeDetail } from './detail.js';

/* ---------------- permission mode ---------------- */
function setPerm(v) {
  state.perm = v;
  localStorage.setItem('cr_perm', v);
  const label = $('perm-label');
  if (label) label.textContent = v === 'ask' ? '审批' : '自动';
  const btn = $('perm');
  if (btn) { btn.dataset.v = v; btn.title = v === 'ask' ? '需要时审批（点击切换）' : '自动执行（点击切换）'; }
}
/* permission picker (bubble instead of direct toggle) */
function openPermSheet() {
  const box = $('perm-list');
  box.innerHTML = '';
  const opts = [
    { v: 'auto', label: '自动执行', sub: 'YOLO · 工具免审批' },
    { v: 'ask', label: '需要时审批', sub: '弹卡确认后继续' },
  ];
  for (const o of opts) {
    const el = document.createElement('button');
    el.className = 'opt' + (state.perm === o.v ? ' active' : '');
    el.innerHTML = '<span class="o-main"><span class="o-label"></span><span class="o-sub"></span></span>'
      + '<svg class="o-check" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';
    el.querySelector('.o-label').textContent = o.label;
    el.querySelector('.o-sub').textContent = o.sub;
    el.onclick = () => { setPerm(o.v); closeBubble('perm-sheet'); };
    box.appendChild(el);
  }
  openBubble('perm-sheet');
}

/* ---------- effort picker moved to ctxring.js (v36: merged into the model
   sheet) - composer only READS currentEffort() when sending ---------- */

/* ---------------- queue panel (v17): flat rows above the input ---------------- */
const QI = {
  grip: '<svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor"><circle cx="2.5" cy="2.5" r="1.3"/><circle cx="7.5" cy="2.5" r="1.3"/><circle cx="2.5" cy="8" r="1.3"/><circle cx="7.5" cy="8" r="1.3"/><circle cx="2.5" cy="13.5" r="1.3"/><circle cx="7.5" cy="13.5" r="1.3"/></svg>',
  play: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="7 4 20 12 7 20"/></svg>',
  pencil: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>',
  trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>',
};
const Q_MAX_ROWS = 3;
function queueEntries() { return state.queue[state.currentId] || []; }
function qApi(path, opts) { return api('/api/sessions/' + encodeURIComponent(state.currentId) + '/queue' + path, opts); }
function fetchQueue(id) {
  api('/api/sessions/' + encodeURIComponent(id) + '/queue')
    .then((r) => r.json())
    .then((d) => {
      if (d.queue && d.queue.length) state.queue[id] = d.queue;
      else delete state.queue[id];
      if (state.currentId === id) renderQueuePanel();
    })
    .catch(() => {});
}
function renderQueuePanel() {
  const host = $('queue-area');
  if (!host) return;
  host.innerHTML = '';
  const q = queueEntries();
  if (!q.length) return;
  const shown = q.slice(0, Q_MAX_ROWS), hidden = q.length - shown.length;
  const area = document.createElement('div');
  area.className = 'queue-area';
  const head = document.createElement('div');
  head.className = 'q-head';
  const info = document.createElement('span');
  const cnt = document.createElement('b'); cnt.className = 'cnt'; cnt.textContent = q.length;
  info.append('队列 · ', cnt, ' · ' + (hidden ? '本轮结束后依序发出 · ' + hidden + ' 条待上屏' : '本轮结束后依序发出'));
  const clr = document.createElement('button');
  clr.className = 'clr'; clr.textContent = '清空';
  clr.onclick = () => {
    showConfirm({ title: '清空队列', body: '移除全部 ' + cnt + ' 条排队中的消息？', ok: '清空', danger: true,
      onOk: () => qApi('', { method: 'DELETE' }).catch(() => {}) });
  };
  head.append(info, clr);
  area.appendChild(head);
  for (const e of shown) area.appendChild(qRowEl(e, area));
  host.appendChild(area);
}
function qRowEl(e, area) {
  const row = document.createElement('div');
  row.className = 'q-row';
  row.dataset.qid = e.id;
  const grip = document.createElement('span');
  grip.className = 'q-grip'; grip.title = '拖动排序'; grip.innerHTML = QI.grip;
  const txt = document.createElement('span');
  txt.className = 'q-txt'; txt.textContent = e.text;
  const acts = document.createElement('span');
  acts.className = 'q-acts';
  // ▶ 立即：插到队首 + 中断当前 run，排空时优先发这条
  const run = document.createElement('button');
  run.className = 'q-ico run'; run.title = '立即运行：中断当前任务并发送此条'; run.innerHTML = QI.play;
  run.onclick = () => {
    showConfirm({ title: '立即发送', body: '中断当前正在运行的任务，改为立即发送这条排队消息？', ok: '中断并发送', danger: true,
      onOk: () => qApi('/' + encodeURIComponent(e.id) + '/runnow', { method: 'POST' }).catch(() => {}) });
  };
  // ✏ 编辑：取回输入框（出队），改完重新发送会重新排队
  const edit = document.createElement('button');
  edit.className = 'q-ico'; edit.title = '编辑：取回输入框'; edit.innerHTML = QI.pencil;
  edit.onclick = () => {
    const input = $('msg-input');
    input.value = e.text;
    saveDraft(); // taken back into the box = it IS the draft now
    autoGrow();
    qApi('/' + encodeURIComponent(e.id), { method: 'DELETE' }).catch(() => {});
    input.focus();
  };
  const del = document.createElement('button');
  del.className = 'q-ico del'; del.title = '删除'; del.innerHTML = QI.trash;
  del.onclick = () => qApi('/' + encodeURIComponent(e.id), { method: 'DELETE' }).catch(() => {});
  acts.append(run, edit, del);
  row.append(grip, txt, acts);
  wireQDrag(grip, row, area);
  return row;
}
// drag-to-reorder on the grip only (touch-action:none there, scroll unaffected)
function wireQDrag(grip, row, area) {  grip.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    const startY = ev.clientY;
    let started = false;
    const rows = () => [...area.querySelectorAll('.q-row')];
    const onMove = (e2) => {
      if (!started) {
        if (Math.abs(e2.clientY - startY) < 6) return;
        started = true;
        row.classList.add('dragging');
      }
      const all = rows();
      const idx = all.indexOf(row);
      if (idx < 0) return;
      for (let i = 0; i < all.length; i++) {
        if (all[i] === row) continue;
        const b = all[i].getBoundingClientRect();
        const mid = b.top + b.height / 2;
        if (i < idx && e2.clientY < mid) { area.insertBefore(row, all[i]); break; }
        if (i > idx && e2.clientY > mid) { area.insertBefore(row, all[i].nextElementSibling); break; }
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      row.classList.remove('dragging');
      if (!started || !state.currentId) return;
      const hiddenIds = queueEntries().slice(Q_MAX_ROWS).map((x) => x.id);
      const order = rows().map((r) => r.dataset.qid).concat(hiddenIds);
      qApi('/reorder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order }) }).catch(() => {});
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

/* ---------------- attachments (v19): pick -> downscale -> upload -> chip ---------------- */
const DOC_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
function renderAttachChips() {
  const host = $('attach-chips');
  host.innerHTML = '';
  for (const a of state.attach) host.appendChild(chipEl(a));
  host.classList.toggle('hidden', !state.attach.length);
}
function chipEl(a) {
  const s = document.createElement('span');
  s.className = 'attach-chip';
  if (/^image\//.test(a.type || '') && a.url) {
    const im = document.createElement('img');
    im.src = a.url;
    im.onclick = () => openLightbox(a.url);
    s.appendChild(im);
  } else {
    const ic = document.createElement('span');
    ic.className = 'ac-ico';
    ic.innerHTML = DOC_ICON;
    ic.onclick = () => !a.uploading && openFilePreview(a);
    s.appendChild(ic);
  }
  const nm = document.createElement('span');
  nm.className = 'ac-name';
  nm.textContent = a.name + (a.uploading ? ' …' : '');
  nm.onclick = () => !a.uploading && (/^image\//.test(a.type || '') ? openLightbox(a.url) : openFilePreview(a));
  const x = document.createElement('button');
  x.className = 'ac-x';
  x.textContent = '×';
  x.onclick = () => {
    const i = state.attach.indexOf(a);
    if (i >= 0) state.attach.splice(i, 1);
    renderAttachChips();
  };
  s.append(nm, x);
  return s;
}
async function addAttachment(f) {
  if (state.attach.length >= 4) { toast('最多带 4 个附件'); return; }
  if (f.size > 20 * 1024 * 1024) { toast('文件超过 20MB：' + f.name); return; }
  const att = { name: f.name, type: f.type || '', uploading: true, url: '' };
  state.attach.push(att);
  renderAttachChips();
  try {
    let bytes = new Uint8Array(await f.arrayBuffer());
    if (/^image\//.test(att.type) && att.type !== 'image/gif') {
      const r = await downscaleImage(bytes, att.type);
      bytes = r.bytes; att.type = r.type;
      att.url = URL.createObjectURL(new Blob([bytes], { type: att.type }));
    }
    const r = await fetch('/api/sessions/' + encodeURIComponent(state.currentId) + '/attach?name=' + encodeURIComponent(f.name), {
      method: 'POST', headers: auth(), body: bytes,
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    att.file = j.file; att.uploading = false;
  } catch {
    toast('附件上传失败：' + f.name);
    const i = state.attach.indexOf(att);
    if (i >= 0) state.attach.splice(i, 1);
  }
  renderAttachChips();
}
// photos from the phone camera are multi-MB; canvas-downscale to the vision
// sweet spot before upload (small images pass through untouched)
async function downscaleImage(bytes, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const MAX = 1568;
    if (bytes.length <= 400 * 1024 && img.width <= MAX && img.height <= MAX) return { bytes, type };
    const scale = Math.min(1, MAX / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * scale));
    c.height = Math.max(1, Math.round(img.height * scale));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
    return { bytes: new Uint8Array(await blob.arrayBuffer()), type: 'image/jpeg' };
  } finally { URL.revokeObjectURL(url); }
}

/* ---------------- composer ---------------- */
// per-session draft persistence (v40): unsent input survives leaving the
// session (localStorage cr_draft_<sid>, re-filled by openDetail -> setDraft)
const draftKey = (id) => 'cr_draft_' + id;
let _draftTimer = null;
function saveDraft() {
  const id = state.currentId;
  if (!id) return;
  const v = $('msg-input').value.slice(0, 20000);
  try { if (v) localStorage.setItem(draftKey(id), v); else localStorage.removeItem(draftKey(id)); } catch { /* quota */ }
}
function setDraft(id) {
  let v = '';
  try { v = localStorage.getItem(draftKey(id)) || ''; } catch { /* */ }
  const input = $('msg-input');
  input.value = v;
  autoGrow();
  updateComposer();
}
function autoGrow() {
  const t = $('msg-input');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, window.innerHeight * 0.38) + 'px';
}
function updateComposer() {
  const run = state.currentId && state.runs[state.currentId];
  const rec = state.sessions.find((x) => x.id === state.currentId);
  // live run may be known locally (run frames) or come from the server list
  const running = !!(run && run.state === 'running') || !!(rec && rec.running);
  const typed = $('msg-input').value.trim().length > 0;
  // three-state (v17): idle=send · running+empty=stop · running+typed=amber
  // queue-send ONLY (stop hides while typing; clear text to reach it again)
  const showSend = !running || typed;
  $('send').classList.toggle('hidden', !showSend);
  $('send').classList.toggle('queue', running && typed);
  $('stop').classList.toggle('hidden', !running || typed);
  $('msg-input').placeholder = running ? '继续输入以排队后续修改' : '提出后续修改要求';
  renderDriverChip();
}
function sendMessage(force) {
  const input = $('msg-input');
  const text = input.value.trim();
  if (!text) return;
  if (!state.currentId) { if (state.provisional) toast('会话创建中，稍候再发'); return; }
  if (state.armedBranch === state.currentId) { sendFork(text, input.value); return; }
  _send(text, input.value, force);
}
// v40 branch send: this message forks into a NEW session that inherits the
// source thread's context (runner: --resume <src> --fork-session). No
// optimistic bubble - the message belongs to the thread we're about to
// navigate AWAY from. The fork's real session id rides the init line
// (runner adoption, same as new sessions); app.js opens it via the
// pendingBranch flags. The fork does not queue: a busy source refuses.
function sendFork(text, rawInput) {
  const src = state.currentId;
  const atts = state.attach.splice(0);
  renderAttachChips();
  clearComposer();
  state.pendingBranch = true;
  state.pendingBranchRun = null;
  api('/api/sessions/' + encodeURIComponent(src) + '/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text, force: false, perm: state.perm, model: currentModel(), effort: currentEffort(),
      branchFrom: src, attachments: atts.map((a) => ({ file: a.file, name: a.name, type: a.type })),
    }),
  })
    .then(async (r) => {
      if (!r.ok) {
        disarmFork();
        restoreComposer(rawInput, atts);
        const j = await r.json().catch(() => ({}));
        toast(j.error === 'busy' ? '源会话正在运行，结束后再分支' : '分支启动失败（' + r.status + '）');
        return;
      }
      const j = await r.json().catch(() => ({}));
      state.pendingBranchRun = j.runId || null;
      toast('分支线程启动中…');
    })
    .catch(() => { disarmFork(); restoreComposer(rawInput, atts); toast('网络错误'); });
}
function disarmFork() {
  state.armedBranch = null;
  state.pendingBranch = false;
  state.pendingBranchRun = null;
  const chip = $('fork-chip');
  if (chip) chip.classList.add('hidden');
}
// optimistic path (v18→v21): the box empties, its height collapses, the
// three-state button flips and the message bubble appears THE MOMENT the send
// is tapped — not after the network round-trip (slow links made taps feel
// dead). Every failure path restores the original text so nothing is lost.
function _send(text, rawInput, force, attsOverride, shownTurn) {
  // retry passes its attachments back in; first attempt takes them from state
  const atts = attsOverride || state.attach.splice(0);
  if (!attsOverride) renderAttachChips();
  clearComposer();
  // optimistic bubble (v21): at TAP time, not after the round-trip — on slow
  // links the POST latency is the same dead-tap window v18 closed for the
  // composer. Retracted by every refusal path unless the transcript already
  // folded into it (then it is a real message and stays).
  if (!shownTurn && state.currentId) shownTurn = pushOptimisticUser(text);
  const fail = () => { restoreComposer(rawInput, atts); retractOptimisticUser(shownTurn); };
  api('/api/sessions/' + encodeURIComponent(state.currentId) + '/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text, force: !!force, perm: state.perm, model: currentModel(), effort: currentEffort(),
      attachments: atts.map((a) => ({ file: a.file, name: a.name, type: a.type })),
    }),
  })
    .then(async (r) => {
      if (r.status === 409) {
        const j = await r.json().catch(() => ({}));
        if (j.error === 'recent-local-write') {
          const ago = j.sinceMs != null ? Math.round(j.sinceMs / 1000) + ' 秒' : '刚刚';
          showConfirm({ title: '电脑端可能正在使用', body: '电脑端 ' + ago + '前刚在写这个会话（电脑窗口需重开才能看到手机的新消息）。仍然发送？', ok: '仍然发送',
            onOk: () => _send(text, rawInput, force, atts, shownTurn), onCancel: fail });
          return;
        }
        if (j.error === 'pc-claim') {
          showConfirm({ title: '电脑端已接管', body: '电脑端正通过 cr attach 持有此会话。切换为手机驱动并发送？', ok: '切换并发送',
            onOk: () => _send(text, rawInput, force, atts, shownTurn), onCancel: fail });
          return;
        }
        if (j.error === 'busy') { toast('本会话已有消息在运行，等它结束或点停止'); fail(); return; }
      }
      if (!r.ok) { toast('发送失败（' + r.status + '）'); fail(); return; }
      const j = await r.json().catch(() => ({}));
      if (j.queued) {
        // v37: queued = not on the transcript yet - pull the optimistic
        // bubble back out; it goes on screen when the dispatch really
        // writes it (expectQueuedUser arms the fold for that moment).
        // Retract is race-safe: if the dispatch somehow already folded the
        // turn, optimistic=false makes it a no-op.
        retractOptimisticUser(shownTurn);
        toast('已排队（第 ' + j.position + ' 条）· 本轮结束后自动发出');
      }
      state.atBottom = true;
    })
    .catch(() => { toast('网络错误'); fail(); });
}
function clearComposer() {
  const input = $('msg-input');
  input.value = '';
  try { if (state.currentId) localStorage.removeItem(draftKey(state.currentId)); } catch { /* */ }
  autoGrow();       // collapse the grown height back to one line
  updateComposer(); // re-evaluate the button: running+empty => stop, not amber queue-send
}
function restoreComposer(text, atts) {
  const input = $('msg-input');
  if (!input.value) {
    input.value = text;
    saveDraft(); // programmatic set doesn't fire input - persist it here
    autoGrow();
    updateComposer();
  }
  if (atts && atts.length) {
    state.attach = atts.concat(state.attach);
    renderAttachChips();
  }
}
function stopRun() {
  // runId from the run frame, or from the sessions frame (v34: mergedSessions
  // exposes it) - covers loading the page mid-run, when no frame was ever seen
  const rec = state.currentId && state.sessions.find((x) => x.id === state.currentId);
  const runId = (state.runs[state.currentId] || {}).runId || (rec && rec.runId) || '';
  if (!runId) return;
  fetch('/api/runs/' + encodeURIComponent(runId) + '/cancel', { method: 'POST', headers: auth() })
    .then(() => toast('已发送停止信号'))
    .catch(() => {});
}

/* ---------------- new session ---------------- */
// presetCwd: preselect the project dir (list-page group-head + button).
// Existing onclick= wiring passes the event object here, so non-strings reset.
function openNewModal(presetCwd) {
  if (typeof presetCwd !== 'string') presetCwd = '';
  const go = $('new-go'); // every open starts fresh
  go.disabled = false; go.classList.remove('loading');
  // v78: group-head + already knows the project - the whole cwd section
  // stays hidden (default IS that dir); the bare header + shows it
  $('nsec-cwd').classList.toggle('hidden', !!presetCwd);
  // progressive disclosure resets on every open
  $('new-cwd-box').classList.remove('on');
  $('new-cwd-manual').style.display = '';
  const sel = $('new-cwd');
  sel.innerHTML = '';
  const seen = new Set();
  const opts = [];
  for (const s of state.sessions) {
    if (s.kind !== 'cc' || !s.cwd || seen.has(s.cwd)) continue;
    seen.add(s.cwd);
    opts.push(s.cwd);
  }
  if (opts.length === 0) {
    sel.innerHTML = '<option value="">（暂无已知项目，手动输入路径）</option>';
  } else {
    for (const c of opts) {
      const o = document.createElement('option');
      o.value = c;
      o.textContent = shortPath(c) + '  —  ' + c;
      sel.appendChild(o);
    }
  }
  if (presetCwd) {
    // target dir not among known cwds -> add it so the select can show it
    if (![...sel.options].some((o) => o.value === presetCwd)) {
      const o = document.createElement('option');
      o.value = presetCwd;
      o.textContent = shortPath(presetCwd) + '  —  ' + presetCwd;
      sel.insertBefore(o, sel.firstChild);
    }
    sel.value = presetCwd;
  }
  $('new-cwd-custom').value = '';
  $('new-text').value = '';
  $('new-err').textContent = '';
  document.querySelectorAll('#new-perm button').forEach((b) => {
    b.classList.toggle('active', b.dataset.v === state.perm);
  });
  $('new-modal').classList.remove('hidden');
  $('new-text').focus();
}
function submitNewSession() {
  const go = $('new-go');
  if (go.disabled) return; // POST in flight - no double submit
  go.disabled = true; go.classList.add('loading');
  const text = $('new-text').value.trim();
  if (!text) { $('new-err').textContent = '任务内容不能为空'; return; }
  // manual path only counts while its disclosure is open (v78)
  const custom = $('new-cwd-box').classList.contains('on') ? $('new-cwd-custom').value.trim() : '';
  const cwd = custom || $('new-cwd').value || '';
  const perm = document.querySelector('#new-perm .seg-btn.active')?.dataset.v || state.perm;
  const model = (document.querySelector('#new-perm .seg-btn.active')?.dataset.v, currentModel());
  fetch('/api/sessions/new', {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, cwd, perm, model, effort: currentEffort() }),
  })
    .then((r) => r.json())
    .then((j) => {
      if (!j.ok) { $('new-err').textContent = '启动失败：' + (j.error || ''); return; }
      $('new-modal').classList.add('hidden');
      state.pendingNew = j.runId;
      state.pendingNewText = text; // adoption seed (openDetail re-shows it after the rebuild)
      openDetailProvisional(text, cwd); // v65: straight into the conversation
      setTimeout(() => { // safety: run frame lost (WS drop) - never hang the page
        if (state.pendingNew === j.runId) {
          state.pendingNew = null; state.pendingNewText = '';
          if (state.provisional) closeDetail();
          toast('启动超时，稍后会出现在列表');
        }
      }, 30_000);
    })
    .catch(() => { go.disabled = false; go.classList.remove('loading'); $('new-err').textContent = '网络错误'; });
}

/* ---------------- wiring ---------------- */
$('send').onclick = () => sendMessage(false);
$('stop').onclick = stopRun;
$('attach').onclick = () => $('attach-input').click();
$('attach-input').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  for (const f of files) await addAttachment(f);
});
$('perm').onclick = openPermSheet;
$('msg-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !IS_TOUCH) { e.preventDefault(); sendMessage(false); }
});
$('msg-input').addEventListener('input', () => {
  autoGrow();
  updateComposer();
  clearTimeout(_draftTimer);
  _draftTimer = setTimeout(saveDraft, 250);
});
$('fork-x').onclick = disarmFork;
$('new-session').onclick = openNewModal;
$('new-go').onclick = submitNewSession;
$('new-cancel').onclick = () => $('new-modal').classList.add('hidden');
document.querySelectorAll('#new-perm button').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('#new-perm button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    setPerm(b.dataset.v);
  };
});
// v78 progressive disclosure: manual path is a link, the input unfolds
$('new-cwd-manual').onclick = () => {
  $('new-cwd-box').classList.add('on');
  $('new-cwd-manual').style.display = 'none';
  $('new-cwd-custom').focus();
};
$('new-cwd-x').onclick = () => {
  $('new-cwd-box').classList.remove('on');
  $('new-cwd-manual').style.display = '';
  $('new-cwd-custom').value = '';
};
$('new-text').addEventListener('input', function () {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, window.innerHeight * 0.3) + 'px';
});
setPerm(state.perm);
// the composer grows (run-status line, queue badge, multi-line input): the
// transcript's bottom padding and the FAB must track its live height or the
// dock covers the last messages. ResizeObserver keeps both in step.
const composerEl = $('composer');
if (window.ResizeObserver && composerEl) {
  const applyPad = () => {
    const h = composerEl.offsetHeight;
    $('chat').style.paddingBottom = (h + 14) + 'px';
    $('jump').style.bottom = (h + 14) + 'px';
  };
  new ResizeObserver(() => {
    applyPad();
    // re-measure one frame later: mid-transition reads lag the final layout
    requestAnimationFrame(applyPad);
  }).observe(composerEl);
}

export { updateComposer, fetchQueue, renderQueuePanel, renderAttachChips, openNewModal, setDraft, disarmFork };
