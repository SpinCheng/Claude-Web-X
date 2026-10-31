// js/md.js - pure text/DOM helpers for transcript rendering: markdown
// (conclusion cards, v25) + file-path linkify (artifact preview, v23) +
// preview doc builders (md v139; csv/json/diff v142). All builders share one
// discipline: escape first, standalone styled doc for the #hp-frame srcdoc.
// No app state lives here; linkifyPaths takes the open-callback as a param.

/* safe markdown: escape first, then block-level (fences / headings / hr /
   blockquote / lists / tables) + inline (code / bold / italic / links).
   Links are https? only - javascript: and any model-injected markup die in
   the escape step. */
function mdInline(s) {
  return s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}
export function miniMd(src) {
  const esc = String(src).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const parts = esc.split('```');
  let html = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) { // fenced code: line after ``` is the lang tag
      const nl = parts[i].indexOf('\n');
      const body = nl >= 0 ? parts[i].slice(nl + 1) : parts[i];
      html += '<pre><code>' + body.replace(/\n+$/, '') + '</code></pre>';
      continue;
    }
    const lines = parts[i].split('\n');
    let j = 0;
    const isBlockStart = (l) => /^(#{1,4}\s|&gt;|\|)/.test(l) || /^\s*([-*+]\s|\d+[.)]\s)/.test(l) || /^(\s*[-*_]){3,}\s*$/.test(l);
    while (j < lines.length) {
      const ln = lines[j];
      let m;
      if (!ln.trim()) { j++; continue; }
      if ((m = ln.match(/^(#{1,4})\s+(.*)$/))) {
        html += '<div class="mdh' + Math.min(m[1].length, 4) + '">' + mdInline(m[2]) + '</div>'; j++;
      } else if (/^(\s*[-*_]){3,}\s*$/.test(ln)) {
        html += '<hr>'; j++;
      } else if ((m = ln.match(/^&gt;\s?(.*)$/))) {
        const buf = [];
        while (j < lines.length && (m = lines[j].match(/^&gt;\s?(.*)$/))) { buf.push(m[1]); j++; }
        html += '<blockquote>' + mdInline(buf.join('<br>')) + '</blockquote>';
      } else if ((m = ln.match(/^\s*[-*+]\s+(.*)$/))) {
        const buf = [];
        while (j < lines.length && (m = lines[j].match(/^\s*[-*+]\s+(.*)$/))) { buf.push('<li>' + mdInline(m[1]) + '</li>'); j++; }
        html += '<ul>' + buf.join('') + '</ul>';
      } else if ((m = ln.match(/^\s*\d+[.)]\s+(.*)$/))) {
        const buf = [];
        while (j < lines.length && (m = lines[j].match(/^\s*\d+[.)]\s+(.*)$/))) { buf.push('<li>' + mdInline(m[1]) + '</li>'); j++; }
        html += '<ol>' + buf.join('') + '</ol>';
      } else if (ln.trim().startsWith('|') && j + 1 < lines.length && /^[\s|:-]+$/.test(lines[j + 1]) && lines[j + 1].includes('-') && lines[j + 1].includes('|')) {
        const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const head = cells(ln);
        j += 2;
        const rows = [];
        while (j < lines.length && lines[j].trim().startsWith('|')) { rows.push(cells(lines[j])); j++; }
        html += '<table><thead><tr>' + head.map((h) => '<th>' + mdInline(h) + '</th>').join('') + '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + r.map((c) => '<td>' + mdInline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
      } else {
        const buf = [];
        while (j < lines.length && lines[j].trim() && !isBlockStart(lines[j])) { buf.push(mdInline(lines[j])); j++; }
        if (!buf.length) { buf.push(mdInline(ln)); j++; } // lone '|'-ish line
        html += '<p>' + buf.join('<br>') + '</p>';
      }
    }
  }
  return html;
}

/* v139 md file preview (render tab): strip a leading YAML frontmatter block
   before rendering - GitHub-style. Guarded so a bare leading `---` hr is NOT
   swallowed: requires a closing `---`/`...` fence and at least one `key:`
   line between. Source tab keeps the untouched text. CRLF tolerant. */
