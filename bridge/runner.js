// runner.js - non-resident CC executor (Plan D3).
// One `claude --resume <id> -p --output-format stream-json` child per phone
// message; the child exits when the turn ends, so between messages no process
// holds the session and the PC can take over via `claude --resume` any time.
//
// Transcript content is NOT streamed from here: the adapter already tails the
// session files and pushes 'append' frames. This module only manages run
// lifecycle: start / capture session_id (new sessions) / end / cancel.
//
// Env: Claude Code on this machine does NOT self-apply the `env` block of
// ~/.claude/settings.json for auth (bare spawn => "Not logged in"), so we read
// that block once and inject it into the child env. Secrets stay in memory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { findClaudeBinary, bashToolEnv } from './lib/platform.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_CONCURRENT_RUNS = 4;

export class Runner extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.store = opts.store; // Store (for cwd lookup); optional but expected
    this.claudePathOverride = opts.claudePath || '';
    // YOLO mode: phone-dispatched turns run with permission checks skipped --
    // nobody is at the PC to approve prompts, so without this any tool use
    // stalls the run forever. Default on; cfg.yolo=false opts out.
    this.yolo = opts.yolo !== false;
    this.port = opts.port || 3742; // for the approve-mcp callback URL
    this.uploadsDir = opts.uploadsDir || ''; // attachment storage root
    this.runs = new Map(); // runId -> run record
    this.outcomes = new Map(); // sessionId -> { state, exitCode, cancelled, at } (last finished run)
    this.queues = new Map(); // sessionId -> [{id, text, perm, model, effort, at}] (pending while busy)
    this._seq = 0;
    this._qseq = 0;
    this._claudeExe = null;
    this._settingsEnv = null;
    // v94: hung-CLI janitor (see _watchdog)
    this._watchdogTimer = setInterval(() => this._watchdog(), 30_000);
  }

  // live or recently-finished run record (for approval routing)
  getRun(runId) { return this.runs.get(runId) || null; }

  resolveClaude() {
    if (!this._claudeExe) this._claudeExe = findClaudeBinary(this.claudePathOverride);
    return this._claudeExe;
  }

  // `env` block of ~/.claude/settings.json (relay base URL + auth token...).
  // Read lazily and cached; never logged, never returned to clients.
  settingsEnv() {
    if (this._settingsEnv) return this._settingsEnv;
    this._settingsEnv = {};
    try {
      const p = path.join(os.homedir(), '.claude', 'settings.json');
      const env = JSON.parse(fs.readFileSync(p, 'utf8')).env;
      if (env && typeof env === 'object') this._settingsEnv = env;
    } catch { /* no settings / no env block */ }
    return this._settingsEnv;
  }

  // Continue an existing session from the phone ("resume" path).
  // opts.perm: 'auto' (yolo, default) | 'ask' (route permission prompts to
  // the phone via the approve-mcp tool).
  send(sessionId, text, opts = {}) {
    if (!sessionId || !text) return { error: 'bad-request' };
    const cwd = (this.store.get(sessionId) || {}).cwd || os.homedir();
    // v40 branch: fork instead of resume-in-place (--fork-session = the CLI
    // creates a NEW session id). run.sessionId stays null so the init-line
    // adoption kicks in, exactly like `start`. Busy => refuse without
    // queueing: a queued fork would fork once per queue drain.
    if (opts.forkFrom) {
      if (this.activeRunFor(sessionId)) return { error: 'busy', sessionId };
      return this._spawnRun(['--resume', opts.forkFrom, '--fork-session'], text, cwd, null, opts.perm || 'auto', opts.model || '', opts.effort || '', opts.attachments || [], opts.forkFrom);
    }
    const r = this._spawnRun(['--resume', sessionId], text, cwd, sessionId, opts.perm || 'auto', opts.model || '', opts.effort || '', opts.attachments || []);
    if (r.error === 'busy') {
      // queue instead of rejecting: phone users type follow-ups while a turn
      // is still running; they dispatch automatically when it finishes
      const q = this.queues.get(sessionId) || [];
      if (q.length >= 5) return { error: 'queue-full' };
      q.push({ id: 'q' + (++this._qseq).toString(36), text, perm: opts.perm || 'auto', model: opts.model || '', effort: opts.effort || '', attachments: opts.attachments || [], at: Date.now() });
      this.queues.set(sessionId, q);
      this._queueChanged(sessionId);
      return { queued: true, position: q.length, runId: null };
    }
    return r;
  }

  queuedFor(sessionId) { return this.queues.get(sessionId) || []; }

  // wire-safe snapshot (ids + texts only) for WS frames / GET
  queueSnapshot(sessionId) {
    return this.queuedFor(sessionId).map((e) => ({ id: e.id, text: e.text }));
  }
  _queueChanged(sessionId) {
    this.emit('queue-changed', { sessionId, queue: this.queueSnapshot(sessionId) });
  }

  removeQueued(sessionId, qid) {
    const q = this.queues.get(sessionId);
    if (!q) return false;
    const i = q.findIndex((e) => e.id === qid);
    if (i < 0) return false;
    q.splice(i, 1);
    if (q.length === 0) this.queues.delete(sessionId);
    this._queueChanged(sessionId);
    return true;
  }

  reorderQueue(sessionId, ids) {
    const q = this.queues.get(sessionId);
    if (!q || !Array.isArray(ids) || ids.length !== q.length) return false;
    const byId = new Map(q.map((e) => [e.id, e]));
    if (!ids.every((id) => byId.has(id))) return false;
    this.queues.set(sessionId, ids.map((id) => byId.get(id)));
    this._queueChanged(sessionId);
    return true;
  }

  // "run now": jump this queued item to the front, interrupt the active run
  // (or dispatch directly when idle) — the drain then sends it first
  runNow(sessionId, qid) {
    const q = this.queues.get(sessionId);
    if (!q) return false;
    const i = q.findIndex((e) => e.id === qid);
    if (i < 0) return false;
    const [entry] = q.splice(i, 1);
    q.unshift(entry);
    this._queueChanged(sessionId);
    const run = this.activeRunFor(sessionId);
    if (run) this.cancel(run.runId);
    else this._drainQueue(sessionId);
    return true;
  }

  clearQueue(sessionId) {
    const n = (this.queues.get(sessionId) || []).length;
    if (n) {
      this.queues.delete(sessionId);
      this._queueChanged(sessionId);
    }
    return n;
  }

  // dispatch the next queued message for a session (called when its run ends)
  _drainQueue(sessionId) {
    if (!sessionId) return;
    const q = this.queues.get(sessionId);
    if (!q || q.length === 0) return;
    const next = q.shift();
    if (q.length === 0) this.queues.delete(sessionId);
    this._queueChanged(sessionId);
    this.emit('queued-dispatch', { sessionId, text: next.text, remaining: q.length });
    const cwd = (this.store.get(sessionId) || {}).cwd || os.homedir();
    this._spawnRun(['--resume', sessionId], next.text, cwd, sessionId, next.perm, next.model || '', next.effort || '', next.attachments || []);
  }

  // Start a fresh session from the phone; sessionId is captured from the
  // stream's init line and reported via an 'update' event.
  start(text, cwd, opts = {}) {
    if (!text) return { error: 'bad-request' };
    return this._spawnRun([], text, cwd || os.homedir(), null, opts.perm || 'auto', opts.model || '', opts.effort || '');
  }

  // v94: a CLI process can linger after finishing its turn when the Stop
  // hook hangs (curl without a timeout used to hang indefinitely). The
  // transcript already says the turn is done - a stop-class system line
  // written AFTER this run started. Force-end such runs: kill the child;
  // the regular close handler books the outcome and drains the queue.
  _watchdog() {
    for (const run of this.runs.values()) {
      if (run.state !== 'running' || !run.sessionId || run.watchdogFired) continue;
      const rec = this.store && this.store.get(run.sessionId);
      const tp = rec && rec.transcriptPath;
      if (!tp) continue;
      let st; try { st = fs.statSync(tp); } catch { continue; }
      if (st.mtimeMs < run.startedAt + 1000) continue; // nothing written since start (cold start / idle)
      let tail = '';
      try {
        const len = Math.min(64 * 1024, st.size);
        const buf = Buffer.alloc(len);
        const fd = fs.openSync(tp, 'r');
        fs.readSync(fd, buf, 0, len, st.size - len);
        fs.closeSync(fd);
        tail = buf.toString('utf8');
      } catch { continue; }
      const lines = tail.split('\n').filter((l) => l.trim());
      for (let i = lines.length - 1; i >= 0 && i >= lines.length - 10; i--) {
        let o; try { o = JSON.parse(lines[i]); } catch { continue; }
        if (o.type === 'system' && typeof o.subtype === 'string' && o.subtype.startsWith('stop')) {
          const ts = Date.parse(o.timestamp || '');
          if (!isNaN(ts) && ts > run.startedAt - 1000) {
            run.watchdogFired = true;
            console.log(`[runner] watchdog: run ${run.runId} force-ended (transcript complete, CLI lingering)`);
            try { run.child.kill(); } catch { /* already gone */ }
          }
          break; // only the last stop-class line is relevant
        }
      }
    }
  }

  cancel(runId) {
    const run = this.runs.get(runId);
    if (!run || run.state !== 'running') return false;
    run.cancelled = true;
    try { run.child.kill(); } catch { /* already gone */ }
    return true;
  }

  activeRunFor(sessionId) {
    for (const run of this.runs.values()) {
      if (run.state === 'running' && run.sessionId === sessionId) return run;
    }
    return null;
  }

  // last finished phone-run outcome for a session (undefined = never ran)
  recallOutcome(sessionId) {
    return this.outcomes.get(sessionId);
  }

  _spawnRun(resumeArgs, text, cwd, sessionId, perm, model, effort, attachments = [], forkFrom = '') {
    if (sessionId && this.activeRunFor(sessionId)) return { error: 'busy', sessionId };
    let live = 0;
    for (const r of this.runs.values()) if (r.state === 'running') live++;
    if (live >= MAX_CONCURRENT_RUNS) return { error: 'overloaded' };

    // attachments (v19): images ride the message as native image blocks via
    // --input-format stream-json stdin (probe-verified on 2.1.308; stdin must
    // stay open - closing it immediately after write stalls the CLI). Text-ish
    // attachments are inlined into the prompt instead (the relay may not have
    // vision, but it can always read text).
    let stdinMsg = null;
    let prompt = text;
    const imgs = [];
    for (const a of attachments) {
      const isImg = /^image\//.test(a.type || '') || /\.(png|jpe?g|webp|gif)$/i.test(a.file || '');
      if (isImg) imgs.push(a);
      else if (this.uploadsDir) {
        try {
          const full = path.join(this.uploadsDir, a.file);
          const buf = fs.readFileSync(full);
          if (buf.length <= 24 * 1024) {
            prompt += '\n\n[附件 ' + a.name + ']\n```\n' + buf.toString('utf8').slice(0, 24 * 1024) + '\n```';
          } else {
            prompt += '\n\n[附件 ' + a.name + ' 已保存到 ' + full + '，可用 Read 查看]';
          }
        } catch { /* vanished upload: skip */ }
      }
    }
    if (imgs.length) {
      const content = [{ type: 'text', text: prompt }];
      for (const a of imgs) {
        try {
          const data = fs.readFileSync(path.join(this.uploadsDir, a.file)).toString('base64');
          const mt = /^image\//.test(a.type || '') ? a.type : 'image/png';
          content.push({ type: 'image', source: { type: 'base64', media_type: mt, data } });
        } catch { /* vanished upload: skip */ }
      }
      if (content.length > 1) stdinMsg = JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
    }

    const runId = 'r' + Date.now().toString(36) + (++this._seq).toString(36);
    const args = stdinMsg
      ? [...resumeArgs, '--input-format', 'stream-json', '-p', '--output-format', 'stream-json', '--verbose']
      : [...resumeArgs, '-p', prompt, '--output-format', 'stream-json', '--verbose'];
    if (model) args.push('--model', model);
    // reasoning effort (CLI: --effort low|medium|high|xhigh|max)
    if (['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) args.push('--effort', effort);
    if (perm === 'ask') {
      // route permission prompts to the phone: minimal MCP server, spawned by
      // the CLI itself via --mcp-config, calls back into the bridge
      const script = path.join(__dirname, 'approve-mcp.mjs').split(path.sep).join('/');
      const mcpCfg = JSON.stringify({
        mcpServers: {
          crapprove: { command: process.execPath, args: [script, '--run', runId, '--port', String(this.port)], env: {} },
        },
      });
      args.push('--permission-prompts', 'host', '--permission-prompt-tool', 'mcp__crapprove__phone_approve', '--mcp-config', mcpCfg);
    } else if (this.yolo) {
      args.push('--dangerously-skip-permissions');
    }
    const child = spawn(this.resolveClaude(), args, {
      cwd,
      // bashToolEnv: prepend the detected git dirs so the CLI's Bash tool
      // seats even when this bridge inherited a PATH without Git (v62)
      env: { ...process.env, ...this.settingsEnv(), ...bashToolEnv(process.env) },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (stdinMsg) child.stdin.write(stdinMsg); // keep stdin open: closing right away stalls the CLI
    const run = {
      runId, sessionId, child, state: 'running', startedAt: Date.now(),
      exitCode: null, stderrTail: '', cancelled: false, forkFrom,
    };
    this.runs.set(runId, run);

    const onLine = (line) => {
      if (!line) return;
      let o; try { o = JSON.parse(line); } catch { return; }
      // session_id rides on every stream-json line; adopt it as soon as seen
      // (matters for `start` where we don't know the id up front).
      if (o.session_id && !run.sessionId) {
        run.sessionId = o.session_id;
        this._emit(run);
      }
    };
    let stdoutBuf = '';
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop(); // keep partial last line
      for (const l of lines) onLine(l.trim());
    });
    child.stderr.on('data', (chunk) => {
      run.stderrTail = (run.stderrTail + chunk.toString('utf8')).slice(-400);
    });
    child.on('error', (err) => {
      run.state = 'error';
      run.error = String((err && err.message) || err);
      this._emit(run);
      this.runs.delete(runId);
    });
    child.on('close', (code) => {
      run.state = 'end';
      run.exitCode = code == null ? (run.cancelled ? 'cancelled' : 0) : code;
      this._emit(run);
      if (run.sessionId) {
        this.outcomes.set(run.sessionId, {
          state: run.cancelled ? 'stopped' : (run.exitCode === 0 ? 'ok' : 'failed'),
          exitCode: run.exitCode, cancelled: run.cancelled, at: Date.now(),
        });
      }
      // keep the record around briefly for status polls, then forget it
      setTimeout(() => this.runs.delete(runId), 60_000);
      // dispatch the next queued phone message for this session, if any
      if (run.sessionId) setTimeout(() => this._drainQueue(run.sessionId), 800);
    });

    this._emit(run);
    return { runId };
  }

  _emit(run) {
    this.emit('update', {
      runId: run.runId,
      sessionId: run.sessionId,
      state: run.state,
      exitCode: run.exitCode,
      error: run.error,
      cancelled: run.cancelled,
      startedAt: run.startedAt,
      forkFrom: run.forkFrom || undefined,
      stderrTail: run.state === 'error' || (run.state === 'end' && run.exitCode !== 0)
        ? run.stderrTail : undefined,
    });
  }
}
