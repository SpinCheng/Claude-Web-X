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
  clearCmdChip();
  hideCmdMenu();
  cmdList = null; cmdListFor = null; state.cmdNames = null;
  hideAtMenu();   // v192: @ 气泡与索引随会话重置
  atIdx = null; atIdxFor = null;
  atTags = [];    // v197: 引用标签不跨会话（草稿只存文本）
  renderAtTags();
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
  $('msg-input').placeholder = running ? '继续输入以排队后续修改'
    : (cmdChip ? ('/' + cmdChip.name + (cmdChip.argHint ? ' ' + cmdChip.argHint : '') + ' · 输入参数或说明后发送')
    : (atTags.length ? '@ 引用已就绪——输入说明后发送' : '提出后续修改要求'));
  renderDriverChip();
}
function sendMessage(force) {
  const input = $('msg-input');
  let text = input.value.trim();
  // v197: dock 标签前置组合（/ 命令最前、@ 引用随后、正文殿后——'/名 @ref 说明'）
  const pre = [];
  if (cmdChip) pre.push('/' + cmdChip.name);
  if (atTags.length) pre.push(atTags.map((t) => '@' + t).join(' '));
  if (pre.length) text = pre.join(' ') + (text ? ' ' + text : '');
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
  const sentTags = atTags.slice(); // v197
  clearComposer();
  const tagFail = () => { if (sentTags.length) { atTags = sentTags; renderAtTags(); } };
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
        tagFail(); // v197
        const j = await r.json().catch(() => ({}));
        toast(j.error === 'busy' ? '源会话正在运行，结束后再分支' : '分支启动失败（' + r.status + '）');
        return;
      }
      const j = await r.json().catch(() => ({}));
      state.pendingBranchRun = j.runId || null;
      toast('分支线程启动中…');
    })
    .catch(() => { disarmFork(); restoreComposer(rawInput, atts); tagFail(); toast('网络错误'); });
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
  const sentChip = cmdChip;
  const sentTags = atTags.slice(); // v197: fail paths re-set the tags (chip semantics)
  clearComposer();
  // optimistic bubble (v21): at TAP time, not after the round-trip — on slow
  // links the POST latency is the same dead-tap window v18 closed for the
  // composer. Retracted by every refusal path unless the transcript already
  // folded into it (then it is a real message and stays).
  if (!shownTurn && state.currentId) shownTurn = pushOptimisticUser(text);
  const fail = () => { restoreComposer(rawInput, atts); retractOptimisticUser(shownTurn); if (sentChip) setCmdChip(sentChip); if (sentTags.length) { atTags = sentTags; renderAtTags(); } };
  api('/api/sessions/' + encodeURIComponent(state.currentId) + '/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text, force: !!force, perm: state.perm, model: currentModel(), effort: currentEffort(),
      attachments: atts.map((a) => ({ file: a.file, name: a.name, type: a.type })),
    }),
  })
    .then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (r.status === 409) {
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
      if (!r.ok) { toast('发送失败：' + (j.error || ('HTTP ' + r.status))); fail(); return; }
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
/* ---------- v109 slash-command menu + chip ---------- */
// 单选 chip（v2 裁定）：点选 -> dock 内标签；重开选单点选 = 替换；✕/空框退格删除。
// 菜单 = 锚定气泡（无 scrim，点外部即收，不动 history）。命令来源 = 桥端
// /api/sessions/:id/commands（内置白名单 + 自定义命令发现）。
let cmdChip = null;
let cmdList = null;
let cmdListFor = null;
function ensureCmdList() {
  const id = state.currentId;
  if (!id) return Promise.resolve([]);
  if (cmdList && cmdListFor === id) return Promise.resolve(cmdList);
  cmdListFor = id; cmdList = null;
  return api('/api/sessions/' + encodeURIComponent(id) + '/commands')
    .then((r) => r.json())
    .then((j) => {
      cmdList = j.commands || [];
      state.cmdNames = new Set(cmdList.map((c) => c.name.toLowerCase()));
      return cmdList;
    })
    .catch(() => { cmdList = []; return []; });
}
function hideCmdMenu() { $('cmd-menu').classList.add('hidden'); }
function renderCmdMenu(q) {
  const listEl = $('cmd-menu-list');
  listEl.innerHTML = '';
  const ql = (q || '').toLowerCase();
  const hits = (cmdList || []).filter((c) => !ql || c.name.toLowerCase().startsWith(ql) || c.name.toLowerCase().includes(ql) || (c.desc || '').toLowerCase().includes(ql));
  // v198 用户裁定：无命中=直接收起菜单，不出空态列表（文本照常作为普通内容发送）
  if (!hits.length) { hideCmdMenu(); return; }
  for (const c of hits.slice(0, 30)) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'cm-row';
    const nm = document.createElement('span'); nm.className = 'cm-name';
    const full = '/' + c.name;
    const at = ql ? c.name.toLowerCase().indexOf(ql) : -1;
    if (at >= 0) {
      nm.appendChild(document.createTextNode(full.slice(0, at + 1)));
      const hb = document.createElement('b'); hb.textContent = full.slice(at + 1, at + 1 + ql.length);
      nm.appendChild(hb);
      nm.appendChild(document.createTextNode(full.slice(at + 1 + ql.length)));
    } else nm.textContent = full;
    const de = document.createElement('span'); de.className = 'cm-desc'; de.textContent = c.desc || '';
    const sr = document.createElement('span'); sr.className = 'cm-src';
    // v135: kind chip - the menu lists commands AND skills, labeled
    sr.textContent = (c.kind === 'skill' ? '技能' : '命令') + ' · ' + c.src;
    b.append(nm, de, sr);
    b.addEventListener('click', () => {
      if ($('msg-input').value.startsWith('/')) $('msg-input').value = '';
      setCmdChip(c);
      hideCmdMenu();
      autoGrow();
      updateComposer();
      $('msg-input').focus();
    });
    listEl.appendChild(b);
  }
  $('cmd-menu').classList.remove('hidden');
}
function setCmdChip(c) {
  cmdChip = c;
  const row = $('cmd-chips');
  row.innerHTML = '';
  const tag = document.createElement('span'); tag.className = 'cmd-tag';
  tag.title = '点选替换命令';
  tag.addEventListener('click', () => { ensureCmdList().then(() => renderCmdMenu('')); });
  const nm = document.createElement('b'); nm.textContent = '/' + c.name;
  tag.appendChild(nm);
  if (c.argHint) { const h = document.createElement('span'); h.className = 'hint'; h.textContent = c.argHint; tag.appendChild(h); }
  const x = document.createElement('span'); x.className = 'x'; x.textContent = '✕';
  x.addEventListener('click', (e) => { e.stopPropagation(); clearCmdChip(); updateComposer(); });
  tag.appendChild(x);
  row.appendChild(tag);
  row.classList.remove('hidden');
  // v137: the chip floats over the textarea's first line - reserve its width
  // via text-indent (first line only), so wrapped lines start at the true
  // left edge instead of beside the chip
  $('msg-input').style.textIndent = (tag.getBoundingClientRect().width + 8) + 'px';
}
function clearCmdChip() {
  cmdChip = null;
  const row = $('cmd-chips');
  if (row) { row.innerHTML = ''; row.classList.add('hidden'); }
  $('msg-input').style.textIndent = '';
}
$('msg-input').addEventListener('input', () => {
  const v = $('msg-input').value;
  if (!cmdChip && v.startsWith('/')) {
    ensureCmdList().then(() => {
      const cur = $('msg-input').value;
      if (!cmdChip && cur.startsWith('/')) renderCmdMenu(cur.slice(1));
      else hideCmdMenu();
    });
  } else hideCmdMenu();
});
$('msg-input').addEventListener('keydown', (e) => {
  if (e.key === 'Backspace' && $('msg-input').value === '' && cmdChip) { e.preventDefault(); clearCmdChip(); updateComposer(); }
});
// v145: pasted FILES ride the normal attachment pipeline (Ctrl+V on desktop,
// e.g. a copied file in Explorer or a screenshot). Plain-text paste keeps the
// browser default; images go through the same downscale+upload as picked ones.
$('msg-input').addEventListener('paste', (e) => {
  const files = e.clipboardData && e.clipboardData.files;
  if (!files || !files.length) return;
  e.preventDefault();
  for (const f of files) addAttachment(f);
});
document.addEventListener('click', (e) => {
  if ($('cmd-menu').classList.contains('hidden')) return;
  if (e.target.closest('#cmd-menu') || e.target.id === 'msg-input') return;
  hideCmdMenu();
});