export function mdFrontmatter(src) {
  const m = String(src).match(/^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\r?\n?/);
  if (!m) return String(src);
  const yamlish = m[1].split(/\r?\n/).some((l) => /^[ \t]*[\w$-]+:/.test(l));
  return yamlish ? String(src).slice(m[0].length) : String(src);
}

/* shared standalone-doc envelope for the #hp-frame srcdoc (opaque-origin
   iframe - parent CSS vars don't reach it, so the conclusion-card tokens are
   inlined). Content across ALL builders is escape-first: raw HTML/<script>
   arrive as text, md links are https? only. extraCss rides after the shared
   set (same specificity, later wins). */
const ESC = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const DOC_CSS =
  ':root{color-scheme:dark}' +
  'body{margin:0;padding:14px 16px 44px;background:#1D1C1A;color:#F2EDE3;' +
  'font:15px/1.55 -apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}' +
  'p{margin:7px 0}b{font-weight:700}' +
  'pre{background:#171613;border-radius:9px;padding:9px;overflow-x:auto;font-size:12px}' +
  'code{font-family:ui-monospace,"Cascadia Code",Consolas,monospace;font-size:12.5px;background:rgba(255,250,240,.07);border-radius:5px;padding:1.5px 5px;overflow-wrap:anywhere}' +
  'pre code{background:none;padding:0;border-radius:0;overflow-wrap:normal;font-weight:400}' +
  '.mdh1{font-size:19px;font-weight:700;margin:15px 0 7px}.mdh2{font-size:17px;font-weight:650;margin:13px 0 6px}' +
  '.mdh3{font-size:15px;font-weight:650;margin:11px 0 5px}.mdh4{font-size:13.5px;font-weight:600;color:#A79F92;margin:11px 0 5px}' +
  'ul,ol{margin:7px 0;padding-left:20px;font-weight:400}li{margin:3px 0}' +
  'blockquote{margin:8px 0;padding:2px 0 2px 11px;border-left:2px solid rgba(255,255,255,.16);color:#A79F92;font-weight:400}' +
  'hr{border:0;height:1px;background:rgba(255,255,255,.1);margin:11px 0}' +
  'table{border-collapse:collapse;margin:8px 0;font-size:12.5px;display:block;overflow-x:auto;max-width:100%}' +
  'th,td{padding:5px 12px 5px 0;border-bottom:1px solid rgba(255,255,255,.08);text-align:left;font-variant-numeric:tabular-nums;font-weight:400}' +
  'th{color:#A79F92;font-weight:600;white-space:nowrap}' +
  'a{color:#D97757;text-decoration:none;border-bottom:1px dashed rgba(217,119,87,.45);overflow-wrap:anywhere}' +
  '.note{font-size:12px;color:#A79F92;margin:10px 0}';
export function docShell(body, extraCss) {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>' + DOC_CSS + (extraCss || '') + '</style></head><body>' + body + '</body></html>';
}

/* v139: md render - frontmatter strip + miniMd into the shared shell. Links
   open in new tabs (the md iframe rides allow-popups). */
export function mdDoc(src) {
  return docShell(miniMd(mdFrontmatter(src)));
}

/* v142 csv/tsv render - RFC4180 fields (quoted delimiters/quotes/newlines),
   first row as header, 500-row cap (huge dumps would explode the DOM). The
   table flows the page (display:table) so the sticky header tracks the body
   scroll instead of a nested overflow box. */
