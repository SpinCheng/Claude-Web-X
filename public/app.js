/* claude-remote PWA — cockpit app (vanilla, no build)
   转录以"轮次"渲染：用户消息 → 机器轮（思考/工具折叠区 + 最终结论）。
   运行中的轮次思考区展开并带光标；结束后收起。 */
'use strict';

const $ = (id) => document.getElementById(id);
const CLOSED_KEY = 'cr_closed_groups';
// touch devices: Enter inserts a newline (send only via the button);
// desktop keeps the Enter-to-send convention
const IS_TOUCH = matchMedia('(pointer: coarse)').matches;

const state = {
  token: localStorage.getItem('cr_token') || '',
  ws: null, wsTimer: null, wsRetry: 1000,
  sessions: [],
  currentId: null,
  atBottom: true,
  runs: {},            // sessionId -> {runId, state}
  driver: null,
  pendingNew: null,
  turns: [],           // transcript turn objects for the open session
  liveTurnOpen: false,
  closedGroups: new Set(JSON.parse(localStorage.getItem(CLOSED_KEY) || '[]')),
  perm: localStorage.getItem('cr_perm') || 'auto', // 'auto' | 'ask'
  approvals: [],   // pending permission requests (queue)
  userCollapsedLive: false, // user folded the live turn manually - respect it
  modelCatalog: null, // /api/models cache: [{id,label,ctx}]
  ctxProbe: null,    // last /context probe result {key,window,fixed,buffer}
};

/* ---------------- token gate ---------------- */
async function tryToken(token) {
  try {
    const r = await fetch('/api/ping', { headers: { Authorization: 'Bearer ' + token } });
    if (r.status === 401) return false;
    return r.ok;
  } catch { return false; }
}
async function saveToken() {
  const t = $('token-input').value.trim();
  $('gate-err').textContent = '';
  if (!t) return;
  if (await tryToken(t)) {
    state.token = t;
    localStorage.setItem('cr_token', t);
    enterApp();
  } else {
    $('gate-err').textContent = '令牌无效，或 bridge 没在运行';
  }
}
function enterApp() {
  $('gate').classList.add('hidden');
  $('list').classList.remove('hidden');
  connectWs();
  fetchSessions(); // HTTP bootstrap so the list shows even before WS settles
  setInterval(() => { if (state.currentId) updateTokenRing(); }, 15000);
  renderModelChip();
}
let gateReason = '';
function showGate(reason) {
  // token died (rotated on PC): back to pairing
  state.token = '';
  localStorage.removeItem('cr_token');
  try { if (state.ws) state.ws.close(); } catch (e) { /* noop */ }
  gateReason = reason || '';
  $('gate-err').textContent = gateReason;
  $('list').classList.add('hidden');
  $('detail').classList.add('hidden');
  $('gate').classList.remove('hidden');
  $('token-input').focus();
}
// fetch wrapper: any 401 means the stored token is dead
async function api(path, opts) {
  const r = await fetch(path, { ...opts, headers: { ...auth(), ...(opts && opts.headers) } });
  if (r.status === 401) { showGate('令牌已失效（可能刚轮换过），请用新二维码重新配对'); throw new Error('unauthorized'); }
  return r;
}
function fetchSessions() {
  api('/api/sessions')
    .then((r) => r.json())
    .then((d) => { state.sessions = d.sessions || []; renderList(); renderMeta(); })
    .catch(() => {});
}

/* ---------------- history (system back = leave detail) ---------------- */
function openDetail(id) {
  state.currentId = id;
  state.atBottom = true;
  state.userCollapsedLive = false;
  $('list').classList.add('hidden');
  $('detail').classList.remove('hidden');
  $('chat').innerHTML = '';
  renderMeta();
  refreshDriver();
  ensureModels(); // context-window lookup for the ring
  sendWs({ type: 'subscribe', id });
  api('/api/sessions/' + encodeURIComponent(id) + '/messages')
    .then((r) => r.json())
    .then((d) => {
      if (state.currentId !== id) return;
      buildTurns(d.events || []);
      renderAllTurns();
      state.atBottom = true;          // entering a session always lands on the latest
      scrollBottom(true);
      updateJumpFab();
    })
    .catch(() => {});
  updateComposer();
  updateQueueBadge();
  updateRunStatus();
  history.pushState({ cr: 'detail' }, '', '#s');
}
function closeDetail() { // via the ← button only
  sendWs({ type: 'unsubscribe' });
  state.currentId = null;
  state.turns = [];
  $('detail').classList.add('hidden');
  $('list').classList.remove('hidden');
}
window.addEventListener('popstate', (e) => {
  // an open bubble absorbs back (close it, stay in the detail view)
  const open = BUBBLES.find((id) => !$(id).classList.contains('hidden'));
  if (open) {
    $(open).classList.add('hidden');
    if (state.currentId) history.pushState({ cr: 'detail' }, '', '#s'); // restore the consumed detail entry
    return;
  }
  // system back inside detail returns to the list
  if (state.currentId) {
    sendWs({ type: 'unsubscribe' });
    state.currentId = null;
    state.turns = [];
    $('detail').classList.add('hidden');
    $('list').classList.remove('hidden');
  }
});

