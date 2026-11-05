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
import { execFile, spawn } from 'node:child_process';
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
export function clearIndexCache() { _idxCache.clear(); _stCache.clear(); } // tests（状态缓存同清）

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
      out.push({ abs, file: disp, name: disp, type: IMG_MIME[ext], at: true });
    } else if (TEXT_EXT.has(ext) && st.size <= INLINE_LIMIT) {
      out.push({ abs, file: disp, name: disp, type: 'text/plain', at: true });
    }
    // 其余（二进制/未知扩展/超限文本）= 纯路径降级，不产出
  }
  return out;
}

// ---- 项目文件树数据面（roadmap 12，v193）----
// 磁盘真相：readdir 逐层懒加载（未跟踪/被 ignore 的都在）；git 只作标注层：
// tracked=纯 index 清单（git ls-files，无 --others——@ 选择器的混合索引会把
// 未跟踪也算进来，树的「已跟踪」语义必须是 staged 集）、untracked=
// `git status --porcelain`（?? 折叠目录按前缀展开判定）、ignored=
// `git check-ignore --stdin` 批查。用户裁定「git 视角不筛 git」——
// untracked/ignored 行照常可开/预览/插入，仅角标置灰。
const GIT_ENV = () => ({ ...process.env, ...bashToolEnv(process.env), windowsHide: true });

// 纯 index（staged）文件清单，3s TTL；非 git -> null
export async function trackedFileList(cwd) {
  const hit = _idxCache.get('trk:' + cwd);
  if (hit && Date.now() - hit.at < 3000) return hit.files;
  let files = null;
  try {
    const { stdout } = await new Promise((resolve, reject) => {
      execFile('git', ['ls-files', '-z'], {
        cwd, timeout: 5000, maxBuffer: 32 * 1024 * 1024, env: GIT_ENV(),
      }, (err, out) => (err ? reject(err) : resolve({ stdout: out })));
    });
    files = stdout.split('\0').filter(Boolean);
  } catch { /* 非 git / git 缺失 -> 无标注层 */ }
  _idxCache.set('trk:' + cwd, { files, at: Date.now() });
  return files;
}

// porcelain -z --ignored（折叠目录保持一行，node_modules 不会炸开）；
// 3s TTL 缓存。v200 起全状态：XY 码 → mod/add/del（D 优先 > A > M/R），
// unt/ign 维持独立集合；返回 {unt,ign,st:Map(path→code),u,i,m,a,d} 或 null。
const _stCache = new Map(); // cwd -> {parsed, at}
export async function gitStatusZ(cwd) {
  const hit = _stCache.get(cwd);
  if (hit && Date.now() - hit.at < 3000) return hit.parsed;
  let parsed = null;
  try {
    const { stdout } = await new Promise((resolve, reject) => {
      execFile('git', ['status', '--porcelain', '-z', '--ignored'], {
        cwd, timeout: 5000, maxBuffer: 16 * 1024 * 1024, env: GIT_ENV(),
      }, (err, out) => (err ? reject(err) : resolve({ stdout: out })));
    });
    parsed = parseStatusZ(stdout);
  } catch { /* 非 git / 超时 -> 无标注层 */ }
  _stCache.set(cwd, { parsed, at: Date.now() });
  return parsed;
}
// porcelain -z：字段 = `XY <path>`\0；R/C 条目跟第二个 \0 字段（原路径）要跳过。
// X=staged Y=unstaged：删（任一位 D）> 增（任一位 A）> 改（M/R/C）
export function parseStatusZ(out) {
  const unt = new Set(), ign = new Set(), st = new Map();
  let m = 0, a = 0, d = 0;
  const toks = String(out).split('\0');
  for (let k = 0; k < toks.length; k++) {
    const f = toks[k];
    if (!f) continue;
    const xy = f.slice(0, 2);
    const p = f.slice(3).replace(/\/$/, '');
    if (xy === '??') { unt.add(p); continue; }
    if (xy === '!!') { ign.add(p); continue; }
    if (xy[0] === 'R' || xy[0] === 'C') k++; // 折掉 rename 原路径字段
    if (xy.includes('D')) { st.set(p, 'del'); d++; }
    else if (xy[0] === 'A' || xy[1] === 'A') { st.set(p, 'add'); a++; }
    else { st.set(p, 'mod'); m++; } // M/R/C 及其余组合都按"改"着色
  }
  return { unt, ign, st, u: unt.size, i: ign.size, m, a, d };
}

// check-ignore 批查：stdin 喂 NUL 分隔路径，stdout 返回被忽略的路径集合。
// 退出码 1 = 全都不忽略（不是错误）；非 git（128）-> 空集。
async function checkIgnore(cwd, paths) {
  const out = await new Promise((resolve) => {
    const child = spawn('git', ['check-ignore', '-z', '--stdin'], { cwd, env: GIT_ENV() });
    let buf = '';
    child.stdout.on('data', (c) => { buf += c.toString('utf8'); });
    child.on('error', () => resolve(null));
    child.on('close', () => resolve(buf));
    child.stdin.write(paths.join('\0') + '\0');
    child.stdin.end();
  }).catch(() => null);
  if (!out) return new Set();
  return new Set(out.split('\0').filter(Boolean));
}

