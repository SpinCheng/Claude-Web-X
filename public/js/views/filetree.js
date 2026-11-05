// js/views/filetree.js - 项目文件树（roadmap 12 定稿，v193）
// 手机=右缘遮挡抽屉（82vw + 轻 scrim 点外即收）；PC 右栏面板归条目 13，
// 届时行单元在本模块直接复用。挂 #detail——cwd=当前会话项目（列表(全局)→
// 详情(会话)→文件树(项目)），切会话自动跟随重建（openDetail→resetFileTree）。
// 不动 history（短动作不保鲜，同气泡裁定）；收起即销毁。
// 数据面=桥 GET /tree（readdir 磁盘真相，git 仅标注层）；点文件=预览
// （previewArtifact 管线全复用）；⋯/右键=预览/插入 @ 引用/复制路径/复制文件名
// （动作借力：插入只调 composer.insertRef，与 @ 选择器组件解耦）。
// untracked/ignored 角标只标注不筛除（用户裁定「git 视角不筛 git」）。
import { $, shortPath } from '../util.js';
import { state } from '../state.js';
import { api } from '../api.js';
import { toast } from './toast.js';
import { openBubble, closeBubble, previewArtifact } from './overlays.js';
import { insertRef } from './composer.js';

// v201 图标：真·文件树标准语系（VSCode seti 的单色版）——文件夹开/合双态
// （展开=开口文件夹，与旋箭头双重状态表达），文件按类型 5 族字形：
// 代码 <> / 文档=页+行 / 配置={} / 图片=相框 / 默认=素页。全部 currentColor，
// 不引入新色相（珊瑚纪律不破）。
const FT_DIR_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';
const FT_DIR_OPEN_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>';
const FT_DOC_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
const FT_CODE_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/></svg>';
const FT_TEXT_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></svg>';
const FT_CONF_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1"/><path d="M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1"/></svg>';
const FT_IMG_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>';
const FT_CODE_RE = /\.(js|mjs|cjs|ts|jsx|tsx|vue|svelte|astro|html?|css|scss|sass|less|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|lua|r|m|pl|sh|bash|zsh|fish|ps1|psm1|bat|cmd|sql)$/i;
const FT_TEXT_RE = /\.(md|markdown|txt|log|csv|tsv|diff|patch)$/i;
const FT_CONF_RE = /(^|\/)(\.[\w.-]+|[\w-]+\.(json|jsonc|ya?ml|toml|ini|cfg|conf|env|xml|lock|properties))$/i;
const FT_IMG_RE = /\.(png|jpe?g|webp|gif|svg|ico|bmp)$/i;
function ftFileIcon(name) {
  if (FT_CODE_RE.test(name)) return FT_CODE_ICON;
  if (FT_TEXT_RE.test(name)) return FT_TEXT_ICON;
  if (FT_CONF_RE.test(name)) return FT_CONF_ICON;
  if (FT_IMG_RE.test(name)) return FT_IMG_ICON;
  return FT_DOC_ICON;
}
const FT_TW = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg>';
const FT_MORE = '<svg viewBox="0 0 24 24" width="14" height="14"><circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/></svg>';
const FT_DEPTH_MAX = 11; // 深度上限 12（桥侧同限）：第 12 层不再给展开箭头
const I = {
  eye: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.6"/></svg>',
  at: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/></svg>',
  copy: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
};

let ftOpen = false;
let ftDir = new Map();   // rel -> {entries, more, capped}（'' = 根）
let ftExp = new Set();   // 展开中的 rel（'' = 根）
let ftFilter = 'all';    // all | tracked | untracked
let ftQuery = '';
let ftStats = null;
let ftLoading = new Set();

const ftRelOf = (p, n) => (p ? p.replace(/\/+$/, '') + '/' + n : n);