/* ---------------- meta / driver chip ---------------- */
function renderMeta() {
  const s = state.sessions.find((x) => x.id === state.currentId);
  if (!s) return;
  $('d-title').textContent = s.title || s.id.slice(0, 8);
  const bits = [];
  if (s.cwd) bits.push(shortPath(s.cwd));
  if (s.cost && s.cost.usd != null) bits.push('$' + Number(s.cost.usd).toFixed(2));
  $('d-meta').textContent = bits.join(' · ');
  const m = $('c-model-name');
  if (m) renderModelChip();
  updateTokenRing();
  renderDriverChip();
}
function renderDriverChip() {
  const chip = $('d-driver');
  if (!state.currentId) return;
  const run = state.runs[state.currentId];
  if (run && run.state === 'running') { chip.textContent = '手机'; chip.className = 'chip run'; }
  else if (state.driver && state.driver.driver === 'pc') { chip.textContent = '电脑'; chip.className = 'chip pc'; }
  else { chip.textContent = '空闲'; chip.className = 'chip'; }
}
function refreshDriver() {
  if (!state.currentId) return;
  fetch('/api/sessions/' + encodeURIComponent(state.currentId) + '/driver', { headers: auth() })
    .then((r) => r.json())
    .then((d) => { state.driver = d; renderDriverChip(); })
    .catch(() => {});
}

/* ---------------- session list: project groups ---------------- */
function sessState(s) {
  if (s.running || state.runs[s.id]?.state === 'running') return 'running';
  const o = s.lastRun?.state || s.lastOutcome || '';
  if (o === 'failed') return 'failed';
  if (o === 'stopped') return 'stopped';
  return 'idle';
}
const ST_WORD = { running: '运行中', failed: '失败', stopped: '已停止', idle: '' };
const GROUP_RANK = { running: 3, failed: 2, stopped: 2, idle: 1 };

function projectLabel(s) {
  if (s.cwd) return shortPath(s.cwd);
  return s.project || '(未知项目)';
}
function shortPath(p) {
  const parts = String(p).replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}
function groupKey(s) { return s.cwd || s.project || '?'; }

function renderList() {
  const box = $('groups');
  box.innerHTML = '';
  const cc = state.sessions.filter((s) => s.kind === 'cc');
  if (cc.length === 0) {
    box.innerHTML = '<div class="empty">还没有 Claude Code 会话<br>点右上角 ＋ 从手机发起一个任务</div>';
    return;
  }
  const groups = new Map();
  for (const s of cc) {
    const k = groupKey(s);
    if (!groups.has(k)) groups.set(k, { label: projectLabel(s), sessions: [], latest: 0 });
    const g = groups.get(k);
    g.sessions.push(s);
    if (s.lastActive > g.latest) g.latest = s.lastActive;
  }
  const ordered = [...groups.values()].sort((a, b) => b.latest - a.latest);
  for (const g of ordered) {
    g.sessions.sort((a, b) => b.lastActive - a.lastActive);
    box.appendChild(renderGroup(g));
  }
}

function renderGroup(g) {
  const wrap = document.createElement('div');
  wrap.className = 'pgroup' + (state.closedGroups.has(g.label) ? ' closed' : '');

  const states = g.sessions.map(sessState);
  const top = states.reduce((acc, st) => (GROUP_RANK[st] > GROUP_RANK[acc] ? st : acc), 'idle');
  const counts = { running: 0, failed: 0, stopped: 0 };
  for (const st of states) if (counts[st] != null) counts[st]++;

  const head = document.createElement('button');
  head.className = 'pgroup-head';
  head.innerHTML =
    '<span class="lamp" data-st="' + top + '"></span>' +
    '<span class="pgroup-name"></span>' +
    '<span class="tally">' +
      (counts.running ? '<span class="t live"><span class="lamp" data-st="running"></span>' + counts.running + '</span>' : '') +
      (counts.failed ? '<span class="t fail"><span class="lamp" data-st="failed"></span>' + counts.failed + '</span>' : '') +
      (counts.stopped ? '<span class="t hold"><span class="lamp" data-st="stopped"></span>' + counts.stopped + '</span>' : '') +
      '<span class="t">' + g.sessions.length + '</span>' +
    '</span>' +
    '<svg class="chev" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>';
  head.querySelector('.pgroup-name').textContent = g.label;
  head.onclick = () => {
    if (state.closedGroups.has(g.label)) state.closedGroups.delete(g.label);
    else state.closedGroups.add(g.label);
    localStorage.setItem(CLOSED_KEY, JSON.stringify([...state.closedGroups]));
    wrap.classList.toggle('closed');
  };

  const body = document.createElement('div');
  body.className = 'pgroup-body';
  for (const s of g.sessions) body.appendChild(renderRow(s));
  wrap.append(head, body);
  return wrap;
}