/* ---------- v192 @ 远程文件选择器（roadmap 11 · 方案A 直选同构；v197 chip 化）----------
   输入 @（词边界，防 user@host/中文@x 误判）唤起锚定气泡：空查询=项目根平铺
   （目录+根文件），继续输入即全局模糊（派生目录行也命中）；点选=v197 用户裁定
   固定成 dock 标签（/ 命令 chip 同款交互、✕ 可删），发送时前置组合成
   `@path ` 文本——手输 @path 不经标签，桥侧扫描照常代附（lib/fileindex.js），
   两条路殊途同归。索引=桥 /files 一次拉取本地过滤（v109 先例，10s 内复用）；
   非 git cwd 退化为 readdir 首层。 */
const AT_DIR_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/></svg>';
const AT_DOC_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
const AT_MAX_ROWS = 50;
const atCi = (a, b) => a.toLowerCase().localeCompare(b.toLowerCase());
let atIdx = null;      // 派生后的索引（repo 形态或 readdir 兜底形态）
let atIdxFor = null;   // 索引所属会话
let atToken = null;    // 活动 @token {start,end,q}（end=光标）

// 与桥侧 scanAtTokens 同语义镜像（bridge/lib/fileindex.js 是权威副本）：
// 词内遇 prose 标点即截断（「@a.md，看看」的 q=a.md），插入时只替换真 token
const AT_STOP = /[,;:!?'"‘’“”…—·，。、；：！？（）【】《》〈〉「」『』]/u;
function atDetect() {
  const input = $('msg-input');
  const pos = input.selectionStart == null ? input.value.length : input.selectionStart;
  const m = input.value.slice(0, pos).match(/@([^\s@]*)$/u);
  if (!m) return null;
  const start = pos - m[0].length;
  const prev = start > 0 ? input.value[start - 1] : '';
  if (prev && /[\p{L}\p{N}_]/u.test(prev)) return null; // 词边界：前一字符是词字符则不是引用
  const stop = m[1].search(AT_STOP);
  if (stop === 0) return null;                         // @后紧跟标点：不是引用
  const q = stop < 0 ? m[1] : m[1].slice(0, stop);
  const end = start + 1 + q.length;
  if (stop >= 0 && pos > end) return null;             // 标点已终结 token，光标在正文里：收起
  return { start, end, q };
}
// 索引拉取+派生（顶层目录/根文件/全目录集，客户端一次算好）
function ensureAtIndex() {
  const id = state.currentId;
  if (!id) return Promise.resolve(null);
  if (atIdx && atIdxFor === id && Date.now() - atIdx.at < 10_000) return Promise.resolve(atIdx);
  atIdxFor = id;
  return api('/api/sessions/' + encodeURIComponent(id) + '/files')
    .then((r) => r.json())
    .then((j) => {
      if (atIdxFor !== id) return atIdx; // 会话已切换：迟到响应弃用
      atIdx = atPrepare(j);
      return atIdx;
    })
    .catch(() => { if (atIdxFor === id) atIdx = null; return null; });
}
function atPrepare(j) {
  if (!j || !j.repo) return { repo: false, dirs: (j && j.dirs) || [], files: (j && j.files) || [], at: Date.now() };
  const files = j.files || [];
  const topDirs = new Set(); const rootFiles = []; const allDirs = new Set();
  for (const f of files) {
    const i = f.indexOf('/');
    if (i < 0) rootFiles.push(f);
    else {
      topDirs.add(f.slice(0, i));
      let p = f;
      for (;;) { const k = p.lastIndexOf('/'); if (k <= 0) break; p = p.slice(0, k); allDirs.add(p); }
    }
  }
  return { repo: true, total: files.length, files, at: Date.now(),
    topDirs: [...topDirs].sort(atCi), rootFiles: rootFiles.sort(atCi), allDirs: [...allDirs].sort(atCi) };
}
function hideAtMenu() { $('at-menu').classList.add('hidden'); atToken = null; }
// 行构建全程 createElement/textContent（路径是外部数据，拼 HTML = XSS 面）
function atRowEl(r, q) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'at-row' + (r.dir ? ' dir' : '');
  const ic = document.createElement('span');
  ic.className = 'ic';
  ic.innerHTML = r.dir ? AT_DIR_ICON : AT_DOC_ICON; // 静态 SVG 串，无插值
  const nm = document.createElement('span');
  nm.className = 'nm';
  if (!q) {
    nm.textContent = r.p;
  } else {
    const hit = r.p.toLowerCase().indexOf(q);
    if (hit < 0) nm.textContent = r.p; // 防御：不该发生
    else {
      const before = r.p.slice(0, hit);
      const after = r.p.slice(hit + q.length);
      if (before) { const s = document.createElement('span'); s.className = 'pre'; s.textContent = before; nm.appendChild(s); }
      const hb = document.createElement('b'); hb.textContent = r.p.slice(hit, hit + q.length); nm.appendChild(hb);
      const k = after.lastIndexOf('/');
      if (k >= 0) {
        const s1 = document.createElement('span'); s1.className = 'pre'; s1.textContent = after.slice(0, k + 1); nm.appendChild(s1);
        const s2 = document.createElement('span'); s2.textContent = after.slice(k + 1); nm.appendChild(s2);
      } else if (after) {
        const s1 = document.createElement('span'); s1.textContent = after; nm.appendChild(s1);
      }
    }
  }
  b.append(ic, nm);
  b.addEventListener('click', () => atPick(r.p, r.dir));
  return b;
}
function renderAtMenu() {
  if (!atToken) return;
  const q = atToken.q.toLowerCase();
  const listEl = $('at-menu-list');
  listEl.innerHTML = '';
  let rows = [];
  let matched = 0;
  if (!atIdx) {
    const e = document.createElement('div');
    e.className = 'at-empty';
    e.textContent = '载入项目索引…';
    listEl.appendChild(e);
  } else if (atIdx.repo) {
    if (q) {
      const ds = atIdx.allDirs.filter((d) => d.toLowerCase().includes(q));
      const fs = atIdx.files.filter((f) => f.toLowerCase().includes(q));
      matched = ds.length + fs.length;
      rows = ds.map((p) => ({ p, dir: true })).concat(fs.map((p) => ({ p, dir: false }))).slice(0, AT_MAX_ROWS);
    } else {
      matched = atIdx.total;
      rows = atIdx.topDirs.map((p) => ({ p, dir: true })).concat(atIdx.rootFiles.map((p) => ({ p, dir: false }))).slice(0, AT_MAX_ROWS);
    }
  } else {
    const ds = atIdx.dirs.filter((d) => d.toLowerCase().includes(q));
    const fs = atIdx.files.filter((f) => f.toLowerCase().includes(q));
    matched = ds.length + fs.length;
    rows = ds.map((p) => ({ p, dir: true })).concat(fs.map((p) => ({ p, dir: false }))).slice(0, AT_MAX_ROWS);
  }
  // v198 用户裁定：无命中=直接收起菜单，不出空态列表——@token 文本照常按
  // 原文发送（桥侧校验失败本就不改写）；继续输入/回删命中重现时自然重开
  if (atIdx && !rows.length) { hideAtMenu(); return; }
  for (const r of rows) listEl.appendChild(atRowEl(r, q));
  $('at-bt').textContent = atIdx && atIdx.repo && q ? '搜索' : '项目文件';
  $('at-idx').textContent = atIdx && atIdx.repo
    ? (q ? matched + ' / ' + atIdx.total : 'git 索引 · ' + atIdx.total)
    : '未建索引 · 目录浏览';
  $('at-hint').textContent = !atIdx ? '目录可直接引用'
    : atIdx.repo ? (q ? '继续输入即过滤' : '目录可直接引用') : '未建 git 索引 · 仅首层浏览';
  $('at-k').textContent = '点选插入 @引用';
  $('at-menu').classList.remove('hidden');
}
function atOnInput() {
  const v = $('msg-input').value;
  if (!cmdChip && !v.startsWith('/') && state.currentId) {
    const t = atDetect();
    if (t) {
      atToken = t;
      ensureAtIndex().then(() => { if (atToken) renderAtMenu(); });
      renderAtMenu(); // 缓存命中即时渲染；未命中先出载入态
      return;
    }
  }
  hideAtMenu();
}
function atPick(rel, isDir) {
  if (atToken) { // 标签接管引用：输入框里的半截 @token 剥掉（/ 命令清空输入同款语义）
    const input = $('msg-input');
    input.value = input.value.slice(0, atToken.start) + input.value.slice(atToken.end);
    try { input.setSelectionRange(atToken.start, atToken.start); } catch { /* detached */ }
    saveDraft();
    autoGrow();
  }
  hideAtMenu();
  addAtTag(rel, isDir);
  $('msg-input').focus(); // 继续敲正文
}
// v197 用户裁定：选中固定成 dock 标签（/ 命令 chip 同款交互、✕ 可删），不再
// 写进输入框；发送时前置组合成 `@path ` 文本（转录气泡照显=v190 逐字纪律）。
// 手输 @path 不经标签，桥侧扫描照常代附——两条路殊途同归。
let atTags = [];        // 当前引用标签（相对路径，目录带尾 /）
function addAtTag(rel, isDir) {
  const t = (rel || '').replace(/\/+$/, '') + (isDir ? '/' : '');
  if (!t || t === '/') return;
  if (atTags.includes(t)) { toast('已在引用里：@' + t); return; }
  if (atTags.length >= 8) { toast('引用标签最多 8 个（超出部分按纯路径发送）'); return; }
  atTags.push(t);
  renderAtTags();
}
function renderAtTags() {
  const row = $('at-chips');
  if (!row) return;
  row.innerHTML = '';
  for (const t of atTags) {
    const tag = document.createElement('span');
    tag.className = 'cmd-tag';
    const nm = document.createElement('b'); nm.textContent = '@' + t;
    nm.title = '@' + t; // 长路径悬停看全名（行内截断）
    tag.appendChild(nm);
    const x = document.createElement('span'); x.className = 'x'; x.textContent = '✕';
    x.setAttribute('role', 'button'); x.title = '移除引用';
    x.addEventListener('click', (e) => { e.stopPropagation(); atTags = atTags.filter((v) => v !== t); renderAtTags(); });
    tag.appendChild(x);
    row.appendChild(tag);
  }
  row.classList.toggle('hidden', !atTags.length);
  updateComposer();
}
// 文件树（roadmap 12）借力：与 @ 选择器同一标签语义（v197 起不再插文本）
function insertRef(rel, isDir) { addAtTag(rel, isDir); }
$('msg-input').addEventListener('input', atOnInput);
$('msg-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('at-menu').classList.contains('hidden')) hideAtMenu();
});
document.addEventListener('click', (e) => {
  if ($('at-menu').classList.contains('hidden')) return;
  if (e.target.closest && (e.target.closest('#at-menu') || e.target.id === 'msg-input')) return;
  hideAtMenu();
});

