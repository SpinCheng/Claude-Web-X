// js/views/activity.js - 会话活动悬浮件（v154）：单悬浮件两态——收起=胶囊
// 「待办 n/total · 代理 N」、展开=右上悬浮面板。非模态：无遮罩、不拦截会话页
// 交互（滚动/发送照常），可长期存在；挂 #detail、非 #chat 子节点（renderTail
// 1:1 红线）；top 让出 #hist-more 70px 下拉带（样式见 style.css #act）。
// 数据：待办板 = state.board（messages 快照 + 'tasks' 帧，桥侧结构化下发，
// 前端禁 parse chip 文本）；代理 = 当前会话未完成的 state.agents（帧只达当前
// 会话，切回靠 messages 的 agents 摘要重建；完成即移除，活跃语义）。
// 全完成 → 「已完成」收尾 2.5s 再隐（仅活态转变时；重开旧会话的陈旧全完成板
// 不闪）。面板开着时新事件实时进列表（就地重建面板、保 scrollTop）；会话切走
// 随视图卸载、回来从桥侧快照重建（默认收起）。
import { $ } from '../util.js';
import { state } from '../state.js';
import { openAgentView } from './agentview.js';

let expanded = false;
let doneFlash = false; // 活态转全完成：胶囊短暂显示「已完成」
let doneTimer = null;
let wasAllDone = false;
const curAgents = new Set(); // 属于当前会话的 toolUseId（state.agents 跨会话残留，不能直接遍历）

export function resetActivity() {
  expanded = false; doneFlash = false; wasAllDone = false;
  clearTimeout(doneTimer); doneTimer = null;
  curAgents.clear();
  state.goal = null; // v165: goal 不跨会话（重放时由 goal 事件重建）
  render();
}

// openDetail 的 messages 响应：待办板快照 + 本会话代理摘要（无板=隐藏）
export function seedActivity(d) {
  curAgents.clear();
  if (d.agents) for (const a of d.agents) if (a.toolUseId) curAgents.add(a.toolUseId);
  state.board = d.board || null;
  state.goal = null; // v165: goal 由 events 重放写入（buildTurns 在 seed 之后跑）
  expanded = false; doneFlash = false;
  clearTimeout(doneTimer); doneTimer = null;
  wasAllDone = isAllDone(); // 陈旧全完成板不再触发收尾闪
  render();
}

// v165: goal 事件到达（重放后首绘 / 活 append）后由 app.js/detail.js 调用
export function refreshActivity() { render(); }

// ws 'tasks' 帧（桥侧待办板变更，仅当前会话）
export function onTasksFrame(d) {
  if (d.id !== state.currentId) return;
  state.board = d.board || null;
  noteDoneTransition();
  render();
}

// ws 'agent' 帧（state.agents 已写入后调用）：新代理入集合（curAgents 只靠
// messages 快照播种——会话开着时新 spawn 的代理只能从这里进来，v156 真机踩中）
export function onAgentUpdate(d) {
  if (d && d.toolUseId) curAgents.add(d.toolUseId);
  noteDoneTransition();
  render();
}

// app.js 1s 滴答：仅刷新展开面板里的活耗时（就地改文本，完成态冻结硬规则）
export function tickActivity() {
  if (!expanded) return;
  const el = $('act');
  if (!el) return;
  el.querySelectorAll('.ac-agrow[data-tid]').forEach((r) => {
    const a = state.agents[r.dataset.tid];
    if (a && a.startedAt && !a.finished) {
      const d = r.querySelector('.dur');
      if (d) d.textContent = fmtDur(Date.now() - a.startedAt);
    }
  });
}

function noteDoneTransition() {
  const now = isAllDone();
  if (now && !wasAllDone) {
    doneFlash = true;
    clearTimeout(doneTimer);
    doneTimer = setTimeout(() => { doneFlash = false; render(); }, 2500);
  }
  wasAllDone = now;
}

function isAllDone() {
  const b = state.board;
  return !!(b && b.total > 0 && b.n >= b.total && !runningAgents().length);
}

function runningAgents() {
  const out = [];
  for (const tid of curAgents) {
    const a = state.agents[tid];
    if (a && !a.finished && a.startedAt) out.push({ tid, a });
  }
  return out;
}

const fmtDur = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? m + 'm' + String(s % 60).padStart(2, '0') + 's' : s + 's';
};
// 停止语义归属 composer 的三态停止键（停主 run=停一切：bg 代理是父 CLI 进程内
// 任务，无法单停，v159 曾试过面板总停钮——语义重复且误导，真机裁定撤除）。

function render() {
  const el = $('act');
  if (!el) return;
  if (!state.currentId) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  const b = state.board;
  const ags = runningAgents();
  const hasBoard = !!(b && b.total > 0);
  const goal = state.goal; // v165: 活目标（met/stopped 后为 null）
  const allDone = hasBoard && b.n >= b.total && !ags.length && !goal;
  if (!hasBoard && !ags.length && !goal) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  if (allDone && !doneFlash) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  if (expanded) renderPanel(el, b, hasBoard, ags, goal);
  else renderPill(el, b, hasBoard, ags, goal);
}