function renderRow(s) {
  const st = sessState(s);
  const el = document.createElement('div');
  el.className = 'srow';
  el.innerHTML =
    '<span class="lamp" data-st="' + st + '"></span>' +
    '<div class="srow-main">' +
      '<div class="srow-title"></div>' +
      '<div class="srow-sub"><span class="st-word" data-st="' + st + '">' + ST_WORD[st] + '</span><span class="srow-info"></span></div>' +
    '</div>' +
    '<svg class="srow-go" viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M9 6l6 6-6 6"/></svg>';
  el.querySelector('.srow-title').textContent = s.title || s.id.slice(0, 8);
  const info = [relTime(s.lastActive), (s.lines || 0) + ' 行'];
  if (s.cost && s.cost.usd != null) info.push('$' + Number(s.cost.usd).toFixed(2));
  el.querySelector('.srow-info').textContent = info.join(' · ');
  el.onclick = () => openDetail(s.id);
  return el;
}

/* ---------------- transcript: turn model ---------------- */
function sessionLive(id) {
  if (state.runs[id]?.state === 'running') return true;
  const s = state.sessions.find((x) => x.id === id);
  return !!(s && s.status === 'active' && Date.now() - s.lastActive < 180_000);
}

// events -> turns. A user event closes the pending bot turn and starts a new
// user turn; assistant parts accumulate into the following bot turn.
function buildTurns(events) {
  state.turns = [];
  state.liveTurnOpen = false;
  for (const ev of events) applyEventToTurns(ev);
  markLiveTurn();
}
function applyEventToTurns(ev) {
  const T = state.turns;
  if (ev.k === 'user') {
    state.userCollapsedLive = false; // a new question re-opens the next live turn
    T.push({ role: 'user', text: ev.text, ts: ev.ts });
    T.push({ role: 'bot', think: [], tools: [], texts: [], ts: '' });
  } else if (ev.k === 'assistant') {
    if (T.length === 0 || T[T.length - 1].role !== 'bot') T.push({ role: 'bot', think: [], tools: [], texts: [], ts: ev.ts });
    const turn = T[T.length - 1];
    turn.ts = turn.ts || ev.ts;
    for (const p of ev.parts || []) {
      if (p.t === 'think') turn.think.push(p.v);
      else if (p.t === 'tool') turn.tools.push({ name: p.name, v: p.v });
      else if (p.t === 'text' && p.v && p.v.trim()) turn.texts.push(p.v);
    }
  } else if (ev.k === 'stats') {
    T.push({ role: 'sys', text: '成本 $' + (ev.stats.usd != null ? Number(ev.stats.usd).toFixed(2) : '?') +
      ' · in ' + (ev.stats.inTok ?? '?') + ' / out ' + (ev.stats.outTok ?? '?') + ' tok' });
  } else if (ev.k === 'title') { /* meta only */ }
}
function markLiveTurn() {
  // the trailing bot turn is "live" when its session is streaming
  state.liveTurnOpen = false;
  if (state.currentId && sessionLive(state.currentId) && state.turns.length) {
    const last = state.turns[state.turns.length - 1];
    if (last.role === 'bot' && (last.think.length || last.tools.length || last.texts.length)) {
      state.liveTurnOpen = true;
    }
  }
}
function closeLiveTurn() { state.liveTurnOpen = false; state.userCollapsedLive = false; }

/* ---------------- transcript: DOM rendering ---------------- */
// apply height caps only where content actually overflows: a permanently-on
// max-height+overflow+overscroll-contain turns short expanded panels into
// gesture dead zones on touch devices (nothing to scroll inside, chaining cut)
function markCapped(root) {
  requestAnimationFrame(() => {
    const cap = Math.floor(window.innerHeight * 0.34) + 8;
    (root || $('chat')).querySelectorAll('.tool-chip:not(.capped), .think:not(.capped)').forEach((el) => {
      if (el.scrollHeight > cap) el.classList.add('capped');
    });
  });
}

function renderAllTurns() {
  const chat = $('chat');
  chat.innerHTML = '';
  if (state.turns.length === 0) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = '还没有对话内容';
    chat.appendChild(d);
    return;
  }
  for (const t of state.turns) chat.appendChild(renderTurn(t));
  markCapped();
  armCodeCopy();
}
/* ---------------- transcript DOM: timeline turns ---------------- */
const CHEV_S = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';
const CHEV_B = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
const ICO_CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m8.5 12.5 2.5 2.5 5-5.5"/></svg>';
const ICO_CLOCK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>';
const DOTS = {
  think: '<span class="dot-hollow"></span>',
  tool: '<span class="dot-tool"></span>',
  mid: '<span class="dot-mid"></span>',
  final: '<span class="dot-final">' + ICO_CHECK + '</span>',
};

function appendCaret(el) {
  const c = document.createElement('span');
  c.className = 'caret';
  el.appendChild(c);
}
function addTs(el, iso) {
  const t = fmtTs(iso);
  if (!t) return;
  const s = document.createElement('span');
  s.className = 'ts';
  s.textContent = t;
  el.appendChild(s);
}

