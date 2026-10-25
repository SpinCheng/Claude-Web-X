// ctxprobe.js - ground-truth context breakdown via the CLI's /context command.
//
// The CLI's own accounting (what the Desktop popover shows) splits the context
// window into System prompt / System tools / MCP tools / MCP server
// instructions / Memory files / Skills / Messages / Autocompact buffer /
// Free space. Those fixed parts depend only on (cwd, model) - not on the
// session - so we measure them once with a THROWAWAY -p session: spawn
// `claude -p --output-format stream-json /context`, parse the markdown table,
// then trash the junk transcript the run leaves behind. Cached in memory and
// on disk (bridge/data/ctx-probe.json); one probe at a time per key.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PROBE_TIMEOUT_MS = 60_000;

// "48.7k" / "1m" / "206" -> integer tokens
function toTokens(s) {
  const m = String(s).trim().match(/^([\d.]+)\s*([km]?)$/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const mult = m[2].toLowerCase() === 'k' ? 1e3 : m[2].toLowerCase() === 'm' ? 1e6 : 1;
  return Math.round(n * mult);
}

// Row names in /context output -> normalized keys. "Messages"/"Free space"
// depend on the throwaway session and are ignored (PWA derives them itself).
const ROW_KEYS = {
  'system prompt': 'system',
  'system tools': 'tools',
  'system tools (deferred)': 'toolsDeferred',
  'mcp tools': 'mcp',
  'mcp tools (deferred)': 'mcpDeferred',
  'mcp server instructions': 'mcpInstr',
  'memory files': 'memory',
  'skills': 'skills',
  'custom agents': 'agents',
  'autocompact buffer': 'buffer',
  'compact buffer': 'buffer',
};

function parseContextReport(text) {
  const out = { window: null, buffer: 0, fixed: { system: 0, tools: 0, mcp: 0, mcpInstr: 0, memory: 0, skills: 0 } };
  const wm = text.match(/\*\*Tokens:\*\*\s*[\d.]+[km]?\s*\/\s*([\d.]+[km]?)/i);
  if (wm) out.window = toTokens(wm[1]);
  const rowRe = /^\|\s*([^|]+?)\s*\|\s*([\d.]+[km]?)\s*\|/gm;
  let m;
  while ((m = rowRe.exec(text))) {
    const key = ROW_KEYS[m[1].trim().toLowerCase()];
    if (!key) continue;
    const n = toTokens(m[2]);
    if (key === 'buffer') out.buffer = out.buffer || n;
    else if (key in out.fixed) out.fixed[key] = n;
  }
  out.fixed.total = Object.values(out.fixed).reduce((a, b) => a + (b || 0), 0);
  return out;
}

export class CtxProbe {
  constructor(opts = {}) {
    this.runner = opts.runner;       // for resolveClaude() + settingsEnv()
    this.adapter = opts.adapter;     // for archiveSession() cleanup
    this.cachePath = opts.cachePath || '';
    this.defaultCwd = opts.defaultCwd || '';
    this.cache = new Map();          // "cwd|modelId" -> report
    this.inflight = new Map();
    try {
      if (this.cachePath && fs.existsSync(this.cachePath)) {
        for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(this.cachePath, 'utf8')))) {
          this.cache.set(k, v);
        }
      }
    } catch { /* corrupt cache: start empty */ }
  }

  get(cwd, modelId) {
    const key = (cwd || this.defaultCwd) + '|' + (modelId || '');
    if (this.cache.has(key)) return Promise.resolve(this.cache.get(key));
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = this._probe(cwd, modelId)
      .then((r) => { this._persist(); return r; })
      .finally(() => this.inflight.delete(key))
      .catch((e) => { throw e; });
    this.inflight.set(key, p);
    return p;
  }

  _persist() {
    try {
      if (this.cachePath) {
        fs.writeFileSync(this.cachePath, JSON.stringify(Object.fromEntries(this.cache)));
      }
    } catch { /* non-fatal */ }
  }

  _probe(cwd, modelId) {
    return new Promise((resolve, reject) => {
      const exe = this.runner.resolveClaude();
      const args = ['-p'];
      if (modelId) args.push('--model', modelId);
      args.push('/context', '--output-format', 'stream-json', '--verbose');
      const child = spawn(exe, args, {
        cwd: cwd || this.defaultCwd || undefined,
        env: { ...process.env, ...this.runner.settingsEnv() },
        windowsHide: true,
      });
      let out = '', sessionId = '';
      const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, PROBE_TIMEOUT_MS);
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.stderr.on('data', () => { /* noise */ });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        try {
          for (const line of out.split('\n')) {
            if (!line.trim()) continue;
            try {
              const o = JSON.parse(line);
              if (o.type === 'system' && o.session_id) sessionId = o.session_id;
              if (o.type === 'result' && o.result) out += '\n' + o.result; // keep both; parser scans for the table
            } catch { /* not json */ }
          }
          const report = parseContextReport(out);
          if (!report.window || report.fixed.total === 0) {
            throw new Error('unparseable /context output');
          }
          report.at = Date.now();
          const key = (cwd || this.defaultCwd) + '|' + (modelId || '');
          this.cache.set(key, report);
          // trash the throwaway transcript so it never shows up anywhere
          if (sessionId) { try { this.adapter.archiveSession(sessionId); } catch { /* benign */ } }
          resolve(report);
        } catch (e) {
          reject(new Error('ctxprobe: ' + (e && e.message || e) + ' (exit ' + code + ')'));
        }
      });
    });
  }
}
