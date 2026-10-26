// js/views/ctxring.js - context window accounting: the token ring
// (usage/window, formula identical to Desktop), the /context probe sheet
// (per-category fixed parts) and the model catalog + picker bubble.

import { $, fmtTokens } from '../util.js';
import { state, currentModel } from '../state.js';
import { api } from '../api.js';
import { openBubble, closeBubble } from './overlays.js';

/* ---------- token ring: 已用上下文 / 窗口 ---------- */
function ctxWindowFor(s) {
  // measured window (CLI /context probe) wins when it matches this session
  if (state.ctxProbe) {
    const key = ((s && s.cwd) || '') + '|' + ((state.modelCatalog || []).find((x) => x.label === ((s && s.model) || '')) || {}).id;
    if (state.ctxProbe.key === key && state.ctxProbe.window) return state.ctxProbe.window;
  }
  const pickedId = localStorage.getItem('cr_model') || '';
  if (pickedId) {
    const m = (state.modelCatalog || []).find((x) => x.id === pickedId);
    if (m) return m.ctx;
  }
  const label = (s && s.model) || '';
  const byLabel = (state.modelCatalog || []).find((x) => x.label === label);
  return (byLabel && byLabel.ctx) || 200_000;
}
function ctxUsed(s) {
  const u = s && s.usage;
  if (!u || u.in == null) return null;
  // last request's full prompt footprint: new input + both cache streams
  return (u.in || 0) + (u.cacheRead || 0) + (u.cacheCreate || 0);
}
function updateTokenRing() {
  const s = state.sessions.find((x) => x.id === state.currentId);
  const ring = $('ring-fg');
  if (!ring) return;
  const used = ctxUsed(s);
  const win = ctxWindowFor(s);
  const ratio = used != null ? Math.min(1, used / win) : 0;
  const C = 56.55;
  ring.style.strokeDasharray = (ratio * C).toFixed(1) + ' ' + C.toFixed(1);
  // pressure coloring: brand -> amber (>=80%) -> red (>=95%)
  ring.style.stroke = ratio >= 0.95 ? 'var(--err)' : ratio >= 0.8 ? 'var(--warn)' : '';
  const rv = $('ring-val');
  if (rv) rv.textContent = used != null ? Math.round(ratio * 100) + '%' : '—';
  ring.parentElement.parentElement.title = used != null
    ? '上下文 ' + fmtTokens(used) + ' / ' + fmtTokens(win) + '（' + Math.round(ratio * 100) + '%，点击看明细）'
    : '暂无上下文数据（点击看明细）';
}
// context detail sheet: fine-grained Desktop-aligned breakdown. The probe
// (CLI /context) gives per-category fixed parts; the bar mirrors Desktop with
// one segment per category. Rows that aren't about context (cost, cumulative
// tokens, cache reads) are deliberately NOT shown here.
const CTX_CATS = [
  { key: 'system',   label: '系统提示',   cls: 'sys' },
  { key: 'tools',    label: '系统工具',   cls: 'tools' },
  { key: 'mcp',      label: 'MCP 工具',   cls: 'mcp' },
  { key: 'mcpInstr', label: 'MCP 指令',   cls: 'mcpin' },
  { key: 'memory',   label: '记忆文件',   cls: 'mem' },
  { key: 'skills',   label: '技能',       cls: 'skill' },
];
function ctxCatRow(label, cls, valueText, dim) {
  const row = document.createElement('div');
  row.className = 'ctx-cat' + (dim ? ' ctx-cat-dim' : '');
  const sw = document.createElement('span'); sw.className = 'sw sw-' + cls;
  const name = document.createElement('span'); name.className = 'cat-name'; name.textContent = label;
  const b = document.createElement('b'); b.textContent = valueText;
  row.append(sw, name, b);
  return row;
}
function openContextSheet() {
  const s = state.sessions.find((x) => x.id === state.currentId);
  if (!s) return;
  renderContextSheet(s, state.ctxProbe, null);
  const alreadyOpen = !$('ctx-sheet').classList.contains('hidden');
  if (!alreadyOpen) openBubble('ctx-sheet');
  const key = (s.cwd || '') + '|' + ((state.modelCatalog || []).find((x) => x.label === (s.model || '')) || {}).id;
  if (state.ctxProbe && state.ctxProbe.key === key) return; // already exact
  // measure (bridge caches; first call per project+model takes a few seconds)
  $('ctx-note').textContent = '正在测量精确口径…（约 10 秒，仅一次）';
  api('/api/sessions/' + encodeURIComponent(s.id) + '/context')
    .then((r) => r.json())
    .then((d) => {
      if (state.currentId !== s.id) return;
      if (d.ok) state.ctxProbe = { key, window: d.window, fixed: d.fixed, buffer: d.buffer };
      renderContextSheet(s, state.ctxProbe, d.ok ? null : '测量失败，使用估算值');
    })
    .catch(() => { if (state.currentId === s.id) renderContextSheet(s, state.ctxProbe, '测量失败，使用估算值'); });
}
function renderContextSheet(s, probe, note) {
  const c = s.cost || {};
  const used = ctxUsed(s);
  const win = (probe && probe.window) || ctxWindowFor(s);
  const buffer = (probe && probe.buffer) || 0;
  const messages = used != null ? Math.max(0, used - Math.min(used, fixedTotal(s, probe))) : 0;
  const free = Math.max(0, win - (used || 0) - buffer);
  const total = used || 0;
  $('ctx-used').textContent = total > 0 ? fmtTokens(Math.round(total)) : '—';
  $('ctx-total').textContent = '/ ' + fmtTokens(win);
  $('ctx-pct').textContent = total > 0 ? Math.min(100, Math.round(total / win * 100)) + '%' : '—';
  // --- bar: one segment per category, like the Desktop popover ---
  const bar = $('ctx-bar');
  bar.innerHTML = '';
  const wSeg = (n) => Math.min(100, (n / win) * 100).toFixed(2) + '%';
  const addSeg = (cls, n) => {
    if (n <= 0) return;
    const el = document.createElement('span');
    el.className = 'seg-' + cls;
    el.style.width = wSeg(n);
    bar.appendChild(el);
  };
  // --- rows ---
  const cats = $('ctx-cats');
  cats.innerHTML = '';
  const num = (n) => total > 0
    ? fmtTokens(Math.round(n)) + ' · ' + (n / Math.max(1, total) * 100 < 1 && n > 0 ? '<1' : Math.round(n / Math.max(1, total) * 100)) + '%'
    : '—';
  if (probe && probe.fixed) {
    for (const cat of CTX_CATS) addSeg(cat.cls, probe.fixed[cat.key] || 0);
    for (const cat of CTX_CATS) {
      cats.appendChild(ctxCatRow(cat.label, cat.cls, num(probe.fixed[cat.key] || 0)));
    }
  } else {
    const est = used != null ? Math.min(Number(s.fixedTok) || 0, used) : (Number(s.fixedTok) || 0);
    addSeg('tools', est);
    cats.appendChild(ctxCatRow('系统与工具', 'tools', used != null ? num(est) : fmtTokens(Math.round(est))));
  }
  addSeg('msg', messages);
  cats.appendChild(ctxCatRow('消息', 'msg', used != null ? num(messages) : '—'));
  cats.appendChild(ctxCatRow('自动压缩保留', 'buffer', buffer > 0 ? fmtTokens(buffer) : '—', true));
  cats.appendChild(ctxCatRow('剩余可用', 'free', total > 0 ? fmtTokens(Math.round(free)) : fmtTokens(win), true));
  // cost stays out of the context sheet - it lives in the session header
  void c;
  $('ctx-note').textContent = note || (probe ? '口径与桌面端一致（实测）' : '口径与桌面端一致：已用 = 最近一次请求的输入 tokens（含缓存）');
}
function fixedTotal(s, probe) {
  if (probe && probe.fixed) return probe.fixed.total;
  return Math.min(Number(s.fixedTok) || 0, 1e9);
}