// timeline node: kind = think|tool|mid|final (mid/final not foldable)
function nodeEl(kind, head, bodyBuilder, open) {
  const plain = kind === 'mid' || kind === 'final';
  const node = document.createElement('div');
  node.className = 'node' + (plain ? ' plain' : '') + (!plain && open ? ' open' : '');
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.innerHTML = DOTS[kind];
  const h = document.createElement(plain ? 'div' : 'button');
  h.className = 'node-head';
  h.innerHTML = '<span class="badge"></span>' +
    (head.meta ? '<span class="dur"></span>' : '') +
    (head.link ? '<span class="lnk"></span>' : '') +
    (head.diff ? '<span class="diffbadge"><span class="add"></span><span class="del"></span></span>' : '') +
    (plain ? '' : '<span class="chev">' + CHEV_S + '</span>');
  h.querySelector('.badge').textContent = head.badge;
  if (head.meta) h.querySelector('.dur').textContent = '· ' + head.meta;
  if (head.link) h.querySelector('.lnk').textContent = head.link;
  if (head.diff) {
    h.querySelector('.diffbadge .add').textContent = head.diff.add;
    h.querySelector('.diffbadge .del').textContent = head.diff.del;
  }
  node.append(dot, h);
  if (bodyBuilder) {
    const body = document.createElement('div');
    body.className = 'node-body';
    bodyBuilder(body);
    node.appendChild(body);
  }
  if (!plain) h.onclick = () => {
    node.classList.toggle('open');
    markCapped(node); // hidden bodies never got measured at render time
  };
  return node;
}

// extract a short path/command label for a tool's head line
function toolLink(t) {
  let input = null;
  try { input = JSON.parse(t.v); } catch { return ''; }
  if (!input || typeof input !== 'object') return '';
  const p = input.file_path || input.path || input.pattern || input.notebook_path;
  if (typeof p === 'string' && p) return p;
  const cmd = input.command || input.cmd;
  if (typeof cmd === 'string' && cmd) return cmd.split('\n')[0].slice(0, 42);
  return '';
}
// Edit/Write: line delta badge from old_string/new_string lengths
function toolDiff(t) {
  let input = null;
  try { input = JSON.parse(t.v); } catch { return null; }
  if (!input || typeof input !== 'object') return null;
  if (typeof input.new_string === 'string' || typeof input.content === 'string') {
    const add = (input.new_string || input.content || '').split('\n').length;
    const del = typeof input.old_string === 'string' ? input.old_string.split('\n').length : 0;
    return { add: '+' + add, del: '−' + del };
  }
  return null;
}

function renderTurn(t) {
  if (t.role === 'sys') {
    const d = document.createElement('div');
    d.className = 'sysline';
    d.textContent = t.text;
    return d;
  }
  if (t.role === 'user') {
    const d = document.createElement('div');
    d.className = 'bubble user';
    d.textContent = t.text;
    if (t.ts) addTs(d, t.ts);
    return d;
  }
  // bot turn: trigger pill + timeline(思考/工具/修改/输出/结论) + final card.
  // final conclusion is NEVER folded away: expanded turns end with a 结论
  // node, collapsed turns keep the final-card below the pill.
  const wrap = document.createElement('div');
  const live = state.liveTurnOpen && t === state.turns[state.turns.length - 1];
  const concl = t.texts.length ? t.texts[t.texts.length - 1] : '';
  const mids = t.texts.slice(0, -1);
  const steps = t.think.length + t.tools.length + mids.length;
  // a live turn opens by default UNLESS the user folded it by hand (streaming
  // re-renders must not force it back open every append)
  const liveOpen = live && !state.userCollapsedLive;
  wrap.className = 'turn bot ' + (live ? (liveOpen ? 'live open' : 'live') : 'done');

  if (steps > 0) {
    const trig = document.createElement('button');
    trig.className = 'trigger';
    trig.innerHTML = '<span class="ic">' + (live ? ICO_CLOCK : ICO_CHECK) + '</span>' +
      '<span class="t">过程</span><span class="n">· ' + steps + ' 步</span>' +
      '<span class="chev">' + CHEV_B + '</span>';
    trig.onclick = () => {
      wrap.classList.toggle('open');
      if (live) state.userCollapsedLive = !wrap.classList.contains('open');
      markCapped(wrap); // bodies were display:none while collapsed (scrollHeight 0) - remeasure now
    };
    wrap.appendChild(trig);

    const tl = document.createElement('div');
    tl.className = 'timeline';
    for (const th of t.think) {
      tl.appendChild(nodeEl('think', { badge: '思考' }, (b) => {
        const d = document.createElement('div');
        d.className = 'think';
        d.textContent = th;
        b.appendChild(d);
      }, live));
    }
    for (const tool of t.tools) {
      const isEdit = tool.name === 'Edit' || tool.name === 'Write' || tool.name === 'MultiEdit';
      const diff = isEdit ? toolDiff(tool) : null;
      tl.appendChild(nodeEl('tool', {
        badge: isEdit ? '修改' : '工具',
        meta: tool.name,
        link: toolLink(tool),
        diff,
      }, (b) => {
        const c = document.createElement('div');
        c.className = 'tool-chip';
        const p = document.createElement('span');
        p.className = 'p';
        p.textContent = '⚙ ';
        c.appendChild(p);
        c.appendChild(document.createTextNode(tool.name + ' ' + (tool.v || '')));
        b.appendChild(c);
      }, live));
    }
    for (const m of mids) {
      tl.appendChild(nodeEl('mid', { badge: '输出' }, (b) => {
        const d = document.createElement('div');
        d.className = 'mid';
        d.textContent = m;
        b.appendChild(d);
      }));
    }
    if (concl && !live) {
      tl.appendChild(nodeEl('final', { badge: '结论' }, (b) => {
        const d = document.createElement('div');
        d.className = 'final';
        d.innerHTML = miniMd(concl);
        b.appendChild(d);
      }));
    }
    wrap.appendChild(tl);
  }
  if (concl || (live && steps === 0)) {
    const b = document.createElement('div');
    b.className = 'final-card';
    if (concl) b.innerHTML = miniMd(concl);
    if (live) appendCaret(b);
    if (t.ts) addTs(b, t.ts);
    wrap.appendChild(b);
  }
  return wrap;
}

