// js/util.js - tiny shared helpers: DOM lookup + display formatters.
// No state, no app imports - every other module may depend on this.

export const $ = (id) => document.getElementById(id);

// 'D:\foo\Bar' -> 'Bar' (group labels, detail meta, new-session options)
export function shortPath(p) {
  const parts = String(p).replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}

// ISO -> 'HH:MM' ('' when unparsable) - timestamps on bubbles/final cards
export function fmtTs(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

// epoch ms -> '刚刚 / N 分钟前 / N 小时前 / date' - session list rows
export function relTime(ms) {
  if (!ms) return '';
  const dt = Date.now() - ms;
  if (dt < 60e3) return '刚刚';
  if (dt < 3600e3) return Math.floor(dt / 60e3) + ' 分钟前';
  if (dt < 86400e3) return Math.floor(dt / 3600e3) + ' 小时前';
  return new Date(ms).toLocaleDateString();
}

// 1234567 -> '1.2M' - token counts (ring tooltip, context sheet, model sub)
export function fmtTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
