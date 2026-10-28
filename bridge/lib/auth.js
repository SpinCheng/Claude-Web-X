// lib/auth.js - request auth + body readers shared by every route
import crypto from 'node:crypto';

export function authOk(req, url, cfg) {
  const q = url.searchParams.get('token') || '';
  const h = req.headers.authorization || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7) : '';
  const given = q || bearer;
  if (!given || given.length !== cfg.token.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(cfg.token));
  } catch {
    return false;
  }
}

export function readBody(req, limit) {
  return new Promise((resolve) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); resolve(''); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

// binary variant for attachment uploads (raw bytes, capped)
export function readRawBody(req, limit) {
  return new Promise((resolve) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}
