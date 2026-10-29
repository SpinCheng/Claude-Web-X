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
const BUBBLES = ['ctx-sheet', 'model-sheet', 'perm-sheet', 'row-actions', 'rename-modal', 'cost-sheet', 'agent-sheet'];
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
  if (id === 'agent-sheet') state.agentView = null; // v112: drop the bubble's binding
}
// tap the scrim (the overlay itself, not the bubble) to dismiss
for (const id of BUBBLES) {
  $(id).addEventListener('click', (e) => { if (e.target === $(id)) closeBubble(id); });
}

/* ---------- lightbox ---------- */
function openLightbox(src) {
  $('lightbox-img').src = src;
  $('lightbox').classList.remove('hidden');
}
function openFilePreview(a) {
  if (!a.file) return;
  fetch('/files/' + a.file.split('/').map(encodeURIComponent).join('/'), { headers: auth() })
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
    .then((t) => openHtmlPreview({ name: a.name, srcText: t, sourceOnly: true }))
    .catch(() => toast('读取失败'));
}

/* ---------- artifact preview (v23) ---------- */
const ART_HTML = /\.html?$/i;
let artPreviewUrl = '';
async function previewArtifact(winPath) {
  const url = '/api/sessions/' + encodeURIComponent(state.currentId) + '/preview?p=' + encodeURIComponent(winPath);
  try {
    const r = await fetch(url, { headers: auth() });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const name = winPath.split(/[\\/]/).pop();
    if (ART_IMG.test(winPath)) {
      const blob = await r.blob();
      if (artPreviewUrl) URL.revokeObjectURL(artPreviewUrl);
      artPreviewUrl = URL.createObjectURL(blob);
      openLightbox(artPreviewUrl);
    } else {
      const text = await r.text();
      // v105/v107: html renders fullscreen in-app (srcdoc, opaque origin);
      // everything else opens the page in source mode
      if (ART_HTML.test(winPath)) openHtmlPreview({ name, text, srcText: text.slice(0, 128 * 1024) });
      else openHtmlPreview({ name, srcText: text.slice(0, 128 * 1024), sourceOnly: true });
    }
  } catch (e) {
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
    // v58: Bash commands read as text, not JSON - stringify escapes the
    // command's real newlines into literal \n soup (unreadable for heredocs)
    let detail = '';
    if (a.input && typeof a.input.command === 'string') {
      detail = a.input.command.replace(/\n$/, '');
      if (detail.length > 2000) detail = detail.slice(0, 2000) + '…';
    } else {
      try { detail = typeof a.input === 'string' ? a.input : JSON.stringify(a.input, null, 2); } catch { detail = String(a.input); }
      if (detail.length > 800) detail = detail.slice(0, 800) + '…';
    }
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
// keyboard escape route for the click-to-close overlays (v27 a11y); never
// hijacks Esc while composing (textarea keeps it for IME cancel etc.)
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const t = e.target;
  if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)) return;
  for (const id of ['lightbox', 'html-prev', 'row-actions', 'rename-modal']) {
    const el = $(id);
    if (el && !el.classList.contains('hidden')) {
      if (id === 'lightbox') $('lightbox-img').src = '';
      if (id === 'html-prev') { closeHtmlPreview(); return; }
      el.classList.add('hidden');
      return;
    }
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

/* ---------- confirm modal (v51) ---------- */
// window.confirm replacement: the OS dialog froze rendering, looked foreign
// next to the sheet language, and headless e2e had to fake-answer it. Same
// bottom-sheet grammar as rename/new; destructive confirms get a red primary
// (danger), handoff asks keep coral. Focus lands on the SAFE action for
// danger (Enter cancels), on OK otherwise. Escape / scrim / 取消 all dismiss.
let cfDone = null;
const cfKey = (e) => { if (e.key === 'Escape' && cfDone) cfDone(false); };
document.addEventListener('keydown', cfKey, true);
function showConfirm(o) {
  $('cf-title').textContent = o.title || '确认操作';
  const body = $('cf-body');
  body.textContent = o.body || '';
  body.hidden = !o.body;
  const ok = $('cf-ok');
  ok.textContent = o.ok || '确定';
  ok.className = 'btn' + (o.danger ? ' danger' : '');
  cfDone = (yes) => {
    $('confirm-modal').classList.add('hidden');
    cfDone = null;
    if (yes) { if (o.onOk) o.onOk(); }
    else if (o.onCancel) o.onCancel();
  };
  $('cf-cancel').onclick = () => cfDone(false);
  ok.onclick = () => cfDone(true);
  $('confirm-modal').onclick = (e) => { if (e.target === $('confirm-modal')) cfDone(false); };
  $('confirm-modal').classList.remove('hidden');
  (o.danger ? $('cf-cancel') : ok).focus({ preventScroll: true });
}

/* ---------- v104/v105 in-app preview page: same-origin links AND artifact
   files open full-screen inside the PWA; iframe is allow-scripts-only
   (opaque origin), never same-origin */
let hpSrcText = '';
let hpSeq = 0;
function setHpView(run) {
  $('hp-tab-run').classList.toggle('on', run);
  $('hp-tab-src').classList.toggle('on', !run);
  $('hp-frame').classList.toggle('hidden', !run);
  $('hp-src').classList.toggle('hidden', run);
}
async function openHtmlPreview(o) { // {name, url?, text?, srcText?, sourceOnly?}
  // v107: content is ALWAYS injected via srcdoc. Never set iframe.src here -
  // blob/direct src navigations append entries to the joint session history,
  // so a back press silently steps iframe state and the close-on-back wiring
  // dies (measured: every src change grows history.length). srcdoc never
  // navigates; sandbox allow-scripts keeps the doc opaque-origin.
  if (o.text === undefined && o.url) {
    try {
      const r = await fetch(o.url, { headers: auth() });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const t = await r.text();
      o.text = t;
      if (o.srcText === undefined) o.srcText = t.slice(0, 128 * 1024);
    } catch (e) {
      toast('页面加载失败：' + ((e && e.message) || ''));
      return;
    }
  }
  $('hp-title').textContent = o.name || o.url || '';
  hpSrcText = o.srcText !== undefined ? o.srcText : '';
  $('hp-src').textContent = hpSrcText || '（空）';
  $('hp-tabs').classList.toggle('hidden', !!o.sourceOnly);
  const f = $('hp-frame');
  f.removeAttribute('src');
  f.srcdoc = o.text !== undefined ? o.text : '';
  setHpView(!o.sourceOnly);
  $('html-prev').classList.remove('hidden');
  hpSeq++;
  history.pushState({ cr: 'htmlprev', n: hpSeq }, '', '#hp/' + hpSeq);
}
function closeHtmlPreview() {
  $('html-prev').classList.add('hidden');
  $('hp-frame').srcdoc = '';
  hpSrcText = '';
}
// direct close only: a fire-and-forget history.back() here races the next
// open's pushState (the traversal can commit late and pop the NEW entry);
// stale htmlprev entries left behind are swallowed by the popstate branch
$('hp-back').onclick = () => closeHtmlPreview();
$('hp-tab-run').onclick = () => setHpView(true);
$('hp-tab-src').onclick = () => setHpView(false);

export { BUBBLES, openBubble, closeBubble, showConfirm, openLightbox, openFilePreview, previewArtifact, openHtmlPreview, closeHtmlPreview,
  queueApproval, showApproval, fetchPendingApprovals };
