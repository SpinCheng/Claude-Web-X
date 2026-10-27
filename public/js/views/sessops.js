// js/views/sessops.js - list-level session operations (v34): long-press /
// right-click a row -> the action bubble (停止运行 / 重命名 / 删除).
// A bubble, NOT swipe or inline buttons: renderList() rebuilds the whole list
// on every sessions frame (a swiped-open row would snap shut; touch has no
// hover for reveal-buttons), an overlay-level sheet survives rebuilds and
// keeps the rows clean. Rename appends a native custom-title line server-side
// - the change lives in the transcript, optimistic update here is cosmetic.
// NOTE: function-level import cycle with list.js (wireRowPress -> openRowActions
// vs optimistic rename -> renderList) - safe because no cross-module call
// happens at module-evaluation time (ESM live bindings).

import { $ } from '../util.js';
import { state } from '../state.js';
import { api } from '../api.js';
import { toast } from './toast.js';
import { openBubble, closeBubble } from './overlays.js';
import { renderList } from './list.js';

const PRESS_MS = 480;      // long-press threshold (iOS ≈500ms, Android ≈400ms)
const MOVE_PX = 9;         // anything beyond this is a scroll, not a press

const I = {
  stop: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
  pencil: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>',
  trash: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>',
};

let renameId = '';

/* ---------------- press detection on a row ---------------- */
// 480ms hold within 9px fires the bubble; scroll/pointercancel kills the
// timer. Desktop right-click opens via contextmenu - which is also the
// Android long-press path (open is idempotent).
export function wireRowPress(el, id) {
  let timer = null, pressed = false, x0 = 0, y0 = 0;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  el.addEventListener('pointerdown', (e) => {
    if (e.button && e.button !== 0) return;
    pressed = false; x0 = e.clientX; y0 = e.clientY;
    cancel();
    timer = setTimeout(() => {
      timer = null;
      pressed = true;
      try { if (navigator.vibrate) navigator.vibrate(10); } catch { /* no haptics */ }
      openRowActions(id);
    }, PRESS_MS);
  });
  el.addEventListener('pointermove', (e) => {
    if (timer && (Math.abs(e.clientX - x0) > MOVE_PX || Math.abs(e.clientY - y0) > MOVE_PX)) cancel();
  });
  el.addEventListener('pointerup', () => {
    cancel();
    if (pressed) { pressed = false; armRowSwallow(el); }
  });
  el.addEventListener('pointercancel', () => { cancel(); pressed = false; });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); armRowSwallow(el); openRowActions(id); });
}

// The click that trails a fired long-press must not ALSO open the detail
// view. Swallowing on the row is too late: at-target listeners run in
// registration order and renderRow assigned el.onclick first. A document-
// level capture listener runs before every target handler. Arming happens at
// gesture end and self-expires (trailing clicks are synthesized right at
// lift) so a gesture without one can't eat a later intentional tap.
const SWALLOW_MS = 700;
let armedRow = null, armedAt = 0;
function armRowSwallow(el) { armedRow = el; armedAt = Date.now(); }
document.addEventListener('click', (e) => {
  if (!armedRow) return;
  const hit = e.target === armedRow || armedRow.contains(e.target);
  const fresh = Date.now() - armedAt < SWALLOW_MS;
  armedRow = null; // any click disarms; the next gesture is intentional
  if (hit && fresh) { e.preventDefault(); e.stopImmediatePropagation(); }
}, true);

/* ---------------- the action bubble ---------------- */
function openRowActions(id) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  const sheet = document.querySelector('#row-actions .act-bubble');
  sheet.querySelector('.act-title').textContent = s.title || s.id.slice(0, 8);
  sheet.querySelector('.act-sub').textContent = s.cwd || s.project || '';
  const list = sheet.querySelector('.act-list');
  list.innerHTML = '';
  // stop only exists for phone-driven runs (PC/CLI runs have no bridge runId;
  // those surface as the wait banner instead)
  const running = (state.runs[id] || {}).state === 'running' || !!s.running;
  if (running) list.appendChild(actRow(I.stop, '停止运行', '中断这台手机发起的运行', 'warn', () => stopFromList(id)));
  list.appendChild(actRow(I.pencil, '重命名', '修改会话显示名', '', () => openRename(id)));
  list.appendChild(actRow(I.trash, '删除会话', '转录移入电脑回收站，可找回', 'danger', () => deleteFromList(id)));
  openBubble('row-actions');
}

function actRow(icon, label, sub, tone, fn) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'opt act-row' + (tone ? ' ' + tone : '');
  el.innerHTML = '<span class="o-ico">' + icon + '</span>' +
    '<span class="o-main"><span class="o-label"></span><span class="o-sub"></span></span>';
  el.querySelector('.o-label').textContent = label;
  el.querySelector('.o-sub').textContent = sub;
  el.onclick = fn;
  return el;
}

/* ---------------- stop ---------------- */
function stopFromList(id) {
  closeBubble('row-actions');
  const rec = state.sessions.find((x) => x.id === id);
  const runId = (state.runs[id] || {}).runId || (rec && rec.runId) || '';
  if (!runId) { toast('只有手机发起的运行能从手机停止'); return; }
  api('/api/runs/' + encodeURIComponent(runId) + '/cancel', { method: 'POST' })
    .then(() => toast('已发送停止信号'))
    .catch(() => toast('网络错误'));
}

/* ---------------- rename ---------------- */
function openRename(id) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  renameId = id;
  closeBubble('row-actions');
  $('rename-input').value = s.title && s.title !== '(loading)' ? s.title : '';
  $('rename-err').textContent = '';
  $('rename-modal').classList.remove('hidden');
  // focus after the sheet is laid out; select-all so typing replaces
  setTimeout(() => { const i = $('rename-input'); i.focus(); i.select(); }, 60);
}
function saveRename() {
  const v = $('rename-input').value.trim();
  if (!v) { $('rename-err').textContent = '名称不能为空'; return; }
  if (!renameId) return;
  api('/api/sessions/' + encodeURIComponent(renameId) + '/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: v }),
  })
    .then((r) => r.json().catch(() => ({})).then((j) => ({ r, j })))
    .then(({ r, j }) => {
      if (!r.ok || !j.ok) { $('rename-err').textContent = '失败：' + (j.error || r.status); return; }
      $('rename-modal').classList.add('hidden');
      toast('已重命名');
      // optimistic; the drain's sessions broadcast confirms server-side
      const s = state.sessions.find((x) => x.id === renameId);
      if (s) { s.title = v; renderList(); }
    })
    .catch(() => { $('rename-err').textContent = '网络错误'; });
}

/* ---------------- delete ---------------- */
function deleteFromList(id) {
  closeBubble('row-actions');
  const s = state.sessions.find((x) => x.id === id);
  if (!window.confirm('删除「' + (s && s.title || id.slice(0, 8)) + '」？转录移入电脑回收站，可找回。')) return;
  api('/api/sessions/' + encodeURIComponent(id), { method: 'DELETE' })
    .then(async (r) => {
      if (r.status === 409) { toast('会话正在运行，先停止再删除'); return; }
      if (!r.ok) { toast('删除失败（' + r.status + '）'); return; }
      toast('已移入回收站'); // list refreshes via the store.drop sessions frame
    })
    .catch(() => toast('网络错误'));
}

/* ---------------- wiring ---------------- */
$('rename-save').onclick = saveRename;
$('rename-cancel').onclick = () => $('rename-modal').classList.add('hidden');
$('rename-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveRename();
  if (e.key === 'Escape') $('rename-modal').classList.add('hidden');
});