function openFileTree() {
  ftOpen = true;
  syncFtMode();
  const rec = state.sessions.find((x) => x.id === state.currentId);
  $('ft-proj').textContent = rec && rec.cwd ? shortPath(rec.cwd) : '';
  $('ft-toggle').classList.add('active');
  $('ft-scrim').classList.remove('hidden'); // 宽屏由 CSS display:none 压掉
  $('ft-drawer').classList.remove('hidden');
  if (ftDir.has('') && ftExp.has('')) renderTree();
  else ftLoad('');
}
function closeFileTree() {
  if (!ftOpen) return;
  ftOpen = false;
  syncFtMode();
  $('ft-toggle').classList.remove('active');
  $('ft-scrim').classList.add('hidden');
  $('ft-drawer').classList.add('hidden');
  closeBubble('row-actions');
  // 手势/回弹残留的内联 transform 一并清掉（下次 open 重新走 ftIn 动画）
  const dEl = $('ft-drawer');
  dEl.style.transform = ''; dEl.style.transition = '';
  // 收起即销毁：短动作不保鲜，重开走一次懒加载（面板偏好只由用户显式
  // 开关写入——代码路径（closeDetail/popstate）关闭不擦 localStorage）
  ftDir = new Map(); ftExp = new Set(); ftLoading = new Set();
  ftFilter = 'all'; ftQuery = ''; ftStats = null;
  $('ft-q').value = '';
  $('ft-find-row').classList.add('hidden');
  syncSeg();
}
// v195 双形态：窄=右缘抽屉；宽=第三栏 242px（纯 CSS 差异）。body.ft-open 供
// 1024~1280 档的左栏自动收窄规则（342→262 保转录可读）；断点切换由 app.js
// applyWide 回调同步
export function syncFtMode() {
  document.body.classList.toggle('ft-open', state.wide && ftOpen);
}
// 切会话：跟随新 cwd 重建（打开态保持打开）
function resetFileTree() {
  ftDir = new Map(); ftExp = new Set(); ftLoading = new Set(); ftStats = null;
  if (ftOpen) {
    const rec = state.sessions.find((x) => x.id === state.currentId);
    $('ft-proj').textContent = rec && rec.cwd ? shortPath(rec.cwd) : '';
    ftLoad('');
  }
}

async function ftLoad(rel) {
  const id = state.currentId;
  if (!id || ftLoading.has(rel)) return;
  ftLoading.add(rel);
  renderTree(); // 展开行下先给一个载入占位
  try {
    const r = await api('/api/sessions/' + encodeURIComponent(id) + '/tree?p=' + encodeURIComponent(rel));
    const j = await r.json();
    if (state.currentId !== id) return; // 会话已切换：迟到响应弃用
    if (!j.ok) { toast('目录读取失败'); return; }
    ftDir.set(rel, j);
    if (j.stats) ftStats = j.stats;
    ftExp.add(rel);
  } catch { toast('目录读取失败'); }
  finally { ftLoading.delete(rel); }
  renderTree();
}

// 名字过滤只作用于已加载节点（全盘搜索是 @ 选择器的职责）；命中节点的祖先保留
function nodeMatches(e, rel) {
  const rp = ftRelOf(rel, e.n).toLowerCase();
  if (ftQuery) {
    if (rp.includes(ftQuery.toLowerCase())) return true;
    if (e.d && ftExp.has(rp)) {
      const dd = ftDir.get(rp);
      if (dd && dd.entries.some((c) => nodeMatches(c, rp))) return true;
    }
    return false;
  }
  if (ftFilter === 'tracked') return e.t;
  if (ftFilter === 'untracked') return e.g === 'unt' || e.g === 'ign';
  return true;
}

