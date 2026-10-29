// agents.js - live subagent tracker (v112, 方案A). CLI 2.1.308 writes every
// subagent's transcript to <projects>/<slug>/<sessionId>/subagents/agent-<agentId>.jsonl
// (+ agent-<agentId>.meta.json with agentType/description/toolUseId/finished).
// The file grows incrementally while the agent runs, so the adapter's
// recursive fs.watch streams it exactly like a parent transcript.
//
// This module owns:
//   - registry: agentId -> {tailer, meta, attribution, step summary}
//   - attribution: the parent transcript's Agent tool_use (call id +
//     input.description) is the ONLY live source of the description; the
//     durable toolUseId<->agentId link lands when the CLI rewrites meta.json
//     at completion. Until then a FIFO spawn queue assigns newly-seen agent
//     files to pending tool_use ids (files are created at spawn, in order).
//   - summary frames {type:'agent', id, agentId, toolUseId, desc, agentType,
//     bg, state:'run'|'done', steps, act, startedAt} - tiny by design; the
//     api-request* blob lines are never parsed into events.
// Full display events for the bubble come from readEvents() (HTTP), parsed
// with the same applyLine the parent transcript uses.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Tailer } from './tailer.js';
import { applyLine } from './parsers-cc.js';

const AGENT_TOOL_NAMES = new Set(['Agent', 'Task']);

// short action label for a tool_use input ("Read README.en.md") - the
// live-line is one line of mono text: file paths collapse to their basename,
// never the raw 300-char briefJson blob
function inputBrief(v) {
  let input = null;
  try { input = JSON.parse(v); } catch { return ''; }
  if (!input || typeof input !== 'object') return '';
  const s = (x) => (typeof x === 'string' && x ? x.split('\n')[0].slice(0, 48) : '');
  const base = (x) => {
    if (typeof x !== 'string' || !x) return '';
    const b = x.split(/[\\/]/).filter(Boolean).pop() || x;
    return b.slice(0, 24);
  };
  return base(input.file_path) || base(input.path) || s(input.pattern) || s(input.command)
    || s(input.url) || s(input.description) || s(input.query) || s(input.prompt);
}

export class AgentTracker extends EventEmitter {
  constructor() {
    super();
    this.agents = new Map();    // agentId -> entry
    this.bySession = new Map(); // sessionId -> Set(agentId)
    this.pending = new Map();   // sessionId -> [toolUseId] unmatched spawns (FIFO)
    this.toolDesc = new Map();  // toolUseId -> description (from parent tool_use)
  }

  // ---- discovery: adapter watcher routes every <sid>/subagents/ event here
  touch(absPath) {
    const base = path.basename(absPath);
    if (!base.startsWith('agent-')) return;
    if (base.endsWith('.meta.json')) this._readMeta(absPath);
    else if (base.endsWith('.jsonl')) this._drainFile(this._ensure(absPath));
  }

  _ensure(absPath) {
    const agentId = path.basename(absPath, '.jsonl').slice('agent-'.length);
    let e = this.agents.get(agentId);
    if (e) return e;
    // .../<slug>/<sessionId>/subagents/agent-x.jsonl
    const sessionId = path.basename(path.dirname(path.dirname(absPath)));
    e = { agentId, sessionId, path: absPath, tailer: new Tailer(absPath),
      toolUseId: '', desc: '', agentType: '', bg: false, finished: false,
      steps: 0, act: '', startedAt: 0, finishedAt: 0 };
    this.agents.set(agentId, e);
    let set = this.bySession.get(sessionId);
    if (!set) { set = new Set(); this.bySession.set(sessionId, set); }
    set.add(agentId);
    // FIFO attribution: this new file belongs to the oldest unmatched spawn
    const q = this.pending.get(sessionId);
    if (q && q.length) {
      e.toolUseId = q.shift();
      e.desc = this.toolDesc.get(e.toolUseId) || '';
      this._emit(e, 'run');
    }
    return e;
  }

  _readMeta(absPath) {
    let m;
    try { m = JSON.parse(fs.readFileSync(absPath, 'utf8')); } catch { return; }
    const agentId = path.basename(absPath, '.meta.json').slice('agent-'.length);
    const e = this.agents.get(agentId);
    if (!e) return; // file not seen yet - its own touch will _ensure
    if (m.toolUseId && e.toolUseId !== m.toolUseId) {
      // release a wrong FIFO guess back to the queue head
      if (e.toolUseId) {
        const q = this.pending.get(e.sessionId);
        if (q) q.unshift(e.toolUseId);
      }
      e.toolUseId = m.toolUseId;
    }
    if (m.description && !e.desc) e.desc = String(m.description).slice(0, 80);
    e.agentType = m.agentType || '';
    e.bg = m.requestShape === 'background';
    if (m.finished === true && !e.finished) {
      e.finished = true;
      e.finishedAt = Date.now();
      this._emit(e, 'done');
    }
  }

