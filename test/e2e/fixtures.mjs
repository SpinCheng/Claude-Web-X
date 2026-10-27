// test/e2e/fixtures.mjs - synthetic transcript builders (timestamps in the
// recent past so the adapter's freshness window behaves deterministically).
// NOTE: never inline these through bash node -e (backslashes get eaten);
// real-world paths use String.raw here.

const T0 = Date.now() - 120_000;
const ts = (i) => new Date(T0 + i * 1000).toISOString();

export const user = (i, text, cwd = 'D:\\e2e') =>
  ({ type: 'user', timestamp: ts(i), cwd, origin: { kind: 'human' }, message: { role: 'user', content: text } });

export const assistant = (i, parts, model = 'glm-5.3') =>
  ({ type: 'assistant', timestamp: ts(i), message: { role: 'assistant', model, content: parts, usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 } } });

export const toolResult = (i, id, text) =>
  ({ type: 'user', timestamp: ts(i), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } });

export const stop = (i) => ({ type: 'system', timestamp: ts(i), subtype: 'stop' });

export const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
export const text = (v) => ({ type: 'text', text: v });

export const compactSummary = (i, chars = 12000) =>
  ({ type: 'user', timestamp: ts(i), cwd: 'D:\\e2e', isCompactSummary: true, isVisibleInTranscriptOnly: true,
     message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. ' + 'summary '.repeat(chars / 8) } });

export const skillBody = (i, name, lines = 600) => {
  // plain concat: String.raw templates cannot END with a backslash (the \`
  // before the closing tick would escape it) - this file is never inlined
  // through bash, so doubled backslashes are safe here
  const body = 'Base directory for this skill: C:\\Users\\x\\.claude\\skills\\' + name + '\n\n# ' + name + '\n' + 'instruction line\n'.repeat(lines);
  return { type: 'user', timestamp: ts(i), cwd: 'D:\\e2e', message: { role: 'user', content: [{ type: 'text', text: body }] } };
};

export const slashCommand = (i, name, args = '') =>
  ({ type: 'user', timestamp: ts(i), cwd: 'D:\\e2e', origin: { kind: 'human' },
     message: { role: 'user', content: `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>` } });

// scenario: chronological timeline with tool result pairing; a second turn
// carries an Edit so the conclusion-card file rollup (v45 fsum) is exercised
export function timelineLines() {
  return [
    user(1, '做时间轴测试'),
    assistant(2, [text('开始'), toolUse('t1', 'Bash', { command: 'echo timeline-order-ok' })]),
    toolResult(3, 't1', 'timeline-order-ok'),
    assistant(4, [text('命令输出：timeline-order-ok')]),
    stop(5),
    user(6, '改文件汇总'),
    assistant(7, [toolUse('t2', 'Edit', { file_path: 'D:\\e2e\\a.txt', old_string: 'x\ny', new_string: 'x1\ny1\nz' }), text('已修改 a.txt')]),
    stop(8),
  ];
}

// scenario: history pagination (v46) - 140 turns = 420 events; the first
// screen shows only the LAST 400 (events 21..420 = turns 7..139, 266 turns);
// "load older" brings the first 20 events (turns 0..6, 14 turns) => 280.
export function pagedLines(turns = 140) {
  const L = [];
  let i = 1;
  for (let n = 0; n < turns; n++) {
    L.push(user(i++, '第' + n + '轮提问'));
    L.push(assistant(i++, [text('第' + n + '轮回答')]));
    L.push(stop(i++));
  }
  return L;
}

// scenario: markdown-rich conclusion
export function mdLines() {
  const md = [
    '## 部署结果', '',
    '完成 **3 项**，重点 `bridge/server.js` 与 *斜体*。', '',
    '- 新增端点', '- 修复双显', '',
    '1. 先测试', '2. 再提交', '',
    '| 项 | 值 |', '|---|---|', '| 成本 | $1.20 |', '',
    '> 引用一行', '', '---', '',
    '见 [文档](https://example.com/a?b=1)。', '',
    '```js', 'const x = 1;', '```',
  ].join('\n');
  return [user(1, 'md 测试'), assistant(2, [text(md)]), stop(3)];
}

// scenario: fold markers (compaction + skill + slash command)
export function foldsLines() {
  return [
    slashCommand(1, 'goal', '请进行优化'),
    assistant(2, [text('第一答')]),
    compactSummary(3),
    skillBody(4, 'sample-skill'),
    assistant(5, [text('技能后回答')]),
    stop(6),
  ];
}

// scenario: artifact preview (cwd = the scenario temp root; dir with real
// backslashes - JSON.stringify escapes them on write)
export function previewLines(dir, fileName) {
  const p = dir.replace(/[\\/]+$/, '') + '\\' + fileName;
  return [
    user(1, '预览测试', dir),
    assistant(2, [toolUse('t1', 'Write', { file_path: p, content: 'hello' })]),
    toolResult(3, 't1', 'File written to ' + p + ' (12 bytes)'),
    assistant(4, [text('产物在 ' + p)]),
    stop(5),
  ];
}
