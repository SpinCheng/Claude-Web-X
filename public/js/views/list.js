// js/views/list.js - the session list page: search (v43), project groups,
// state lamps, per-group tallies, collapse persistence (cr_closed_groups) and
// batch select+delete (v43). Opening a row routes into the detail view
// (detail.js owns that transition).
import { $, shortPath, relTime } from '../util.js';
import { state, CLOSED_KEY } from '../state.js';
import { api } from '../api.js';
import { toast } from './toast.js';
import { showConfirm } from './overlays.js';
import { openDetail } from './detail.js';
import { openNewModal } from './composer.js';
import { openBubble } from './overlays.js';
import { copyText } from './transcript.js';
import { wireRowOps, openGroupCopy } from './sessops.js';

const CK_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.5l5 5 10-11"/></svg>';
// v125 置顶: pushpin in coral (active-state semantics per the palette rules).
// Canonical Material push_pin path - the earlier hand-variant had its needle
// ~1 unit right of the head's centerline (visible at 16px).
const PIN_PATH = 'M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z';
const PIN_ICO = '<svg class="pgroup-ico" data-st="pinned" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="' + PIN_PATH + '"/></svg>';

function sessState(s) {
  if (s.running || state.runs[s.id]?.state === 'running') return 'running';
  if (state.waits[s.id]) return 'waiting';
  const o = s.lastRun?.state || s.lastOutcome || '';
  if (o === 'failed') return 'failed';
  if (o === 'stopped') return 'stopped';
  return 'idle';
}
const ST_WORD = { running: '运行中', waiting: '待确认', failed: '失败', stopped: '已停止', idle: '' };
const GROUP_RANK = { running: 3, waiting: 3, failed: 2, stopped: 2, idle: 1 };

function projectLabel(s) {
  if (s.cwd) return shortPath(s.cwd);
  return s.project || '(未知项目)';
}
function groupKey(s) { return s.cwd || s.project || '?'; }

// sessions matching the search box (title / cwd / project slug / id prefix)
function visibleSessions() {
  const q = (state.listQuery || '').trim().toLowerCase();
  const cc = state.sessions.filter((s) => s.kind === 'cc');
  if (!q) return cc;
  return cc.filter((s) =>
    (s.title || '').toLowerCase().includes(q) ||
    (s.cwd || '').toLowerCase().includes(q) ||
    (s.project || '').toLowerCase().includes(q) ||
    s.id.toLowerCase().includes(q));
}

function renderList() {
  const box = $('groups');
  box.innerHTML = '';
  const cc = visibleSessions();
  if (cc.length === 0) {
    const searching = (state.listQuery || '').trim();
    box.innerHTML = '<div class="empty list-empty">' +
      '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8.5v7M8.5 12h7"/></svg>' +
      (searching
        ? '<div class="le-t">没有匹配的会话</div><div class="le-s">换个关键词试试</div>'
        : '<div class="le-t">还没有 Claude Code 会话</div><div class="le-s">从手机发起一个任务，让它跑在你电脑的工程里</div><button class="le-btn" type="button">发起任务</button>') +
      '</div>';
    const btn = box.querySelector('.le-btn');
    if (btn) btn.onclick = openNewModal;
    return;
  }
  if ((state.listQuery || '').trim()) {
    // search: flat result list, newest first - group chrome just gets in the way
    const flat = document.createElement('div');
    for (const s of [...cc].sort((a, b) => b.lastActive - a.lastActive)) flat.appendChild(renderRow(s));
    box.appendChild(flat);
    return;
  }
  const groups = new Map();
  for (const s of cc) {
    if (s.pinned) continue; // pinned ones live in the 置顶 section, not here
    const k = groupKey(s);
    if (!groups.has(k)) groups.set(k, { label: projectLabel(s), path: s.cwd || '', sessions: [], latest: 0 });
    const g = groups.get(k);
    g.sessions.push(s);
    if (s.lastActive > g.latest) g.latest = s.lastActive;
  }
  // v125: the 置顶 section always comes first regardless of group recency.
  // It reuses the project-group chrome (collapse via the shared
  // closedGroups key '置顶'); newest pin first within the section.
  const pinned = cc.filter((s) => s.pinned).sort((a, b) => (b.pinnedAt || 0) - (a.pinnedAt || 0));
  if (pinned.length) box.appendChild(renderGroup({ label: '置顶', path: '', sessions: pinned, latest: 0 }, true));
  const ordered = [...groups.values()].sort((a, b) => b.latest - a.latest);
  for (const g of ordered) {
    g.sessions.sort((a, b) => b.lastActive - a.lastActive);
    box.appendChild(renderGroup(g));
  }
}

