// js/api.js - HTTP client: bearer auth + JSON wrapper. Any 401 means the
// stored token is dead; the app registers the recovery callback at boot so
// this module stays free of view logic.
import { state } from './state.js';

let onUnauthorized = () => {};
export function setUnauthorized(fn) { onUnauthorized = fn; }

export function auth() { return { Authorization: 'Bearer ' + state.token }; }

export async function tryToken(token) {
  try {
    const r = await fetch('/api/ping', { headers: { Authorization: 'Bearer ' + token } });
    if (r.status === 401) return false;
    return r.ok;
  } catch { return false; }
}

export async function api(path, opts) {
  const r = await fetch(path, { ...opts, headers: { ...auth(), ...(opts && opts.headers) } });
  if (r.status === 401) { onUnauthorized(); throw new Error('unauthorized'); }
  return r;
}