function renderTree() {
  const host = $('ft-tree');
  const st = host.scrollTop;
  host.innerHTML = '';
  const frag = document.createDocumentFragment();
  if (ftDir.has('')) appendLevel(frag, '', 0);
  else {
    const e = document.createElement('div');
    e.className = 'ft-more';
    e.textContent = '载入项目目录…';
    frag.appendChild(e);
  }
  host.appendChild(frag);
  host.scrollTop = st;
  const bar = $('ft-bar');
  if (ftStats) {
    bar.classList.remove('hidden');
    const t = $('ft-stats');
    t.textContent = '';
    t.append(ftStats.t + ' 跟踪 · ' + ftStats.u + ' 未跟踪' + (ftStats.i ? ' · ' + ftStats.i + ' 忽略' : ''));
    // v200 全状态彩色计数（旧桥响应无 m/a/d 字段时静默省略）
    const colored = [['M', ftStats.m, 'cm'], ['A', ftStats.a, 'ca'], ['D', ftStats.d, 'cd']];
    for (const [label, n, cls] of colored) {
      if (!n) continue;
      const s = document.createElement('span');
      s.className = cls;
      s.textContent = ' · ' + label + n;
      t.appendChild(s);
    }
  } else bar.classList.add('hidden');
}

function appendLevel(host, rel, depth) {
  const d = ftDir.get(rel);
  if (!d) return;
  for (const e of d.entries) {
    if (!nodeMatches(e, rel)) continue;
    host.appendChild(ftRowEl(e, rel, depth));
    if (!e.d) continue;
    const childRel = ftRelOf(rel, e.n);
    if (ftExp.has(childRel)) {
      if (ftDir.has(childRel)) appendLevel(host, childRel, depth + 1);
      else {
        const l = document.createElement('div');
        l.className = 'ft-more';
        l.style.setProperty('--ft-depth', depth + 1);
        l.textContent = '载入…';
        host.appendChild(l);
      }
    }
  }
  if (d.more) {
    const m = document.createElement('div');
    m.className = 'ft-more';
    m.textContent = '单层超过 500 项已截断——用文件名过滤或 @ 引用直达';
    host.appendChild(m);
  }
  if (d.capped) {
    const m = document.createElement('div');
    m.className = 'ft-more';
    m.textContent = '已达 12 层深度上限';
    host.appendChild(m);
  }
}

// 行单元（纯函数渲染，无 DOM 全局依赖——PC 面板（条目 13）复用件）：
// 名字是盘上数据，全程 textContent 构建
function ftRowEl(e, rel, depth) {
  const rp = ftRelOf(rel, e.n);
  const b = document.createElement('button');
  b.type = 'button';
  // v200 全状态着色：ign 保持置灰（.un）；mod/add/del/unt 走各自颜色类
  b.className = 'frow' + (e.d && ftExp.has(rp) ? ' open' : '')
    + (e.g === 'ign' ? ' un' : (e.g ? ' ' + e.g : ''));
  b.style.setProperty('--ft-depth', depth);
  const tw = document.createElement('span');
  tw.className = 'tw' + (e.d && depth < FT_DEPTH_MAX ? '' : ' leaf');
  if (e.d && depth < FT_DEPTH_MAX) tw.innerHTML = FT_TW;
  const ic = document.createElement('span');
  ic.className = 'ic';
  ic.innerHTML = e.d ? (e.d && ftExp.has(rp) ? FT_DIR_OPEN_ICON : FT_DIR_ICON) : ftFileIcon(e.n);
  const nm = document.createElement('span');
  nm.className = 'nm';
  nm.textContent = e.n;
  // v199 裁定：ignored 不带文字标签——置灰即语义。v200：unt 升绿（角标同绿，
  // 「新增」色系）；mod/add/del 纯颜色无角标（VSCode 语系，状态即颜色）
  if (e.g === 'unt') {
    const g = document.createElement('span');
    g.className = 'gitb unt';
    g.textContent = 'untracked';
    nm.appendChild(g);
  }
  const side = document.createElement('span');
  side.className = 'side';
  if (e.d && !ftExp.has(rp) && e.c) {
    const c = document.createElement('span');
    c.className = 'cnt';
    c.title = '被跟踪文件数（git 索引推得）';
    c.textContent = e.c;
    side.appendChild(c);
  }
  const more = document.createElement('span');
  more.className = 'more';
  more.setAttribute('role', 'button');
  more.title = '文件操作';
  more.innerHTML = FT_MORE;
  more.addEventListener('click', (ev) => { ev.stopPropagation(); openFileActions(e, rp); });
  side.appendChild(more);
  b.append(tw, ic, nm, side);
  b.addEventListener('contextmenu', (ev) => { ev.preventDefault(); openFileActions(e, rp); });
  b.addEventListener('click', () => {
    if (!e.d) {
      if (e.g === 'del') { toast('文件已删除（仅存于 git 记录）'); return; } // 幽灵行：磁盘上没有
      previewArtifact(rp); return; // 点文件=预览（管线全复用）
    }
    if (ftExp.has(rp)) { ftExp.delete(rp); renderTree(); return; } // 折叠：数据留缓存
    if (ftDir.has(rp)) { ftExp.add(rp); renderTree(); }
    else ftLoad(rp); // 首次展开=懒加载（ftLoad 完成后自行 add+render）
  });
  return b;
}

