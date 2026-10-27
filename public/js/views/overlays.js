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
const BUBBLES = ['ctx-sheet', 'model-sheet', 'perm-sheet', 'row-actions', 'rename-modal'];
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
  let detail = '';
  try { detail = typeof a.input === 'string' ? a.input : JSON.stringify(a.input, null, 2); } catch { detail = String(a.input); }
  if (detail.length > 800) detail = detail.slice(0, 800) + '…';
  $('ap-input').textContent = detail || '(无参数)';
  $('approval').classList.remove('hidden');
  if (navigator.vibrate) { try { navigator.vibrate([120, 60, 120]); } catch (e) { /* noop */ } }
}
function respondApproval(decision) {
  const a = state.approvals[0];
  if (!a) return;
  state.approvals.shift();
  showApproval();
  fetch('/api/approvals/' + encodeURIComponent(a.id), {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision }),
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

export { BUBBLES, openBubble, closeBubble, openLightbox, openFilePreview, previewArtifact,
  queueApproval, showApproval, fetchPendingApprovals };
