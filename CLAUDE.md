# CLAUDE.md — claude-web 工程手册

用手机（PWA）远程查看并操控本机 Claude Code 会话（LAN bridge + 免构建 PWA）。

> **手册纪律（文档职责分工，更新前先对号入座）**
> - **本文件**（入库）：纪律、架构速览、快速开始、分区路由表、全局铁律速查、工程红线、路线图——每次会话整体载入，保持精炼。
> - **`docs/rules/`**（入库）：分区硬规则与实测事实的归属地，按下方路由表**改码前必读对应文件**；每文件只收蒸馏后的一行版规则，不写叙事。
> - **模块文件头注释**：机制细节的第一归属地——改哪个文件先读它的头，改动先落那里。
> - **README.md**（入库）：面向初见者——架构总览、消息流图、目录树、快速开始/部署。不收硬约束细则。
> - **`docs/history.md`**（gitignored）：版本号、调试时间线、翻车复盘的唯一归宿。
> - **`LOCAL.md`**（gitignored）：本机路径/端口/环境特例。
> - **`docs/`**：`screenshots/`（README 截图）与 `rules/` 入库；设计稿与方案文档不入库。
> - 落笔分流：全局铁律→本文件速查区；分区规则与事实→docs/rules/ 对应文件（新能力域=新文件+路由表加行）；单模块机制→文件头；叙事与版本→history.md；不建路由表之外的平行文档。

## 架构

- README「架构与消息流」双 mermaid 图 + 目录树。后端 `bridge/`：`server.js` 组装根 + `lib/`（router/wshub/auth/mime/models/**platform**=OS 差异单点，勿在其他模块分支 process.platform）+ `routes/` + `parsers-cc.js`（转录行判定纯函数，有单测）。前端 `public/` 免构建 vanilla JS：`app.js` 组装根（boot/gate/路由/WS 帧语义）→ `js/` + `js/views/`。函数级循环 import（求值期零交叉）：composer↔detail、list↔sessops、detail↔ctxring、transcript↔agentview。
- 测试：`npm test` = 单测 + e2e（写/跑前必读 [testing](docs/rules/testing.md)）。

## 快速开始

```powershell
npm install
npm start          # node bridge/index.js，端口 3742
```

手机浏览器打开启动日志里的 URL 输 token；PC 端接管 `node cli/cr.mjs list` → `attach <序号>`（跨平台）；配对面板 `http://localhost:3742/pair`（API 仅同机）可装开机自启（EADDRINUSE 双开保护）。config（`bridge/data/config.json`，gitignored）键：`token`/`port`/`claudePath`/`defaultCwd`/`yolo`/`titleGen`/`notify.ntfyTopic`。

## 分区规则路由（做什么→改码前必读对应文件；均在 docs/rules/）

| 能力域 | 必读文件 |
|---|---|
| 任何前端改动（滚动/折叠/视觉/弹层/缓存 bump） | `pwa-core.md` |
| 消息链路/handoff/runner/审批卡/等待横幅/探针/CLI 环境 | `sessions-runs.md` |
| 转录解析（parsers-cc/adapter）/改动文件汇总/filediff | `transcript-format.md` |
| 标题/改名/自动标题/分支标题/write-fence | `titles.md` |
| 附件/图片占位符/Ctrl+V/@ 引用/回显折叠 | `attach-refs.md` |
| 项目文件树/文件索引/git 标注层 | `filetree.md` |
| PC 双栏/断点/composer 锚定/拖宽手柄 | `wide-layout.md` |
| 会话列表/归档/历史分页/搜索 | `list-history.md` |
| 产物预览/md·csv·json·diff·svg 渲染/#html-prev | `preview.md` |
| 费用面板/结算速率/上下文口径 | `cost-ctx.md` |
| 子代理直播/活动悬浮件/待办板 | `agents-board.md` |
| 斜杠命令/命令块解析/clear | `commands.md` |
| 配对/token 轮换/hooks | `pairing-hooks.md` |
| 写/跑测试（fixture/e2e/harness） | `testing.md` |

表外功能域（导出 MD、改动文件汇总入口、会话分支、搜索/批量、队列面板）以对应 routes/views 文件头注释为准。

## 全局铁律速查（细节在对应分区文件；违反即翻车）

- renderTail 只从 `prevLen-1` 重渲染；`#hist-more` 必须挂 #chat 外（transcript 1:1 不变量）。
- 折叠 CSS 必须 `.node:not(.open):not(.plain) .node-body{display:none}`；限高必须 `markCapped()` 动态加 `.capped`。
- 页级滚动器 `overscroll-behavior:contain`，内嵌滚动器必须 `auto`。
- 改 `public/` 的 app.js/style.css 三处同版本 bump：index `?v=N` + `#build` 徽章 + pairing.js `BUILD`。
- 模型产物一律先转义或 createElement/textContent 构建，禁拼 HTML；禁 window.confirm/alert（用 showConfirm）。
- sessions 帧必须走 `mergedSessions()`；未注册非 GET 一律 405——新端点必须重启桥才加载。
- 人类输入逐字原样：绝不剥离/改写/占位符化（用户裁定）。
- 测试夹具的合成绝对路径（`D:\x`、`C:\Temp\shot-x.png` 类）豁免隐私红线：它们是纯字符串标签、全程无 fs 访问，但必须是通用合成形状（禁本机用户名/真实路径），且勿用 path.join——分隔符随宿主 OS 变，夹具就失去跨平台确定性。
- fork 转录是父会话拷贝：fork 标题必须用显式 prev 钉住。
- CSS 只认 `body.wide` 类名，勿写重复媒体查询。

## 工程红线

1. 后端只允许 `ws` 一个运行时依赖；`public/` 免构建 vanilla JS，不引打包器。
2. `.ps1` 必须纯 ASCII（PS 5.1 按 GBK 解析）；**严禁用 PowerShell 读写含中文的文件**——一律 Edit/Write 或 bash。
3. 密钥/token 永不写日志；`bridge/data/` 永不入库。
4. 静态服务只允许 `public/`（路径穿越防护）；响应 no-cache+ETag 304。
5. Node ≥ 20 ESM；fs.watch(recursive) 不可用时自动降级轮询。
6. 手机驱动的开发会话长在 bridge 进程树里：会话内脚本杀 bridge 切断的是当前 turn 的输出管道——CLI 子进程不死、转录为准、可被新桥按 `--resume` 接管；重启桥一律从 PC 侧做，例外=用户同意后走 detached 看护脚本自重启（缓冲→杀→等端口→startup vbs→HTTP 验版本）。

## 路线图

**已裁定不做**：锁屏/推送通知。下一步：Phase 3（Cowork 数据面）→ Phase 4（Cowork 控制面，UIA）。候选功能与 bug/优化待办清单：本地 `docs/roadmap.md`（gitignored，按条目追加）。
