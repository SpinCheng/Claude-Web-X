# claude-remote

用手机（PWA/网页）远程查看并操控本机 **Claude Code** 会话；电脑端浏览器扫码即配对，无需装任何 App。

- 架构基准：`docs/方案-v2.md`（"会话即文件、接管即恢复"，CC 优先，双向接管，LAN/Tailscale 直连，第三方 API 环境）
- 会话交接与全部实测数据事实：`CLAUDE.md`（Claude 会话必读）
- 当前进度：**Phase 2 完成**（双向接管 + 无驻留执行器 + 产品化 PWA），下一步 Phase 3（Cowork 数据面）

## 快速开始

```powershell
cd D:\dev_workspaces\claude-remote
npm install
npm start          # node bridge/index.js，端口 3742
```

1. 电脑浏览器打开 **http://localhost:3742/pair**（仅本机可访问）→ 页面显示配对二维码
2. 手机（连同一 Wi-Fi）扫码 → 自动配对并进入会话列表，之后永久有效
3. 在 pair 页点 **安装开机自启**，登录后 bridge 自动后台运行（双开保护）

## 能做什么

**手机端（PWA，可"添加到主屏幕"）**

- 会话列表按项目分组折叠，组头与每个会话带状态灯（运行中/失败/已停止/完成）
- 点开会话看实时转录：思考过程与工具调用折叠、最终结论常显、流式输出自动跟随滚动
- 直接续聊（无驻留 `claude --resume`，与电脑端零冲突）、新建任务（选工作目录）、停止运行、删除会话（进回收站可找回）
- 电脑端正在使用某会话时发送会先确认，避免双写

**电脑端**

- 配对面板 `localhost:3742/pair`：二维码、token 一键轮换（自动同步 hooks，先备份）、开机自启安装
- 终端接管：`powershell -ExecutionPolicy Bypass -File cli\cr.ps1 list` → `cr attach <序号>`（交互式 resume，自动注入 API 凭证）
- Claude Code 完成任务时自动推送到手机（Stop/Notification hooks → bridge → PWA 通知）

## 目录结构

```
claude-remote/
├── CLAUDE.md                   # Code 会话交接文档（全部实测事实与约定，必读）
├── package.json                # 仅 ws 一个运行时依赖
├── docs/方案-v2.md             # 架构基准
├── bridge/
│   ├── index.js                # 入口：配置迁移、事件接线、双开保护
│   ├── server.js               # HTTP + WS + 静态服务 + token 鉴权 + 控制面路由
│   ├── adapter-cc.js           # ~/.claude/projects 监听解析（含状态推导、回收站删除、墓碑）
│   ├── runner.js               # 无驻留执行器（每条消息一次 resume -p，完成即退）
│   ├── handoff.js              # 接管仲裁（mtime 活跃检测 + PC advisory 锁）
│   ├── pairing.js              # token 热轮换 / 自启安装（配对面板后端）
│   ├── tailer.js               # JSONL 增量读取（字节偏移）
│   ├── hooks.js                # CC hooks 回调接收 + ntfy 推送
│   └── hook-post.cmd           # hook 回调包装脚本（绕 PowerShell 的 curl @- 语法坑）
├── public/                     # PWA（免构建 vanilla JS）：app.js / style.css / pair.html / vendor(qrcode)
├── cli/cr.ps1                  # 电脑端接管工具 list/attach/release/url
├── scripts/
│   ├── start-bridge.vbs        # 隐藏窗口启动器（装入 shell:startup）
│   ├── rotate-token.ps1        # CLI 版 token 轮换（面板是主入口）
│   └── make-icons.mjs          # 零依赖生成 PWA 图标
└── phase0/                     # 六项实测脚本与报告（已完成，PHASE0-REPORT.md 末尾补测节最重要）
```

## 路线图

| 阶段 | 内容 | 状态 |
|---|---|---|
| Phase 0 | 六项实测，冻结 adapter 接口 | ✅ |
| Phase 1 | CC 只读 + hooks 通知 | ✅ |
| Phase 2 | CC 全双工 + 双向接管 + 产品化 PWA + 配对面板 | ✅ |
| Phase 3 | Cowork 数据面接入统一模型 | ◀ 下一步 |
| Phase 4 | Cowork 控制（UIA 主路线，deep link 已实测不可用） | 待开始 |

## 注意

- **给本机写 .ps1 必须纯 ASCII**（PS 5.1 按 GBK 解析无 BOM UTF-8）；JS/MD 无此限制。
- API 密钥/token 永不写入日志；`bridge/data/`（config、锁、回收站）已 gitignore。
- 静态服务只允许 `public/` 目录内文件（路径穿越防护）；配对面板仅 localhost。
- 第三方 API 环境的凭证在 `~/.claude/settings.json` 的 env 块，CLI 不会自行使用——spawn 时必须显式注入（runner/cr.ps1 已实现，密钥只进内存）。
- 本工程全部读取/自动化为本机自用范围。
