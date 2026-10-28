# claude-web

**Remote control for local Claude Code sessions from your phone — LAN bridge + PWA, zero install, single `ws` dependency.**

用手机（PWA/网页）远程查看并操控本机 **Claude Code** 会话；电脑端浏览器扫码即配对，无需装任何 App。

> ⚠️ **先读 [SECURITY.md](SECURITY.md)**：这个工具把「能执行任意命令的 Claude Code」暴露给局域网网页。
> 只在可信网络（家庭局域网 / Tailscale）使用；不要端口映射到公网。

- 架构基准：[docs/方案-v2.md](docs/方案-v2.md)（"会话即文件、接管即恢复"，CC 优先，双向接管，第三方 API 环境）
- 工程事实与约定全集：[CLAUDE.md](CLAUDE.md)（贡献前必读，配合 [CONTRIBUTING.md](CONTRIBUTING.md)）
- 当前进度：**Phase 2 完成**（双向接管 + 无驻留执行器 + 产品化 PWA + 上下文/模型/推理等级控制），下一步 Phase 3（Cowork 数据面）

## 快速开始

```powershell
git clone <repo> claude-web
cd claude-web
npm install
npm start          # node bridge/index.js，端口 3742
```

1. 电脑浏览器打开 **http://localhost:3742/pair**（仅本机可访问）→ 页面显示配对二维码
2. 手机（连同一 Wi-Fi）扫码 → 自动配对并进入会话列表，之后永久有效
3. 在 pair 页点 **安装开机自启**，登录后 bridge 自动后台运行（双开保护）

前提：本机装有可用的 Claude Code CLI 并已完成登录（第三方客户端内置的 CLI 亦可，runner 会自动发现）；
API 凭证按你环境的惯例放在 `~/.claude/settings.json` 的 `env` 块，spawn 时由 bridge 显式注入子进程。

## 运行环境（与 CLI 版本强关联）

本工程直接消费 Claude Code CLI 的行为与数据格式，**与 CLI 版本强耦合**。以下为实测通过的组合：

| 组件 | 实测版本 | 说明 |
|---|---|---|
| OS | Windows 11（10.0.22631+） | 启动器/PowerShell/路径均按 Windows 设计 |
| Node.js | ≥ 20（实测 22.x） | ESM、`fs.watch(recursive)`、降级轮询 |
| Claude Code CLI | **2.1.308** | 来源任意：npm 全局安装、或第三方桌面客户端内置副本（runner 按 mtime 自动发现，升级即跟随） |

> **桌面客户端不是依赖**：bridge 从不与桌面 App 通信。桌面会话之所以在列表里可见，是因为桌面版底层运行同一 CLI、写同一份 `~/.claude/projects` 转录。第三方客户端在本工程中的唯一角色是**提供了一个已配好登录态的 CLI 分发渠道**（`%LOCALAPPDATA%\Claude-3p\claude-code\...`，且其实测环境无需官方订阅）——你也可以完全用官方渠道安装的 CLI。

**强关联点**（CLI 升级后若出问题，先对照这份清单排查）：

- 转录 JSONL 行格式：`user`/`assistant`/`system`/`cost-state` 的字段形状、`origin.kind`、`message.usage`、`message.model`
- `--resume <id> -p` 追加写原 JSONL（不新建文件）；`--output-format stream-json` 行序列（`system/init` 携带 `session_id`）
- 旗标名：`--dangerously-skip-permissions`、`--permission-prompt-tool`（+内联 `--mcp-config`）、`--model`、`--effort`
- `/context` 命令的 markdown 输出结构（上下文探针按表格式解析）
- Stop/Notification hooks 回调格式

CLI 自动升级后若行为异常，可在 `bridge/data/config.json` 设 `claudePath` 钉住指定版本。

## 能做什么

**手机端（PWA，可"添加到主屏幕"）**