function fmtTs(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

// re-render the tail of the transcript. Invariant: chat children map 1:1 to
// state.turns. New events either mutate the trailing turn (g=0) or append
// turns after it (user event: g=2); in both cases re-rendering from the
// previously-trailing turn (index prevLen-1) keeps the mapping aligned.
// Removing more than that desyncs children vs turns and forces a full
// rebuild on the next append (which collapses scrollHeight mid-frame and
// yanks the scroll position).
function renderTail(prevLen) {
  const chat = $('chat');
  const rendered = chat.childNodes.length;
  if (state.turns.length < rendered) { renderAllTurns(); return; }
  const start = Math.max(0, prevLen - 1);
  while (chat.childNodes.length > start) chat.removeChild(chat.lastChild);
  for (let i = start; i < state.turns.length; i++) chat.appendChild(renderTurn(state.turns[i]));
  markCapped();
  armCodeCopy();
}

/* tiny safe markdown: escape first, then fences / inline code / bold */
function miniMd(s) {
  const esc = String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const parts = esc.split('```');
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const nl = parts[i].indexOf('\n');
      const body = nl >= 0 ? parts[i].slice(nl + 1) : parts[i];
      out += '<pre><code>' + body + '</code></pre>';
    } else {
      out += parts[i]
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
        .replace(/\n/g, '<br>');
    }
  }
  return out;
}

/* delegate copy clicks for <pre><code> blocks (works for re-rendered nodes) */
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.copy-btn');
  if (!btn) return;
  const code = btn.parentElement && btn.parentElement.querySelector('code');  if (!code) return;
  copyText(code.textContent, btn);
});
function copyText(text, btn) {
  const done = () => {
    if (!btn) return;
    btn.classList.add('ok');
    const c = btn.querySelector('.i-copy'), o = btn.querySelector('.i-ok');
    if (c && o) { c.style.display = 'none'; o.style.display = 'block'; }
    setTimeout(() => {
      btn.classList.remove('ok');
      if (c && o) { c.style.display = 'block'; o.style.display = 'none'; }
    }, 1600);
  };
  const fallback = () => {
    // execCommand path (embedded contexts / denied clipboard)
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      document.execCommand('copy');
      ta.remove();
      done();
    } catch (e2) { /* last resort: nothing to do */ }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    Promise.race([
      navigator.clipboard.writeText(text).then(() => true, () => false),
      new Promise((r) => setTimeout(() => r(false), 1200)),
    ]).then((ok) => (ok ? done() : fallback()));
  } else fallback();
}
// add copy buttons to every code fence inside a container (call after renders).
// the pre gets wrapped in .codeblock so the button stays pinned to the frame
// while the code scrolls beneath it.
function armCodeCopy(root) {
  (root || $('chat')).querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector('.copy-btn') || !pre.querySelector('code')) return;
    const wrap = document.createElement('div');
    wrap.className = 'codeblock';
    pre.replaceWith(wrap);
    wrap.appendChild(pre);
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.type = 'button';
    btn.title = '复制代码';
    btn.innerHTML = '<svg class="i-copy" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>' +
      '<svg class="i-ok" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="display:none"><path d="m5 12.5 4.5 4.5L19 7"/></svg>';
    wrap.appendChild(btn);
  });
}

/* ---------------- scrolling ---------------- */
function updateJumpFab() {
  const chat = $('chat');
  const overflow = chat.scrollHeight > chat.clientHeight + 40;
  $('jump').classList.toggle('hidden', !(overflow && !state.atBottom));
}
// scroll events arrive asynchronously after content growth; re-check on the
// next frame so atBottom reflects the post-growth geometry
function scrollBottom(force) {
  const chat = $('chat');
  if (force || state.atBottom) {
    chat.scrollTop = chat.scrollHeight;
    requestAnimationFrame(() => { if (state.atBottom) chat.scrollTop = chat.scrollHeight; });
  }
}

/* ---------------- permission mode & approval cards ---------------- */
function setPerm(v) {
  state.perm = v;
  localStorage.setItem('cr_perm', v);
  const label = $('perm-label');
  if (label) label.textContent = v === 'ask' ? '审批' : '自动';
  const btn = $('perm');
  if (btn) { btn.dataset.v = v; btn.title = v === 'ask' ? '需要时手机审批（点击切换）' : '自动执行（点击切换）'; }
}
function togglePerm() { setPerm(state.perm === 'ask' ? 'auto' : 'ask'); }

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