function renderGroup(g, pinSection = false) {
  const wrap = document.createElement('div');
  const closed = state.closedGroups.has(g.label);
  wrap.className = 'pgroup' + (closed ? ' closed' : '');

  const states = g.sessions.map(sessState);
  const top = states.reduce((acc, st) => (GROUP_RANK[st] > GROUP_RANK[acc] ? st : acc), 'idle');
  const counts = { running: 0, waiting: 0, failed: 0, stopped: 0 };
  for (const st of states) if (counts[st] != null) counts[st]++;

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'pgroup-head';
  head.setAttribute('aria-expanded', closed ? 'false' : 'true');
  head.innerHTML =
    // folder icon carries the group's top state as a tint (same palette the
    // lamps used); per-state exact counts stay in the tally chips. The pin
    // section swaps the folder for a coral pushpin and drops project chrome.
    (pinSection ? PIN_ICO
      : '<svg class="pgroup-ico" data-st="' + top + '" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="currentColor" d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>') +
    '<span class="pgroup-main">' +
      '<span class="pgroup-name"></span>' +
      (!pinSection && g.path ? '<span class="pgroup-path"></span>' : '') +
    '</span>' +
    '<span class="tally">' +
      // actionable first: waiting (phone can act) > running > failed > stopped
      (counts.waiting ? '<span class="t wait"><span class="lamp" data-st="waiting"></span>' + counts.waiting + '</span>' : '') +
      (counts.running ? '<span class="t live"><span class="lamp" data-st="running"></span>' + counts.running + '</span>' : '') +
      (counts.failed ? '<span class="t fail"><span class="lamp" data-st="failed"></span>' + counts.failed + '</span>' : '') +
      (counts.stopped ? '<span class="t hold"><span class="lamp" data-st="stopped"></span>' + counts.stopped + '</span>' : '') +
      '<span class="t">' + g.sessions.length + '</span>' +
    '</span>' +
    // v41: new-session shortcut for this project (span role=button, NOT a
    // nested <button> - the fragment parser hoists those out of the head)
    (!pinSection && g.path ? '<span class="pgroup-new" role="button" tabindex="0" aria-label="在此项目新建会话">' +
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></span>' : '') +
    '<svg class="chev" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>';
  head.querySelector('.pgroup-name').textContent = g.label;
  if (!pinSection && g.path) head.querySelector('.pgroup-path').textContent = g.path;
  head.onclick = () => {
    if (state.closedGroups.has(g.label)) state.closedGroups.delete(g.label);
    else state.closedGroups.add(g.label);
    localStorage.setItem(CLOSED_KEY, JSON.stringify([...state.closedGroups]));
    wrap.classList.toggle('closed');
    head.setAttribute('aria-expanded', wrap.classList.contains('closed') ? 'false' : 'true');
  };
  // v95: project copy actions - right-click on the group head opens a tiny
  // copy bubble (name / path); left-click stays collapse-toggle (unchanged).
  head.addEventListener('contextmenu', (e) => {
    if (!g.path || (window.getSelection && window.getSelection().toString())) return;
    e.preventDefault();
    openGroupCopy(g);
  });
  // the + must not toggle collapse: swallow the event before it reaches head
  const nw = head.querySelector('.pgroup-new');
  if (nw) {
    const open = (e) => { e.preventDefault(); e.stopPropagation(); openNewModal(g.path); };
    nw.onclick = open;
    nw.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') open(e); };
  }

  const body = document.createElement('div');
  body.className = 'pgroup-body';
  for (const s of g.sessions) body.appendChild(renderRow(s, pinSection));
  wrap.append(head, body);
  return wrap;
}

function renderRow(s, inPinSection = false) {
  const st = sessState(s);
  // real <button>: keyboard reachable + free focus semantics; the whole row
  // is the target, the right slot holds the status word (color + text,
  // never color alone) and the trailing ⋯ (v35 session ops)
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'srow' + (state.batchSel.has(s.id) ? ' sel' : '');
  el.innerHTML =
    '<span class="lamp" data-st="' + st + '"></span>' +
    '<span class="srow-main">' +
      '<span class="srow-title"></span>' +
      '<span class="srow-info"></span>' +
    '</span>' +
    (st !== 'idle' ? '<span class="st-word" data-st="' + st + '">' + ST_WORD[st] + '</span>' : '');
  el.querySelector('.srow-title').textContent = s.title || s.id.slice(0, 8);
  // v125: rows in the 置顶 section lost their project group - the project
  // name now leads the info line (marker pin dropped, user decision v126)
  const info = inPinSection ? [projectLabel(s), relTime(s.lastActive), (s.lines || 0) + ' 行'] : [relTime(s.lastActive), (s.lines || 0) + ' 行'];
  if (s.cost && s.cost.usd != null) info.push('$' + Number(s.cost.usd).toFixed(2));
  el.querySelector('.srow-info').textContent = info.join(' · ');

  // v43 batch mode: row = selection toggle, no open / no ⋯ bubble
  if (state.batchMode) {
    const ck = document.createElement('span');
    ck.className = 'ck' + (state.batchSel.has(s.id) ? ' on' : '');
    ck.innerHTML = CK_SVG;
    el.insertBefore(ck, el.firstChild);
    el.title = '点击选择';
    el.onclick = () => {
      if (state.batchSel.has(s.id)) state.batchSel.delete(s.id);
      else state.batchSel.add(s.id);
      renderList();
      updateBatchBar();
    };
    return el;
  }

  el.title = '点击打开 · 右键更多操作';
  el.onclick = () => openDetail(s.id);
  // trailing ⋯: the touch path to the action bubble. A span with role=button,
  // NOT a <button> - nested buttons get hoisted out by the HTML fragment
  // parser and would tear the row apart
  const more = document.createElement('span');
  more.className = 'srow-more';
  more.setAttribute('role', 'button');
  more.setAttribute('tabindex', '0');
  more.setAttribute('aria-label', '更多操作');
  more.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="12" cy="19" r="1.9"/></svg>';
  el.appendChild(more);
  wireRowOps(el, s.id); // ⋯ click / right-click -> action bubble (sessops.js)
  return el;
}

/* ---------------- v43 batch management ---------------- */
function updateBatchBar() {
  const vis = visibleSessions();
  const all = vis.length > 0 && vis.every((s) => state.batchSel.has(s.id));
  $('b-selall').textContent = all ? '清空' : '全选';
  $('b-count').textContent = '已选 ' + state.batchSel.size;
  $('b-del').disabled = state.batchSel.size === 0;
}

function setBatch(on) {
  state.batchMode = on;
  if (!on) state.batchSel.clear();
  $('list-manage').classList.toggle('active', on);
  $('batch-bar').classList.toggle('hidden', !on);
  document.getElementById('list').classList.toggle('batching', on);
  renderList();
  if (on) updateBatchBar();
}

async function batchDelete() {
  const ids = [...state.batchSel];
  if (!ids.length) return;
  showConfirm({ title: '删除选中会话', body: '将删除 ' + ids.length + ' 个会话，转录移入电脑回收站，可找回。', ok: '删除', danger: true,
    onOk: () => runBatchDelete(ids) });
}
async function runBatchDelete(ids) {
  let ok = 0, busy = 0, fail = 0;
  for (const id of ids) {
    try {
      const r = await api('/api/sessions/' + encodeURIComponent(id), { method: 'DELETE' });
      if (r.status === 409) busy++;       // running: skipped, not lost
      else if (r.ok) ok++;
      else fail++;
    } catch { fail++; }
    state.batchSel.delete(id);
  }
  toast('已删除 ' + ok + ' 个' + (busy ? '，' + busy + ' 个运行中已跳过' : '') + (fail ? '，' + fail + ' 个失败' : ''));
  renderList();
  updateBatchBar();
}

/* ---------------- wiring ---------------- */
$('list-search').addEventListener('input', function () {
  state.listQuery = this.value;
  $('search-clear').classList.toggle('hidden', !this.value);
  renderList();
});
$('search-clear').onclick = () => {
  const i = $('list-search');
  i.value = '';
  state.listQuery = '';
  $('search-clear').classList.add('hidden');
  renderList();
  i.focus();
};
$('list-manage').onclick = () => setBatch(!state.batchMode);
$('b-done').onclick = () => setBatch(false);
$('b-del').onclick = batchDelete;
$('b-selall').onclick = () => {
  const vis = visibleSessions();
  const all = vis.length > 0 && vis.every((s) => state.batchSel.has(s.id));
  for (const s of vis) {
    if (all) state.batchSel.delete(s.id);
    else state.batchSel.add(s.id);
  }
  renderList();
  updateBatchBar();
};

export { renderList };
