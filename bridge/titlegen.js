// titlegen.js - LLM session titles for phone-created sessions.
//
// New-task titles were a 24-char truncation of the first prompt (the
// parsers-cc fallback) - findable but inaccurate and ugly. When the FIRST run
// of a phone-created session ends (runner marks it `newSession`), send the
// opening prompt + the assistant's final text through a throwaway `-p` call
// and write the reply as a native custom-title line - the exact append+pin
// path the manual rename route uses, so the fence/flush semantics are
// inherited, not duplicated.
//
// Guards: fires once per session id; only when the record still carries
// `titleFallback` (re-checked at WRITE time, so a rename that lands while the
// model is thinking wins); skips when there is no user/assistant text at all.
// The throwaway transcript the `-p` call leaves behind is archived like
// ctxprobe's sidecar - with retries: archiveSession can only trash a session
// the adapter has discovered, and on a fast call the file event may still be
// in flight when the child exits.
import os from 'node:os';
import { spawn } from 'node:child_process';

const TITLE_TIMEOUT_MS = 45_000;
const MAX_TITLE_CHARS = 32;

// Pure: from readTranscript events pick the opening human bubble and the
// final assistant text (the run's conclusion summarizes what the task
// actually became, which is often a better title source than the prompt).
export function pickTitleInputs(events) {
  let user = '';
  for (const ev of events || []) {
    if (ev.k === 'user' && ev.text) { user = ev.text; break; }
  }
  let bot = '';
  for (let i = (events || []).length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.k !== 'assistant') continue;
    bot = (ev.parts || []).filter((p) => p && p.t === 'text' && p.v).map((p) => p.v).join('\n');
    break;
  }
  return { user, bot };
}

// Pure: v134 suggest-title input - the user's own prompts only, no assistant
// conclusions (user decision). Each clipped to 100 chars, the whole set
// within ~2000 chars (oldest first, stop before crossing the budget).
export function pickUserPrompts(events) {
  const out = [];
  let total = 0;
  for (const ev of events || []) {
    if (ev.k !== 'user' || !ev.text) continue;
    const t = String(ev.text).slice(0, 100);
    if (total + t.length + (out.length ? 1 : 0) > 2000) break; // newline counts toward budget
    out.push(t);
    total += t.length;
  }
  return out.join('\n');
}

export function buildSuggestPrompt(prompts) {
  return [
    '为下面的会话生成一个标题。要求：',
    '- 语言与会话内容一致；标题不超过 15 个字',
    '- 概括会话的目标与主题，不要照抄开头',
    '- 以下是用户在这个会话里发过的全部消息（每条独立，可能被截断）',
    '- 不调用任何工具；只输出标题本身，不带引号、编号或任何说明',
    '',
    '[用户消息]',
    prompts,
  ].join('\n');
}

export function buildTitlePrompt(user, bot) {
  const L = [
    '为下面的任务生成一个会话标题。要求：',
    '- 语言与任务内容一致；中文不超过 14 个字，英文不超过 8 个词',
    '- 概括任务目标，不要照抄任务开头',
    '- 不调用任何工具；只输出标题本身，不带引号、编号或任何说明',
  ];
  if (user) L.push('', '[任务]', String(user).slice(0, 1600));
  if (bot) L.push('', '[执行结果]', String(bot).slice(0, 1000));
  return L.join('\n');
}

