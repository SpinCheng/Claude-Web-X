// lib/fileindex.js - @ 远程文件选择器数据面 + 发送时代附扫描（roadmap 11，v192）
//
// 数据面：`git ls-files --cached --others --exclude-standard` 一次拉全索引
// （已跟踪 + 未忽略未跟踪，万级仓库毫秒级），客户端本地过滤（v109 斜杠菜单
// 先例——零 per-keystroke 请求）。非 git cwd 退化为 readdir 目录浏览兜底。
// ignore 白名单 = bridge/data/file-index-include（gitignore 语法，`!目录/`
// 否定行让被忽略目录重进索引——逐行转 --exclude= 直传，见 repoFileList 注释；
// 缺省不存在 = 纯 git 语义；只影响选择器索引不影响 git 状态；管理 UI 已
// 裁定后置 PWA 设置页）。
//
// 代附（发送前，message 路由调用）：词边界扫描 @path 记号（防 user@host
// 误判）→ 逐个过 cwd 守卫（复用产物预览的前缀校验语义）→ 文本 ≤24KB 内联
// （同文本附件路径，runner 侧） / 图片扩展走 stdin 图片块（远程项目图片直入
// 对话）/ 超限·二进制·目录·校验失败 → 降级为纯路径文本由模型自取。
// 单条消息代附上限 4；不修改原文（v190 用户文本逐字纪律）。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CI_PATHS, bashToolEnv } from './platform.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_INCLUDE = path.join(__dirname, '..', 'data', 'file-index-include');

export const MAX_AT_ATTACH = 4;
export const INLINE_LIMIT = 24 * 1024;      // 文本内联上限（同文本附件路径）
export const IMG_LIMIT = 2 * 1024 * 1024;   // 图片直附上限（预览 2MB 先例；超限降级纯路径，模型可自行 Read）

const IMG_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
};
// 可内联的文本类扩展（白名单外 = 二进制态度：降级纯路径）
const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.log', '.json', '.jsonc', '.yaml', '.yml', '.toml',
  '.ini', '.cfg', '.conf', '.env', '.xml', '.csv', '.tsv', '.diff', '.patch', '.svg',
  '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.vue', '.svelte', '.astro',
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp',
  '.cs', '.php', '.lua', '.r', '.m', '.pl', '.sh', '.bash', '.zsh', '.fish',
  '.ps1', '.psm1', '.bat', '.cmd', '.sql', '.gradle', '.properties', '.gitignore',
  '.editorconfig', '.npmrc', '.nvmrc', '.lock',
]);

// cwd 守卫（产物预览同语义）：resolve 后大小写按平台比较前缀
export function insideRoot(root, p) {
  const a = CI_PATHS ? p.toLowerCase() : p;
  const b = CI_PATHS ? root.toLowerCase() : root;
  return a === b || a.startsWith(b + path.sep);
}

// ---- git 索引（per-cwd 3s TTL；新文件/新会话跑几轮自然刷新） ----
const _idxCache = new Map(); // cwd -> { files: string[]|null, at }
export function clearIndexCache() { _idxCache.clear(); } // tests

// 返回 string[]（仓库相对正斜杠路径）或 null（非 git 仓库 / git 不可用）。
// include 文件逐行转 `--exclude=` 直传（命令行层优先级最高）——实测
// `--exclude-from=` 的 `!` 否定压不过 .gitignore（父目录已排除时无法复活），
// 逐行 --exclude 才能让 `!dir/` 白名单真正生效（探针 2026-11-05）。
export async function repoFileList(cwd, includePath = DEFAULT_INCLUDE) {
  const hit = _idxCache.get(cwd);
  if (hit && Date.now() - hit.at < 3000) return hit.files;
  let extra = [];
  try {
    if (fs.existsSync(includePath)) {
      extra = fs.readFileSync(includePath, 'utf8').split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
    }
  } catch { /* unreadable -> pure git semantics */ }
  const args = ['ls-files', '-z', '--cached', '--others', '--exclude-standard',
    ...extra.map((l) => '--exclude=' + l)];
  let files = null;
  try {
    const { stdout } = await new Promise((resolve, reject) => {
      execFile('git', args, {
        cwd, timeout: 5000, maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, ...bashToolEnv(process.env) }, // lean-start 桥也要找得到 git（v62 同坑）
        windowsHide: true,
      }, (err, out) => (err ? reject(err) : resolve({ stdout: out })));
    });
    files = stdout.split('\0').filter(Boolean);
  } catch { /* 非 git 仓库 / git 缺失 / 超时 -> 浏览兜底 */ }
  _idxCache.set(cwd, { files, at: Date.now() });
  return files;
}