/* ---------------- run status line / queue badge / token ring ---------------- */
function lastLiveToolName() {
  for (let i = state.turns.length - 1; i >= 0; i--) {
    const t = state.turns[i];
    if (t.role !== 'bot') break;
    if (t.tools.length) return t.tools[t.tools.length - 1].name;
  }
  return '';
}
function updateRunStatus() {
  const el = $('run-status');
  if (!state.currentId) { el.classList.add('hidden'); return; }
  const rec = state.sessions.find((x) => x.id === state.currentId);
  const run = state.runs[state.currentId];
  const running = (run && run.state === 'running') || (rec && rec.running);
  if (!running) { el.classList.add('hidden'); return; }
  let s;
  if (run && run.state === 'running' && run.startedAt) {
    const sec = Math.max(0, Math.floor((Date.now() - run.startedAt) / 1000));
    const mm = Math.floor(sec / 60), ss = sec % 60;
    s = '已运行 ' + (mm > 0 ? mm + ' 分 ' : '') + String(ss).padStart(2, '0') + ' 秒';
  } else {
    s = '转录更新中';
  }
  const tool = lastLiveToolName();
  $('run-status-text').textContent = s + (tool ? ' · 正在调用 ' + tool : '');
  el.classList.remove('hidden');
}
function updateQueueBadge() {
  const rec = state.sessions.find((x) => x.id === state.currentId);
  const n = rec ? (rec.queued || 0) : 0;
  $('queue-n').textContent = n;
  $('queue-badge').classList.toggle('hidden', n === 0);
}
function fmtTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
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
  const cur = localStorage.getItem('cr_model') || '';
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
function currentModel() {
  return localStorage.getItem('cr_model') || '';
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

/* ---------- bubble popups (v15 E): anchored above the dock ---------- */
const BUBBLES = ['ctx-sheet', 'model-sheet', 'perm-sheet', 'effort-sheet'];
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

/* ---------- effort picker (--effort low|medium|high|xhigh|max) ---------- */
const EFFORTS = [
  { v: '', label: '默认', sub: '跟随会话 / CLI 配置' },
  { v: 'low', label: '低', sub: 'low · 快速直接，几乎不深想' },
  { v: 'medium', label: '中', sub: 'medium · 常规任务平衡之选' },
  { v: 'high', label: '高', sub: 'high · 更彻底的推理' },
  { v: 'xhigh', label: '超高', sub: 'xhigh · 复杂任务' },
  { v: 'max', label: '最高', sub: 'max · 最难任务，可能显著变慢' },
];
function currentEffort() { return localStorage.getItem('cr_effort') || ''; }
function openEffortSheet() {
  const box = $('effort-list');
  const cur = currentEffort();
  box.innerHTML = '';
  for (const f of EFFORTS) {
    const el = document.createElement('button');
    el.className = 'opt' + (cur === f.v ? ' active' : '');
    el.innerHTML = '<span class="o-main"><span class="o-label"></span><span class="o-sub"></span></span>'
      + '<svg class="o-check" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';
    el.querySelector('.o-label').textContent = f.label;
    el.querySelector('.o-sub').textContent = f.sub;
    el.onclick = () => {
      if (cur === f.v) localStorage.removeItem('cr_effort');
      else localStorage.setItem('cr_effort', f.v);
      renderEffortChip();
      closeBubble('effort-sheet');
    };
    box.appendChild(el);
  }
  openBubble('effort-sheet');
}
function renderEffortChip() {
  const el = $('c-effort-name');
  if (!el) return;
  const v = currentEffort();
  el.textContent = v ? (EFFORTS.find((f) => f.v === v) || {}).label || v : '默认';
}

/* ---------- permission picker (bubble instead of direct toggle) ---------- */
function openPermSheet() {
  const box = $('perm-list');
  box.innerHTML = '';
  const opts = [
    { v: 'auto', label: '自动执行', sub: 'YOLO · 工具免审批' },
    { v: 'ask', label: '需要时手机审批', sub: '弹卡确认后继续' },
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
setInterval(() => { if (state.currentId) updateRunStatus(); }, 1000);

/* ---------------- composer ---------------- */
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
  $('send').classList.toggle('hidden', running);
  $('stop').classList.toggle('hidden', !running);
  // input stays usable while running: sends are queued server-side
  renderDriverChip();
}
function sendMessage(force) {
  const input = $('msg-input');
  const text = input.value.trim();
  if (!text || !state.currentId) return;
  api('/api/sessions/' + encodeURIComponent(state.currentId) + '/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, force: !!force, perm: state.perm, model: currentModel(), effort: currentEffort() }),
  })
    .then(async (r) => {
      if (r.status === 409) {
        const j = await r.json().catch(() => ({}));
        if (j.error === 'recent-local-write') {
          const ago = j.sinceMs != null ? Math.round(j.sinceMs / 1000) + ' 秒' : '刚刚';
          if (window.confirm('电脑端 ' + ago + '前刚在写这个会话，可能正在使用（电脑窗口需重开才能看到手机的新消息）。仍然发送？')) sendMessage(true);
          return;
        }
        if (j.error === 'pc-claim') {
          if (window.confirm('电脑端已接管此会话（cr attach）。切换为手机驱动并发送？')) sendMessage(true);
          return;
        }
        if (j.error === 'busy') { toast('本会话已有消息在运行，等它结束或点停止'); return; }
      }
      if (!r.ok) { toast('发送失败（' + r.status + '）'); return; }
      const j = await r.json().catch(() => ({}));
      if (j.queued) toast('已排队（第 ' + j.position + ' 条）· 本轮结束后自动发出');
      input.value = '';
      state.atBottom = true;
    })
    .catch(() => toast('网络错误'));
}
function stopRun() {
  const run = state.currentId && state.runs[state.currentId];
  if (!run || !run.runId) return;
  fetch('/api/runs/' + encodeURIComponent(run.runId) + '/cancel', { method: 'POST', headers: auth() })
    .then(() => toast('已发送停止信号'))
    .catch(() => {});
}

/* ---------------- toast ---------------- */
let toastTimer = null;
function toast(text) {
  let el = $('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.style.cssText = 'position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:30;' +
      'background:var(--panel2);border:1px solid var(--line);border-radius:999px;padding:8px 18px;' +
      'font-size:13px;color:var(--fg);max-width:86vw;box-shadow:0 6px 20px rgba(0,0,0,.5)';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, 2600);
}

/* ---------------- delete ---------------- */
function deleteSession() {
  const id = state.currentId;
  if (!id) return;
  if (!window.confirm('删除该会话？转录移入电脑回收站，可找回。')) return;
  fetch('/api/sessions/' + encodeURIComponent(id), { method: 'DELETE', headers: auth() })
    .then((r) => r.json())
    .then((j) => {
      if (!j.ok) { toast('删除失败：' + (j.error || '')); return; }
      state.currentId = null;
      $('detail').classList.add('hidden');
      $('list').classList.remove('hidden');
      if (history.state && history.state.cr) history.back();
    })
    .catch(() => toast('网络错误'));
}

/* ---------------- new session ---------------- */
function openNewModal() {
  const sel = $('new-cwd');
  sel.innerHTML = '';
  const seen = new Set();
  const opts = [];
  for (const s of state.sessions) {
    if (s.kind !== 'cc' || !s.cwd || seen.has(s.cwd)) continue;
    seen.add(s.cwd);
    opts.push(s.cwd);
  }
  if (opts.length === 0) {
    sel.innerHTML = '<option value="">（暂无已知项目，手动输入路径）</option>';
  } else {
    for (const c of opts) {
      const o = document.createElement('option');
      o.value = c;
      o.textContent = shortPath(c) + '  —  ' + c;
      sel.appendChild(o);
    }
  }
  $('new-cwd-custom').value = '';
  $('new-text').value = '';
  $('new-err').textContent = '';
  document.querySelectorAll('#new-perm .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.v === state.perm);
  });
  $('new-modal').classList.remove('hidden');
  $('new-text').focus();
}
function submitNewSession() {
  const text = $('new-text').value.trim();
  if (!text) { $('new-err').textContent = '任务内容不能为空'; return; }
  const custom = $('new-cwd-custom').value.trim();
  const cwd = custom || $('new-cwd').value || '';
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
    })
    .catch(() => { $('new-err').textContent = '网络错误'; });
}