// Pure: model replies arrive wrapped in code fences / quotes / "标题:" prefixes
// - trim it all down to one clean line, hard-capped to list-friendly width.
export function sanitizeTitle(s) {
  let t = String(s || '').trim();
  const fence = t.match(/```[a-z]*\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  t = t.split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
  t = t.replace(/^(会话标题|标题|title)\s*[:：]\s*/i, '');
  t = t.replace(/^[#>*\-\s]+/, '');
  // trailing junk can stack (quote hiding behind punctuation): strip, then
  // quotes, then punctuation again
  t = t.replace(/^["'“”‘’`《「]+/, '');
  t = t.replace(/[。．.!！?？:：;；,，、\-—–\s]+$/, '');
  t = t.replace(/["'“”‘’`《「]+/, '').replace(/["'“”‘’`》」]+$/, '');
  t = t.replace(/[。．.!！?？:：;；,，、\-—–\s]+$/, '');
  t = t.replace(/\s+/g, ' ');
  if (t.length > MAX_TITLE_CHARS) t = t.slice(0, MAX_TITLE_CHARS).trim() + '…';
  return t;
}

export class TitleGen {
  constructor(opts = {}) {
    this.runner = opts.runner;     // resolveClaude() + settingsEnv()
    this.adapter = opts.adapter;   // readTranscript / appendTitle / pinRename / archiveSession
    this.store = opts.store;
    this.enabled = opts.enabled !== false;
    this.done = new Set();         // one attempt per session per bridge life
  }

  maybeTitle(sessionId, model = '') {
    if (!this.enabled || !sessionId || this.done.has(sessionId)) return;
    this.done.add(sessionId);
    const rec = this.store.get(sessionId);
    if (!rec || !rec.transcriptPath || !rec.titleFallback) return; // real title already
    const tr = this.adapter.readTranscript(sessionId, 400);
    const { user, bot } = pickTitleInputs(tr ? tr.events : []);
    if (!user && !bot) return;
    this._generate(sessionId, rec, user, bot, model).catch(() => { /* keep fallback */ });
  }

  // v121: suggest WITHOUT writing - the rename modal's ✦ button (user still
  // confirms via the normal rename route). Deliberately ignores this.enabled
  // (that gates AUTO-titling only) and this.done (repeatable on demand).
  // Same one-shot -p machinery, so the ghost transcript is archived in _ask.
  // v134: the caller builds the prompt (user prompts only, its own budget).
  suggest(prompt, model, rec) {
    return this._ask(prompt, rec, model);
  }

  async _generate(sessionId, rec, user, bot, model) {
    // sanitize again on this side: _ask already cleans, but anything raw that
    // slips through a future variant must never hit the transcript
    const title = sanitizeTitle(await this._ask(buildTitlePrompt(user, bot), rec, model));
    if (!title) return;
    const now = this.store.get(sessionId);
    if (!now || !now.titleFallback) return; // renamed / titled while we asked
    if (!this.adapter.appendTitle(sessionId, title)) return;
    // same fence as manual rename: the Desktop may have cached the truncation
    this.adapter.pinRename(sessionId, title);
    console.log('[titlegen] session %s titled: %s', sessionId, title);
  }

  // One-shot `claude -p` (ctxprobe's proven flag set). Resolves '' on any
  // failure - the caller keeps the truncation title. The ghost transcript is
  // archived BEFORE the verdict, success or not.
  _ask(prompt, rec, model = '') {
    return new Promise((resolve) => {
      const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
      if (model) args.push('--model', model);
      let child;
      try {
        child = spawn(this.runner.resolveClaude(), args, {
          cwd: rec.cwd || os.homedir(),
          env: { ...process.env, ...this.runner.settingsEnv() },
          windowsHide: true,
        });
      } catch { resolve(''); return; }
      let out = '';
      let sessionId = '';
      const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, TITLE_TIMEOUT_MS);
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.stderr.on('data', () => { /* noise */ });
      child.on('error', () => { clearTimeout(timer); resolve(''); });
      child.on('close', () => {
        clearTimeout(timer);
        let result = '';
        try {
          for (const line of out.split('\n')) {
            if (!line.trim()) continue;
            try {
              const o = JSON.parse(line);
              if (o.session_id) sessionId = o.session_id;
              if (o.type === 'result' && typeof o.result === 'string') result = o.result;
            } catch { /* not json */ }
          }
        } catch { /* resolve empty below */ }
        if (sessionId) this._archiveGhost(sessionId, 0);
        const title = sanitizeTitle(result);
        if (!title) console.log('[titlegen] no usable title from -p call (session %s)', sessionId || '?');
        resolve(title);
      });
    });
  }

  _archiveGhost(sessionId, attempt) {
    try {
      const r = this.adapter.archiveSession(sessionId);
      if (r && r.ok) return;
    } catch { /* benign */ }
    // the adapter may not have discovered the file yet (fast call, watcher
    // event still in flight) - retry a few times before giving up
    if (attempt >= 5) { console.warn('[titlegen] ghost transcript not archived: %s', sessionId); return; }
    setTimeout(() => this._archiveGhost(sessionId, attempt + 1), 1200);
  }
}
