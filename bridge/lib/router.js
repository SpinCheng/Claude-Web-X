// lib/router.js - ~40-line pattern router (method + :param paths). The only
// "framework" in the bridge: the ws-only dependency rule stays intact.
export function createRouter() {
  const routes = [];
  const add = (method, pattern, handler) => {
    const names = [];
    // '*' = catch-all wildcard; ':name' = one path segment (decoded)
    const re = new RegExp('^' + pattern
      .split('*')
      .map((seg) => seg
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/:([A-Za-z]+)/g, (_, n) => { names.push(n); return '([^/]+)'; }))
      .join('(.*)') + '$');
    routes.push({ method, re, names, handler });
  };
  return {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    del: (p, h) => add('DELETE', p, h),
    async dispatch(req, res, url) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const params = {};
        r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
        await r.handler(req, res, { url, params });
        return true;
      }
      return false;
    },
  };
}