/* ---------- 文件动作：复用 #row-actions 气泡壳（group-copy v96 先例） ---------- */
function ftAct(icon, label, sub, fn) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'opt act-row';
  el.innerHTML = '<span class="o-ico">' + icon + '</span><span class="o-main"><span class="o-label"></span><span class="o-sub"></span></span>';
  el.querySelector('.o-label').textContent = label;
  el.querySelector('.o-sub').textContent = sub;
  el.onclick = fn;
  return el;
}
function openFileActions(e, rp) {
  const sheet = document.querySelector('#row-actions .act-bubble');
  sheet.querySelector('.act-title').textContent = e.n;
  sheet.querySelector('.act-sub').textContent = rp;
  const list = sheet.querySelector('.act-list');
  list.innerHTML = '';
  if (e.g !== 'del') { // 幽灵删除行磁盘上没有，预览/插入无从谈起
    list.appendChild(ftAct(I.eye, '预览', '支持类型 · ≤2MB · 项目目录内', () => { closeBubble('row-actions'); previewArtifact(rp); }));
    list.appendChild(ftAct(I.at, '插入 @ 引用', '写入输入框光标处（发送时代附内容）', () => {
      closeBubble('row-actions');
      closeFileTree(); // 让用户看见引用落进输入框
      insertRef(rp, !!e.d);
    }));
  } else {
    list.appendChild(ftAct(I.eye, '文件已删除', '仅存于 git 记录，恢复请走 git 命令', () => closeBubble('row-actions')));
  }
  const rec = state.sessions.find((x) => x.id === state.currentId);
  const abs = rec && rec.cwd ? rec.cwd.replace(/[\\/]+$/, '') + '/' + rp : rp;
  list.appendChild(ftAct(I.copy, '复制路径', abs, () => { closeBubble('row-actions'); ftCopy(abs, '路径'); }));
  list.appendChild(ftAct(I.copy, '复制文件名', e.n, () => { closeBubble('row-actions'); ftCopy(e.n, '文件名'); }));
  openBubble('row-actions');
}
function ftCopy(t, label) {
  // v206：clipboard API 在局域网 HTTP（非 localhost）下缺失或被拒——
  // 与 transcript.js copyText 同款兜底：writeText 竞速 1.2s 超时 → execCommand
  const fallback = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('已复制' + label);
    } catch { toast('复制失败'); }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    Promise.race([
      navigator.clipboard.writeText(t).then(() => true, () => false),
      new Promise((r) => setTimeout(() => r(false), 1200)),
    ]).then((ok) => (ok ? toast('已复制' + label) : fallback()));
  } else fallback();
}