- 会话列表按项目分组折叠，组头与每个会话带状态灯（运行中/失败/已停止/完成）
- 点开会话看实时转录：思考过程与工具调用折叠、最终结论常显、流式输出自动跟随滚动
- 直接续聊（无驻留 `claude --resume`，与电脑端零冲突）、新建任务（选工作目录）、停止运行、删除会话（进回收站可找回）
- 发送时可带 **权限模式**（自动执行 / 需要时手机逐条审批）、**模型**（如 glm-5.3 / glm-5.3-flash）、**推理等级**（--effort 低→最高）
- 底部 **上下文圆环**：已用上下文/窗口实时占比（≥80% 变琥珀、≥95% 变红）；点开看与桌面端同源的明细（系统提示/系统工具/MCP/记忆/技能/消息/压缩保留，CLI `/context` 实测口径）
- 电脑端正在使用某会话时发送会先确认，避免双写；运行中发消息自动排队

**电脑端**

- 配对面板 `localhost:3742/pair`：二维码、token 一键轮换（自动同步 hooks，先备份）、开机自启安装
- 终端接管：`powershell -ExecutionPolicy Bypass -File cli\cr.ps1 list` → `cr attach <序号>`（交互式 resume，自动注入 API 凭证，退出自动释放）
- Claude Code 完成任务时自动推送到手机（Stop/Notification hooks → bridge → PWA 通知）

## 目录结构

```
claude-web/
├── README.md / SECURITY.md / CONTRIBUTING.md / LICENSE
├── CLAUDE.md                   # 工程事实与约定全集（机器无关部分；本机细节在 LOCAL.md，不入库）
├── package.json                # 仅 ws 一个运行时依赖，Node ≥ 20 ESM
├── bridge/                     # 常驻 daemon（HTTP+WS+静态+鉴权）
│   ├── index.js                # 入口：配置迁移、事件接线、双开保护
│   ├── server.js               # 路由 + 静态（ETag 再验证、穿越防护）+ /api/models + /context 探针
│   ├── adapter-cc.js           # ~/.claude/projects JSONL 监听解析（状态推导、回收站、墓碑、上下文记账）
│   ├── runner.js               # 无驻留执行器（每条消息一次 resume -p；排队；--model/--effort；权限路由）
│   ├── handoff.js              # 接管仲裁（mtime 活跃检测 + PC advisory 锁）
│   ├── ctxprobe.js             # /context 实测探针（与桌面端同源的上下文明细，按 cwd+模型缓存）
│   ├── pairing.js              # token 热轮换 / 自启安装（生成绝对路径版 vbs）
│   ├── tailer.js / store.js / hooks.js / approve-mcp.mjs / hook-post.cmd
├── public/                     # PWA（免构建 vanilla JS）：app.js / style.css / pair.html / vendor(qrcode, MIT)
├── cli/cr.ps1                  # 电脑端接管工具 list/attach/release/url
├── scripts/                    # 自启动模板 vbs / token 轮换 / 图标生成
└── docs/                       # 方案-v2.md（架构）、phase0/（环境勘探脚本）、design/（设计稿）
```

## 路线图

| 阶段 | 内容 | 状态 |
|---|---|---|
| Phase 0 | 环境勘探六项实测，冻结 adapter 接口 | ✅ |
| Phase 1 | CC 只读 + hooks 通知 | ✅ |
| Phase 2 | CC 全双工 + 双向接管 + 产品化 PWA + 配对面板 + 上下文/模型/等级控制 | ✅ |
| **PWA·P0** | **核心闭环补全**（见下方 Backlog P0 组） | ◀ 候选下一批 |
| Phase 3 | Cowork 数据面接入统一模型 | 待开始 |
| Phase 4 | Cowork 控制（UIA 主路线，deep link 已实测不可用） | 待开始 |

### Backlog（功能补全清单）

对标 CLI/桌面版与其他 Harness 工具（OpenCode/Aider 等）梳理的能力缺口，按优先级分组。

**P0 · 核心场景断点**（"远程派活"闭环缺口）

- [x] ~~锁屏/后台完成通知~~（已裁定不做，2026-10-28：无锁屏推送需求；ntfy 桥侧代码保留但默认不配）
- [x] ~~手动 /compact~~（已裁定不做，2026-10-28）
- [x] ~~审批卡 diff 视图~~（v44 已实现：Edit/Write/MultiEdit/NotebookEdit 渲染 ±diff，其余工具 JSON 明细）
- [x] ~~历史回看分页~~（v44/v46 已实现：400 条展示切片上开"加载更早"，header 加载行 + 切轮缝合 + 跨页 toolres 配对）
- [x] ~~手机发图~~（v19 已实现：📎 附件上传 + 图片/文本预览 + 转录渲染 + 灯箱；注意：模型能否"看懂"图取决于后端——实测当前中转对图是盲的，链路已就绪即插即用）

