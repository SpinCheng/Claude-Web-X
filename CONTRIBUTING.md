# 贡献指南

欢迎 issue / PR。提交 PR 即表示你接受本项目的[非商业许可](LICENSE)条款（个人/非商业使用、转载注明出处、禁商用）。
这是一个刻意保持极简的工程，提交前请读 `CLAUDE.md`（工程事实与约定全集）与 `SECURITY.md`（安全模型）。

## 工程红线（违反即 reject）

1. **零构建**：`public/` 是免构建 vanilla JS，不引入打包器/框架；后端只允许 `ws` 一个运行时依赖。
2. **纯 ASCII 的 .ps1**：PS 5.1 按 GBK 解析无 BOM UTF-8，`.ps1` 里出现非 ASCII 必炸。JS/MD 无此限制（中文注释欢迎）。
3. **密钥卫生**：token/密钥永不写日志、永不入库；运行时数据只进 `bridge/data/`（gitignore）。
4. **静态服务边界**：只服务 `public/` 内文件，保持路径穿越防护。
5. **改动前端必须 bump `?v=N`**（index.html 资源引用 + `#build` 徽章 + `bridge/pairing.js` 的 `BUILD`，三者同版本），否则手机端会出现新旧资源混搭的幽灵 bug。

## 提交前自查

```bash
npm ci
node --check bridge/*.js public/app.js   # 语法
npm test                                 # 37 单测 + 9 e2e（隔离桥 :3799 + headless Edge）
node bridge/index.js                     # 能起来、端口 3742
```

- UI 改动：手机（或 390px 视口）过一遍 CDP 或真机；缓存三重保险是否生效看列表头版本徽章。
- 涉及 runner/spawn 的改动：确认 `--resume` 追加写原 JSONL、无驻留进程。