function clearComposer() {
  clearCmdChip(); // v110: a sent message consumes its chip too (fail paths re-set it)
  atTags = [];    // v197: 同 chip 语义——发送即消费，失败路径显式恢复
  renderAtTags();
  const input = $('msg-input');
  input.value = '';
  try { if (state.currentId) localStorage.removeItem(draftKey(state.currentId)); } catch { /* */ }
  autoGrow();       // collapse the grown height back to one line
  hideCmdMenu();    // sending or clearing dismisses the completion menu
  hideAtMenu();     // v192: same dismissal for the @ picker
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
  // v189 方案A：原生 select 换锚定气泡选择器（cwdSel/cwdOpts 模块态）
  cwdOpts = [];
  const seen = new Set();
  for (const s of state.sessions) {
    if (s.kind !== 'cc' || !s.cwd || seen.has(s.cwd)) continue;
    seen.add(s.cwd);
    cwdOpts.push({ path: s.cwd });
  }
  // group-head preset may be a dir no session ever used - put it on top
  if (presetCwd && !cwdOpts.some((o) => o.path === presetCwd)) cwdOpts.unshift({ path: presetCwd });
  cwdSel = presetCwd || (cwdOpts[0] ? cwdOpts[0].path : '');
  syncCwdTrigger();
  closeCwdPicker();
  $('new-cwd-custom').value = '';
  $('new-text').value = '';
  $('new-err').textContent = '';
  document.querySelectorAll('#new-perm button').forEach((b) => {
    b.classList.toggle('active', b.dataset.v === state.perm);
  });
  $('new-modal').classList.remove('hidden');
  $('new-text').focus();
}
/* ---------- v189 工作目录选择器（方案A 锚定气泡） ----------
   触发行=两行（短名+等宽全路径+下箭头），点开锚定气泡平铺行（全局 .opt 语系，
   选中=珊瑚勾）；点选即回落并更新触发行；scrim 点按关闭（新建任务表单保留）。
   行必须 createElement/textContent 构建（路径是外部数据，拼 HTML= XSS 面）。 */