// 一层目录：{ entries:[{n,d,g,c,t}], more, capped }。g='unt'|'ign'|null；
// c=目录内被跟踪文件数（索引推得，不触盘）；t=已跟踪（文件在索引/目录含
// 跟踪后代）。单层 >500 截断（more=true）；深度上限 12（capped=true）。
export async function treeDir(cwd, rel = '') {
  if (!cwd || typeof rel !== 'string') return null;
  const root = path.resolve(cwd);
  const abs = path.resolve(root, rel || '.');
  if (!insideRoot(root, abs)) return null;
  const depth = rel.split('/').filter(Boolean).length;
  if (depth >= 12) return { entries: [], more: false, capped: true };
  const srt = (a, b) => a.toLowerCase().localeCompare(b.toLowerCase());
  // v200 全状态：状态先取（幽灵删除行不依赖磁盘），readdir 失败也可服务
  const tracked = await trackedFileList(cwd).catch(() => null);
  const st = tracked ? await gitStatusZ(cwd).catch(() => null) : null;
  const fileSt = st && st.st && st.st.size ? st.st : null;
  const dirSt = new Map(); // 目录聚合：后代状态按 D>M>A 取最强
  const RANK = { del: 4, mod: 3, add: 2 };
  if (fileSt) {
    for (const [p, code] of fileSt) {
      let i = p.indexOf('/');
      while (i > 0) {
        const dir = p.slice(0, i);
        const prev = dirSt.get(dir);
        if (!prev || RANK[code] > RANK[prev]) dirSt.set(dir, code);
        i = p.indexOf('/', i + 1);
      }
    }
  }
  const relOf = (n) => (rel ? rel.replace(/\/+$/, '') + '/' : '') + n;
  const relPre = rel ? rel.replace(/\/+$/, '') + '/' : '';
  // 幽灵删除行：porcelain 里有 D、磁盘上已不存在的直接子项（更深的路径折进
  // 其首段作为幽灵目录行——展开时 readdir 失败但幽灵注入不依赖磁盘）
  const ghosts = [], ghostDirs = new Set();
  if (fileSt) {
    for (const [p, code] of fileSt) {
      if (code !== 'del' || !p.startsWith(relPre)) continue;
      const base = p.slice(relPre.length);
      if (!base) continue;
      if (base.includes('/')) ghostDirs.add(base.slice(0, base.indexOf('/')));
      else ghosts.push(base);
    }
  }
  let names = null;
  try { names = fs.readdirSync(abs, { withFileTypes: true }); } catch { /* 目录整体已删：只剩幽灵行 */ }
  const dirs = [], files = [];
  if (names) {
    for (const e of names) {
      try {
        if (e.isDirectory()) dirs.push(e.name);
        else if (e.isFile()) files.push(e.name);
      } catch { /* raced away */ }
    }
    dirs.sort(srt); files.sort(srt);
  }
  const onDisk = new Set(dirs.concat(files));
  for (const gName of ghosts) if (!onDisk.has(gName)) files.push(gName);
  for (const gName of ghostDirs) if (!onDisk.has(gName)) dirs.push(gName);
  dirs.sort(srt); files.sort(srt);
  const all = dirs.concat(files);
  const more = all.length > 500;
  const shown = more ? all.slice(0, 500) : all;

  let unt = null;
  let ignSet = new Set();
  if (tracked) {
    unt = st ? st.unt : new Set();
    if (shown.length) ignSet = await checkIgnore(cwd, shown.map(relOf)).catch(() => new Set());
  }
  const trackedSet = tracked ? new Set(tracked) : null;
  const dirSet = new Set(dirs);
  const underUnt = (rp) => { // 自己或祖先被 ?? 折叠收录
    if (unt.has(rp)) return true;
    for (const e of unt) if (rp.startsWith(e + '/')) return true;
    return false;
  };
  const entries = shown.map((n) => {
    const rp = relOf(n);
    const isDir = dirSet.has(n);
    if (isDir) {
      let c = 0;
      if (trackedSet) { const pre = rp + '/'; for (const f of tracked) if (f.startsWith(pre)) c++; }
      let g = null;
      if (tracked && unt.has(rp)) g = 'unt';            // 整目录未跟踪（?? 折叠行）
      else if (dirSt && dirSt.has(rp)) g = dirSt.get(rp); // v200 聚合状态（含幽灵删除目录）
      else if (ignSet.has(rp)) g = 'ign';
      return { n, d: 1, g, c, t: c > 0 };
    }
    let g = null;
    if (fileSt && fileSt.has(rp)) g = fileSt.get(rp);     // v200 全状态（del=幽灵行）
    else if (tracked && underUnt(rp)) g = 'unt';
    else if (ignSet.has(rp)) g = 'ign';
    return { n, d: 0, g, t: trackedSet ? trackedSet.has(rp) : false };
  });
  // 目录在前、名称升序（幽灵行已并入 files，统一排序）
  entries.sort((x, y) => (y.d - x.d) || srt(x.n, y.n));
  return { entries, more, capped: false };
}

// 项目根统计（ftbar）：跟踪=|staged 索引|；v200 带全状态计数（改/增/删）；非 git -> null
export async function repoStats(cwd) {
  const tracked = await trackedFileList(cwd).catch(() => null);
  if (!tracked) return null;
  const st = await gitStatusZ(cwd).catch(() => null);
  return { t: tracked.length, u: st ? st.u : 0, i: st ? st.i : 0, m: st ? st.m : 0, a: st ? st.a : 0, d: st ? st.d : 0 };
}
