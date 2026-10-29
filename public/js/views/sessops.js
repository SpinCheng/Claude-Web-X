// js/views/sessops.js - list-level session operations (v34): the trailing ⋯
// button (touch primary) or right-click (desktop) opens the action bubble
// (停止运行 / 重命名 / 删除). v35: long-press was REPLACED by the explicit ⋯
// button - it conflicted with text selection (both want the same gesture).
// A bubble, NOT swipe or inline buttons: renderList() rebuilds the whole list
// on every sessions frame (a swiped-open row would snap shut; touch has no
// hover for reveal-buttons), an overlay-level sheet survives rebuilds and
// keeps the rows clean. Rename appends a native custom-title line server-side
// - the change lives in the transcript, optimistic update here is cosmetic.
// NOTE: function-level import cycle with list.js (wireRowOps -> openRowActions
// vs optimistic rename -> renderList) - safe because no cross-module call
// happens at module-evaluation time (ESM live bindings).

import { $ } from '../util.js';
import { state } from '../state.js';
import { auth, api } from '../api.js';
import { toast } from './toast.js';
import { openBubble, closeBubble, showConfirm } from './overlays.js';
import { renderList } from './list.js';
import { copyText } from './transcript.js';

const I = {
  stop: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
  pencil: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>',
  trash: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>',
  down: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>',
  doc: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8"/></svg>',
  back: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>',
  copy: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
};

let renameId = '';

/* ---------------- row action triggers ---------------- */
// ⋯ tap = bubble (stopPropagation keeps the row's open-detail click quiet);
// keyboard gets Enter/Space (span has no native activation). Right-click
// opens too, UNLESS text is selected - the native copy menu wins. The row's
// long-press stays with the browser: it now selects text again (v35).
export function wireRowOps(el, id) {
  const more = el.querySelector('.srow-more');
  if (more) {
    more.addEventListener('click', (e) => { e.stopPropagation(); openRowActions(id); });
    more.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      openRowActions(id);
    });
  }
  el.addEventListener('contextmenu', (e) => {
    const sel = window.getSelection ? window.getSelection() : null;
    if (sel && sel.toString()) return; // selection copy menu beats the bubble
    e.preventDefault();
    openRowActions(id);
  });
}

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
  list.appendChild(actRow(I.copy, '复制名称 / 路径 / ID', '写入剪贴板（三行）', '', () => copySessionInfo(id)));
  list.appendChild(actRow(I.pencil, '重命名', '修改会话显示名', '', () => openRename(id)));
  list.appendChild(actRow(I.down, '导出 Markdown', '下载完整记录或结论摘要', '', () => openExportScope(id)));
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

/* ---------------- copy (v95): name / cwd / id in one shot ---------------- */
function copySessionInfo(id) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  const info = [s.title || s.id.slice(0, 8), s.cwd || s.project || '', s.id].join('\n');
  closeBubble('row-actions');
  copyText(info);
  toast('已复制：名称、路径、会话 ID');
}


/* ---------------- group copy (v95): project name / path ---------------- */
export function openGroupCopy(g) {
  closeBubble('row-actions');
  // lightweight inline bubble anchored as a bottom bubble (same overlay
  // machinery feel); built on the fly, removed on dismissal
  const ov = document.createElement('div');
  ov.className = 'overlay bub';
  ov.id = 'group-copy';
  const sheet = document.createElement('div');
  sheet.className = 'sheet bubble act-bubble';
  const title = document.createElement('div');
  title.className = 'act-title';
  title.textContent = g.label;
  const list = document.createElement('div');
  list.className = 'act-list';
  const mk = (label, sub, text) => {
    const row = actRow(I.copy, label, sub, '', () => {
      copyText(text);
      toast('已复制：' + label);
      ov.remove();
    });
    list.appendChild(row);
  };
  mk('复制项目名称', '目录的显示名', g.label);
  mk('复制完整路径', g.path, g.path);
  ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
  sheet.append(title, list);
  ov.appendChild(sheet);
  document.body.appendChild(ov);
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

/* ---------------- export (v44) ---------------- */
// scope swap INSIDE the same bubble (openRowActions restores title/sub from
// the session record on return). The blob + a[download] click is the relay:
// Content-Disposition alone is unreliable inside PWA webviews.
function openExportScope(id) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  const sheet = document.querySelector('#row-actions .act-bubble');
  sheet.querySelector('.act-title').textContent = '导出 Markdown';
  sheet.querySelector('.act-sub').textContent = s.title || s.id.slice(0, 8);
  const list = sheet.querySelector('.act-list');
  list.innerHTML = '';
  list.appendChild(actRow(I.doc, '完整会话', '全部往来消息 + 工具调用清单', '', () => doExport(id, 'full')));
  list.appendChild(actRow(I.pencil, '仅结论摘要', '每轮提问 + 最终结论文本', '', () => doExport(id, 'summary')));
  list.appendChild(actRow(I.back, '返回', '回到会话操作', '', () => openRowActions(id)));
}
function doExport(id, scope) {
  closeBubble('row-actions');
  const s = state.sessions.find((x) => x.id === id) || {};
  const name = ((s.title && s.title !== '(loading)' ? s.title : id.slice(0, 8))
    .replace(/[\\/:*?"<>|#]+/g, '').trim().slice(0, 60)) || id.slice(0, 8);
  fetch('/api/sessions/' + encodeURIComponent(id) + '/export?scope=' + scope, { headers: auth() })
    .then(async (r) => {
      if (!r.ok) { toast('导出失败（' + r.status + '）'); return; }
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name + (scope === 'summary' ? '-摘要' : '') + '.md';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast(scope === 'summary' ? '已导出结论摘要' : '已导出完整会话');
    })
    .catch(() => toast('网络错误'));
}

/* ---------------- delete ---------------- */
function deleteFromList(id) {
  closeBubble('row-actions');
  const s = state.sessions.find((x) => x.id === id);
  showConfirm({ title: '删除「' + (s && s.title || id.slice(0, 8)) + '」', body: '转录移入电脑回收站，可找回。', ok: '删除', danger: true,
    onOk: () => api('/api/sessions/' + encodeURIComponent(id), { method: 'DELETE' })
      .then(async (r) => {
        if (r.status === 409) { toast('会话正在运行，先停止再删除'); return; }
        if (!r.ok) { toast('删除失败（' + r.status + '）'); return; }
        toast('已移入回收站'); // list refreshes via the store.drop sessions frame
      })
      .catch(() => toast('网络错误')) });
}

/* ---------------- wiring ---------------- */
$('rename-save').onclick = saveRename;
$('rename-cancel').onclick = () => $('rename-modal').classList.add('hidden');
$('rename-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveRename();
  if (e.key === 'Escape') $('rename-modal').classList.add('hidden');
});
