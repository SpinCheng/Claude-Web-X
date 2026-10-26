// adapter-cc.js - watches ~/.claude/projects/**/*.jsonl and maintains
// SessionRecords + streams parsed transcript events.
//
// Confirmed line schema (Phase 0 field test, 2026-10-25):
//   user:         { message: { role, content: string | parts[] }, origin: { kind: 'human' }, cwd, timestamp }
//   assistant:    { message: { role: 'assistant', model, content: [{type:'thinking'|'text'|'tool_use', ...}] } }
//   custom-title: { customTitle }
//   cost-state:   { totalCostUSD, modelUsage: { <model>: { inputTokens, outputTokens, ... } } }
//   system:       { subtype, ... }  (stop-ish subtypes => idle)
//   others:       attachment / api-request* / last-prompt / queue-operation / ... (ignored)
//
// Display event model emitted to clients:
//   { k: 'user'|'assistant'|'title'|'stats'|'status', ts, text?, parts?, title?, stats? }
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { Tailer } from './tailer.js';

const ACTIVE_WINDOW_MS = 120_000;
// terminal-ish system subtypes => idle + a last run outcome the PWA can show
const STOP_SUBTYPES = new Set([
  'stop_hook_summary', 'stop', 'interrupt', 'error', 'max_turns', 'permission_denied',
]);
const OUTCOME_SUBTYPES = {
  interrupt: 'stopped',
  error: 'failed',
  max_turns: 'failed',
  permission_denied: 'failed',
  stop: 'ok',
  stop_hook_summary: 'ok',
};

export class CcAdapter extends EventEmitter {
  constructor(store, rootOverride, trashDir) {
    super();
    this.store = store;
    this.root = rootOverride || path.join(os.homedir(), '.claude', 'projects');
    this.trashDir = trashDir || path.join(this.root, '..', 'claude-remote-trash');
    this.tailers = new Map(); // transcriptPath -> { tailer, id }
    this.archived = new Set(); // transcriptPaths deleted via archiveSession (tombstones)
    this._pending = new Set();
    this._drainTimer = null;
  }