// ---- readdir 浏览兜底（非 git cwd 的首层目录浏览；?p= 深钻同函数） ----
// 返回 { dirs: [名], files: [名] }（各 ≤500 截断、不区分大小写排序）或 null（守卫拒绝/不存在）
export function browseDir(cwd, rel = '') {
  if (!cwd || typeof rel !== 'string') return null;
  const root = path.resolve(cwd);
  const abs = path.resolve(root, rel || '.');
  if (!insideRoot(root, abs)) return null;
  let entries;
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return null; }
  const dirs = [], files = [];
  for (const e of entries) {
    try {
      if (e.isDirectory()) dirs.push(e.name);
      else if (e.isFile()) files.push(e.name);
    } catch { /* raced away */ }
  }
  const ci = (a, b) => a.toLowerCase().localeCompare(b.toLowerCase());
  return { dirs: dirs.sort(ci).slice(0, 500), files: files.sort(ci).slice(0, 500) };
}

// ---- 发送时代附 ----
// @token 提取：`@` 后连续非空白非 @ 字符；@ 前一字符必须是 行首/空白/非词字符
// （词字符 = 字母/数字/下划线，含 CJK——防 user@host 与「中文@引用」误判）。
// token 内遇 prose 标点（全角句读/引号/ASCII ,;:!?）即截断——「@a.md，看看」
// 取 a.md；'.' '-' '_' ASCII 括号等文件名常用字符保留（file(1).txt 可引用）。
// 纯函数，供单测与扫描共用（前端 composer.js 有同语义镜像）。
const AT_STOP = /[,;:!?'"‘’“”…—·，。、；：！？（）【】《》〈〉「」『』]/u;
export function scanAtTokens(text) {
  const out = [];
  const re = /@([^\s@]+)/gu;
  let m;
  while ((m = re.exec(text))) {
    const prev = m.index > 0 ? text[m.index - 1] : '';
    if (prev && /[\p{L}\p{N}_]/u.test(prev)) continue;
    const stop = m[1].search(AT_STOP);
    const tok = stop < 0 ? m[1] : m[1].slice(0, stop);
    if (!tok) continue;
    out.push({ start: m.index, end: m.index + 1 + tok.length, path: tok });
  }
  return out;
}

// 逐 token 校验分类，产出 runner 附件对象（abs=项目内绝对路径；name=用户引用
// 的相对路径，进内联块标题）。任何不满足 = 不产出（原文保留，模型自取）。
export function collectAtAttachments(text, cwd) {
  if (!text || typeof text !== 'string' || !cwd) return [];
  const root = path.resolve(cwd);
  const out = [];
  for (const t of scanAtTokens(text)) {
    if (out.length >= MAX_AT_ATTACH) break;          // 前 4 个可代附者，其余降级
    const rel = t.path;
    if (rel.endsWith('/') || rel.endsWith('\\')) continue; // 显式目录引用：只插路径文本
    // 绝对/家目录形态不是项目相对引用，不代附（守卫也会拒，先省一次 stat）
    if (/^([a-zA-Z]:[\\/]|\\\\|\/|~)/.test(rel)) continue;
    const abs = path.resolve(root, rel);
    if (!insideRoot(root, abs)) continue;            // cwd 守卫
    let st;
    try { st = fs.statSync(abs); } catch { continue; } // 不存在：原文保留
    if (!st.isFile()) continue;                      // 目录/特殊文件：模型自探索
    const ext = path.extname(abs).toLowerCase();
    const disp = rel.split('\\').join('/');
    if (IMG_MIME[ext]) {
      if (st.size > IMG_LIMIT) continue;             // 超限图片：纯路径（可 Read）
      out.push({ abs, file: disp, name: disp, type: IMG_MIME[ext] });
    } else if (TEXT_EXT.has(ext) && st.size <= INLINE_LIMIT) {
      out.push({ abs, file: disp, name: disp, type: 'text/plain' });
    }
    // 其余（二进制/未知扩展/超限文本）= 纯路径降级，不产出
  }
  return out;
}
