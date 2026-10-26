// js/md.js - pure text/DOM helpers for transcript rendering: markdown
// (conclusion cards, v25) + Windows-path linkify (artifact preview, v23).
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

/* artifact linkify: Windows file paths in tool text become links; separators
   tolerate the JSON-doubled backslashes shown in tool chips; only whitelisted
   extensions linkify (avoids mangling ordinary sentences) */
export const ART_IMG = /\.(png|jpe?g|webp|gif|bmp)$/i;
const ART_PATH_RE = /[A-Za-z]:[\\/]{1,2}(?:[^\s"'<>|:*?\\/]+[\\/]{1,2})*[^\s"'<>|:*?\\/]*\.(?:png|jpe?g|webp|gif|bmp|txt|md|log|json|csv|ya?ml|xml|html?|css|mjs|cjs|js|ts|py|ps1|sh|ini|toml)\b/gi;
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
