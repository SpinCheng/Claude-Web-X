// parsers-cc.js - PURE transcript-line semantics for ~/.claude/projects
// JSONL (CLI 2.1.308): human/machine classification, fold markers
// (compaction/skill), tool_result pairing, cost-state collapse, stop markers.
// All the v22/v24/v28 judgment pitfalls live here, unit-tested in
// test/unit/parsers.test.mjs - importable without any Tailer/Store.

// Phone-rename write-fence (v39): the Desktop app re-emits its CACHED
// (pre-rename) custom-title every time it flushes session metadata, instantly
// reverting a phone rename (97 stale rewrites observed in one transcript).
// The bridge pins {title, prev} at rename time; this classifier decides what
// a custom-title line means while a pin is armed: 'stale' = exactly the pinned
// prev value -> caller swallows it; 'disarm' = a genuinely new title (a real
// desktop rename) -> desktop is authoritative, pin goes away; null = no fence
// action (no pin / same-as-pinned title / malformed blank record).
// v175: 取消目标的会话控制元数据。adapter 写入 isMeta 行、解析层折叠，避免
// 把停止状态显示成用户发言，也避免后续回答主动复述取消说明。
export const GOAL_CANCEL_DIRECTIVE = '【会话控制状态】用户已手动停止并作废之前的目标。除非用户明确通过新的 /goal 命令重新设定目标，否则不得恢复或续做该目标；后续消息按当前问题直接回答，不要主动提及或复述这条控制状态。';

export function fenceTitle(pin, customTitle) {
  if (!pin || typeof customTitle !== 'string') return null;
  const t = customTitle.trim();
  if (!t || t === pin.title) return null;
  if (t === pin.prev) return 'stale';
  return 'disarm';
}
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

// v209: close the open assistant message group into the per-model rate
// buckets. dur = last part's ts - the base captured at group open; the base
// then advances to the group end so a directly-following group never overlaps
// the span (a later non-assistant line's fresher ts still wins, as usual).
export function commitRateGroup(rec) {
  if (!rec || !rec._rateMsg) return;
  const dur = (rec._rateEnd || 0) - (rec._rateStartBase || 0);
  if (dur > 0 && rec._rateOut > 0) {
    rec._rate = rec._rate || {};
    const bk = rec._rate[rec._rateModel] || (rec._rate[rec._rateModel] = { out: 0, ms: 0 });
    bk.out += rec._rateOut;
    bk.ms += dur;
  }
  if ((rec._rateEnd || 0) > (rec._rateBase || 0)) rec._rateBase = rec._rateEnd;
  rec._rateMsg = ''; rec._rateModel = ''; rec._rateOut = 0; rec._rateStartBase = 0; rec._rateEnd = 0;
}

