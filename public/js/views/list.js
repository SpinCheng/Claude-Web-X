// js/views/list.js - the session list page: project groups, state lamps,
// per-group tallies and collapse persistence (cr_closed_groups).
// Opening a row routes into the detail view (detail.js owns that transition).

import { $, shortPath, relTime } from '../util.js';
import { state, CLOSED_KEY } from '../state.js';
import { openDetail } from './detail.js';
import { openNewModal } from './composer.js';
import { wireRowPress } from './sessops.js';

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

function renderList() {
  const box = $('groups');
  box.innerHTML = '';
  const cc = state.sessions.filter((s) => s.kind === 'cc');
  if (cc.length === 0) {
    box.innerHTML = '<div class="empty list-empty">' +
      '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8.5v7M8.5 12h7"/></svg>' +
      '<div class="le-t">还没有 Claude Code 会话</div>' +
      '<div class="le-s">从手机发起一个任务，让它跑在你电脑的工程里</div>' +
      '<button class="le-btn" type="button">发起任务</button></div>';
    box.querySelector('.le-btn').onclick = openNewModal;
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
    '<span class="lamp" data-st="' + top + '"></span>' +
    '<span class="pgroup-name"></span>' +
    '<span class="tally">' +
      // actionable first: waiting (phone can act) > running > failed > stopped
      (counts.waiting ? '<span class="t wait"><span class="lamp" data-st="waiting"></span>' + counts.waiting + '</span>' : '') +
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
    head.setAttribute('aria-expanded', wrap.classList.contains('closed') ? 'false' : 'true');
  };

  const body = document.createElement('div');
  body.className = 'pgroup-body';
  for (const s of g.sessions) body.appendChild(renderRow(s));
  wrap.append(head, body);
  return wrap;
}

function renderRow(s) {
  const st = sessState(s);
  // real <button>: keyboard reachable + free focus semantics; the whole row
  // is the target so no per-row go-arrow is needed - the right slot is the
  // status word (color + text, never color alone)
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'srow';
  el.innerHTML =
    '<span class="lamp" data-st="' + st + '"></span>' +
    '<span class="srow-main">' +
      '<span class="srow-title"></span>' +
      '<span class="srow-info"></span>' +
    '</span>' +
    (st !== 'idle' ? '<span class="st-word" data-st="' + st + '">' + ST_WORD[st] + '</span>' : '');
  el.querySelector('.srow-title').textContent = s.title || s.id.slice(0, 8);
  const info = [relTime(s.lastActive), (s.lines || 0) + ' 行'];
  if (s.cost && s.cost.usd != null) info.push('$' + Number(s.cost.usd).toFixed(2));
  el.querySelector('.srow-info').textContent = info.join(' · ');
  el.title = '点击打开 · 长按/右键更多操作';
  el.onclick = () => openDetail(s.id);
  wireRowPress(el, s.id); // long-press / right-click -> action bubble (sessops.js)
  return el;
}

export { renderList };