/* ---------- wiring ---------- */
function syncSeg() {
  $('ft-seg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.f === ftFilter));
}
$('ft-toggle').onclick = () => {
  if (ftOpen) {
    closeFileTree();
    if (state.wide) { try { localStorage.setItem('cr_ft_panel', '0'); } catch { /* quota */ } }
  } else {
    openFileTree();
    if (state.wide) { try { localStorage.setItem('cr_ft_panel', '1'); } catch { /* quota */ } }
  }
};
$('ft-close').onclick = () => {
  closeFileTree();
  if (state.wide) { try { localStorage.setItem('cr_ft_panel', '0'); } catch { /* quota */ } }
};
$('ft-scrim').onclick = closeFileTree;

/* v207 手势：窄屏抽屉态右缘拖拽收起（6px 起步判定竖直滑动；跟手位移→松手
   超 1/3 宽或快甩即收，否则回弹）。宽屏面板形态不参与（static 列非 transient
   抽屉，有拖宽手柄在管）。touch-action:none 只挂 FT_TREE_GRIP 宽的边缘条，
   其余树体保持可滚动。 */
const FT_TREE_GRIP = 6;
function wireFtSwipe() {
  const d = $('ft-drawer');
  d.addEventListener('touchstart', (e) => {
    if (state.wide || !ftOpen) return;
    const t0 = e.touches[0];
    const x0 = t0.clientX; const y0 = t0.clientY;
    const w = d.getBoundingClientRect().width;
    let moved = false; let cur = 0; let lastT = 0; let lastX = x0; let v = 0;
    const move = (ev) => {
      const t = ev.touches[0];
      if (!moved) {
        if (Math.abs(t.clientY - y0) > Math.abs(t.clientX - x0)) { cleanup(); return; } // 竖直滑动让给树滚动
        if (t.clientX - x0 > FT_TREE_GRIP) moved = true; else return;
      }
      ev.cancelable && ev.preventDefault(); // 已判定为收起手势，拦掉树体滚动
      cur = Math.max(0, t.clientX - x0);
      const now = performance.now();
      if (now - lastT > 0) { v = (t.clientX - lastX) / (now - lastT); lastT = now; lastX = t.clientX; }
      d.style.transform = 'translateX(' + cur + 'px)';
      d.style.transition = 'none';
    };
    const up = () => {
      cleanup();
      if (!moved) return;
      const fling = v > 0.45; // px/ms 向右甩
      d.style.transition = 'transform .18s ease';
      if (cur > w / 3 || fling) {
        d.style.transform = 'translateX(100%)';
        setTimeout(closeFileTree, 160);
      } else {
        d.style.transform = ''; // 回弹
        setTimeout(() => { d.style.transition = ''; }, 190);
      }
    };
    const cleanup = () => {
      window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', up);
      window.removeEventListener('touchcancel', up);
    };
    window.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('touchend', up);
    window.addEventListener('touchcancel', up);
  }, { passive: true });
}
wireFtSwipe();
$('ft-find').onclick = () => {
  const row = $('ft-find-row');
  if (row.classList.contains('hidden')) { row.classList.remove('hidden'); $('ft-q').focus(); }
  else { row.classList.add('hidden'); $('ft-q').value = ''; ftQuery = ''; renderTree(); }
};
$('ft-q').addEventListener('input', () => { ftQuery = $('ft-q').value.trim(); renderTree(); });
$('ft-seg').querySelectorAll('button').forEach((b) => {
  b.onclick = () => { ftFilter = b.dataset.f || 'all'; syncSeg(); renderTree(); };
});
// Esc 收抽屉（全屏预览/lightbox 优先——它们盖在抽屉之上，先关它们）
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !ftOpen) return;
  if (!$('lightbox').classList.contains('hidden') || !$('html-prev').classList.contains('hidden')) return;
  if (e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT')) return;
  closeFileTree();
});

export { openFileTree, closeFileTree, resetFileTree };