export function applyLine(id, obj, patch, events, rec) {
    // cwd rides on several line types (user, system/local_command, ...):
    // harvest from ANY of them - a transcript that only ever carries cwd on
    // system lines (e.g. a leaked ctxprobe sidecar) must still group by its
    // real project instead of falling back to the workspace slug.
    // v212 用户裁定：首次锚定后锁定——CLI 会把模型 shell 的 cd 跟踪为会话
    // cwd 写进后续行（fork 4aa28a42 实证：改 docs/design 时 149 行 cwd 变
    // 子目录，「最后胜出」把会话甩进了新项目组）。归属项目=创建时的事实，
    // 中途 cd 不改写。锁定值经 patch 传递，drain/重放两条路都幂等。
    if (obj.cwd) {
      if (patch.cwdSet) patch.cwd = patch.cwdSet;
      else { patch.cwd = obj.cwd; patch.cwdSet = obj.cwd; }
    }
    // v114 command-block state: an envelope line arms "next plain user line is
    // the expanded prompt body". Any NON-user line disarms - a local-type
    // command (no body) must not swallow the human's next real message.
    if (obj.type !== 'user' && rec) rec._cmdEnv = false;
    // v209 结算速率：非 assistant 行的 ts = 下一段模型输出的计时起点（通常
    // 是 tool_result / api-request——间隔≈收到输入到吐完输出的真实耗时）。
    // 先收口上一个 message 组，再推进基点；累加挂 rec（_cmdEnv 先例）。
    if (obj.type !== 'assistant' && rec) {
      commitRateGroup(rec);
      const bt = Date.parse(obj.timestamp || '');
      if (Number.isFinite(bt)) rec._rateBase = bt;
    }
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
        // v111: a command's stdout arrives as its OWN user line wrapped in
        // <local-command-stdout> (2.1.308, e.g. /model "Set model to ...") -
        // surface it as the command's visible result. Must run BEFORE
        // stripReminder, which blanks the wrapper entirely.
        if (!images.length) {
          const so = text.match(/^\s*<local-command-stdout>([\s\S]*?)<\/local-command-stdout>\s*$/);
          // a stdout follower proves this is a local-type command (no expand
          // body) - disarm so the human's next message is never swallowed
          if (so && so[1].trim()) {
            if (rec) rec._cmdEnv = false;
            return { k: 'cmdout', ts: obj.timestamp || '', text: so[1].trim() };
          }
        }
        // 2.1.308 image markers. TWO shapes, opposite verdicts (v190 用户裁定):
        // a marker-ONLY line is the CLI's synthetic echo beside an
        // image-bearing tool_result (real-find 8786f2b0: the model's own
        // Read() of a PNG leaked two as mystery right bubbles) - machine
        // bookkeeping, fold. A marker INLINE in human text is the user's own
        // content (pasted image or typed reference; the image bytes never
        // enter the transcript) - leave VERBATIM: never stripped, never
        // restyled as an image placeholder. The optimistic-twin dedup in the
        // PWA compares marker-insensitively instead.
        if (!images.length && /^\[Image: original \d+x\d+(?:, displayed at \d+x\d+)?\. Multiply coordinates by [\d.]+ to map to original image\.\]\s*$/.test(text)) return null;
        const rawText = text;
        text = stripReminder(text);
        if (!text && !images.length) return null;
        // CLI-injected chatter: when an image is attached the CLI adds its own
        // user turn pointing the model at the extracted temp file - not human
        // content, fold it out of the timeline
        if (!images.length && /^\[Image: source: .+\]\s*$/.test(text)) return null;
        // v111: /goal arms a session Stop hook and injects its directive as a
        // user line - machine text aimed at the model, never a human bubble.
        // The model acknowledges the goal in its reply, so nothing is lost.
        if (/^A session-scoped Stop hook is now active with condition:/.test(text)) return null;
        // v175: 取消目标的声明行（adapter 自写，用户口吻进模型上下文）——
        // 解析层按全串精确匹配折叠，绝不进用户气泡。
        if (text === GOAL_CANCEL_DIRECTIVE) return null;        // v158: the agent-guard Stop hook's block reason rides as an injected
        // user turn (same shape as the /goal directive) - machine text, fold.
        if (/^\[agent-wait\] /.test(text)) return null;
        // v162: /goal's Stop-hook block feedback rides as a user turn whose
        // text is the goal-keeper's dynamic verdict wrapped in a fixed
        // envelope ("Stop hook feedback: [<goal>]: <verdict>..."). Machine text
        // aimed at the model - v165 用户裁定：**仅恢复后首轮显示**（armed 由
        // resume 事件武装、一次即解除），常规每轮收尾的检查反馈保持折叠。
        // v173: ANY "Stop hook feedback:" envelope is machine text aimed at the
        // model - fold at PREFIX level (real-find e4ffccee: the old agent-guard
        // hook's "[agent-wait] 还有 N 个…" shape missed the bracket-colon regex
        // and leaked as a user bubble). The goal-keeper's structured verdict
        // still upgrades to a goalhold event when armed AND the [goal]: verdict
        // shape matches.
        if (/^Stop hook feedback:/.test(text)) {
          const gh = text.match(/^Stop hook feedback:\s*\[([\s\S]*?)\]\s*:\s*([\s\S]*)$/);
          if (gh && rec && rec._goalHoldArmed) {
            rec._goalHoldArmed = false;
            return { k: 'goalhold', ts: obj.timestamp || '', cond: gh[1].trim(), verdict: gh[2].trim() };
          }
          return null;
        }
        // v114: prompt-type commands (custom .md / init / security-review)
        // write their EXPANDED template body as the next plain user line -
        // machine-expanded text for the model, never a second human bubble.
        // Armed by the envelope line right before (rec._cmdEnv survives drain
        // batch boundaries). MUST run after the stdout/caveat/hook checks: a
        // local-type command's first follower is its stdout line.
        if (rec && rec._cmdEnv && !images.length) {
          rec._cmdEnv = false;
          return null; // expanded body folds away; the bubble shows /name args
        }
        if (patch.est) patch.est.prose += text.length;
        // v165: goal 活着时来了新的（非 /goal）人话消息 = 恢复（单发世界每条
        // 消息都是新进程；静默被杀的会话没有 stop 行，靠这条判定恢复——真机
        // 44d2d62e 踩中）。内容判定顺序免疫；恢复即武装首轮拦停显示。
        if (rec && rec._goalLive && !/^\/goal\b/.test(text)) {
          rec._goalHoldArmed = true;
          events.push({ k: 'goal', ts: obj.timestamp || '', st: 'resumed', cond: rec._goalCond || '' });
        }
        // fallback title from first human message only; explicit custom-title wins.
        // Guard against same-batch overwrites (store not yet updated mid-batch).
        const rec0 = rec || {};
        // first human message length: needed once to derive the fixed overhead
        // (system prompt + tools) from the first request's prompt size
        if (rec && rec0.firstUserChars == null && patch.firstUserChars == null && text) {
          patch.firstUserChars = text.length;
        }
        const haveTitle = patch.title || (rec && rec0.title && rec0.title !== '(loading)');
        if (!haveTitle && text) {
          // v64: first LINE only, hard 24-char cap + ellipsis - the raw
          // prompt used to ride along at 48 chars and read as a wall of text
          const first = text.split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
          patch.title = first.slice(0, 24) + (first.length > 24 ? '…' : '');
          patch.titleFallback = true;
        }
        const ev = { k: 'user', ts: obj.timestamp || '', text };
        if (images.length) ev.images = images;
        // v114: arm at the EXIT - raw tag soup normalized into a clean
        // /name args means this line IS an envelope; the NEXT plain user
        // line (if nothing else intervenes) is its expanded prompt body
        if (rawText !== text && /^\/[^\/\s]/.test(text) && rec) rec._cmdEnv = true;
        // v197: 代附/附件回显折叠。runner 在正文后追加 `\n\n[引用 @x]\n```…```
        // （或 `[附件 name]`）机器附录，CLI 把整段 prompt 原样写进 user 行——
        // 不折叠就多出一个非用户输入的大气泡。词法切分：首个附录标记前=
        // 用户文本（含 @ 标签——乐观孪生因此仍精确匹配），其后=机器附录。
        // 锚定完整机器格式（标记行以 \n\n 开头），正文撞上≈主动伪造（v145 先例）。
        const AP_M = text.match(/\n\n\[(引用 @[^\]\n]+|附件[^\]\n]+)\]/);
        if (AP_M && AP_M.index > 0) {
          const appendix = text.slice(AP_M.index);
          const files = [];
          const FRE = /\[(引用 @[^\]\n]+|附件[^\]\n]+)\]/g;
          let fm;
          while ((fm = FRE.exec(appendix))) {
            const lab = fm[1];
            files.push(lab.startsWith('引用 @') ? '@' + lab.slice(4) : lab.slice(3).trim().split(' 已保存到')[0]);
          }
          ev.text = text.slice(0, AP_M.index);
          events.push(ev); // user event first, marker after (companions land before the return)
          return { k: 'attref', ts: obj.timestamp || '', files };
        }
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
          if (rec && rec.usageFirst == null && patch.usageFirst == null) {
            const total = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
            const fu = patch.firstUserChars != null ? patch.firstUserChars : (rec.firstUserChars != null ? rec.firstUserChars : 0);
            patch.usageFirst = total;
            patch.fixedTok = Math.min(200_000, Math.max(0, Math.round(total - fu / 2.5)));
          }
          // v209 结算速率累加（v191 修正案）：同一条 API message 被 CLI 按
          // content part 拆成多行 assistant（message.id 相同，且每行都重复
          // 整条消息的 usage——实测三转录 708 个多行组 100% 逐行同值，逐行
          // 累加会把 out 记 ~2.5 倍）。按 message.id 分组：out 只在组首计一次、
          // 间隔=基点(上一非 assistant 行 ts)→组末行 ts（组末≈整条完成时刻）；
          // 无 id 的行（拆行时代之前）按单行组内联累计。无 ts / 无基点 / 非正
          // 间隔整组跳过（token 计量不受影响，那是 cost-state 的账）。
          if (rec) {
            const at = Date.parse(obj.timestamp || '');
            if (Number.isFinite(at)) {
              const mid = (obj.message && obj.message.id) || '';
              if (mid && rec._rateMsg === mid) {
                rec._rateEnd = at; // same message, later part: extend to real completion
              } else {
                commitRateGroup(rec);
                if (Number.isFinite(rec._rateBase) && at > rec._rateBase) {
                  const name = String((obj.message && obj.message.model) || '');
                  const out = u.output_tokens || 0;
                  if (mid) {
                    rec._rateMsg = mid; rec._rateModel = name;
                    rec._rateStartBase = rec._rateBase; rec._rateEnd = at; rec._rateOut = out;
                  } else {
                    rec._rate = rec._rate || {};
                    const bk = rec._rate[name] || (rec._rate[name] = { out: 0, ms: 0 });
                    bk.out += out;
                    bk.ms += at - rec._rateBase;
                    rec._rateBase = at;
                  }
                }
              }
            }
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
            // v158: the CLI's synthetic "No response requested." text part is
            // bookkeeping for a turn that ended with no model output (killed
            // run / resume-time patch for an interrupted turn) - not model
            // content, drop it. Exact-string match, so a longer reply that
            // merely contains the phrase still renders.
            if (p.text.trim() === 'No response requested.') continue;
            parts.push({ t: 'text', v: p.text });
            if (patch.est) patch.est.prose += p.text.length;
          }
          else if (p.type === 'tool_use') {
            // v145: the changed-file rollup delta rides the part as f
            // [{path,add,del}] - computed HERE while the input object is
            // still whole. The chip text v is briefJson-capped at 300 chars
            // and a truncated JSON string can never be re-parsed downstream,
            // which used to silently drop every edit whose input exceeded
            // the cap from the conclusion-card rollup.
            const part = { t: 'tool', name: p.name, id: p.id || '', v: briefJson(p.input) };
            // v212 用户裁定：改动文件汇总只收会话项目内的文件——Temp 里的
            // 截图/探针脚本等临时中间件不进汇总。锚=锁定 cwd（cwdSet，与
            // 归组同源）；大小写不敏感前缀（Windows 盘符不分大小，产物
            // 预览守卫同语义）；无锚（罕见：转录没有任何 cwd 行）不滤。
            const f = editDelta(p.name, p.input);
            if (f && patch.cwdSet) {
              const anchor = patch.cwdSet.replace(/[\\/]+$/, '');
              const lcAnchor = anchor.toLowerCase();
              const inProj = (fp) => {
                const lfp = String(fp).replace(/[\\/]+$/, '').toLowerCase();
                return lfp.startsWith(lcAnchor + '\\') || lfp.startsWith(lcAnchor + '/') || lfp === lcAnchor;
              };
              const kept = f.filter((x) => inProj(x.path));
              if (kept.length) part.f = kept;
            } else if (f) part.f = f;
            // v154: 待办板结构化载荷照同一先例随事件下发（tb）——前端禁 parse
            // chip 文本；会话级板状态由 adapter 用 applyBoard 累积
            const tb = taskPart(p.name, p.input);
            if (tb) part.tb = tb;
            parts.push(part);
            if (patch.est) { try { patch.est.tools += JSON.stringify(p.input || {}).length + 32; } catch { /* skip */ } }
          }
        }
        if (parts.length === 0) return null;
        return { k: 'assistant', ts: obj.timestamp || '', parts };
      }
      case 'custom-title': {
        const t = typeof obj.customTitle === 'string' ? obj.customTitle.trim() : '';
        if (!t) return null; // malformed/blank record: keep the current title
        patch.title = t;
        patch.titleFallback = false;
        return { k: 'title', ts: '', title: t };
      }
      case 'cost-state': {
        // aggregate across ALL models (a session can switch models mid-way);
        // do NOT touch patch.model here - assistant lines own the display label.
        // models: per-model breakdown kept for the v48 cost panel - model
        // switching must let each model's tokens price at ITS rate
        const usage = obj.modelUsage || {};
        let inTok = 0, outTok = 0, cacheRead = 0, cacheCreate = 0, usd = 0;
        const models = {};
        for (const [name, m] of Object.entries(usage)) {
          inTok += m.inputTokens || 0;
          outTok += m.outputTokens || 0;
          cacheRead += m.cacheReadInputTokens || 0;
          cacheCreate += m.cacheCreationInputTokens || 0;
          const mu = m.costUSD || 0;
          usd += mu;
          models[name] = { inTok: m.inputTokens || 0, outTok: m.outputTokens || 0, cacheRead: m.cacheReadInputTokens || 0, cacheCreate: m.cacheCreationInputTokens || 0, usd: mu };
        }
        const stats = { usd: (usd || obj.totalCostUSD || null), inTok, outTok, cacheRead, cacheCreate, models };
        // v191: 结算速率随 stats 下发（原始和数随行、除法留给前端）——只在
        // cost-state 落地时刷新，即费用面板的「结算」口径；无累加数据不带键。
        if (rec && rec._rate) {
          let rOut = 0, rMs = 0;
          const rModels = {};
          for (const [name, b] of Object.entries(rec._rate)) {
            rOut += b.out; rMs += b.ms;
            rModels[name] = { out: b.out, ms: b.ms };
          }
          stats.rate = { out: rOut, ms: rMs, models: rModels };
        }
        patch.cost = stats;
        // 2.1.308 occasionally flushes two cost-state lines back-to-back at
        // process exit (distinct snapshots; once in 39 here) - collapse
        // adjacent stats into the final one instead of rendering both
        const prevEv = events[events.length - 1];
        if (prevEv && prevEv.k === 'stats') events.pop();
        return { k: 'stats', ts: '', stats };
      }
      case 'system': {
        if (obj.subtype === 'local_command') {
          const so = String(obj.content || '').match(/^\s*<local-command-stdout>([\s\S]*?)<\/local-command-stdout>\s*$/);
          if (so && so[1].trim()) {
            const txt = so[1].trim();
            // v178: /goal 的 cmdout 信封（"Goal set: <条件>"）是「设定」事件的
            // 唯一展示源——它在文件序上紧跟 /goal 命令泡（sentinel attachment
            // 行在命令泡之前，用它展示会把提醒顶到命令上方——真机 4037478e）。
            const gs = txt.match(/^Goal set:\s*([\s\S]+)$/);
            if (gs) {
              if (rec) { rec._goalLive = true; rec._goalCond = gs[1].trim(); rec._goalCancelled = false; }
              return { k: 'goal', ts: obj.timestamp || '', st: 'set', cond: gs[1].trim() };
            }
            return { k: 'cmdout', ts: obj.timestamp || '', text: txt };
          }
        }
        if (STOP_SUBTYPES.has(obj.subtype)) {
          patch.status = 'idle';
          if (OUTCOME_SUBTYPES[obj.subtype]) patch.lastOutcome = OUTCOME_SUBTYPES[obj.subtype];
          // v165: goal 活着却停机 → 中断事件；其后 goal 活动 → 恢复事件。
          // 跨行状态走 rec（_cmdEnv 先例）。
          if (rec && rec._goalLive) {
            rec._goalInterrupted = true;
            events.push({ k: 'stop' }); // cost-state 先例：伴生事件直接入列
            return { k: 'goal', ts: obj.timestamp || '', st: 'interrupted', cond: rec._goalCond || '' };
          }
          // marker event: lets the PWA auto-collapse the live turn the moment
          // ANY driver (Desktop/CLI/phone) finishes, not just phone runs
          return { k: 'stop' };
        }
        return null;
      }
      case 'attachment': {
        // v165: goal 生命周期行（/goal 的持久状态源）。sentinel 行只置状态——
        // 「设定」气泡的唯一来源是 cmdout 信封（v165 真机踩中双气泡）；
        // 仅当 cmdout 信封缺席（异常驱动）时 sentinel 兜底发事件。
        const at = obj.attachment;
        if (!at || at.type !== 'goal_status') return null;
        const cond = String(at.condition || '');
        if (at.met || at.failed) {
          if (rec) { rec._goalLive = false; rec._goalInterrupted = false; rec._goalHoldArmed = false; }
          // v177: 用户取消（墓碑）后 CLI 的会话状态仍会幽灵武装 Stop hook——
          // 后续 met/failed 是幽灵判定噪音（真机 6b03224e：取消后 hook 复活
          // 跑检查并写 met=「已完成」）。停止行本身照常展示并武装压制；
          // 新 /goal 的 sentinel 行解除压制。
          const stopped = !!(at.met && at.note);
          if (stopped) {
            if (rec) rec._goalCancelled = true;
            return { k: 'goal', ts: obj.timestamp || '', st: 'stopped', cond };
          }
          if (rec && rec._goalCancelled) return null;
          return { k: 'goal', ts: obj.timestamp || '', st: at.met ? 'met' : 'failed', cond };
        }
        // v177: 取消后的非 sentinel 检查行（幽灵 hook 写入）全部静默；
        // sentinel = 用户重新 /goal = 解除压制（展示由随后的 cmdout 负责）
        if (rec && rec._goalCancelled) {
          if (!at.sentinel) return null;
          rec._goalCancelled = false;
        }
        if (rec) { rec._goalLive = true; rec._goalCond = cond; }
        // v178: sentinel 只置状态不展示（文件序在命令泡之前，展示会错位）
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

// v146: synthesize a unified-diff view of EVERY edit a transcript made to one
// file, for the rollup's +/- tap. Works on RAW JSONL line objects (not the
// display events - those truncate inputs at 300 chars). Edit/MultiEdit render
// old->new hunks chronologically; Write/NotebookEdit render the full content
// as additions (the previous content is unknowable from the input). Hunk
// headers only need to LOOK like @@ markers - the PWA renderer never reads
// the numbers. Returns '' when no tool_use targeted the file.
const FILEDIFF_MAX = 256 * 1024;
export function synthesizeFileDiff(lines, matchPath) {
  const want = String(matchPath || '').toLowerCase();
  if (!want) return '';
  const name = String(matchPath).split(/[\\/]/).pop();
  const lc = (v) => (typeof v === 'string' ? v.split('\n') : []);
  const minus = (v) => (v ? lc(v).map((l) => '-' + l).join('\n') : '');
  const plus = (v) => (v ? lc(v).map((l) => '+' + l).join('\n') : '');
  let out = '', toolN = 0;
  for (const obj of lines) {
    if (!obj || obj.type !== 'assistant' || !obj.message) continue;
    const parts = obj.message.content;
    if (!Array.isArray(parts)) continue;
    for (const p of parts) {
      if (!p || p.type !== 'tool_use' || !p.input) continue;
      const inp = p.input;
      const fp = inp.file_path || inp.path || inp.notebook_path;
      if (typeof fp !== 'string' || fp.toLowerCase() !== want) continue;
      toolN++;
      let hunk = '';
      if (Array.isArray(inp.edits)) {
        inp.edits.forEach((e, i) => {
          hunk += '@@ MultiEdit ' + (i + 1) + '/' + inp.edits.length + ' @@\n' +
            minus(e && e.old_string) + '\n' + plus(e && e.new_string) + '\n';
        });
      } else if (typeof inp.content === 'string') {
        hunk += '@@ Write · 全文 ' + lc(inp.content).length + ' 行 @@\n' + plus(inp.content) + '\n';
      } else if (typeof inp.new_source === 'string') {
        hunk += '@@ NotebookEdit · 全文 ' + lc(inp.new_source).length + ' 行 @@\n' + plus(inp.new_source) + '\n';
      } else {
        hunk += '@@ Edit @@\n' + minus(inp.old_string) + '\n' + plus(inp.new_string) + '\n';
      }
      out += hunk;
      if (out.length > FILEDIFF_MAX) { out = out.slice(0, FILEDIFF_MAX) + '\n…（过大截断，完整编辑记录见转录）'; break; }
    }
    if (out.length > FILEDIFF_MAX) break;
  }
  if (!toolN) return '';
  return '--- a/' + name + '\n+++ b/' + name + '\n' + out;
}

// v145: per-tool_use changed-file delta for the PWA conclusion-card rollup,
// mirroring the old frontend logic (Write counts every line as an addition -
// the previous content is unknowable from the input alone). Called only for
// file-edit tools; everything else returns null and carries no f.
const EDIT_TOOLS = { Edit: 1, Write: 1, MultiEdit: 1, NotebookEdit: 1 };
function editDelta(name, input) {
  if (!EDIT_TOOLS[name] || !input || typeof input !== 'object') return null;
  const p = input.file_path || input.path || input.notebook_path;
  if (typeof p !== 'string' || !p) return null;
  const lc = (v) => (typeof v === 'string' ? v.split('\n').length : 0);
  if (Array.isArray(input.edits)) {
    let add = 0, del = 0;
    for (const e of input.edits) { add += lc(e && e.new_string); del += lc(e && e.old_string); }
    return [{ path: p, add, del }];
  }
  if (typeof input.content === 'string') return [{ path: p, add: lc(input.content), del: 0 }];
  return [{ path: p, add: lc(input.new_string) + lc(input.new_str) + lc(input.new_source),
    del: lc(input.old_string) + lc(input.old_str) + lc(input.old_source) }];
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
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .trim();
}

// ---------- v154: 待办板（Task* / TodoWrite） ----------
// 实测（2026-11-01，2.1.308 二进制 schema；-p 工具集不含这些工具，待办数据只
// 可能来自 TUI/桌面驱动会话的转录）：
//   TaskCreate = {subject, description?, activeForm?} 一次一条
//   TaskUpdate = {taskId, status?(pending|in_progress|completed|deleted),
//                 subject?, activeForm?} —— 真实枚举无 cancelled，deleted=移出板
//   TodoWrite  = {todos:[{content, status(pending|in_progress|completed),
//                 activeForm?}]} 全量覆写
//   TaskList / TaskGet 只读查询，不解析（保持普通工具 chip）
// tb 载荷照 v145 f:[] 先例随事件下发（chip v 截 300 字符，结构化必须解析层给）。

export const TASK_TOOLS = { TaskCreate: 1, TaskUpdate: 1, TodoWrite: 1 };

// 从原始 tool_use input 提取结构化载荷；非待办工具（或形状不认识）返回 null。
export function taskPart(name, input) {
  if (!input || typeof input !== 'object') return null;
  if (name === 'TodoWrite') {
    if (!Array.isArray(input.todos)) return null;
    return { g: 'w', items: input.todos.map((t) => ({
      s: String((t && t.content) || ''),
      st: (t && t.status) || 'pending',
      af: (t && t.activeForm) || '',
    })) };
  }
  if (name === 'TaskCreate') {
    if (typeof input.subject !== 'string' || !input.subject) return null;
    return {
      g: 'c', s: input.subject,
      d: typeof input.description === 'string' ? input.description.slice(0, 500) : '',
      af: typeof input.activeForm === 'string' ? input.activeForm : '',
    };
  }
  if (name === 'TaskUpdate') {
    if (input.taskId == null) return null;
    return {
      g: 'u', id: String(input.taskId),
      st: typeof input.status === 'string' ? input.status : '',
      s: typeof input.subject === 'string' ? input.subject : '',
      af: typeof input.activeForm === 'string' ? input.activeForm : '',
    };
  }
  return null;
}

// 会话级板状态机。board 形状（对外快照）：{n, total, items:[{id,s,st,af}]}——
// n=completed 数，total=items.length（deleted 已移除；未知状态灰显计入分母）。
// _pend 为内部字段（TaskCreate→tool_result 的 id 绑定槽），快照时剥掉。
// 返回值=板是否变化（调用方据此决定是否广播）。
export function applyBoard(board, tb, toolUseId) {
  if (!board || !tb) return false;
  if (tb.g === 'w') {
    board.items = tb.items.map((it) => ({ id: '', s: it.s, st: it.st, af: it.af }));
    board._pend = [];
    return recalcBoard(board);
  }
  if (tb.g === 'c') {
    // v203 用户裁定：每批待办列表独立——上一批全部 completed 后再来的新
    // TaskCreate = 新周期开始，历史完成项清出板（不再计入 n/total；转录内
    // 的历史节点是逐事件渲染的，不受板影响）。部分完成（还有 pending/
    // in_progress）时的新 create = 同批补充，不清。
    if (board.items.length && board.items.every((x) => x.st === 'completed')) {
      board.items = [];
      board._pend = [];
    }
    const item = { id: '', s: tb.s, st: 'pending', af: tb.af };
    board.items.push(item);
    board._pend.push({ toolUseId: toolUseId || '', ref: item });
    return recalcBoard(board);
  }
  if (tb.g === 'u') {
    const it = board.items.find((x) => x.id && x.id === tb.id);
    if (!it) {
      // 未绑定的 id：占位行（TodoWrite 板无 id、或 create 结果未落盘时的兜底）
      board.items.push({ id: tb.id, s: tb.s || '任务 #' + tb.id, st: tb.st && tb.st !== 'deleted' ? tb.st : 'pending', af: tb.af });
      return recalcBoard(board);
    }
    if (tb.st === 'deleted') {
      board.items.splice(board.items.indexOf(it), 1);
      return recalcBoard(board);
    }
    if (tb.st) it.st = tb.st;
    if (tb.s) it.s = tb.s;
    if (tb.af) it.af = tb.af;
    return recalcBoard(board);
  }
  return false;
}

// TaskCreate 的 tool_result 落地：从结果文本容错提取分配的 id 绑回条目。
// 形状未实测（-p 无此工具），按 JSON {"id":...} / "#3" / 裸数字宽容匹配。
export function bindCreated(board, toolUseId, text) {
  if (!board || !Array.isArray(board._pend) || !board._pend.length) return false;
  const i = board._pend.findIndex((p) => p.toolUseId && p.toolUseId === toolUseId);
  if (i < 0) return false;
  const pend = board._pend.splice(i, 1)[0];
  const m = /"id"\s*:\s*"?(\w+)"?|#\s*(\w+)|\b(\d+)\b/.exec(String(text || '').slice(0, 400));
  const id = m && (m[1] || m[2] || m[3]);
  if (id && pend.ref) pend.ref.id = id;
  return true;
}

function recalcBoard(board) {
  const n = board.items.reduce((acc, it) => acc + (it.st === 'completed' ? 1 : 0), 0);
  const sig = JSON.stringify(board.items);
  const changed = board.n !== n || board.total !== board.items.length || board._sig !== sig;
  board.n = n;
  board.total = board.items.length;
  board._sig = sig;
  return changed;
}

// 对外快照：剥内部字段 + 拷贝，避免下发对象与内部状态共享引用。
export function boardSnapshot(board) {
  if (!board || !board.total) return null;
  return {
    n: board.n, total: board.total,
    items: board.items.map((it) => ({ id: it.id, s: it.s, st: it.st, af: it.af })),
  };
}