const CSV_MAX_ROWS = 500;
export function csvDoc(src, delim) {
  const text = String(src).replace(/^﻿/, '');
  const d = delim === '\t' ? '\t' : ',';
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"' && !field) inQ = true;
    else if (ch === d) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++; // CRLF is one break
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return docShell('<p class="note">（空文件）</p>');
  const shown = rows.slice(0, CSV_MAX_ROWS);
  let html = '<table><thead><tr>' + shown[0].map((h) => '<th>' + ESC(h) + '</th>').join('') + '</tr></thead><tbody>';
  for (let r = 1; r < shown.length; r++) html += '<tr>' + shown[r].map((c) => '<td>' + ESC(c) + '</td>').join('') + '</tr>';
  html += '</tbody></table>';
  if (rows.length > CSV_MAX_ROWS) html += '<p class="note">共 ' + rows.length + ' 行，仅显示前 ' + CSV_MAX_ROWS + ' 行</p>';
  return docShell(html,
    'table{display:table;width:100%;max-width:none;font-size:13px}' +
    'thead th{position:sticky;top:0;background:#1D1C1A;box-shadow:0 1px 0 rgba(255,255,255,.14);white-space:normal}' +
    'th,td{padding:6px 14px 6px 0;white-space:pre-wrap;overflow-wrap:anywhere}');
}

/* v142 json render - pretty print + token colors. Coloring runs on the
   ESCAPED text (quotes stay literal so the string regex sees real
   delimiters; entities inside strings survive untouched inside their span).
   Unparseable files degrade to a noted raw view instead of an empty tab. */
export function jsonDoc(src) {
  const text = String(src).replace(/^﻿/, '').trim();
  let pretty;
  try { pretty = JSON.stringify(JSON.parse(text), null, 2); }
  catch { return docShell('<p class="note">JSON 解析失败，原样显示</p><pre>' + ESC(text.slice(0, 128 * 1024)) + '</pre>'); }
  let note = '';
  if (pretty.length > 256 * 1024) { pretty = pretty.slice(0, 256 * 1024); note = '<p class="note">… 超过 256KB 已截断，完整内容见源码</p>'; }
  const colored = ESC(pretty).replace(
    /("(?:[^"\\]|\\[\s\S])*")(\s*:)|("(?:[^"\\]|\\[\s\S])*")|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\btrue\b|\bfalse\b|\bnull\b/g,
    (m, k, colon, str) =>
      k ? '<span class="jk">' + k + '</span>' + colon
        : str ? '<span class="jstr">' + str + '</span>'
          : (m === 'true' || m === 'false' || m === 'null') ? '<span class="jlit">' + m + '</span>'
            : '<span class="jnum">' + m + '</span>'
  );
  return docShell(note + '<pre style="white-space:pre-wrap;overflow-wrap:anywhere">' + colored + '</pre>',
    '.jk{color:#A79F92}.jstr{color:#8FB98D}.jnum{color:#D9A262}.jlit{color:#E8926F}');
}

/* v143/v144 diff/patch render - parse the unified grammar into a PAIRED row
   model, then render BOTH layouts into one doc: stacked (default, the v142
   look) and side-by-side, switched by a CSS-only checkbox (no script for
   small diffs). Inside each hunk context lines pair naturally (same order on
   both sides); del/add runs pair index-wise and the longer side spills into
   one-sided rows - hunk sizes are small, no LCS needed. Patch metadata
   (From / diff --git / index / the bare --- separator / diffstat block)
   renders as full-width prose rows. v144: only the FIRST chunk (2000 rows)
   renders upfront; the rest rides as a JSON payload of prebuilt [stacked,
   split] html pairs and a tiny OWN inline script appends chunks on demand -
   model content was ESC'd when the pairs were built, the script never
   touches raw text. Hard ceiling 10000 rows (beyond: pointer to the source
   tab) keeps monster patches from sinking the phone. */
