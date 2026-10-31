// js/views/transcript.js - the fragile core of the detail view: transcript
// turn model (events -> turns), timeline DOM rendering, renderTail's 1:1
// chat-children/turns invariant, dynamic height caps, scrolling and the
// optimistic user bubble. Scroll laws and markCapped rules live HERE -
// read the PWA 硬约束 section of CLAUDE.md before touching anything.

import { $, fmtTs } from '../util.js';
import { state } from '../state.js';
import { miniMd, linkifyPaths, linkifyDom } from '../md.js';
import { openLightbox, previewArtifact, openHtmlPreview } from './overlays.js';
// v112 function-level cycle (same pattern as composer<->detail): the agent
// live-line/chip open the bubble; agentview imports the node renderers back.
// Zero cross-calls at module-evaluation time.
import { openAgentView } from './agentview.js';

/* ---------------- turn model ---------------- */
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
  let stopped = false;
  for (const ev of events) {
    // track whether the replay ends past a stop marker: a trailing stop means
    // the last run FINISHED (any driver) - the last turn must render done,
    // not live, even while the session is still freshness-"active"
    if (ev.k === 'user') stopped = false;
    else if (ev.k === 'stop') stopped = true;
    applyEventToTurns(ev);
  }
  if (!stopped) markLiveTurn();
}
function applyEventToTurns(ev) {
  const T = state.turns;
  if (ev.k === 'user') {
    state.userCollapsedLive = false; // a new question re-opens the next live turn
    // queued-dispatch marker (v37): queued sends stay OFF screen until the
    // dispatch really writes them, so their user event has no optimistic
    // twin - a same-text elder must not swallow it as a "replay". Consumed
    // on the first user event; a double-fired second copy then hits the
    // normal no-op below (the fresh bubble matches), so dedup survives.
    const queuedDispatch = state.expectQueuedUser === true;
    state.expectQueuedUser = false;
    // fold into a matching recent user turn: an unconfirmed optimistic one
    // (sent this session, transcript not written yet) gets confirmed in place;
    // an already-confirmed match is either a re-delivered duplicate line or a
    // GENUINE repeated question - same text alone cannot tell them apart.
    // v75: timestamps decide. A double-fire re-delivers the SAME transcript
    // line (ev.ts <= t.ts) -> replay no-op; a repeat question is a LATER line
    // (ev.ts > t.ts) -> push fresh (identical questions used to swallow the
    // 2nd/3rd bubble whole). Structure is only the fallback when a side has
    // no ts: replay merely while the bot turn after the elder is still empty.
    for (let i = T.length - 1; i >= Math.max(0, T.length - 12); i--) {
      const t = T[i];
      if (t.role !== 'user') continue;
      if (t.text !== ev.text) continue;
      if (!t.optimistic) {
        const tsKnown = !!(ev.ts && t.ts);
        if (queuedDispatch) continue; // not this event's twin - keep it, push fresh
        if (tsKnown && ev.ts > t.ts) continue; // a later line: genuine repeat
        if (tsKnown) return i; // same/older line re-delivered: replay
        const next = T[i + 1];
        const movedOn = !!(next && ((next.steps && next.steps.length) || (next.texts && next.texts.length) || (next.think && next.think.length)));
        if (movedOn) continue; // conversation passed the elder: new question
        return i; // replay: already on screen, nothing to do
      }
      t.optimistic = false;
      t.ts = ev.ts || t.ts;
      if (ev.images && ev.images.length) t.images = ev.images;
      return i; // edited an earlier turn: caller must re-render from here
    }
    T.push({ role: 'user', text: ev.text, ts: ev.ts, images: ev.images || null });
    // startTs = the question's timestamp: the process capsule's elapsed counts
    // from the question, not the first assistant line (CLI startup excluded)
    T.push({ role: 'bot', think: [], tools: [], texts: [], steps: [], ts: '', startTs: ev.ts || '' });
  } else if (ev.k === 'assistant') {
    if (T.length === 0 || T[T.length - 1].role !== 'bot') {
      const prev = T[T.length - 1];
      T.push(newBotTurn(ev.ts, prev && prev.role === 'user' ? (prev.ts || ev.ts) : ev.ts));
    }
    const turn = T[T.length - 1];
    turn.ts = turn.ts || ev.ts;
    if (ev.ts) turn.endTs = ev.ts;
    for (const p of ev.parts || []) addAssistantPart(turn, p);
  } else if (ev.k === 'toolres') {
    // tool results arrive as later user lines; pair each back to its tool_use
    // step by id (search recent bot turns from the tail)
    const i = pairToolResults(T, ev, state.orphanToolRes); // re-render from this turn so the output shows up
    if (i != null && T[i] && T[i].role === 'bot' && ev.ts) T[i].endTs = ev.ts;
    return i;
  } else if (ev.k === 'cmdout') {
    // v111: the executed command's stdout - its own right-aligned panel right
    // under the command bubble (never merges into a bot turn)
    T.push({ role: 'cmdout', text: ev.text, ts: ev.ts });
  } else if (ev.k === 'compact' || ev.k === 'skill') {
    // v145: cost-state snapshots (k:'stats') no longer render a timeline
    // row - the user ruling killed the "成本 $x · in/out tok" reminder; the
    // number lives on in the header entry / cost panel via the sessions
    // frame, so this display removal loses nothing.
    const mk = sysMarkerTurn(ev);
    if (mk) T.push(mk);
  } else if (ev.k === 'title') { /* meta only */ }
}
// shared turn-shape builders (v44): the history paginator replays older
// events into a SEPARATE array - same shapes, but no optimistic fold and no
// live-state flag writes, which is why it cannot call applyEventToTurns.
function newBotTurn(ts, startTs) { return { role: 'bot', think: [], tools: [], texts: [], steps: [], ts: ts || '', startTs: startTs || '' }; }
function addAssistantPart(turn, p) {
  if (p.t === 'think') { turn.think.push(p.v); turn.steps.push({ t: 'think', v: p.v }); }
  else if (p.t === 'tool') {
    const tool = { name: p.name, id: p.id || '', v: p.v, out: null };
    if (p.f) tool.f = p.f; // v145: bridge-side changed-file delta for the rollup
    turn.tools.push(tool);
    turn.steps.push({ t: 'tool', tool });
  }
  else if (p.t === 'text' && p.v && p.v.trim()) { turn.texts.push(p.v); turn.steps.push({ t: 'text', v: p.v }); }
}
// v46: per-item pairing + an optional sink for orphans - a toolres whose
// tool_use lives in an OLDER page (the pagination split fell between a
// tool_use and its result) is parked in state.orphanToolRes and drained when
// that page is prepended. Per-item search also fixes the old semantics where
// one paired item stopped the loop and stranded its siblings.
function pairToolResults(T, ev, sink) {
  let touched = null;
  const find = (id) => {
    for (let ti = T.length - 1; ti >= Math.max(0, T.length - 3); ti--) {
      const turn = T[ti];
      if (turn.role !== 'bot' || !turn.steps) continue;
      const step = turn.steps.find((s) => s.t === 'tool' && s.tool.id === id && !s.tool.out);
      if (step) return { turn, step, ti };
    }
    return null;
  };
  for (const it of ev.items || []) {
    const hit = find(it.id);
    if (!hit) {
      if (sink && sink.size < 1000) sink.set(it.id, it);
      continue;
    }
    hit.step.tool.out = { text: it.text || '', err: !!it.err, images: it.images || [] };
    const bkt = hit.turn.tools.find((x) => x === hit.step.tool);
    if (bkt) bkt.out = hit.step.tool.out;
    touched = hit.ti;
  }
  return touched;
}
// pair parked tool_results into freshly loaded turns (call after prepend)
function drainOrphanRes(turns) {
  const sink = state.orphanToolRes;
  if (!sink || !sink.size) return;
  for (const t of turns) {
    if (t.role !== 'bot') continue;
    for (const s of t.steps || []) {
      if (s.t !== 'tool' || s.tool.out || !s.tool.id) continue;
      const it = sink.get(s.tool.id);
      if (!it) continue;
      s.tool.out = { text: it.text || '', err: !!it.err, images: it.images || [] };
      const bkt = t.tools.find((x) => x === s.tool);
      if (bkt) bkt.out = s.tool.out;
      sink.delete(s.tool.id);
    }
  }
}
// folded marker lines (compaction summary / skill injection). Cost-state
// snapshots stopped rendering here in v145 (see applyEventToTurns).
function sysMarkerTurn(ev) {
  const wan = (n) => (n >= 10000 ? (n / 10000).toFixed(1) + ' 万字' : n + ' 字');
  if (ev.k === 'compact') return { role: 'sys', text: '⟲ 上下文已压缩（续传摘要 ' + wan(ev.n || 0) + '，已折叠）' };
  return { role: 'sys', text: '✧ 技能 ' + (ev.name || '?') + ' 已注入（' + wan(ev.n || 0) + '，已折叠）' };
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

/* ---------------- DOM rendering ---------------- */
// apply height caps only where content actually overflows: a permanently-on
// max-height+overflow+overscroll-contain turns short expanded panels into
// gesture dead zones on touch devices (nothing to scroll inside, chaining cut)
function markCapped(root) {
  requestAnimationFrame(() => {
    const cap = Math.floor(window.innerHeight * 0.34) + 8;
    (root || $('chat')).querySelectorAll('.tool-chip:not(.capped), .think:not(.capped), .tool-out:not(.capped)').forEach((el) => {
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
/* ---------------- timeline turns ---------------- */
const CHEV_S = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';
const CHEV_B = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
const ICO_CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m8.5 12.5 2.5 2.5 5-5.5"/></svg>';
const ICO_CLOCK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>';
const ICO_COPY = '<svg class="i-copy" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const ICO_OK = '<svg class="i-ok" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="display:none"><path d="m5 12.5 4.5 4.5L19 7"/></svg>';
const ICO_FORK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';
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
// v40 bubble-meta action icon: copy/ok svg pair, animated by copyText's
// .ok class toggle (same mechanism as the code-fence copy buttons)
function metaBtn(title, onGo) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'bicon';
  btn.title = title;
  btn.innerHTML = ICO_COPY + ICO_OK;
  btn.onclick = () => onGo(btn);
  return btn;
}
// v40 branch: arm the composer so the NEXT message forks into a NEW session
// inheriting this one's context (runner passes --resume <src> --fork-session;
// the fork's real id is adopted from the init line, app.js navigates). The
// chip lives in index.html; transcript.js (arm/toggle) and composer.js
// (disarm on send/leave) both poke it directly - no import between them.
function armFork() {
  if (!state.currentId) return;
  const chip = $('fork-chip');
  if (state.armedBranch === state.currentId) {
    state.armedBranch = null;
    if (chip) chip.classList.add('hidden');
    return;
  }
  state.armedBranch = state.currentId;
  if (chip) chip.classList.remove('hidden');
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
    (head.bg ? '<span class="ag-bgtag">后台</span>' : '') +
    (head.title ? '<span class="t"></span>' : '') +
    (head.meta ? '<span class="dur"></span>' : '') +
    (head.link ? '<span class="lnk"></span>' : '') +
    (head.diff ? '<span class="diffbadge"><span class="add"></span><span class="del"></span></span>' : '') +
    (plain ? '' : '<span class="chev">' + CHEV_S + '</span>');
  h.querySelector('.badge').textContent = head.badge;
  if (head.title) h.querySelector('.t').textContent = head.title;
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

// v45 (P1-6R): per-turn changed-file rollup for the conclusion card. Pure
// function of the turn's steps - recomputed on each renderTurn, not cached.
// v145: the ± numbers come PRE-COMPUTED from the bridge (tool.f) - the chip
// text v is briefJson-capped at 300 chars, and JSON.parse on a truncated
// string used to silently drop every edit whose input exceeded the cap
// (only tiny files made it into the rollup). The legacy v-parse path stays
// as a fallback for inputs produced by older bridges. Path identity is
// case-insensitive (Windows); Write counts every line as an addition (the
// old content is unknowable from the input).
const EDIT_TOOLS = { Edit: 1, Write: 1, MultiEdit: 1 };
const lineCount = (v) => (typeof v === 'string' ? v.split('\n').length : 0);
function fileChanges(t) {
  const byKey = new Map();
  const bump = (p, add, del) => {
    if (!p) return;
    const k = p.toLowerCase();
    let rec = byKey.get(k);
    if (!rec) { rec = { path: p, add: 0, del: 0 }; byKey.set(k, rec); }
    rec.path = p; // last spelling wins
    rec.add += add; rec.del += del;
  };
  for (const s of t.steps || []) {
    if (s.t !== 'tool' || !EDIT_TOOLS[s.tool.name]) continue;
    if (Array.isArray(s.tool.f)) {
      for (const r of s.tool.f) bump(r.path, r.add || 0, r.del || 0);
      continue;
    }
    let input = null;
    try { input = JSON.parse(s.tool.v); } catch { continue; }
    if (!input || typeof input !== 'object') continue;
    const p = input.file_path || input.path || input.notebook_path;
    if (typeof p !== 'string' || !p) continue;
    if (Array.isArray(input.edits)) {
      for (const e of input.edits) bump(p, lineCount(e && e.new_string), lineCount(e && e.old_string));
    } else if (typeof input.content === 'string') {
      bump(p, lineCount(input.content), 0);
    } else {
      bump(p, lineCount(input.new_string), lineCount(input.old_string));
    }
  }
  return [...byKey.values()];
}

// v112: render one turn's steps into a .timeline container. Shared by the
// main view (renderTurn) and the subagent bubble (agentview.js) - the agent
// node branch below is therefore written ONCE.
const AGENT_TOOLS = { Agent: 1, Task: 1 };
function renderStepsInto(tl, steps, live) {
  const textSteps = steps.filter((s) => s.t === 'text');
  const concl = textSteps.length ? textSteps[textSteps.length - 1].v : '';
  for (const s of steps) {
    if (s.t === 'think') {
      tl.appendChild(nodeEl('think', { badge: '思考' }, (b) => {
        const d = document.createElement('div');
        d.className = 'think';
        d.textContent = s.v;
        b.appendChild(d);
      }, live));
    } else if (s.t === 'tool') {
      const tool = s.tool;
      const isAgent = AGENT_TOOLS[tool.name] === 1;
      const ag = isAgent ? (state.agents[tool.id] || null) : null;
      const agRunning = !!(ag && !ag.finished && !tool.out);
      const isEdit = !isAgent && (tool.name === 'Edit' || tool.name === 'Write' || tool.name === 'MultiEdit');
      const diff = isEdit ? toolDiff(tool) : null;
      const node = nodeEl('tool', {
        badge: isAgent ? '代理' : (isEdit ? '修改' : '工具'),
        bg: isAgent && ag && ag.bg,
        title: isAgent ? ((ag && ag.desc) || agentDescOf(tool)) : '',
        // head dur = elapsed (mockup 方案A), frozen at finish; tool.name is
        // the fallback when no tracker state exists at all
        meta: isAgent
          ? ((ag && ag.startedAt) ? fmtAgentElapsed(ag) : tool.name)
          : tool.name,
        link: isAgent ? '' : toolLink(tool),
        diff,
      }, (b) => {
        const c = document.createElement('div');
        c.className = 'tool-chip';
        const p = document.createElement('span');
        p.className = 'p';
        p.textContent = '⚙ ';
        c.appendChild(p);
        if (isAgent) {
          c.appendChild(document.createTextNode(
            (ag && ag.finished && !tool.out ? '完成' + (ag.steps ? ' · ' + ag.steps + ' 步' : '') : tool.name) + ' · '));
          c.appendChild(document.createTextNode((ag && ag.desc) || agentDescOf(tool)));
          c.style.cursor = 'pointer';
          c.onclick = () => openAgentView(tool.id);
        } else {
          c.appendChild(document.createTextNode(tool.name + ' '));
          linkifyPaths(c, tool.v || '', previewArtifact);
        }
        b.appendChild(c);
        // the run's actual output, paired back from the tool_result line
        const out = tool.out;
        if (out && (out.text || (out.images && out.images.length))) {
          if (out.text) {
            const o = document.createElement('pre');
            o.className = 'tool-out' + (out.err ? ' err' : '');
            linkifyPaths(o, out.text, previewArtifact);
            b.appendChild(o);
          }
          if (out.images && out.images.length) {
            const box = document.createElement('div');
            box.className = 'tool-out-imgs';
            for (const im of out.images) {
              const img = document.createElement('img');
              img.className = 'bubble-img';
              img.alt = '工具输出图片';
              img.src = 'data:' + im.mt + ';base64,' + im.data;
              img.onclick = () => openLightbox(img.src);
              box.appendChild(img);
            }
            b.appendChild(box);
          }
        }
      }, live || agRunning);
      if (isAgent) {
        node.dataset.agent = tool.id;
        if (agRunning || (ag && ag.finished && !tool.out)) {
          node.insertBefore(agentLiveLine(tool.id, ag), node.querySelector('.node-body'));
        }
        if (agRunning) {
          const dot = node.querySelector('.dot-tool');
          if (dot) dot.classList.add('on');
        }
      }
      tl.appendChild(node);
    } else { // text step: mid-run output, or the conclusion (last one)
      const isConcl = s === textSteps[textSteps.length - 1];
      if (isConcl && concl && !live) {
        tl.appendChild(nodeEl('final', { badge: '结论' }, (b) => {
          const d = document.createElement('div');
          d.className = 'final';
          d.innerHTML = miniMd(concl);
          linkifyDom(d, previewArtifact);
          b.appendChild(d);
        }));
      } else {
        tl.appendChild(nodeEl('mid', { badge: '输出' }, (b) => {
          const d = document.createElement('div');
          d.className = 'mid';
          linkifyPaths(d, s.v, previewArtifact);
          b.appendChild(d);
        }));
      }
    }
  }
}

// description from the Agent tool_use input - v is briefJson({description,
// prompt}) truncated at 300 chars, so a JSON.parse can fail mid-string; a
// regex on the raw text survives truncation
function agentDescOf(tool) {
  const m = /"description"\s*:\s*"((?:[^"\\]|\\.){0,80})/.exec(tool.v || '');
  if (m) { try { return JSON.parse('"' + m[1] + '"'); } catch { return m[1]; } }
  return tool.name;
}

// v112: the live-line under an agent node's head - OUTSIDE .node-body so it
// stays visible while the node is folded (直播行不属于折叠体). Mockup 方案A:
// ↳ <act> · 第 N 步 … <elapsed> <全文 ›>
function agentLiveLine(toolUseId, ag) {
  const d = document.createElement('div');
  d.className = 'agent-live' + (ag && ag.finished ? ' done' : '');
  const pulse = document.createElement('span');
  pulse.className = 'al-pulse';
  const txt = document.createElement('span');
  txt.className = 'al-txt';
  txt.textContent = agentLiveText(ag);
  const st = document.createElement('span');
  st.className = 'al-step';
  if (ag && !ag.finished && ag.startedAt) st.textContent = fmtAgentElapsed(ag);
  const full = document.createElement('span');
  full.className = 'al-full';
  full.textContent = '全文 ›';
  d.append(pulse, txt, st, full);
  d.title = '查看子代理执行全文';
  d.onclick = () => openAgentView(toolUseId);
  return d;
}
function agentLiveText(ag) {
  if (!ag) return '↳ 启动中';
  if (ag.finished) return '已完成 · ' + (ag.steps || 0) + ' 步';
  return '↳ ' + (ag.act || '启动中') + (ag.steps ? ' · 第 ' + ag.steps + ' 步' : '');
}
// elapsed frozen at finishedAt once the agent completes (v115: the bubble
// head + node dur used to keep counting past completion)
function fmtAgentElapsed(a) {
  if (!a || !a.startedAt) return '';
  const end = a.finished ? (a.finishedAt || Date.now()) : Date.now();
  const sec = Math.max(0, Math.floor((end - a.startedAt) / 1000));
  return Math.floor(sec / 60) + 'm' + String(sec % 60).padStart(2, '0') + 's';
}
// seconds -> "42s" / "3m12s" (no leading 0m - capsule-friendly)
function fmtDur(sec) {
  if (sec < 60) return sec + 's';
  return Math.floor(sec / 60) + 'm' + String(sec % 60).padStart(2, '0') + 's';
}
// process-capsule elapsed: start = the question ts (fallback first assistant
// line), end = last event ts for done turns (missing -> no shown duration),
// now for live. Frozen by construction once liveTurnOpen flips off.
function turnDurSec(t, live) {
  const s = Date.parse(t.startTs || t.ts || '');
  if (!Number.isFinite(s)) return -1;
  if (live) return Math.max(0, Math.floor((Date.now() - s) / 1000));
  const e = Date.parse(t.endTs || '');
  if (!Number.isFinite(e) || e < s) return -1;
  return Math.max(0, Math.floor((e - s) / 1000));
}
// 1s ticker: patch the live turn's pill duration in place (never a re-render;
// done turns keep the frozen value renderTurn computed)
function tickTurnDur() {
  const T = state.turns;
  const t = T[T.length - 1];
  if (!t || t.role !== 'bot' || !(state.liveTurnOpen && t === T[T.length - 1])) return;
  const chat = $('chat');
  const el = chat.lastChild && chat.lastChild.querySelector ? chat.lastChild.querySelector('.trigger .t-dur') : null;
  if (!el) return;
  const sec = turnDurSec(t, true);
  if (sec >= 0) el.textContent = '· ' + fmtDur(sec);
}

// v112: agent summary frame landed - patch the rendered node in place; never
// touches state.turns or the chat child list (renderTail's 1:1 invariant and
// scroll position are untouched)
function updateAgentNode(d) {
  const a = state.agents[d.toolUseId];
  if (!a) return;
  const sel = (window.CSS && CSS.escape) ? CSS.escape(d.toolUseId) : d.toolUseId;
  const el = document.querySelector('#chat .node[data-agent="' + sel + '"]');
  if (!el) return;
  if (d.state === 'done') {
    const line = el.querySelector('.agent-live');
    if (line) {
      line.classList.add('done');
      const t = line.querySelector('.al-txt');
      if (t) t.textContent = agentLiveText(a);
      const s2 = line.querySelector('.al-step');
      if (s2) s2.textContent = '';
    }
    const dot = el.querySelector('.dot-tool');
    if (dot) dot.classList.remove('on');
    // freeze the head dur at the final elapsed
    const dur = el.querySelector('.node-head .dur');
    if (dur && a.startedAt) dur.textContent = '· ' + fmtAgentElapsed(a);
    return;
  }
  const line = el.querySelector('.agent-live');
  if (!line) {
    // node rendered before its first frame landed (fetch raced the frame):
    // re-render just the turn that owns this step
    for (let i = state.turns.length - 1; i >= 0; i--) {
      const t = state.turns[i];
      if (t.role === 'bot' && (t.steps || []).some((x) => x.t === 'tool' && x.tool.id === d.toolUseId)) {
        renderTail(i + 1);
        break;
      }
    }
    return;
  }
  const t = line.querySelector('.al-txt');
  if (t) t.textContent = agentLiveText(a);
}

// v112: 1s ticker - head dur + live-line text/elapsed on every visible agent
// node (frozen ones are written once and left alone)
function updateAgentClocks() {
  document.querySelectorAll('#chat .node[data-agent]').forEach((el) => {
    const id = el.dataset.agent;
    const a = state.agents[id];
    if (!a || a.finished || !a.startedAt) return;
    const dur = el.querySelector('.node-head .dur');
    if (dur) dur.textContent = '· ' + fmtAgentElapsed(a);
    const line = el.querySelector('.agent-live');
    if (!line) return;
    const t = line.querySelector('.al-txt');
    if (t) t.textContent = agentLiveText(a);
    const st = line.querySelector('.al-step');
    if (st) st.textContent = fmtAgentElapsed(a);
  });
}

function renderTurn(t) {
  if (t.role === 'sys') {
    const d = document.createElement('div');
    d.className = 'sysline';
    d.textContent = t.text;
    return d;
  }
  if (t.role === 'cmdout') {
    // v111: executed-command stdout - same side as the command bubble
    const d = document.createElement('div');
    d.className = 'cmdout';
    d.textContent = t.text;
    return d;
  }
  if (t.role === 'user') {
    // v40: wrapper keeps renderTail's 1:1 child/turn invariant while adding
    // the meta row (time extracted OUT of the bubble + copy) BELOW it
    const row = document.createElement('div');
    row.className = 'turn user';
    const d = document.createElement('div');
    d.className = 'bubble user' + (t.optimistic ? ' pending' : '');
    // v109: a leading slash-command shows as a tag chip + args text. Known =
    // the composer's fetched name set; if that never loaded (menu unused),
    // any leading /token still tags (chip sends are the common case).
    const cm = /^\/([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?:\s+([\s\S]*))?$/.exec(t.text || '');
    if (cm && (!state.cmdNames || state.cmdNames.has(cm[1].toLowerCase()))) {
      const tag = document.createElement('span'); tag.className = 'b-tag'; tag.textContent = '/' + cm[1];
      d.appendChild(tag);
      if (cm[2]) d.appendChild(document.createTextNode(' ' + cm[2]));
    } else {
      d.textContent = t.text;
    }
    for (const im of t.images || []) {
      const img = document.createElement('img');
      img.className = 'bubble-img';
      img.alt = '附件图片';
      img.src = 'data:' + im.mt + ';base64,' + im.data;
      img.onclick = () => openLightbox(img.src);
      d.appendChild(img);
    }
    // v67: chrysanthemum spinner rides a flex line BESIDE the optimistic
    // bubble (bars fading in sequence - explicitly NOT a stroke ring);
    // it lives inside the turn element, so renderTail's 1:1 chat/turns
    // invariant is untouched. The confirm (fold) or v66 reconcile drops
    // the whole pending styling together with it.
    // v83 (variant A ruling): a single breathing dot left of the bubble -
    // same grammar as the status lamp's "running" breathe. DOM order
    // dot-then-bubble in the right-justified line keeps it hugging the
    // bubble (the bubble's legacy margin-left:auto is neutralized in CSS).
    const line = document.createElement('div');
    line.className = 'u-line';
    if (t.optimistic) {
      const sp = document.createElement('span');
      // v88: stopped runs flip the twin's dot red+static (still foldable if
      // the line somehow lands later - optimistic stays true)
      sp.className = 'uspin' + (t.stopped ? ' stopped' : '');
      sp.setAttribute('aria-hidden', 'true');
      line.appendChild(sp);
    }
    line.appendChild(d);
    row.appendChild(line);
    const meta = document.createElement('div');
    meta.className = 'bmeta';
    if (t.ts) addTs(meta, t.ts);
    meta.appendChild(metaBtn('复制原文', (b) => copyText(t.text, b)));
    row.appendChild(meta);
    return row;
  }
  // bot turn: trigger pill + timeline(思考/工具/修改/输出/结论) + final card.
  // final conclusion is NEVER folded away: expanded turns end with a 结论
  // node, collapsed turns keep the final-card below the pill.
  // v22: nodes render in true chronology from t.steps (think/tool/text
  // interleaved as they happened); tool steps carry their result (out).
  const wrap = document.createElement('div');
  const live = state.liveTurnOpen && t === state.turns[state.turns.length - 1];
  const steps = (t.steps && t.steps.length ? t.steps : [
    ...t.think.map((v) => ({ t: 'think', v })),
    ...t.tools.map((tool) => ({ t: 'tool', tool })),
    ...t.texts.slice(0, -1).map((v) => ({ t: 'text', v })),
  ]);
  const textSteps = steps.filter((s) => s.t === 'text');
  const concl = textSteps.length ? textSteps[textSteps.length - 1].v : '';
  // a live turn opens by default UNLESS the user folded it by hand (streaming
  // re-renders must not force it back open every append)
  const liveOpen = live && !state.userCollapsedLive;
  wrap.className = 'turn bot ' + (live ? (liveOpen ? 'live open' : 'live') : 'done');

  if (steps.length > 0) {
    const trig = document.createElement('button');
    trig.className = 'trigger';
    // elapsed rides in a dedicated span (.n style, .t-dur hook) so the 1s
    // ticker can patch the live turn in place without re-rendering the node
    const durSec = turnDurSec(t, live);
    trig.innerHTML = '<span class="ic">' + (live ? ICO_CLOCK : ICO_CHECK) + '</span>' +
      '<span class="t">过程</span><span class="n">· ' + steps.length + ' 步</span>' +
      '<span class="n t-dur">' + (durSec >= 0 ? '· ' + fmtDur(durSec) : '') + '</span>' +
      '<span class="chev">' + CHEV_B + '</span>';
    trig.onclick = () => {
      wrap.classList.toggle('open');
      if (live) state.userCollapsedLive = !wrap.classList.contains('open');
      markCapped(wrap); // bodies were display:none while collapsed (scrollHeight 0) - remeasure now
    };
    wrap.appendChild(trig);

    const tl = document.createElement('div');
    tl.className = 'timeline';
    renderStepsInto(tl, steps, live);
    wrap.appendChild(tl);
  }
  if (concl || (live && steps.length === 0)) {
    const b = document.createElement('div');
    b.className = 'final-card';
    if (concl) b.innerHTML = miniMd(concl);
    if (concl) linkifyDom(b, previewArtifact);
    if (live) appendCaret(b);
    wrap.appendChild(b);
    // v45 (6C+6B): changed-files rollup under the conclusion - one collapsed
    // summary row, expanded body lists per-file ± lines; row tap opens the
    // artifact preview. Capped at MAXF rows instead of markCapped: the capped
    // regime is reserved for .think/.tool-chip/.tool-out (gesture dead-zone
    // laws), a flat truncation row never grows a scroller.
    if (!live && concl) {
      const files = fileChanges(t);
      if (files.length) {
        const MAXF = 12;
        let adds = 0, dels = 0;
        for (const f of files) { adds += f.add; dels += f.del; }
        const det = document.createElement('details');
        det.className = 'fsum';
        const sum = document.createElement('summary');
        const lb = document.createElement('span');
        lb.textContent = '改动 ' + files.length + ' 个文件';
        const st = document.createElement('span');
        st.className = 'fd';
        const si = document.createElement('i'); si.className = 'ins'; si.textContent = '+' + adds;
        const sd = document.createElement('i'); sd.className = 'dele'; sd.textContent = '−' + dels;
        st.append(si, sd);
        const ch = document.createElement('span'); ch.className = 'chev'; ch.textContent = '▾';
        sum.append(lb, st, ch);
        det.appendChild(sum);
        for (const f of files.slice(0, MAXF)) {
          const row = document.createElement('div');
          row.className = 'frow';
          const nm = document.createElement('span'); nm.className = 'fname mono'; nm.textContent = f.path;
          const fd = document.createElement('span'); fd.className = 'fd';
          const fi = document.createElement('i'); fi.className = 'ins'; fi.textContent = '+' + f.add;
          const fe = document.createElement('i'); fe.className = 'dele'; fe.textContent = '−' + f.del;
          fd.append(fi, fe);
          row.append(nm, fd);
          row.onclick = () => previewArtifact(f.path);
          det.appendChild(row);
        }
        if (files.length > MAXF) {
          const more = document.createElement('div');
          more.className = 'fmore';
          more.textContent = '… 还有 ' + (files.length - MAXF) + ' 个文件';
          det.appendChild(more);
        }
        wrap.appendChild(det);
      }
      // v40: meta row under the card - time extracted out of it + copy + branch
      // (branch only for finished turns: forking mid-stream makes no sense)
      const meta = document.createElement('div');
      meta.className = 'bmeta final-meta';
      if (t.ts) addTs(meta, t.ts);
      meta.appendChild(metaBtn('复制结论', (btn) => copyText(concl, btn)));
      const br = document.createElement('button');
      br.type = 'button';
      br.className = 'bicon';
      br.title = '分支：下一条消息将开启新线程（继承本会话上下文）';
      br.innerHTML = ICO_FORK;
      br.onclick = armFork;
      meta.appendChild(br);
      wrap.appendChild(meta);
    }
  }
  return wrap;
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

/* delegate copy clicks for <pre><code> blocks (works for re-rendered nodes) */
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.copy-btn');
  if (!btn) return;
  const code = btn.parentElement && btn.parentElement.querySelector('code');  if (!code) return;
  copyText(code.textContent, btn);
});

/* v104: same-origin links rendered by miniMd open the in-app sandboxed
   preview page instead of leaving the PWA; cross-origin keeps _blank */
$('chat').addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a || a.classList.contains('flink')) return;
  let u; try { u = new URL(a.href, location.href); } catch { return; }
  if (u.origin !== location.origin) return;
  e.preventDefault();
  openHtmlPreview({ url: a.href, name: a.textContent });
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
  // v59: horizontally centered, anchored 12px above the composer's LIVE top
  // edge (queue/attach/fork rows grow the dock; a static offset would
  // overlap it). rect is viewport-based, so the safe area rides along.
  const comp = $('composer');
  if (comp && typeof window !== 'undefined' && window.innerHeight) {
    $('jump').style.bottom = (window.innerHeight - comp.getBoundingClientRect().top + 12) + 'px';
  }
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

/* ---------------- optimistic user bubble (v21) ---------------- */
// the tap shows the message at once; the transcript line only lands after
// the CLI spawns and writes it (seconds on slow links). The real transcript
// event folds into it (applyEventToTurns) and drops the pending styling.
// Returns the turn so refusal paths can retract it.
function pushOptimisticUser(text) {
  const T = state.turns;
  const t = { role: 'user', text, ts: '', optimistic: true };
  T.push(t);
  state.userCollapsedLive = false;
  renderTail(T.length); // start = len-1: render just the new tail
  scrollBottom();
  updateJumpFab();
  return t;
}
// a refused send (409 declined, network error) pulls its bubble back out —
// unless the transcript already folded into it (optimistic=false), in which
// case the message is real and stays. Removing the matching chat child keeps
// the DOM 1:1 with turns, so renderTail's alignment invariant survives
// without a full rebuild.
function retractOptimisticUser(t) {
  if (!t || t.optimistic !== true) return;
  const i = state.turns.indexOf(t);
  if (i < 0) return;
  state.turns.splice(i, 1);
  const chat = $('chat');
  if (chat.childNodes[i]) chat.removeChild(chat.childNodes[i]);
  updateJumpFab();
}

/* ---------------- history pagination (v44) ---------------- */
// build turns from an OLDER page of /messages events: identical shapes via
// the shared builders, but plain replay - every event is confirmed history,
// so no optimistic folding and no state-flag writes.
function parseOlderTurns(events) {
  const T = [];
  for (const ev of events) {
    if (ev.k === 'user') {
      T.push({ role: 'user', text: ev.text, ts: ev.ts, images: ev.images || null });
      T.push(newBotTurn('', ev.ts));
    } else if (ev.k === 'assistant') {
      if (T.length === 0 || T[T.length - 1].role !== 'bot') {
        const prev = T[T.length - 1];
        T.push(newBotTurn(ev.ts, prev && prev.role === 'user' ? (prev.ts || ev.ts) : ev.ts));
      }
      const turn = T[T.length - 1];
      turn.ts = turn.ts || ev.ts;
      if (ev.ts) turn.endTs = ev.ts;
      for (const p of ev.parts || []) addAssistantPart(turn, p);
    } else if (ev.k === 'toolres') {
      const i = pairToolResults(T, ev, state.orphanToolRes);
      if (i != null && T[i] && T[i].role === 'bot' && ev.ts) T[i].endTs = ev.ts;
    }
    else if (ev.k === 'cmdout') T.push({ role: 'cmdout', text: ev.text, ts: ev.ts });
    else if (ev.k === 'compact' || ev.k === 'skill') {
      const mk = sysMarkerTurn(ev); // stats rows are gone since v145 here too
      if (mk) T.push(mk);
    }
  }
  return T;
}
// v46: a pagination split mid-turn leaves the same conversation as TWO bot
// turns (older page tail + current page head). The neighbors are both bot
// exactly when the cut fell between assistant events of ONE turn - a user
// turn in between would surface as role 'user' on either side - so splice
// them into a single turn and re-render it: one process capsule per talk.
function mergeBotTurns(a, b) {
  return { role: 'bot', think: a.think.concat(b.think), tools: a.tools.concat(b.tools),
    texts: a.texts.concat(b.texts), steps: a.steps.concat(b.steps), ts: a.ts || b.ts,
    startTs: a.startTs || b.startTs, endTs: b.endTs || a.endTs };
}
// prepend an older page: unshift turns AND insert children in equal measure,
// then shift scrollTop by the height delta so the viewport stays anchored on
// the same content (#chat runs overflow-anchor:none per the scroll laws).
// Never touches the trailing children renderTail owns - the 1:1 mapping holds.
function prependTurns(older) {
  if (!older || !older.length) return;
  const chat = $('chat');
  const join = state.turns.length > 0 && older[older.length - 1].role === 'bot' && state.turns[0].role === 'bot';
  let mergedEl = null;
  if (join) {
    const tail = older.pop();
    state.turns[0] = mergeBotTurns(tail, state.turns[0]);
    mergedEl = renderTurn(state.turns[0]);
  }
  const frag = document.createDocumentFragment();
  for (const t of older) frag.appendChild(renderTurn(t));
  if (mergedEl) frag.appendChild(mergedEl);
  const beforeH = chat.scrollHeight;
  chat.insertBefore(frag, chat.firstChild);
  state.turns.unshift(...older);
  if (mergedEl) chat.removeChild(chat.childNodes[older.length + 1]); // old head turn, shifted right by the fragment
  drainOrphanRes(state.turns.slice(0, older.length + (mergedEl ? 1 : 0)));
  chat.scrollTop += chat.scrollHeight - beforeH;
  markCapped();
  armCodeCopy();
}

/* ---------------- wiring ---------------- */
$('jump').onclick = () => { state.atBottom = true; scrollBottom(true); updateJumpFab(); };
// dock height changes (queue/attach rows, run-status) move the fab too
if (typeof ResizeObserver === 'function') new ResizeObserver(() => updateJumpFab()).observe($('composer'));
$('chat').addEventListener('scroll', () => {
  const el = $('chat');
  state.atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  updateJumpFab();
});
window.addEventListener('resize', updateJumpFab);

export { sessionLive, buildTurns, applyEventToTurns, markLiveTurn, closeLiveTurn,
  markCapped, renderAllTurns, renderTurn, renderTail, updateJumpFab, scrollBottom,
  pushOptimisticUser, retractOptimisticUser, parseOlderTurns, prependTurns, fileChanges,
  pairToolResults, drainOrphanRes, mergeBotTurns, copyText,
  nodeEl as renderNode, renderStepsInto, newBotTurn, addAssistantPart,
  updateAgentNode, updateAgentClocks, tickTurnDur };