let cwdSel = '';   // 当前选中路径（''=无项目，提交走 custom/桥默认）
let cwdOpts = [];  // [{path}] 去重后的候选
const CWD_CHECK_SVG = '<svg class="o-check" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';
function syncCwdTrigger() {
  const t = $('new-cwd');
  t.querySelector('.t-name').textContent = cwdSel ? shortPath(cwdSel) : '选择项目';
  t.querySelector('.t-path').textContent = cwdSel || '点开从最近使用过的项目里选';
  t.dataset.cwd = cwdSel; // e2e 断言锚点（原 select.value 的继任）
}
function renderCwdRows() {
  const list = $('cwd-list');
  list.innerHTML = '';
  if (!cwdOpts.length) {
    const p = document.createElement('p');
    p.className = 'cwd-empty';
    p.textContent = '暂无已知项目 — 用下方「手动输入其他路径」';
    list.appendChild(p);
    return;
  }
  for (const o of cwdOpts) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'opt' + (o.path === cwdSel ? ' active' : '');
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', o.path === cwdSel ? 'true' : 'false');
    const main = document.createElement('span');
    main.className = 'o-main';
    const lab = document.createElement('span');
    lab.className = 'o-label';
    lab.textContent = shortPath(o.path);
    const sub = document.createElement('span');
    sub.className = 'o-sub';
    sub.textContent = o.path;
    main.appendChild(lab); main.appendChild(sub);
    b.appendChild(main);
    b.insertAdjacentHTML('beforeend', CWD_CHECK_SVG); // 静态 SVG 串，无插值
    b.onclick = () => { cwdSel = o.path; syncCwdTrigger(); closeCwdPicker(); };
    list.appendChild(b);
  }
}
function openCwdPicker() { renderCwdRows(); $('new-cwd').classList.add('on'); $('cwd-picker').classList.remove('hidden'); }
function closeCwdPicker() { $('cwd-picker').classList.add('hidden'); $('new-cwd').classList.remove('on'); }

function submitNewSession() {
  const go = $('new-go');
  if (go.disabled) return; // POST in flight - no double submit
  go.disabled = true; go.classList.add('loading');
  const text = $('new-text').value.trim();
  if (!text) { $('new-err').textContent = '任务内容不能为空'; return; }
  // manual path only counts while its disclosure is open (v78)
  const custom = $('new-cwd-box').classList.contains('on') ? $('new-cwd-custom').value.trim() : '';
  const cwd = custom || cwdSel || '';
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
  // v195：Ctrl/Cmd+Enter 恒发送（触屏外接键盘/桌面双保险；与 Enter 语义不冲突）
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendMessage(false); }
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
// v189：触发行开合 + scrim 关闭（气泡 open/close 均不动 history——弹层纪律）
$('new-cwd').onclick = () => ($('cwd-picker').classList.contains('hidden') ? openCwdPicker() : closeCwdPicker());
$('cwd-picker').onclick = (e) => { if (e.target === $('cwd-picker')) closeCwdPicker(); };
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

export { updateComposer, fetchQueue, renderQueuePanel, renderAttachChips, openNewModal, setDraft, disarmFork, insertRef };