const DIFF_CHUNK = 2000;
const DIFF_HARD = 10000;
export function diffRows(src) {
  const all = String(src).replace(/^﻿/, '').split('\n');
  if (all.length && all[all.length - 1] === '') all.pop();
  const rows = [];
  let oldS = null, newS = null; // null = outside a hunk (headers/prose)
  const flush = () => {
    if (!oldS) return;
    let i = 0, j = 0;
    while (i < oldS.length || j < newS.length) {
      if (i < oldS.length && j < newS.length && oldS[i].t === 'ctx' && newS[j].t === 'ctx') {
        rows.push({ k: 'ctx', l: oldS[i].s, r: newS[j].s }); i++; j++; continue;
      }
      let di = i, dj = j;
      while (di < oldS.length && oldS[di].t !== 'ctx') di++;
      while (dj < newS.length && newS[dj].t !== 'ctx') dj++;
      if (di === i && dj === j) { i++; j++; continue; } // paranoia: never stall
      const ds = oldS.slice(i, di), as = newS.slice(j, dj);
      for (let x = 0; x < Math.max(ds.length, as.length); x++) {
        if (ds[x] && as[x]) rows.push({ k: 'mod', l: ds[x].s, r: as[x].s });
        else if (ds[x]) rows.push({ k: 'del', l: ds[x].s });
        else rows.push({ k: 'add', r: as[x].s });
      }
      i = di; j = dj;
    }
    oldS = newS = null;
  };
  for (const ln of all) {
    if (/^--- /.test(ln) || ln === '---' || /^\+\+\+ /.test(ln)) { flush(); rows.push({ k: 'file', l: ln }); continue; }
    if (/^@@/.test(ln)) { flush(); rows.push({ k: 'hunk', l: ln }); oldS = []; newS = []; continue; }
    // only true section delimiters force a flush; From/Date/Subject/index
    // prose needs no special case - outside hunks everything is text anyway,
    // and recognizing them inside hunks would misfire on patched code lines
    if (/^diff --git |^-- $/.test(ln)) { flush(); rows.push({ k: 'text', l: ln }); continue; }
    if (oldS) {
      if (ln.startsWith('-')) oldS.push({ t: 'del', s: ln });
      else if (ln.startsWith('+')) newS.push({ t: 'add', s: ln });
      else { oldS.push({ t: 'ctx', s: ln }); newS.push({ t: 'ctx', s: ln }); }
    } else rows.push({ k: 'text', l: ln });
  }
  flush();
  return rows;
}
export function diffDoc(src) {
  const all = diffRows(src);
  const rows = all.length > DIFF_HARD ? all.slice(0, DIFF_HARD) : all;
  if (all.length > rows.length) rows.push({ k: 'text', l: '… 共 ' + all.length + ' 行，仅渲染前 ' + DIFF_HARD + ' 行，完整内容见源码' });
  let adds = 0, dels = 0;
  for (const r of rows) {
    if (r.k === 'mod') { adds++; dels++; }
    else if (r.k === 'add') adds++;
    else if (r.k === 'del') dels++;
  }
  // one builder per row -> [stacked html, split html]; reused for the first
  // chunk AND the lazy payload so the two can never drift apart
  const ZWSP = '&#8203;'; // keep empty lines one row tall
  const cell = (s, cls) => '<div class="dc ' + cls + '">' + (ESC(s) || ZWSP) + '</div>';
  const GAP = '<div class="dc gap">' + ZWSP + '</div>';
  const rowHtml = (r) => {
    const t = (s) => ESC(s) || ZWSP;
    if (r.k === 'file') return ['<div class="dl dfile">' + t(r.l) + '</div>', '<div class="drow full">' + cell(r.l, 'dfile') + '</div>'];
    if (r.k === 'hunk') return ['<div class="dl hunk">' + t(r.l) + '</div>', '<div class="drow full">' + cell(r.l, 'hunk') + '</div>'];
    if (r.k === 'text') return ['<div class="dl ctx">' + t(r.l) + '</div>', '<div class="drow full">' + cell(r.l, 'ctx') + '</div>'];
    if (r.k === 'ctx') return ['<div class="dl ctx">' + t(r.l) + '</div>', '<div class="drow">' + cell(r.l, 'ctx') + cell(r.r, 'ctx') + '</div>'];
    if (r.k === 'del') return ['<div class="dl del">' + t(r.l) + '</div>', '<div class="drow">' + cell(r.l, 'del') + GAP + '</div>'];
    if (r.k === 'add') return ['<div class="dl add">' + t(r.r) + '</div>', '<div class="drow">' + GAP + cell(r.r, 'add') + '</div>'];
    return ['<div class="dl del">' + t(r.l) + '</div><div class="dl add">' + t(r.r) + '</div>',
      '<div class="drow">' + cell(r.l, 'del') + cell(r.r, 'add') + '</div>']; // mod: stacked vs pair
  };
  let un = '', sp = '';
  const first = rows.slice(0, DIFF_CHUNK).map(rowHtml);
  for (const [u, s] of first) { un += u; sp += s; }
  const rest = rows.slice(DIFF_CHUNK);
  let more = '';
  if (rest.length) {
    // < is escaped to < INSIDE the JSON string so no payload content can
    // ever close the host <script> tag; JSON.parse turns it back into <
    const payload = JSON.stringify(rest.map(rowHtml)).replace(/</g, '\\u003c');
    more = '<script type="application/json" id="dpay">' + payload + '</script>' +
      '<button id="dmore" class="dmore" type="button">加载更多（还有 ' + rest.length + ' 行）</button>' +
      '<scr' + 'ipt>(function(){var P=JSON.parse(document.getElementById("dpay").textContent),i=0,b=document.getElementById("dmore");' +
      'b.addEventListener("click",function(){var n=Math.min(' + DIFF_CHUNK + ',P.length-i),u="",s="";' +
      'for(var k=0;k<n;k++){u+=P[i][0];s+=P[i][1];i++;}' +
      'document.querySelector(".dlist").insertAdjacentHTML("beforeend",u);' +
      'document.querySelector(".dsplit").insertAdjacentHTML("beforeend",s);' +
      'if(i>=P.length){b.parentNode.removeChild(b);}else{b.textContent="加载更多（还有 "+(P.length-i)+" 行）";}});})();</scr' + 'ipt>';
  }
  // the checkbox precedes everything it toggles; the label doubles as a
  // segmented control whose active pill also keys off the checkbox state.
  // v144: stats and pills share one 22px box (line-height/flex centers) so
  // the two sides align regardless of device font metrics.
  return docShell(
    '<input id="dmode" type="checkbox" class="dm-cb">' +
    '<div class="dtools"><p class="dstats"><span class="ins">+' + adds + '</span> <span class="dele">−' + dels + '</span></p>' +
    '<label class="dseg" for="dmode"><span class="a">上下</span><span class="b">并排</span></label></div>' +
    '<div class="dlist">' + un + '</div><div class="dsplit">' + sp + '</div>' + more,
    '.dm-cb{position:absolute;opacity:0;pointer-events:none}' +
    '.dm-cb:checked ~ .dlist{display:none}.dm-cb:not(:checked) ~ .dsplit{display:none}' +
    '.dtools{display:flex;align-items:center;justify-content:space-between;margin:2px 0 10px}' +
    '.dstats{margin:0;font-size:12.5px;line-height:22px}.dstats .ins{color:#8FB98D}.dstats .dele{color:#DB6B5E}' +
    '.dseg{display:inline-flex;align-items:center;height:22px;border-radius:999px;background:#2E2B26;font-size:11px;line-height:1;cursor:pointer;overflow:hidden;user-select:none;-webkit-user-select:none}' +
    '.dseg span{display:flex;align-items:center;height:100%;padding:0 12px;color:#A79F92}' +
    '.dm-cb:not(:checked) ~ .dtools .dseg .a,.dm-cb:checked ~ .dtools .dseg .b{background:rgba(217,119,87,.18);color:#E8926F;font-weight:600}' +
    '.dmore{display:block;width:100%;margin:10px 0 0;padding:10px;border:0;border-radius:10px;background:#2E2B26;color:#E8926F;font:600 12.5px -apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;cursor:pointer}' +
    '.dlist{font:11.5px/1.5 ui-monospace,"Cascadia Code",Consolas,monospace;background:#171613;border-radius:10px;overflow:hidden}' +
    '.dl{padding:2.5px 10px;white-space:pre-wrap;overflow-wrap:anywhere}' +
    '.dl.dfile{color:#A79F92;padding-top:8px}.dl.hunk{color:#E8926F;background:rgba(217,119,87,.08)}' +
    '.dl.add{background:rgba(143,185,141,.10)}.dl.del{background:rgba(219,107,94,.10)}.dl.ctx{color:#C9C2B6}' +
    '.dsplit{font:11.5px/1.5 ui-monospace,"Cascadia Code",Consolas,monospace;background:#171613;border-radius:10px;overflow:hidden}' +
    '.drow{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}' +
    '.drow.full{grid-template-columns:1fr}' +
    '.dc{padding:2.5px 8px;white-space:pre-wrap;overflow-wrap:anywhere;color:#C9C2B6}' +
    '.drow .dc + .dc{border-left:1px solid rgba(255,255,255,.07)}' +
    '.dc.dfile{color:#A79F92;padding-top:8px}.dc.hunk{color:#E8926F;background:rgba(217,119,87,.08)}' +
    '.dc.add{background:rgba(143,185,141,.10)}.dc.del{background:rgba(219,107,94,.10)}.dc.gap{color:#C9C2B6}');
}