  start() {
    this.rescan();
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (evt, file) => {
        if (!file) return;
        const p = path.join(this.root, file.split(/[\\/]/).join(path.sep));
        if (p.endsWith('.jsonl')) this._scheduleDrain(p);
      });
    } catch {
      // recursive watch unsupported (old Node / some FS) -> polling fallback
      this.pollTimer = setInterval(() => { this.rescan(true); }, 1500);
    }
    // safety net: periodic rescan regardless of watcher
    this.slowTimer = setInterval(() => { this.rescan(); }, 10_000);
  }

  stop() {
    for (const t of [this.watcher, this.pollTimer, this.slowTimer, this._drainTimer]) {
      try { if (t) (t.close ? t.close() : clearInterval(t)); } catch { /* noop */ }
    }
  }

  // Discover all *.jsonl under root; create records + tailers; drop records
  // whose file has been gone for two consecutive rescans (deleted sessions).
  rescan(drain = false) {
    let dirs = [];
    try { dirs = fs.readdirSync(this.root, { withFileTypes: true }); } catch { return; }
    const seen = new Set();
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const projDir = path.join(this.root, d.name);
      let files = [];
      try { files = fs.readdirSync(projDir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const p = path.join(projDir, f);
        seen.add(p);
        this._ensureSession(p, d.name);
        if (drain) this._scheduleDrain(p);
      }
    }
    // eviction: known transcripts that vanished from disk (two consecutive
    // rescans ~= 20s; a phone-run never removes its own file mid-run)
    for (const [p, entry] of this.tailers) {
      if (seen.has(p)) { entry.miss = 0; continue; }
      entry.miss = (entry.miss || 0) + 1;
      if (entry.miss >= 2) {
        this.tailers.delete(p);
        this.store.drop(entry.id);
      }
    }
  }

  _ensureSession(transcriptPath, projectDirName) {
    if (this.tailers.has(transcriptPath) || this.archived.has(transcriptPath)) return;
    const id = path.basename(transcriptPath, '.jsonl');
    this.tailers.set(transcriptPath, { tailer: new Tailer(transcriptPath), id });
    let st = { mtimeMs: 0, size: 0 };
    try { st = fs.statSync(transcriptPath); } catch { /* gone */ }
    this.store.upsert({
      id, kind: 'cc', project: projectDirName,
      transcriptPath, lastActive: Math.round(st.mtimeMs) || 0,
      title: '(loading)',
    });
    // Initial drain (without emitting appends for backfill; records only)
    this._drain(transcriptPath, false);
  }

  _scheduleDrain(transcriptPath) {
    this._ensureSession(transcriptPath, path.basename(path.dirname(transcriptPath)));
    this._pending.add(transcriptPath);
    if (this._drainTimer) return;
    this._drainTimer = setTimeout(() => {
      this._drainTimer = null;
      const files = [...this._pending];
      this._pending.clear();
      for (const f of files) this._drain(f, true);
    }, 200);
  }

  // Parse new lines of one transcript. emitAppends=false -> only update record meta.
  _drain(transcriptPath, emitAppends) {
    const entry = this.tailers.get(transcriptPath);
    if (!entry) return;
    let lines = [];
    try { lines = entry.tailer.readNew(); } catch { return; }
    if (lines.length === 0) return;
    const rec = this.store.get(entry.id) || {};
    const patch = {
      id: entry.id, lines: (rec.lines || 0) + lines.length,
      // running transcript-composition estimate (chars), for the context sheet;
      // store.upsert merges shallowly, so seed from the record then accumulate
      est: { tools: (rec.est && rec.est.tools) || 0, think: (rec.est && rec.est.think) || 0, prose: (rec.est && rec.est.prose) || 0 },
    };
    const events = [];
    let latestTs = 0;

    for (const line of lines) {
      let obj;
      try { obj = JSON.parse(line); } catch { continue; } // tolerate partial/garbage
      const ev = this._applyLine(entry.id, obj, patch, events);
      if (ev) events.push(ev);
      const ts = Date.parse(obj.timestamp || '');
      if (Number.isFinite(ts) && ts > latestTs) latestTs = ts;
    }

    if (latestTs > (rec.lastActive || 0)) {
      patch.lastActive = latestTs;
      patch.status = 'active';
    } else if (!patch.lastActive) {
      try {
        const st = fs.statSync(transcriptPath);
        patch.lastActive = Math.round(st.mtimeMs);
      } catch { /* noop */ }
    }
    this.store.upsert(patch);
    // freshness-based status correction (only when no explicit stop seen)
    const after = this.store.get(entry.id);
    if (after && after.status === 'active' && Date.now() - after.lastActive > ACTIVE_WINDOW_MS) {
      this.store.upsert({ id: entry.id, status: 'idle' });
    }
    if (emitAppends && events.length > 0) {
      this.emit('append', { id: entry.id, events });
    }
  }

  // Returns a display event or null; mutates patch/rec-props via events.
  _applyLine(id, obj, patch, events) {
    switch (obj.type) {
      case 'user': {
        const cRaw = obj.message && obj.message.content;
        // 2.1.308: local-tool results carry origin=null (only MCP results set
        // origin.kind) - classify by CONTENT, not origin: a tool_result block
        // means machine turn regardless
        const hasToolRes = Array.isArray(cRaw) && cRaw.some((p) => p && p.type === 'tool_result');
        if (hasToolRes || (obj.origin && obj.origin.kind !== 'human')) {
          // tool_result payload: paired back to tool steps below for display,
          // and the biggest context consumer - feed the composition estimate
          const c = cRaw;
          if (patch.est) {
            let n = 0;
            if (typeof c === 'string') n = c.length;
            else if (Array.isArray(c)) {
              for (const p of c) {
                if (!p) continue;
                n += typeof p.text === 'string' ? p.text.length : 0;
                if (p.content) { try { n += JSON.stringify(p.content).length; } catch { /* skip */ } }
                else if (p.type !== 'text') { try { n += JSON.stringify(p).length; } catch { /* skip */ } }
              }
            }
            if (n) patch.est.tools += n + 16;
          }
          // tool results: pair back to their tool_use by id so the PWA can
          // show the run's actual output (text capped, images inline)
          const items = [];
          if (Array.isArray(c)) {
            for (const p of c) {
              if (!p || p.type !== 'tool_result' || !p.tool_use_id) continue;
              let text = '';
              const images = [];
              const rc = p.content;
              if (typeof rc === 'string') text = rc;
              else if (Array.isArray(rc)) {
                for (const b of rc) {
                  if (!b) continue;
                  if (b.type === 'text' && b.text) text += (text ? '\n' : '') + b.text;
                  else if (b.type === 'image' && b.source && b.source.data && images.length < 4) {
                    images.push({ mt: b.source.media_type || 'image/png', data: b.source.data });
                  }
                }
              }
              items.push({
                id: p.tool_use_id,
                text: text.length > 4000 ? text.slice(0, 4000) + '\n…(截断，共 ' + text.length + ' 字符)' : text,
                err: !!p.is_error,
                images,
              });
            }
          }
          if (!items.length) return null; // pure noise (queued/guideline lines etc.)
          return { k: 'toolres', ts: obj.timestamp || '', items };
        }
        const c = obj.message && obj.message.content;
        let text = '';
        const images = [];
        if (typeof c === 'string') text = c;
        else if (Array.isArray(c)) {
          for (const p of c) {
            if (!p) continue;
            if (p.type === 'text') text += (text ? '\n' : '') + p.text;
            else if (p.type === 'image' && p.source && p.source.data) {
              images.push({ mt: p.source.media_type || 'image/png', data: p.source.data });
            }
          }
        }
        if (!text && !images.length) return null;
        text = stripReminder(text);
        if (!text && !images.length) return null;
        // CLI-injected chatter: when an image is attached the CLI adds its own
        // user turn pointing the model at the extracted temp file - not human
        // content, fold it out of the timeline
        if (!images.length && /^\[Image: source: .+\]\s*$/.test(text)) return null;
        if (patch.est) patch.est.prose += text.length;
        // fallback title from first human message only; explicit custom-title wins.
        // Guard against same-batch overwrites (store not yet updated mid-batch).
        const rec = this.store.get(id);
        // first human message length: needed once to derive the fixed overhead
        // (system prompt + tools) from the first request's prompt size
        if (rec && rec.firstUserChars == null && patch.firstUserChars == null && text) {
          patch.firstUserChars = text.length;
        }
        const haveTitle = patch.title || (rec && rec.title && rec.title !== '(loading)');
        if (!haveTitle && text) { patch.title = text.slice(0, 48); patch.titleFallback = true; }
        if (obj.cwd) patch.cwd = obj.cwd;
        const ev = { k: 'user', ts: obj.timestamp || '', text };
        if (images.length) ev.images = images;
        return ev;
      }
      case 'assistant': {
        const content = (obj.message && obj.message.content) || [];
        // assistant label wins for the model display; cost-state keys are API ids
        if (obj.message && obj.message.model) patch.model = obj.message.model;
        // last-request context footprint: the ring's data source
        const u = obj.message && obj.message.usage;
        if (u) {
          patch.usage = {
            in: u.input_tokens ?? 0,
            cacheRead: u.cache_read_input_tokens ?? 0,
            cacheCreate: u.cache_creation_input_tokens ?? 0,
            out: u.output_tokens ?? 0,
          };
          // fixed overhead (system prompt + tool schemas + memory): the FIRST
          // request's full prompt minus the first user message. Desktop's
          // "Messages" category = used - fixed, so mirror that split here.
          const rec0 = this.store.get(id);
          if (rec0 && rec0.usageFirst == null && patch.usageFirst == null) {
            const total = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
            const fu = patch.firstUserChars != null ? patch.firstUserChars : (rec0.firstUserChars != null ? rec0.firstUserChars : 0);
            patch.usageFirst = total;
            patch.fixedTok = Math.min(200_000, Math.max(0, Math.round(total - fu / 2.5)));
          }
        }
        const parts = [];
        for (const p of content) {
          if (!p) continue;
          if (p.type === 'thinking' && p.thinking) {
            parts.push({ t: 'think', v: p.thinking });
            if (patch.est) patch.est.think += p.thinking.length;
          }
          else if (p.type === 'text' && p.text) {
            parts.push({ t: 'text', v: p.text });
            if (patch.est) patch.est.prose += p.text.length;
          }
          else if (p.type === 'tool_use') {
            parts.push({ t: 'tool', name: p.name, id: p.id || '', v: briefJson(p.input) });
            if (patch.est) { try { patch.est.tools += JSON.stringify(p.input || {}).length + 32; } catch { /* skip */ } }
          }
        }
        if (parts.length === 0) return null;
        return { k: 'assistant', ts: obj.timestamp || '', parts };
      }
      case 'custom-title':
        patch.title = obj.customTitle || '';
        patch.titleFallback = false;
        return { k: 'title', ts: '', title: patch.title };
      case 'cost-state': {
        // aggregate across ALL models (a session can switch models mid-way);
        // do NOT touch patch.model here - assistant lines own the display label
        const usage = obj.modelUsage || {};
        let inTok = 0, outTok = 0, cacheRead = 0, cacheCreate = 0, usd = 0;
        for (const m of Object.values(usage)) {
          inTok += m.inputTokens || 0;
          outTok += m.outputTokens || 0;
          cacheRead += m.cacheReadInputTokens || 0;
          cacheCreate += m.cacheCreationInputTokens || 0;
          usd += m.costUSD || 0;
        }
        const stats = { usd: (usd || obj.totalCostUSD || null), inTok, outTok, cacheRead, cacheCreate };
        patch.cost = stats;
        return { k: 'stats', ts: '', stats };
      }
      case 'system': {
        if (STOP_SUBTYPES.has(obj.subtype)) {
          patch.status = 'idle';
          if (OUTCOME_SUBTYPES[obj.subtype]) patch.lastOutcome = OUTCOME_SUBTYPES[obj.subtype];
          // marker event: lets the PWA auto-collapse the live turn the moment
          // ANY driver (Desktop/CLI/phone) finishes, not just phone runs
          return { k: 'stop' };
        }
        return null;
      }
      default:
        return null;
    }
  }

  // Reversible delete: move the transcript into the trash dir (bridge data),
  // drop the record and tailer. Caller must refuse when a run is active.
  // rename across volumes (C: -> D:) throws, so fall back to copy+unlink.
  archiveSession(id) {
    const rec = this.store.get(id);
    if (!rec || !rec.transcriptPath) return { ok: false, error: 'not found' };
    try { fs.mkdirSync(this.trashDir, { recursive: true }); } catch { /* might exist */ }
    const base = path.basename(rec.transcriptPath, '.jsonl');
    const dest = path.join(this.trashDir, base + '-' + Date.now() + '.jsonl');
    try {
      try { fs.renameSync(rec.transcriptPath, dest); }
      catch { fs.copyFileSync(rec.transcriptPath, dest); fs.unlinkSync(rec.transcriptPath); }
    } catch (e) {
      return { ok: false, error: 'fs: ' + (e && e.code || e) };
    }
    // tombstone so the fs.watch delete event doesn't resurrect the record
    this.archived.add(rec.transcriptPath);
    this.tailers.delete(rec.transcriptPath);
    this.store.drop(id);
    return { ok: true, trashedTo: dest };
  }

  // Full message list for detail view (fresh ephemeral tailer, live offsets untouched).
  readTranscript(id, limit = 400) {
    const rec = this.store.get(id);
    if (!rec || !rec.transcriptPath) return null;
    const t = new Tailer(rec.transcriptPath);
    const events = [];
    for (const line of t.readAll()) {
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const ev = this._applyLine(id, obj, {}, events);
      if (ev) events.push(ev);
    }
    return events.slice(-limit);
  }
}

function briefJson(input) {
  try {
    const s = JSON.stringify(input);
    return s && s.length > 300 ? s.slice(0, 300) + '...' : (s || '');
  } catch { return ''; }
}

// Drop <system-reminder>...</system-reminder> blocks (huge injected context).
function stripReminder(text) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, '')
    .trim();
}
