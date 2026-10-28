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
import { applyLine, fenceTitle } from './parsers-cc.js';

const ACTIVE_WINDOW_MS = 120_000;
// terminal-ish system subtypes => idle + a last run outcome the PWA can show

export class CcAdapter extends EventEmitter {
  constructor(store, rootOverride, trashDir, renamesPath) {
    super();
    this.store = store;
    this.root = rootOverride || path.join(os.homedir(), '.claude', 'projects');
    this.trashDir = trashDir || path.join(this.root, '..', 'claude-remote-trash');
    this.renamesPath = renamesPath || ''; // pins persist across boots (Desktop caches titles across boots too)
    this.renames = new Map(); // sessionId -> { title, prev } while a phone rename must be fenced
    this.forkTitled = new Set(); // fork session ids already given their Fork- title
    try {
      if (this.renamesPath && fs.existsSync(this.renamesPath)) {
        this.renames = new Map(Object.entries(JSON.parse(fs.readFileSync(this.renamesPath, 'utf8'))));
      }
    } catch { /* corrupt file -> start empty */ }
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
      const ev = this._applyLine(entry.id, obj, patch, events, emitAppends);
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

  // live=true only for drains of freshly-appended lines. Historical replays
  // (boot backfill, detail-view re-read) must NEVER disarm a rename pin: the
  // transcript may contain custom-title values older than the pin (earlier
  // renames, CLI test values) and a naive replay disarms the fence, letting
  // the pre-rename title win again (the v40b production bug - boot replay
  // killed the 16:49 pin via a day-old "new" line).
  _applyLine(id, obj, patch, events, live = false) {
    const ev = applyLine(id, obj, patch, events, this.store.get(id));
    // write-fence (v39): Desktop re-emits its cached pre-rename title in
    // metadata flushes; swallow exactly that stale value, disarm on real news
    const pin = this.renames.get(id);
    const act = fenceTitle(pin, obj.customTitle);
    if (act === 'stale') {
      patch.title = pin.title;
      if (ev) ev.title = pin.title;
    } else if (act === 'disarm') {
      if (live) {
        this.renames.delete(id);
        this._saveRenames();
      } else {
        // historical value predating the pin: pin is the newer truth, don't
        // let a day-old title line win during boot/readTranscript replays
        patch.title = pin.title;
        if (ev) ev.title = pin.title;
      }
    }
    return ev;
  }

  // called by the rename route right after the transcript append: pin the new
  // title + the value it replaces so Desktop's cached-title re-emits can't
  // revert it. prev='' when the record had no usable title yet.
  pinRename(id, title) {
    const rec = this.store.get(id) || {};
    const prev = rec.title && rec.title !== '(loading)' ? rec.title : '';
    this.renames.set(id, { title, prev });
    this._saveRenames();
  }

  _saveRenames() {
    if (!this.renamesPath) return; // in-memory only (tests)
    try { fs.writeFileSync(this.renamesPath, JSON.stringify(Object.fromEntries(this.renames))); } catch { /* best effort */ }
  }

  // append a native custom-title line (newline boundary repaired first, so a
  // crash-truncated tail can't concatenate). false = transcript not there (yet).
  appendTitle(id, title) {
    const rec = this.store.get(id);
    if (!rec || !rec.transcriptPath) return false;
    try {
      let pre = '';
      try {
        const st2 = fs.statSync(rec.transcriptPath);
        if (st2.size > 0) {
          const fd = fs.openSync(rec.transcriptPath, 'r');
          try {
            const buf = Buffer.alloc(1);
            if (fs.readSync(fd, buf, 0, 1, st2.size - 1) === 1 && buf[0] !== 0x0A) pre = '\n';
          } finally { fs.closeSync(fd); }
        }
      } catch { /* unreadable tail -> append as-is */ }
      fs.appendFileSync(rec.transcriptPath, pre + JSON.stringify({ type: 'custom-title', customTitle: title }) + '\n');
      return true;
    } catch { return false; }
  }

  // v40: name a freshly forked session "Fork-<source title>" - the fork's
  // transcript may copy the source's custom-title line, so ours must be
  // appended AFTER adoption (it is the last custom-title in file order and
  // wins). The record may not exist yet when the init line lands; retry
  // until the adapter discovers the file. Not pinned: Desktop has no cached
  // title for a brand-new session id, so nothing can echo over it.
  titleFork(forkFrom, newId) {
    if (!newId || this.forkTitled.has(newId)) return;
    this.forkTitled.add(newId);
    const src = this.store.get(forkFrom) || {};
    let base = src.title && src.title !== '(loading)' ? src.title : '';
    if (!base && src.cwd) base = src.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
    this._appendTitleWithRetry(newId, 'Fork-' + String(base || '会话').replace(/^(Fork-)+/, ''), 0);
  }
  _appendTitleWithRetry(id, title, attempt) {
    if (this.appendTitle(id, title)) return;
    if (attempt >= 4) return; // transcript never appeared - give up quietly
    setTimeout(() => this._appendTitleWithRetry(id, title, attempt + 1), 1200);
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
    if (this.renames.delete(id)) this._saveRenames();
    return { ok: true, trashedTo: dest };
  }

  // Full message list for detail view (fresh ephemeral tailer, live offsets untouched).
  // before = how many TRAILING events to skip: ?before=N returns the window
  // just older than what the client already has (v44 history pagination).
  readTranscript(id, limit = 400, before = 0) {
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
    const end = Math.max(0, events.length - Math.max(0, before | 0));
    return { events: events.slice(Math.max(0, end - limit), end), total: events.length };
  }
}


