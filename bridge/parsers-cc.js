// parsers-cc.js - PURE transcript-line semantics for ~/.claude/projects
// JSONL (CLI 2.1.308): human/machine classification, fold markers
// (compaction/skill), tool_result pairing, cost-state collapse, stop markers.
// All the v22/v24/v28 judgment pitfalls live here, unit-tested in
// test/unit/parsers.test.mjs - importable without any Tailer/Store.
// Applies one parsed transcript line: mutates `patch` (record fields,
// est accounting) and pushes display events via the RETURN value (caller
// pushes). `rec` is the current store record snapshot (read-only).
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

export function applyLine(id, obj, patch, events, rec) {
    switch (obj.type) {
      case 'user': {
        // compaction continuation (2.1.308): the CLI injects the resume
        // summary as a user line with origin ABSENT and isCompactSummary:
        // true - machine context for the model, not a human message. Fold to
        // a marker. Phone-sent prompts ALSO lack origin (promptSource=sdk)
        // and must stay bubbles, so fold on the explicit flag only.
        if (obj.isCompactSummary) {
          const sc = typeof ((obj.message || {}).content) === 'string' ? obj.message.content : '';
          if (patch.est) patch.est.prose += sc.length;
          return { k: 'compact', ts: obj.timestamp || '', n: sc.length };
        }
        const cRaw = obj.message && obj.message.content;
        // skill expansion (2.1.308): invoking a Skill injects its whole body
        // as a user line - origin absent, array of pure text parts, starting
        // with the base-dir header. Machine context like the compact summary:
        // fold to a marker, never a 50k-char bubble.
        if (Array.isArray(cRaw) && cRaw.length && cRaw.some((p) => p && p.type === 'text' && /^Base directory for this skill:/.test(p.text))
            && !cRaw.some((p) => p && p.type !== 'text')) {
          let n = 0; let name = '';
          for (const p of cRaw) {
            if (!p || !p.text) continue;
            n += p.text.length;
            if (!name) {
              const m = p.text.match(/^Base directory for this skill:\s*(\S+)/);
              if (m) name = m[1].split(/[\\/]/).filter(Boolean).pop() || '';
            }
          }
          if (patch.est) patch.est.prose += n;
          return { k: 'skill', ts: obj.timestamp || '', name, n };
        }
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
        const rec0 = rec || {};
        // first human message length: needed once to derive the fixed overhead
        // (system prompt + tools) from the first request's prompt size
        if (rec && rec0.firstUserChars == null && patch.firstUserChars == null && text) {
          patch.firstUserChars = text.length;
        }
        const haveTitle = patch.title || (rec && rec0.title && rec0.title !== '(loading)');
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
        // 2.1.308 occasionally flushes two cost-state lines back-to-back at
        // process exit (distinct snapshots; once in 39 here) - collapse
        // adjacent stats into the final one instead of rendering both
        const prevEv = events[events.length - 1];
        if (prevEv && prevEv.k === 'stats') events.pop();
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


function briefJson(input) {
  try {
    const s = JSON.stringify(input);
    return s && s.length > 300 ? s.slice(0, 300) + '...' : (s || '');
  } catch { return ''; }
}

// Drop <system-reminder>...</system-reminder> blocks (huge injected context).
// Slash-command envelopes (<command-name>/<command-message>/<command-args>)
// collapse to a clean "/name args" - the raw tag soup used to render in the
// user bubble.
function stripReminder(text) {
  const cm = text.match(/<command-name>\s*\/?([^<]+?)\s*<\/command-name>/);
  if (cm) {
    const am = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
    const args = am ? am[1].trim() : '';
    return ('/' + cm[1].trim() + (args ? ' ' + args : '')).trim();
  }
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .trim();
}
