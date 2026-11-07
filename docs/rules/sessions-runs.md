# rules/sessions-runs — 消息链路/runner/会话状态/运行环境

范围：消息发送链路、handoff、runner、会话状态、审批卡、等待横幅、上下文探针、CLI 运行环境事实。机制细节在模块文件头（runner.js / handoff.js / adapter-cc.js / routes/message.js）。

## 链路与状态

- **消息链路**：`POST /api/sessions/:id/message` → handoff 仲裁 → runner spawn `claude --resume -p --output-format stream-json --verbose`（完成即退，无驻留）。转录实时更新走 adapter 的 fs.watch；run 帧只管生命周期（新会话 id 取自 init 行）。
- **handoff 仲裁**：转录 8s 内新写入 → 409 `recent-local-write`；PC 持有 claim（cr attach）→ 409 `pc-claim`；自己的活 run 在跑时跳过 mtime 仲裁（语义细节在 handoff.js）。
- **runner**：perm=ask 走 `--permission-prompt-tool` + 内联 `--mcp-config`（approve-mcp.mjs 回调手机审批卡，3 分钟超时自动拒）；yolo（默认）加 `--dangerously-skip-permissions`，**Linux root/sudo + yolo 在 spawn 前直接拒绝**（CLI 硬拒，提前给手机明确报错；root+ask 合法）；`--model`/`--effort` 直传。spawn env 前置探测 git 目录——**Windows BashTool 靠发现 Git Bash 落座**，桥从精简上下文启动会丢 PATH → 手机会话全缺 Bash；settingsEnv 按 mtime 缓存（settings.json 后补/后改自动生效，无需重启桥）；纯文本 run spawn 后立即 `stdin.end()`（CLI 对保持打开的 stdin 白等 3s；**仅 stream-json 图片形态必须保持打开**）。队列/并发参数见 runner.js。PWA 选择持久化：`cr_model`(+label)/`cr_effort`/`cr_perm`。
- **会话状态** = running（runner 内存）+ lastRun（桥重启即失）+ lastOutcome（转录 system 行推导，持久）；stop 类 subtype → idle + stop 标记事件。**所有 sessions 帧必须走 `mergedSessions()`**；它携带 `runId`（重载后仍可 cancel）。未注册非 GET 一律 405——新端点必须重启桥才加载。
- **等待横幅**：Notification hook **只认权限类**消息（"waiting for your input" 每轮必发且无清除时机，认了就常驻）；清除双路=该会话任何 append / Stop hook。
- **上下文探针**：按 (cwd, modelId) 缓存，跑一次性 `-p /context`；**归档在解析判定之前、成败都执行**。
- **审批卡**：Edit/Write/MultiEdit/NotebookEdit 渲染 ±diff，其余 JSON（构建纪律见 [pwa-core](pwa-core.md)）；「本次会话始终允许」→ 内存 Map 按会话放行。

## 运行环境事实（实测确认，勿再调研）

- CLI 不在 PATH：第三方客户端内置 `%LOCALAPPDATA%\Claude-3p\claude-code\<版本>\<hash>\claude.exe`（runner 取 mtime 最新，config `claudePath` 可钉）。实测 2.1.308（Win）/ 2.1.197（Linux），行为强耦合：JSONL 格式 / resume 语义 / 旗标名 / `/context` 输出 / hooks 回调。
- 直接 spawn 报 "Not logged in"：`~/.claude/settings.json` 的 env 块**必须显式注入子进程**（密钥只进内存）。
- `/context` 在 `-p` 模式可用；statusline 方案勿用（仅交互会话触发、不热加载）。`claude://` deep link 被官方 Store 版接管（Phase 4 走 UIA）。Cowork 存储（`local-agent-mode-sessions/local_*.json`）字段齐全（Phase 3 可开工）。
- **Linux**：普通用户跑（root/sudo 拒跑 skip-permissions，runner 已前置拦截）；先写 settings.json 再起桥仍为佳（env 缺失已可自愈，但空窗期 run 报未登录）；递归 fs.watch 在 Node ≥20.13 可用；`*.sh` 已由 .gitattributes 钉 `eol=lf`。