/* artifact linkify: absolute file paths (Windows drives + POSIX /) in tool
   text become links; separators tolerate the JSON-doubled backslashes shown
   in tool chips; only whitelisted extensions linkify (avoids mangling
   ordinary sentences); the lookbehind keeps URLs (//) and relative paths out */
export const ART_IMG = /\.(png|jpe?g|webp|gif|bmp|svg)$/i;
const ART_PATH_RE = /(?<![\w/])(?:[A-Za-z]:[\\/]{1,2}|\/)(?:[^\s"'<>|:*?\\/]+[\\/]{1,2})*[^\s"'<>|:*?\\/]*\.(?:png|jpe?g|webp|gif|bmp|svg|txt|md|log|json|csv|tsv|ya?ml|xml|html?|css|mjs|cjs|js|ts|py|ps1|sh|ini|toml|diff|patch)\b/gi;
export function linkifyPaths(el, text, onOpen) {
  if (!text) return;
  let last = 0, mm;
  ART_PATH_RE.lastIndex = 0;
  while ((mm = ART_PATH_RE.exec(text))) {
    const raw = mm[0];
    el.appendChild(document.createTextNode(text.slice(last, mm.index)));
    const a = document.createElement('a');
    a.className = 'flink';
    a.textContent = raw;
    a.href = '#';
    a.onclick = (e) => { e.preventDefault(); onOpen(raw.replace(/\\\\/g, '\\')); };
    el.appendChild(a);
    last = mm.index + raw.length;
  }
  el.appendChild(document.createTextNode(text.slice(last)));
}

/* v106: DOM-walking variant for markdown-rendered containers (conclusion
   text). linkifyPaths() rebuilds an element from raw text - unusable once
   miniMd has formatted the node; this walks text nodes and splices the same
   .flink anchors in place, skipping anchors/code/pre. */
export function linkifyDom(root, onOpen) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const targets = [];
  while (walker.nextNode()) {
    const n = walker.currentNode;
    const p = n.parentElement;
    if (p && p.closest('a, code, pre')) continue;
    if (n.nodeValue && n.nodeValue.match(ART_PATH_RE)) targets.push(n);
  }
  for (const n of targets) {
    const s = n.nodeValue;
    const frag = document.createDocumentFragment();
    let last = 0, mm;
    ART_PATH_RE.lastIndex = 0;
    while ((mm = ART_PATH_RE.exec(s))) {
      const raw = mm[0];
      if (mm.index > last) frag.appendChild(document.createTextNode(s.slice(last, mm.index)));
      const a = document.createElement('a');
      a.className = 'flink';
      a.textContent = raw;
      a.href = '#';
      a.onclick = (e) => { e.preventDefault(); onOpen(raw.replace(/\\\\/g, '\\')); };
      frag.appendChild(a);
      last = mm.index + raw.length;
    }
    if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last)));
    n.parentNode.replaceChild(frag, n);
  }
}
