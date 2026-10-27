// js/views/ctxring.js - context window accounting: the token ring
// (usage/window, formula identical to Desktop), the /context probe sheet
// (per-category fixed parts) and the model + effort picker bubble (v36).

import { $, fmtTokens } from '../util.js';
import { state, currentModel, currentEffort } from '../state.js';
import { api } from '../api.js';
import { openBubble, closeBubble } from './overlays.js';
// function-level import cycle with detail.js (refreshCostUI -> renderMeta vs
// renderMeta -> openCostPanel/costDisplay) - same safe pattern as
// composer<->detail: no cross-module call happens at module-evaluation time
import { renderMeta } from './detail.js';

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

/* ---------- model + effort picker (v36: effort merged into the model sheet;
   relationship: picking a MODEL confirms and closes, picking an EFFORT level
   applies in place so both can be tuned in one sitting) ---------- */
function ensureModels() {
  if (state.modelCatalog) return;
  api('/api/models')
    .then((r) => r.json())
    .then((d) => { state.modelCatalog = d.models || []; updateTokenRing(); })
    .catch(() => { /* ring falls back to 200k */ });
}
const EFFORTS = [
  { v: '', label: '默认' },
  { v: 'low', label: '低' },
  { v: 'medium', label: '中' },
  { v: 'high', label: '高' },
  { v: 'xhigh', label: '超高' },
  { v: 'max', label: '最高' },
];
function setEffort(v) {
  if (v) localStorage.setItem('cr_effort', v);
  else localStorage.removeItem('cr_effort');
  renderEffortTag();
}
function drawEffortRow() {
  const row = $('effort-row');
  if (!row) return;
  const cur = currentEffort();
  row.innerHTML = '';
  for (const f of EFFORTS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg-btn' + (cur === f.v ? ' active' : '');
    b.textContent = f.label;
    b.onclick = () => { setEffort(f.v); drawEffortRow(); };
    row.appendChild(b);
  }
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
    drawEffortRow();
  };
  openBubble('model-sheet');
  drawEffortRow(); // level pills render even while the catalog is loading
  if (state.modelCatalog) draw(state.modelCatalog);
  else {
    box.innerHTML = '<div class="empty">加载中…</div>';
    api('/api/models')
      .then((r) => r.json())
      .then((d) => draw(d.models || []))
      .catch(() => { box.innerHTML = '<div class="empty">读取失败</div>'; });
  }
}
function renderEffortTag() {
  const el = $('c-effort-tag');
  if (!el) return;
  const v = currentEffort();
  el.textContent = v ? '·' + ((EFFORTS.find((f) => f.v === v) || {}).label || v) : '';
  el.hidden = !v;
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
  renderEffortTag();
}

/* ---------- v48 cost panel: cumulative usage + pricing modes ----------
   Entry is the header cost text (detail.js renders it as .cost-entry and
   opens this panel on tap). Pricing is a PWA-local display preference on
   purpose: CC prices tokens at the OFFICIAL table (cost-state usd), relays
   bill differently and expose no rates API - so 'off' shows CC's number,
   'mult' scales it, 'cust' prices token aggregates with per-model rates.
   localStorage, never bridge state. The multiplier prefill (0.07) is the
   usage-weighted DeepSeek-vs-Sonnet ratio on a cache-heavy real mix
   (~48k in / 12.6k out / 892k cacheRead / 31k cacheWrite). */