/* ---------------- websocket ---------------- */
function auth() { return { Authorization: 'Bearer ' + state.token }; }
function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return proto + '://' + location.host + '/ws?token=' + encodeURIComponent(state.token);
}
function connectWs() {
  if (state.ws) { try { state.ws.close(); } catch (e) { /* noop */ } }
  const ws = new WebSocket(wsUrl());
  state.ws = ws;
  ws.onopen = () => {
    state.wsRetry = 1000;
    $('conn-dot').className = 'brand-lamp on';
    if (state.currentId) sendWs({ type: 'subscribe', id: state.currentId });
    fetchPendingApprovals(); // catch cards missed while disconnected
  };
  ws.onmessage = (m) => {
    let d; try { d = JSON.parse(m.data); } catch { return; }
    if (d.type === 'sessions') {
      state.sessions = d.sessions || [];
      renderList();
      renderMeta();
      updateQueueBadge();
      updateTokenRing();
      updateRunStatus();
      // liveness flip via session status (e.g. bridge saw the idle broadcast):
      // close the live turn without waiting for the next append
      if (state.currentId && state.liveTurnOpen && !sessionLive(state.currentId)) {
        closeLiveTurn();
        renderTail(state.turns.length);
      }
    } else if (d.type === 'append') {
      handleAppend(d);
    } else if (d.type === 'queue-dispatched') {
      if (d.sessionId === state.currentId) toast('排队消息已自动发出');
    } else if (d.type === 'run') {
      handleRunFrame(d);
    } else if (d.type === 'approval') {
      queueApproval(d);
    } else if (d.type === 'approval-result') {
      // a decision landed (this client or another); drop it if still queued
      state.approvals = state.approvals.filter((a) => a.id !== d.id);
      showApproval();
    } else if (d.type === 'notify') {
      toast('[' + (d.title || '').slice(0, 20) + '] ' + (d.event === 'stop' ? '已完成' : d.event));
    }
  };
  ws.onclose = () => {
    $('conn-dot').className = 'brand-lamp off';
    clearTimeout(state.wsTimer);
    state.wsTimer = setTimeout(connectWs, state.wsRetry);
    state.wsRetry = Math.min(state.wsRetry * 2, 8000);
  };
  ws.onerror = () => { try { ws.close(); } catch (e) { /* noop */ } };
}
function sendWs(obj) { if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(obj)); }

