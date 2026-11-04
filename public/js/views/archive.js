// js/views/archive.js - the archive list page (v185): an independent .page
// that reuses the main list's row grammar wholesale (renderRow with the
// pin-section info line = project label first). Flat, lastActive desc, no
// group chrome (same posture as search results). The ⋯ bubble is the same
// sessops menu with its archive item flipped to 取消归档 (sessops.js reads
// s.archived). History: every open pushes a UNIQUE (state,url) #arch/N entry
// (detail.js #s/N precedent - adjacent identical entries get silently
// traversed by Chromium and eat a back press).
import { $ } from '../util.js';
import { state } from '../state.js';
import { renderRow, setBatch } from './list.js';
import { openDetail } from './detail.js';

let archSeq = 0;

export function openArchive() {
  setBatch(false); // batch grammar belongs to the main list only
  state.archOpen = true;
  $('list').classList.add('hidden');
  $('arch').classList.remove('hidden');
  renderArchive();
  archSeq++;
  history.pushState({ cr: 'arch', n: archSeq }, '', '#arch/' + archSeq);
}

// direct close (no history op): the #arch-back fallback + popstate sync call
// this; the history-first paths land here via closeArchive semantics
export function closeArchive() {
  state.archOpen = false;
  $('arch').classList.add('hidden');
  $('list').classList.remove('hidden');
}

// re-rendered by renderList() whenever the archive page is open (sessions
// frame, optimistic archive/unarchive, rename) - the two pages never drift
export function renderArchive() {
  const box = $('arch-groups');
  const items = state.sessions
    .filter((s) => s.kind === 'cc' && s.archived)
    .sort((a, b) => b.lastActive - a.lastActive);
  $('arch-count').textContent = items.length
    ? items.length + ' 个会话 · 按最近活动排序'
    : '0 个会话';
  if (!items.length) {
    box.innerHTML = '<div class="empty list-empty">' +
      '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v10.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V8"/><path d="M10 12.5h4"/></svg>' +
      '<div class="le-t">还没有归档的会话</div>' +
      '<div class="le-s">在会话的 ⋯ 菜单里选「归档」<br>闲置的会话会收进这里，可随时恢复</div></div>';
    return;
  }
  const card = document.createElement('div');
  card.className = 'pgroup';
  for (const s of items) card.appendChild(renderRow(s, true)); // true = pin-section info line (project label leads)
  box.innerHTML = '';
  box.appendChild(card);
}