const COST_MULT_DEFAULT = 0.07;
const COST_MODES = [
  { v: 'off', label: '官方价格' },
  { v: 'mult', label: '倍率' },
  { v: 'cust', label: '自定义单价' },
];
const COST_FIELDS = [['in', '输入 $/M'], ['out', '输出 $/M'], ['cr', '缓存读 $/M'], ['cw', '缓存写 $/M']];
function costMode() { return localStorage.getItem('cr_cost_mode') || 'off'; }
function costMult() { const v = parseFloat(localStorage.getItem('cr_cost_mult')); return isFinite(v) && v > 0 ? v : COST_MULT_DEFAULT; }
function costPrices() { try { return JSON.parse(localStorage.getItem('cr_cost_prices') || '{}') || {}; } catch { return {}; } }
const priceCalc = (m, p) => (((m.inTok || 0) * (p.in || 0)) + ((m.outTok || 0) * (p.out || 0)) + ((m.cacheRead || 0) * (p.cr || 0)) + ((m.cacheCreate || 0) * (p.cw || 0))) / 1e6;
// pure: display cost for a session's cost stats under the given prefs
// (defaults resolve lazily so tests can pass everything explicitly)
export function costDisplay(stats, mode, mult, prices) {
  if (!stats) return null;
  mode = mode || costMode(); mult = mult || costMult(); prices = prices || costPrices();
  if (mode === 'cust') {
    const def = prices.def || {};
    // no per-model map (old bridge data) -> price the aggregate with defaults
    const models = (stats.models && Object.keys(stats.models).length) ? stats.models : { '': stats };
    let sum = 0;
    for (const [name, m] of Object.entries(models)) sum += priceCalc(m, (prices.byModel || {})[name] || def);
    return sum;
  }
  if (stats.usd == null) return null;
  if (mode === 'mult') return (Number(stats.usd) || 0) * mult;
  return Number(stats.usd) || 0;
}
function modelLabel(name) {
  const hit = (state.modelCatalog || []).find((x) => x.id === name);
  return hit ? hit.label : name;
}
// 转录体积构成 + counts - char-share estimate straight off the turn model
function compOfTurns() {
  let tool = 0, think = 0, dialog = 0, nTool = 0, nThink = 0, nUser = 0;
  for (const t of state.turns) {
    if (t.role === 'user') { nUser++; dialog += (t.text || '').length; continue; }
    for (const st of t.steps || []) {
      if (st.t === 'tool') { nTool++; tool += (st.tool.v || '').length + ((st.tool.out && st.tool.out.text) || '').length; }
      else if (st.t === 'think') { nThink++; think += (st.v || '').length; }
      else if (st.t === 'text') dialog += (st.v || '').length;
    }
  }
  return { tool, think, dialog, nTool, nThink, nUser };
}
function renderCostSheet() {
  const s = state.sessions.find((x) => x.id === state.currentId);
  if (!s) return;
  const c = s.cost || {};
  const mode = costMode();
  const usd = costDisplay(c);
  $('cost-usd').textContent = usd != null ? '$' + usd.toFixed(2) : '—';
  $('cost-cap').textContent = mode === 'mult' ? '官方 $' + (Number(c.usd) || 0).toFixed(2) + ' × ' + costMult() + ' · 本会话累计'
    : mode === 'cust' ? '自定义单价 × token · 本会话累计' : '官方价格（CC 内置价表）· 本会话累计';
  $('cost-mode-sub').textContent = mode === 'off' ? '官方价格'
    : mode === 'mult' ? '官方 × ' + costMult() : '自定义单价';
  const grid = $('cost-grid');
  grid.textContent = '';
  const cell = (v, k) => {
    const d = document.createElement('div'); d.className = 'cell';
    const a = document.createElement('div'); a.className = 'tv'; a.textContent = v;
    const b = document.createElement('div'); b.className = 'tk'; b.textContent = k;
    d.append(a, b); return d;
  };
  grid.append(cell(fmtTokens(c.inTok || 0), '输入'), cell(fmtTokens(c.outTok || 0), '输出'),
    cell(fmtTokens(c.cacheRead || 0), '缓存读'), cell(fmtTokens(c.cacheCreate || 0), '缓存写'));
  // per-model rows only when the session actually switched models
  const box = $('cost-models');
  box.textContent = '';
  box.hidden = true;
  const names = Object.keys(c.models || {});
  if (names.length > 1) {
    box.hidden = false;
    const head = document.createElement('p');
    head.className = 'comp-cap';
    head.textContent = '分模型 · 切换各归各账';
    box.append(head);
    for (const name of names) {
      const m = c.models[name];
      const row = document.createElement('div'); row.className = 'c-mrow';
      const nm = document.createElement('span'); nm.className = 'c-mname'; nm.textContent = modelLabel(name);
      const us = document.createElement('span'); us.className = 'c-musd';
      us.textContent = m.usd != null ? '$' + Number(m.usd).toFixed(2) : '';
      row.append(nm, us);
      const sub = document.createElement('div'); sub.className = 'c-msub';
      const share = c.usd ? Math.round((m.usd || 0) / c.usd * 100) : 0;
      sub.textContent = '输入 ' + fmtTokens(m.inTok || 0) + ' · 输出 ' + fmtTokens(m.outTok || 0)
        + ' · 缓存读 ' + fmtTokens(m.cacheRead || 0) + ' · 占 ' + share + '%';
      box.append(row, sub);
    }
  }
  const comp = compOfTurns();
  const tot = comp.tool + comp.think + comp.dialog;
  const bar = $('comp-bar'); bar.textContent = '';
  const legend = $('comp-legend'); legend.textContent = '';
  const segEl = (n, cls) => {
    if (n <= 0) return;
    const sp = document.createElement('span'); sp.className = cls;
    sp.style.width = Math.min(100, n / tot * 100).toFixed(2) + '%';
    bar.append(sp);
  };
  const legEl = (cls, txt) => {
    const sp = document.createElement('span');
    const i = document.createElement('i'); i.className = cls;
    sp.append(i, document.createTextNode(txt));
    legend.append(sp);
  };
  if (tot > 0) {
    segEl(comp.tool, 'c-tool'); segEl(comp.think, 'c-think'); segEl(comp.dialog, 'c-dialog');
    legEl('c-tool', '工具 ' + Math.round(comp.tool / tot * 100) + '%');
    legEl('c-think', '思考 ' + Math.round(comp.think / tot * 100) + '%');
    legEl('c-dialog', '对话 ' + Math.round(comp.dialog / tot * 100) + '%');
  } else legEl('c-dialog', '暂无转录数据');
  const ms = $('cost-ministats');
  ms.textContent = '';
  const bEl = (n) => { const x = document.createElement('b'); x.textContent = String(n); return x; };
  ms.append('工具调用 ', bEl(comp.nTool), ' 次 · 思考 ', bEl(comp.nThink), ' 段 · 对话 ', bEl(comp.nUser), ' 轮');
}
function mkPHead(t) { const d = document.createElement('div'); d.className = 'phead'; d.textContent = t; return d; }
function mkGrid(obj, onChange) {
  const g = document.createElement('div'); g.className = 'pgrid';
  for (const [k, label] of COST_FIELDS) {
    const cellD = document.createElement('div'); cellD.className = 'pcell';
    const inp = document.createElement('input');
    inp.inputMode = 'decimal'; inp.placeholder = '0'; inp.spellcheck = false;
    inp.value = obj[k] != null ? String(obj[k]) : '';
    inp.onchange = () => {
      const v = parseFloat(inp.value);
      if (isFinite(v) && v >= 0) obj[k] = v; else delete obj[k];
      onChange();
    };
    const sp = document.createElement('span'); sp.textContent = label;
    cellD.append(inp, sp); g.append(cellD);
  }
  return g;
}
function mkRow(label, value, unit, onchange) {
  const row = document.createElement('div'); row.className = 'frow';
  const fl = document.createElement('span'); fl.className = 'fl'; fl.textContent = label;
  const inp = document.createElement('input'); inp.className = 'pin'; inp.inputMode = 'decimal'; inp.value = value; inp.spellcheck = false;
  inp.onchange = () => { const v = parseFloat(inp.value); if (isFinite(v) && v > 0) onchange(v); };
  const un = document.createElement('span'); un.className = 'unit'; un.textContent = unit;
  row.append(fl, inp, un);
  return row;
}
function drawCostEditor() {
  const seg = $('cost-modes'); seg.textContent = '';
  const mode = costMode();
  for (const f of COST_MODES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'seg-btn' + (mode === f.v ? ' active' : '');
    btn.textContent = f.label;
    btn.onclick = () => { localStorage.setItem('cr_cost_mode', f.v); refreshCostUI(); };
    seg.append(btn);
  }
  const pane = $('cost-pane'); pane.textContent = '';
  const note = (txt) => { const p = document.createElement('p'); p.className = 'sheet-note'; p.textContent = txt; pane.append(p); };
  if (mode === 'off') {
    note('显示 CC 按官方价表算好的原值（cost-state），无需任何配置。三方中转计费不同时请换用另两档。');
    return;
  }
  if (mode === 'mult') {
    pane.append(mkRow('倍率', String(costMult()), '× 官方', (v) => { localStorage.setItem('cr_cost_mult', String(v)); refreshCostUI(); }));
    note('显示 = 官方价 × 倍率，适合中转按官方价打折/加价的计费。预填 0.07 ≈ DeepSeek 级价目对 Sonnet 官方价的用量加权比（缓存读为主的真实结构）。');
    return;
  }
  const s = state.sessions.find((x) => x.id === state.currentId);
  const prices = costPrices();
  prices.def = prices.def || {};
  prices.byModel = prices.byModel || {};
  const save = () => localStorage.setItem('cr_cost_prices', JSON.stringify(prices));
  const changed = () => { save(); refreshCostUI(); };
  pane.append(mkPHead('默认单价（未列出的模型）'));
  pane.append(mkGrid(prices.def, changed));
  for (const name of Object.keys((s && s.cost && s.cost.models) || {})) {
    prices.byModel[name] = prices.byModel[name] || {};
    pane.append(mkPHead(modelLabel(name)));
    pane.append(mkGrid(prices.byModel[name], changed));
  }
  note('本会话用过的模型自动列出，各归各账：计价 = Σ(该模型 token × 该模型单价)。默认行兜底新模型；按模型 id 记忆、跨会话共用。');
}
function refreshCostUI() {
  renderCostSheet();
  drawCostEditor();
  renderMeta(); // header number follows the active pricing mode
}
function openCostPanel() {
  renderCostSheet();
  $('cost-main').hidden = false;
  $('cost-editor').hidden = true;
  drawCostEditor();
  openBubble('cost-sheet');
}

/* ---------- wiring ---------- */
$('token-ring').onclick = openContextSheet;
$('c-model').onclick = openModelSheet;
$('cost-price-row').onclick = () => { $('cost-main').hidden = true; $('cost-editor').hidden = false; drawCostEditor(); };
$('cost-back').onclick = () => { $('cost-editor').hidden = true; $('cost-main').hidden = false; renderCostSheet(); };

export { ensureModels, renderModelChip, updateTokenRing, openCostPanel };