/* ---------- model picker ---------- */
function ensureModels() {
  if (state.modelCatalog) return;
  api('/api/models')
    .then((r) => r.json())
    .then((d) => { state.modelCatalog = d.models || []; updateTokenRing(); })
    .catch(() => { /* ring falls back to 200k */ });
}
function openModelSheet() {
  const box = $('model-list');
  const cur = currentModel();
  const draw = (models) => {
    state.modelCatalog = models;
    const s = state.sessions.find((x) => x.id === state.currentId);
    box.innerHTML = '';
    const mk = (id, label, sub) => {
      const el = document.createElement('button');
      el.className = 'opt' + (cur === id ? ' active' : '');
      el.innerHTML = '<span class="o-main"><span class="o-label"></span><span class="o-sub"></span></span>'
        + '<svg class="o-check" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';
      el.querySelector('.o-label').textContent = label;
      el.querySelector('.o-sub').textContent = sub || '';
      el.onclick = () => {
        if (cur === id) {
          localStorage.removeItem('cr_model');
          localStorage.removeItem('cr_model_label');
        } else {
          localStorage.setItem('cr_model', id);
          localStorage.setItem('cr_model_label', label);
        }
        renderModelChip();
        updateTokenRing();
        closeBubble('model-sheet');
      };
      box.appendChild(el);
    };
    mk('', '默认', s && s.model ? '跟随会话 · 当前 ' + s.model : 'CLI 配置的默认模型');
    for (const m of models) mk(m.id, m.label, fmtTokens(m.ctx) + ' 上下文 · ' + m.id);
    if (models.length === 0) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = 'settings.json 里没有配置模型别名';
      box.appendChild(e);
    }
  };
  openBubble('model-sheet');
  if (state.modelCatalog) draw(state.modelCatalog);
  else {
    box.innerHTML = '<div class="empty">加载中…</div>';
    api('/api/models')
      .then((r) => r.json())
      .then((d) => draw(d.models || []))
      .catch(() => { box.innerHTML = '<div class="empty">读取失败</div>'; });
  }
}
function renderModelChip() {
  const el = $('c-model-name');
  if (!el) return;
  const picked = currentModel();
  if (picked) el.textContent = localStorage.getItem('cr_model_label') || picked;
  else {
    const s = state.sessions.find((x) => x.id === state.currentId);
    el.textContent = (s && s.model) || '默认';
  }
}

/* ---------- wiring ---------- */
$('token-ring').onclick = openContextSheet;
$('c-model').onclick = openModelSheet;

export { ensureModels, renderModelChip, updateTokenRing };