const ICO_COLLAPSE = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>';

function renderPill(el, b, hasBoard, ags, goal) {
  el.innerHTML = '';
  const btn = document.createElement('button');
  btn.className = 'ac-pill' + (doneFlash ? ' done' : '');
  btn.onclick = () => { expanded = true; render(); };
  if (doneFlash) {
    btn.textContent = '已完成';
  } else {
    // v165 用户裁定：目标后展示进度——活目标吞并待办段（进度数字挂目标后）；
    // 无目标时维持「待办 n/total」段
    let first = true;
    const sep = () => { const s = document.createElement('span'); s.className = 'sep'; s.textContent = '·'; btn.append(s); };
    if (goal) {
      // v183 方案B：目标段带状态词（进行中=珊瑚；等待判定不区分——活 goal 一态覆盖）
      const s = document.createElement('span'); s.append('目标 ');
      const w = document.createElement('span'); w.className = 'stw-run'; w.textContent = '进行中';
      s.append(w);
      btn.append(s); first = false;
    }
    if (hasBoard && !goal) {
      if (!first) sep();
      const s = document.createElement('span');
      s.append('待办 ');
      const n = document.createElement('span'); n.className = 'of'; n.textContent = b.n + '/' + b.total;
      s.append(n);
      btn.append(s); first = false;
    }
    if (ags.length) {
      if (!first) sep();
      const s = document.createElement('span'); s.textContent = '代理 ' + ags.length;
      btn.append(s);
    }
  }
  el.append(btn);
}

function renderPanel(el, b, hasBoard, ags, goal) {
  const old = el.querySelector('.ac-panel');
  const sTop = old ? old.scrollTop : 0;
  el.innerHTML = '';
  const p = document.createElement('div');
  p.className = 'ac-panel';
  const hd = document.createElement('div'); hd.className = 'ac-hd';
  const t = document.createElement('span'); t.className = 't'; t.textContent = '会话活动';
  const x = document.createElement('button'); x.className = 'ac-collapse'; x.title = '收起';
  x.setAttribute('aria-label', '收起');
  x.innerHTML = ICO_COLLAPSE;
  x.onclick = () => { expanded = false; render(); };
  hd.append(t, x);
  p.append(hd);
  // v165: 目标分区居首（用户裁定顺序：目标、待办、代理）；条件全文两行
  if (goal) {
    p.append(sechd('目标', '进行中'));
    const row = document.createElement('div'); row.className = 'ac-goalrow';
    const g = document.createElement('span'); g.className = 'g'; g.textContent = '◎';
    const txt = document.createElement('span'); txt.className = 'txt'; txt.textContent = goal.cond || '（未命名目标）';
    row.append(g, txt);
    p.append(row);
  }
  if (hasBoard) {
    p.append(sechd('待办', b.n + '/' + b.total));
    const list = document.createElement('div');
    (b.items || []).forEach((it, i) => list.append(taskRow(it, i)));
    p.append(list);
  }
  if (ags.length) {
    p.append(sechd('代理', '运行中 ' + ags.length));
    for (const { tid, a } of ags) {
      const r = document.createElement('button'); r.className = 'ac-agrow'; r.dataset.tid = tid;
      const lamp = document.createElement('span'); lamp.className = 'lamp'; lamp.dataset.st = 'running';
      const d = document.createElement('span'); d.className = 'd'; d.textContent = a.desc || '子代理';
      const dur = document.createElement('span'); dur.className = 'dur'; dur.textContent = fmtDur(Date.now() - a.startedAt);
      const chev = document.createElement('span'); chev.className = 'chev'; chev.textContent = '›';
      r.append(lamp, d, dur, chev);
      r.onclick = () => openAgentView(tid);
      p.append(r);
    }
  }
  el.append(p);
  p.scrollTop = sTop;
}

function sechd(name, n) {
  const h = document.createElement('div'); h.className = 'ac-sechd';
  h.append(name);
  const b = document.createElement('span'); b.className = 'n'; b.textContent = n;
  h.append(b);
  return h;
}

// 状态原生驱动：completed 划线 / in_progress 珊瑚(静态) / pending 待办 / 其余灰显
function taskRow(it, i) {
  const st = it.st;
  const r = document.createElement('div');
  r.className = 'ac-trow ' + (st === 'completed' ? 'done' : st === 'in_progress' ? 'act' : st === 'pending' ? 'todo' : 'cancel');
  const g = document.createElement('span'); g.className = 'g';
  g.textContent = st === 'completed' ? '✓' : st === 'in_progress' ? '●' : st === 'pending' ? '○' : '✕';
  const idx = document.createElement('span'); idx.className = 'idx'; idx.textContent = String(i + 1);
  const txt = document.createElement('span'); txt.className = 'txt'; txt.textContent = it.s || '(无标题)';
  r.append(g, idx, txt);
  if (st === 'in_progress' && it.af) {
    const af = document.createElement('div'); af.className = 'ac-af'; af.textContent = '↳ ' + it.af;
    txt.append(af);
  }
  return r;
}
