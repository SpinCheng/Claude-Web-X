// js/md.js - pure text/DOM helpers for transcript rendering: markdown
// (conclusion cards, v25) + file-path linkify (artifact preview, v23) +
// md file render preview (frontmatter strip + standalone srcdoc doc, v139).
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

/* v139: wrap miniMd output in a standalone doc for the #hp-frame srcdoc
   (opaque-origin iframe - parent CSS vars don't reach it, so the tokens are
   inlined to mirror the conclusion-card styles). Content is miniMd's
   escape-first output: raw HTML/<script> arrive as text, links are https?
   only. Links open in new tabs (the md iframe rides allow-popups). */
export function mdDoc(src) {
  const body = miniMd(mdFrontmatter(src));
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>' +
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
    '</style></head><body>' + body + '</body></html>';
}

/* artifact linkify: absolute file paths (Windows drives + POSIX /) in tool
   text become links; separators tolerate the JSON-doubled backslashes shown
   in tool chips; only whitelisted extensions linkify (avoids mangling
   ordinary sentences); the lookbehind keeps URLs (//) and relative paths out */
export const ART_IMG = /\.(png|jpe?g|webp|gif|bmp)$/i;
const ART_PATH_RE = /(?<![\w/])(?:[A-Za-z]:[\\/]{1,2}|\/)(?:[^\s"'<>|:*?\\/]+[\\/]{1,2})*[^\s"'<>|:*?\\/]*\.(?:png|jpe?g|webp|gif|bmp|txt|md|log|json|csv|ya?ml|xml|html?|css|mjs|cjs|js|ts|py|ps1|sh|ini|toml)\b/gi;
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
