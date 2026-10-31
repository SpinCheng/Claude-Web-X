// lib/mime.js - content types for static serving and artifact preview
export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
};

// previewable mid-run artifacts (v23): images inline; everything textual as
// text/plain - html/svg are deliberately NEVER served as markup from the
// bridge (kills any XSS vector from a model-written file; svg reaches the
// client lightbox by a client-side blob re-type into an <img>, where svg
// scripts never run), unknown extensions are refused
export const PREVIEW_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8', '.json': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8', '.tsv': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8', '.yaml': 'text/plain; charset=utf-8',
  '.xml': 'text/plain; charset=utf-8',
  '.diff': 'text/plain; charset=utf-8', '.patch': 'text/plain; charset=utf-8',
  '.svg': 'text/plain; charset=utf-8',
  '.html': 'text/plain; charset=utf-8', '.htm': 'text/plain; charset=utf-8',
  '.css': 'text/plain; charset=utf-8', '.js': 'text/plain; charset=utf-8',
  '.mjs': 'text/plain; charset=utf-8', '.cjs': 'text/plain; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8', '.py': 'text/plain; charset=utf-8',
  '.ps1': 'text/plain; charset=utf-8', '.sh': 'text/plain; charset=utf-8',
  '.ini': 'text/plain; charset=utf-8', '.toml': 'text/plain; charset=utf-8',
};