  _drainFile(e) {
    let lines;
    try { lines = e.tailer.readNew(); } catch { return; }
    if (!lines.length) return;
    const events = [];
    for (const line of lines) {
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      // api-request* blob lines fall through applyLine's default: ignored
      const ev = applyLine(e.sessionId, obj, {}, events, null);
      if (ev) events.push(ev);
    }
    if (!events.length) return;
    for (const ev of events) {
      const ts = Date.parse(ev.ts || '');
      if (Number.isFinite(ts)) { e.lastTs = ts; if (!e.startedAt) e.startedAt = ts; }
      if (ev.k === 'assistant') {
        for (const p of ev.parts || []) {
          if (p.t === 'tool') { e.steps++; e.act = p.name + ' ' + inputBrief(p.v); }
          else if (p.t === 'text') e.act = '输出文本';
          else if (p.t === 'think') e.act = '思考中';
        }
      }
    }
    this._emit(e, e.finished ? 'done' : 'run');
  }

  _emit(e, state) {
    this.emit('agent', {
      type: 'agent', id: e.sessionId, agentId: e.agentId, toolUseId: e.toolUseId,
      desc: e.desc, agentType: e.agentType, bg: e.bg, state,
      steps: e.steps, act: e.act, startedAt: e.startedAt || 0,
      finishedAt: e.finishedAt || 0,
    });
  }

  // ---- parent transcript hooks (adapter feeds parsed events from _drain) ----
  // Runs on BOTH live appends and boot replays: replayed yesterday pairs
  // enqueue+dequeue to a net zero, so only genuinely pending spawns (bridge
  // restarted mid-run) survive a boot replay - attribution works again.
  onParentEvents(sessionId, events) {
    for (const ev of events) {
      if (ev.k === 'assistant') {
        for (const p of ev.parts || []) {
          if (p.t !== 'tool' || !AGENT_TOOL_NAMES.has(p.name)) continue;
          let desc = '';
          try {
            const i = JSON.parse(p.v || '{}');
            if (i && typeof i.description === 'string') desc = i.description.slice(0, 80);
          } catch { /* unparseable input - desc stays empty */ }
          if (desc) this.toolDesc.set(p.id, desc);
          let q = this.pending.get(sessionId);
          if (!q) { q = []; this.pending.set(sessionId, q); }
          q.push(p.id);
          // late parent drain (agent file + parent line landed inside the
          // same 200ms drain debounce): the file registered BEFORE its spawn
          // id was queued - adopt it now, oldest file first
          this._adoptUnmatched(sessionId);
        }
      } else if (ev.k === 'toolres') {
        for (const it of ev.items || []) {
          const q = this.pending.get(sessionId);
          if (q) { const i = q.indexOf(it.id); if (i >= 0) q.splice(i, 1); }
          this.toolDesc.delete(it.id);
          // the result landing IS the agent's completion signal (works even
          // when meta.json is never rewritten, e.g. killed CLI)
          for (const aid of this.bySession.get(sessionId) || []) {
            const e = this.agents.get(aid);
            if (e && e.toolUseId === it.id && !e.finished) {
              e.finished = true;
              e.finishedAt = Date.now();
              this._emit(e, 'done');
            }
          }
        }
      }
    }
  }

  // give registered-but-unattributed agent files (file event beat the parent
  // drain) their spawn id from the pending queue, oldest file first
  _adoptUnmatched(sessionId) {
    const q = this.pending.get(sessionId);
    if (!q || !q.length) return;
    for (const aid of this.bySession.get(sessionId) || []) {
      if (!q.length) return;
      const e = this.agents.get(aid);
      if (!e || e.toolUseId) continue;
      e.toolUseId = q.shift();
      e.desc = this.toolDesc.get(e.toolUseId) || '';
      this._emit(e, e.finished ? 'done' : 'run');
    }
  }

  // ---- HTTP: full display events for the bubble (fresh read, offsets untouched)
  readEvents(sessionId, agentId, limit = 2000) {
    const e = this.agents.get(agentId);
    if (!e || e.sessionId !== sessionId) return null;
    const t = new Tailer(e.path);
    const events = [];
    for (const line of t.readAll()) {
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const ev = applyLine(sessionId, obj, {}, events, null);
      if (ev) events.push(ev);
    }
    return { events: events.slice(-limit), total: events.length, agent: this._summary(e) };
  }

  _summary(e) {
    return { agentId: e.agentId, toolUseId: e.toolUseId, desc: e.desc, agentType: e.agentType,
      bg: e.bg, finished: e.finished, steps: e.steps, act: e.act, startedAt: e.startedAt, finishedAt: e.finishedAt };
  }

  // v112: ride on the messages fetch so finished agents render their 全文
  // entry on first paint (live frames only cover agents that grow)
  summariesFor(sessionId) {
    const out = [];
    for (const aid of this.bySession.get(sessionId) || []) {
      const e = this.agents.get(aid);
      if (e && e.toolUseId) out.push(this._summary(e));
    }
    return out;
  }

  // boot scan: register everything already on disk so the HTTP route works
  // for historical sessions; live frames only fire on later growth.
  scanAll(root) {
    let projs = [];
    try { projs = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
    for (const d of projs) {
      if (!d.isDirectory()) continue;
      let sids = [];
      try { sids = fs.readdirSync(path.join(root, d.name), { withFileTypes: true }); } catch { continue; }
      for (const s of sids) {
        if (!s.isDirectory()) continue;
        const dir = path.join(root, d.name, s.name, 'subagents');
        let files = [];
        try { files = fs.readdirSync(dir); } catch { continue; }
        for (const f of files) {
          if (f.startsWith('agent-') && (f.endsWith('.jsonl') || f.endsWith('.meta.json'))) {
            try { this.touch(path.join(dir, f)); } catch { /* skip one file */ }
          }
        }
      }
    }
  }
}
