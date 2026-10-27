// js/views/overlays.js - every non-toast popup layer: the anchored bubbles
// (ctx/model/perm/effort sheets - option lists are filled by their owning
// views), the full-screen lightbox & text preview, artifact preview (v23)
// and the permission approval cards. Owns open/close only.

import { $ } from '../util.js';
import { state } from '../state.js';
import { auth, api } from '../api.js';
import { ART_IMG } from '../md.js';
import { toast } from './toast.js';

/* ---------- bubble popups (v15 E): anchored above the dock ---------- */
// row-actions/rename-modal (v34) live on the LIST page but share the same
// machinery: open hides siblings, scrim click + system back close.
// effort-sheet is gone since v36 (levels merged into the model sheet)
const BUBBLES = ['ctx-sheet', 'model-sheet', 'perm-sheet', 'row-actions', 'rename-modal', 'cost-sheet'];
function openBubble(id) {
  // switching bubbles reuses the open state; no history churn
  for (const b of BUBBLES) {
    if (b === id) continue;
    $(b).classList.add('hidden');
  }
  $(id).classList.remove('hidden');
}
function closeBubble(id) {
  $(id).classList.add('hidden');
}
// tap the scrim (the overlay itself, not the bubble) to dismiss
for (const id of BUBBLES) {
  $(id).addEventListener('click', (e) => { if (e.target === $(id)) closeBubble(id); });
}

/* ---------- lightbox / text file preview ---------- */
function openLightbox(src) {
  $('lightbox-img').src = src;
  $('lightbox').classList.remove('hidden');
}
function openFilePreview(a) {
  if (!a.file) return;
  $('fp-name').textContent = a.name;
  $('fp-body').textContent = '加载中…';
  $('file-prev').classList.remove('hidden');
  fetch('/files/' + a.file.split('/').map(encodeURIComponent).join('/'), { headers: auth() })
    .then((r) => r.text())
    .then((t) => { $('fp-body').textContent = t.slice(0, 32 * 1024); })
    .catch(() => { $('fp-body').textContent = '（读取失败）'; });
}

/* ---------- artifact preview (v23): linked Windows paths in tool text ---------- */
let artPreviewUrl = '';
async function previewArtifact(winPath) {
  const url = '/api/sessions/' + encodeURIComponent(state.currentId) + '/preview?p=' + encodeURIComponent(winPath);
  try {
    const r = await fetch(url, { headers: auth() });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (ART_IMG.test(winPath)) {
      const blob = await r.blob();
      if (artPreviewUrl) URL.revokeObjectURL(artPreviewUrl);
      artPreviewUrl = URL.createObjectURL(blob);
      openLightbox(artPreviewUrl);
    } else {
      $('fp-name').textContent = winPath.split(/[\\/]/).pop();
      $('fp-body').textContent = '加载中…';
      $('file-prev').classList.remove('hidden');
      $('fp-body').textContent = (await r.text()).slice(0, 64 * 1024);
    }
  } catch (e) {
    $('file-prev').classList.add('hidden');
    toast('预览失败：' + ((e && e.message) || '文件不可用'));
  }
}