**P1 · 明显缺失**

- [x] ~~always-allow 工具白名单~~（v44 已实现：会话级内存 Map，审批卡勾选；bridge 重启即重新布防）
- [x] ~~会话改动文件总览~~（v45 已实现：总结卡内折叠行"改动 N 个文件 +a −d"，展开每文件 ± 行数）
- [x] ~~会话重命名~~（v34 已实现：列表长按/右键 → 操作气泡；写原生 `custom-title` 行入转录，落盘即持久、桌面端同款机制，非本地覆盖）
- [x] ~~队列单条管理~~（v17 已实现：队列面板 + 删单条/拖动重排/▶插队/清空）
- [x] ~~会话搜索~~（v43 已实现：列表页搜索框，标题/项目路径/id 实时过滤，命中平铺展示；批量管理同批落地：header 管理钮 → 多选 → 底部栏全选/删除，运行中自动跳过）
- [x] ~~导出 Markdown~~（v44 已实现：full/summary 双档，⋯ 气泡二级范围选择）

**P2 · 体验增强**

- [ ] 斜杠命令快捷面板（/cost /model /clear…）
- [x] ~~token/费用累计统计面板~~（v48 已实现：header 费用文本即入口，面板从上落下；官方口径/倍率/自定义单价三档，分模型各归各账，价格偏好存 localStorage）
- [ ] 配额/速率显示（探测 statusline 的 rate_limits 字段）
- [ ] 离线 PWA shell（service worker）
- [ ] `cr.ps1 status/watch`
- [ ] 检查点回滚（勘测 CC checkpoint 在 headless 的可用性）
- [ ] 多设备/多 token（安全模型需重估，缓行）

## 注意

- **给 Windows 写 .ps1 必须纯 ASCII**（PS 5.1 按 GBK 解析无 BOM UTF-8）；JS/MD 无此限制。
- API 密钥/token 永不写日志；`bridge/data/`（config、锁、回收站、探针缓存）已 gitignore。
- 静态服务只允许 `public/` 目录内文件；配对面板仅同机访问。
- 本项目面向第三方 API 中转/第三方客户端环境开发，与 Anthropic 官方无关联；在你自己的机器上使用，风险自担。
- **官方图标不分发**：`public/brand-mark.png`（官方客户端托盘模板图）已 gitignore，仓库不含其字节。想启用官方图标，从本机官方客户端 `resources/TrayIconTemplate-Dark@2x.png` 自行复制为该路径即可（缺失时 header 图标位为空，其余功能不受影响）。

## 常见问题（Q&A）

**Q：手机会话里 AI 说"没有 Bash/命令执行工具"，但我电脑上 git / bash 明明都能用？**

这是 Claude Code 的 Bash 工具在 Windows 上的已知依赖：它需要**发现 Git Bash**（探测标准安装位置 + 进程 PATH），找不到就整个工具不注册（可在 `~/.claude/debug/*.txt` 看到 `Git Bash not found; BashTool will be unavailable`）。

关键在**环境变量是进程出生时的快照，逐层遗传、从不同步**：你的终端有完整用户 PATH，不代表 bridge 子进程有——bridge 若从精简上下文启动（开机自启、脚本链），它继承的 PATH 可能缺 Git 目录，之后它 spawn 的所有会话都会缺 Bash。

本项目 runner 已内置兜底（v62）：spawn 时自动探测常见 Git 安装位置（hermes、`%LOCALAPPDATA%\Programs\Git`、Program Files 等）并把 `cmd`/`bin` 前置进子进程 PATH。仍中招说明 Git 装在非常规位置，任选其一：

1. **把 Git 的目录加进系统 PATH**（一劳永逸，连桌面客户端直接驱动的会话也受益）；
2. 在带完整 PATH 的上下文（你的终端）里手动重启一次 bridge。

前提只有一条：机器上得装了 Git for Windows（Bash 工具的硬依赖，与本项目无关）。

## License

[MIT](LICENSE)（内含 vendored 的 [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) @1.4.4，同为 MIT）