function handleAppend(d) {
  if (d.id !== state.currentId) return;
  const prevLen = state.turns.length;
  for (const ev of d.events || []) applyEventToTurns(ev);
  // a stop marker means the turn ENDED (any driver): close the live view so
  // the finished turn re-renders collapsed
  if ((d.events || []).some((e) => e.k === 'stop')) {
    state.liveTurnOpen = false;
    state.userCollapsedLive = false;
  } else {
    markLiveTurn();
  }
  renderTail(prevLen);
  scrollBottom();
  updateJumpFab();
  updateRunStatus(); // tool name may have advanced
}
function handleRunFrame(d) {
  if (!d.sessionId) {
    // spawn-level failure (bad cwd, CLI missing): no session will ever appear
    if (state.pendingNew === d.runId && (d.state === 'error' || d.state === 'end')) {
      state.pendingNew = null;
      toast('任务没启动起来：' + (d.stderrTail || d.error || '查看工作目录是否正确').slice(0, 80));
    }
    return;
  }
  state.runs[d.sessionId] = { runId: d.runId, state: d.state, startedAt: d.startedAt };
  if (d.sessionId === state.currentId) {
    updateComposer();
    updateRunStatus();
    if (d.state === 'end' || d.state === 'error') {
      closeLiveTurn();
      if (d.stderrTail) toast('运行异常，详见会话');
      // collapse the finished turn's machine zone in place
      const chat = $('chat');
      const T = state.turns;
      if (T.length && T[T.length - 1].role === 'bot' && chat.lastChild) {
        chat.replaceChild(renderTurn(T[T.length - 1]), chat.lastChild);
        markCapped();
      }
      if ((d.state === 'error' || (d.exitCode != null && d.exitCode !== 0 && d.exitCode !== 'cancelled'))) {
        const text = d.state === 'error'
          ? '— 运行出错：' + (d.error || '') + ' —'
          : '— 已结束，退出码 ' + d.exitCode + ' —';
        const line = document.createElement('div');
        line.className = 'sysline';
        line.textContent = text;
        chat.appendChild(line);
        state.turns.push({ role: 'sys', text });
      }
      scrollBottom();
      refreshDriver();
    }
  }
  if (state.pendingNew === d.runId && d.state === 'running') {
    state.pendingNew = null;
    if (state.currentId !== d.sessionId) openDetail(d.sessionId);
  }
}

/* ---------------- utils ---------------- */
function relTime(ms) {
  if (!ms) return '';
  const dt = Date.now() - ms;
  if (dt < 60e3) return '刚刚';
  if (dt < 3600e3) return Math.floor(dt / 60e3) + ' 分钟前';
  if (dt < 86400e3) return Math.floor(dt / 3600e3) + ' 小时前';
  return new Date(ms).toLocaleDateString();
}

/* ---------------- boot & wiring ---------------- */
$('token-save').onclick = saveToken;
$('token-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveToken(); });
$('back').onclick = () => {
  if (history.state && history.state.cr === 'detail') history.back();
  else closeDetail();
};
$('del').onclick = deleteSession;
$('send').onclick = () => sendMessage(false);
$('stop').onclick = stopRun;
$('perm').onclick = openPermSheet;
$('c-effort').onclick = openEffortSheet;
renderEffortChip();
$('ap-allow').onclick = () => respondApproval('allow');
$('ap-deny').onclick = () => respondApproval('deny');
document.querySelectorAll('#new-perm .seg-btn').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('#new-perm .seg-btn').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    setPerm(b.dataset.v);
  };
});
setPerm(state.perm);
$('new-session').onclick = openNewModal;
$('new-go').onclick = submitNewSession;
$('new-cancel').onclick = () => $('new-modal').classList.add('hidden');
$('jump').onclick = () => { state.atBottom = true; scrollBottom(true); updateJumpFab(); };
$('msg-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !IS_TOUCH) { e.preventDefault(); sendMessage(false); }
});
$('token-ring').onclick = openContextSheet;
$('c-model').onclick = openModelSheet;
$('queue-badge').onclick = () => {
  if (!state.currentId) return;
  if (window.confirm('取消所有排队的消息？')) {
    api('/api/sessions/' + encodeURIComponent(state.currentId) + '/queue', { method: 'DELETE' })
      .then(() => toast('已取消排队'))
      .catch(() => {});
  }
};
$('msg-input').addEventListener('input', autoGrow);
$('new-text').addEventListener('input', function () {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, window.innerHeight * 0.3) + 'px';
});
$('chat').addEventListener('scroll', () => {
  const el = $('chat');
  state.atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  updateJumpFab();
});
window.addEventListener('resize', updateJumpFab);

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

(async function boot() {
  // auto-pairing: ?token=... (QR); saved then stripped from the URL
  const q = new URLSearchParams(location.search).get('token');
  const openId = location.hash.startsWith('#open=') ? location.hash.slice(6) : null;
  if (q && await tryToken(q)) {
    state.token = q;
    localStorage.setItem('cr_token', q);
    history.replaceState(null, '', location.pathname);
    enterApp();
    if (openId) openDetail(openId);
    return;
  }
  if (state.token && await tryToken(state.token)) {
    enterApp();
    if (openId) openDetail(openId);
  } else {
    $('gate').classList.remove('hidden');
    $('token-input').focus();
  }
})();