/* ---------- approval cards (perm=ask runs routed to the phone) ---------- */
function queueApproval(a) {
  state.approvals.push(a);
  if (state.approvals.length === 1) showApproval();
}
function showApproval() {
  const a = state.approvals[0];
  if (!a) { $('approval').classList.add('hidden'); return; }
  const s = state.sessions.find((x) => x.id === a.sessionId);
  $('ap-session').textContent = (s && s.title ? s.title : '派发任务') + ' 请求执行以下操作';
  $('ap-tool').textContent = a.tool || '?';
  // v44 (2B): Edit/Write/MultiEdit render as a collapsed ±diff instead of raw
  // JSON; everything else keeps the pretty-printed input. DOM rows + textContent
  // throughout - the payload is model-generated and must never hit innerHTML.
  const diff = buildApprovalDiff(a.tool, a.input);
  const inEl = $('ap-input'), dfEl = $('ap-diff');
  if (diff) {
    dfEl.innerHTML = '';
    dfEl.appendChild(diff);
    dfEl.classList.remove('hidden');
    inEl.classList.add('hidden');
  } else {
    let detail = '';
    try { detail = typeof a.input === 'string' ? a.input : JSON.stringify(a.input, null, 2); } catch { detail = String(a.input); }
    if (detail.length > 800) detail = detail.slice(0, 800) + '…';
    inEl.textContent = detail || '(无参数)';
    inEl.classList.remove('hidden');
    dfEl.classList.add('hidden');
  }
  // session-level always-allow (5A): unchecked by default every card
  const allowRow = $('ap-allow-row');
  allowRow.querySelector('.ckb').classList.remove('on');
  allowRow.classList.remove('on');
  $('ap-allow-txt').textContent = '本次会话始终允许 ' + (a.tool || '该工具');
  allowRow.dataset.on = '0';
  $('approval').classList.remove('hidden');
  if (navigator.vibrate) { try { navigator.vibrate([120, 60, 120]); } catch (e) { /* noop */ } }
}
// diff builder -> DocumentFragment (or null when the tool/input isn't a file
// edit). B-design: stats summary + <details> expand. Rows capped: content can
// be huge (Write of a whole file); the tail row states how much was elided.
const DIFF_TOOLS = { Edit: 1, MultiEdit: 1, Write: 1, NotebookEdit: 1 };
const DIFF_MAX_ROWS = 120;
function buildApprovalDiff(tool, input) {
  if (!DIFF_TOOLS[tool] || !input || typeof input !== 'object') return null;
  let pairs = [];
  if (Array.isArray(input.edits)) {
    pairs = input.edits.map((e) => ({ oldS: String(e && e.old_string || ''), newS: String(e && e.new_string || '') }));
  } else if (typeof input.content === 'string') {
    pairs = [{ oldS: '', newS: input.content }]; // Write: everything is an addition
  } else if (typeof input.old_string === 'string' || typeof input.new_string === 'string') {
    pairs = [{ oldS: String(input.old_string || ''), newS: String(input.new_string || '') }];
  } else if (typeof input.new_str === 'string' || typeof input.old_str === 'string') {
    pairs = [{ oldS: String(input.old_str || ''), newS: String(input.new_str || '') }];
  } else return null;
  const path = input.file_path || input.path || input.notebook_path || '';
  const frag = document.createDocumentFragment();
  if (path) {
    const ph = document.createElement('div');
    ph.className = 'ap-path mono';
    ph.textContent = path;
    frag.appendChild(ph);
  }
  let adds = 0, dels = 0, budget = DIFF_MAX_ROWS;
  const rows = [];
  pairs.forEach((p, i) => {
    const dl = p.oldS ? p.oldS.split('\n') : [];
    const al = p.newS ? p.newS.split('\n') : [];
    dels += dl.length; adds += al.length;
    if (pairs.length > 1) rows.push({ cls: 'hunk', text: '# ' + (i + 1) });
    for (const l of dl) rows.push({ cls: 'del', text: '− ' + l });
    for (const l of al) rows.push({ cls: 'add', text: '+ ' + l });
  });
  const stats = document.createElement('div');
  stats.className = 'dstats';
  const si = document.createElement('span'); si.className = 'ins'; si.textContent = '+' + adds;
  const sd = document.createElement('span'); sd.className = 'dele'; sd.textContent = '−' + dels;
  const sn = document.createElement('span'); sn.className = 'dim';
  stats.append(si, sd, sn);
  const det = document.createElement('details');
  det.className = 'apdet';
  const sum = document.createElement('summary');
  sum.className = 'exp';
  const chev = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chev.setAttribute('class', 'chev'); chev.setAttribute('viewBox', '0 0 24 24');
  chev.setAttribute('width', '14'); chev.setAttribute('height', '14');
  const cp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  cp.setAttribute('fill', 'currentColor'); cp.setAttribute('d', 'M7 10l5 5 5-5z');
  chev.appendChild(cp);
  sn.textContent = (rows.length > budget ? '前 ' + budget + ' 行 · ' : '') + '点击查看差异';
  sum.append(chev, stats);
  const box = document.createElement('div');
  box.className = 'diff';
  for (const r of rows) {
    if (budget-- <= 0) {
      const more = document.createElement('div');
      more.className = 'dl hunk';
      more.textContent = '… 其余 ' + (rows.length - DIFF_MAX_ROWS) + ' 行已省略（完整内容以文件为准）';
      box.appendChild(more);
      break;
    }
    const el = document.createElement('div');
    el.className = 'dl ' + r.cls;
    el.textContent = r.text;
    box.appendChild(el);
  }
  det.append(sum, box);
  frag.appendChild(det);
  return frag;
}
function respondApproval(decision) {
  const a = state.approvals[0];
  if (!a) return;
  // 5A: tick box rides along on allow; deny ignores it
  const allowSession = decision === 'allow' && $('ap-allow-row').dataset.on === '1';
  state.approvals.shift();
  showApproval();
  fetch('/api/approvals/' + encodeURIComponent(a.id), {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision, allowSession }),
  }).catch(() => {});
}
function fetchPendingApprovals() {
  api('/api/approvals/pending')
    .then((r) => r.json())
    .then((d) => {
      for (const a of d.approvals || []) queueApproval(a);
    })
    .catch(() => {});
}

/* ---------- wiring ---------- */
$('lightbox').onclick = () => { $('lightbox').classList.add('hidden'); $('lightbox-img').src = ''; };
$('file-prev').onclick = (e) => { if (e.target.id === 'file-prev') $('file-prev').classList.add('hidden'); };
// keyboard escape route for the click-to-close overlays (v27 a11y); never
// hijacks Esc while composing (textarea keeps it for IME cancel etc.)
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const t = e.target;
  if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;
  for (const id of ['lightbox', 'file-prev', 'row-actions', 'rename-modal']) {
    const el = $(id);
    if (el && !el.classList.contains('hidden')) { el.classList.add('hidden'); if (id === 'lightbox') $('lightbox-img').src = ''; return; }
  }
});
$('ap-allow').onclick = () => respondApproval('allow');
$('ap-deny').onclick = () => respondApproval('deny');
// v44 5A: session-level always-allow tick (label has no native control inside,
// so this handler is the single source of truth for the visual + dataset)
$('ap-allow-row').onclick = () => {
  const row = $('ap-allow-row');
  const on = row.dataset.on !== '1';
  row.dataset.on = on ? '1' : '0';
  row.classList.toggle('on', on);
  row.querySelector('.ckb').classList.toggle('on', on);
};

export { BUBBLES, openBubble, closeBubble, openLightbox, openFilePreview, previewArtifact,
  queueApproval, showApproval, fetchPendingApprovals };
