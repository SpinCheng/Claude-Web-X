// lib/commands.js - slash-command registry for the composer menu (v109).
// Built-ins are static data (descriptions authored here; availability per the
// 2.1.308 binary's supportsNonInteractive flags, smoke-verified in -p mode).
// Custom commands are discovered from <cwd>/.claude/commands and
// ~/.claude/commands (subdirectories namespace with ':', project overrides
// user on name collision). Pure functions - unit-tested.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BUILTIN_COMMANDS = [
  { name: 'context', desc: '上下文占用明细', argHint: '' },
  { name: 'compact', desc: '压缩上下文，释放窗口空间', argHint: '[压缩指示]' },
  { name: 'clear', desc: '开新会话清空上下文（旧会话留盘可恢复）', argHint: '[名称]' },
  { name: 'usage', desc: '订阅用量统计（/cost /stats 同义）', argHint: '' },
  { name: 'mcp', desc: '管理 MCP 服务器', argHint: '[reconnect|enable|disable <server>|all]' },
  { name: 'autocompact', desc: '自动压缩开关', argHint: '' },
  { name: 'output-style', desc: '输出风格切换', argHint: '' },
  { name: 'goal', desc: '设定/查看会话目标（达成条件）', argHint: '<条件>' },
  { name: 'list-agents', desc: '列出子代理与其他可消息的会话', argHint: '' },
  { name: 'recap', desc: '生成一行会话摘要', argHint: '' },
  { name: 'skill-doctor', desc: '查看哪些已加载技能在吃上下文', argHint: '' },
  { name: 'init', desc: '分析代码库并生成 CLAUDE.md', argHint: '' },
  { name: 'security-review', desc: '安全审查当前分支待提交改动', argHint: '' },
  { name: 'reload-skills', desc: '热加载磁盘上变动的技能', argHint: '' },
  { name: 'reload-plugins', desc: '激活待生效的插件变更', argHint: '[--force]' },
];

// minimal frontmatter: only description / argument-hint matter for the menu
export function parseCommandFrontmatter(text) {
  if (!/^---\r?\n/.test(text)) return {};
  const end = text.indexOf('\n---', 3);
  if (end < 0) return {};
  const block = text.slice(4, end);
  const out = {};
  for (const line of block.split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (k === 'description' || k === 'argument-hint') out[k] = line.slice(i + 1).trim();
  }
  return out;
}

// scan one commands dir; subdirectories namespace with ':' (/ns:name);
// non-.md and unreadable files are skipped
export function scanCommandsDir(dir, depth = 0) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < 3) for (const c of scanCommandsDir(full, depth + 1)) out.push({ ...c, name: e.name + ':' + c.name });
      continue;
    }
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue;
    const name = e.name.slice(0, -3);
    let fm = {};
    try { fm = parseCommandFrontmatter(fs.readFileSync(full, 'utf8')); } catch { /* unreadable -> skip meta */ }
    out.push({ name, desc: fm.description || '', argHint: fm['argument-hint'] || '' });
  }
  return out;
}

export function collectCommands(cwd) {
  const user = path.join(os.homedir(), '.claude', 'commands');
  const proj = cwd ? path.join(cwd, '.claude', 'commands') : null;
  const us = scanCommandsDir(user);
  const ps = proj ? scanCommandsDir(proj) : [];
  const byName = new Map();
  for (const c of us) byName.set(c.name, { ...c, src: '用户' });
  for (const c of ps) byName.set(c.name, { ...c, src: '项目' }); // project overrides user
  return [
    ...BUILTIN_COMMANDS.map((c) => ({ ...c, src: '内置' })),
    ...[...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
  ];
}
