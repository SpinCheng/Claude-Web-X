# CLAUDE.md — claude-web 工程手册

用手机（PWA）远程查看并操控本机 Claude Code 会话（LAN bridge + 免构建 PWA）。

- 架构：README「架构与消息流」双 mermaid 图。后端 `bridge/`：`server.js` 组装根 → `lib/`（router/wshub/auth/mime/models/**platform**=OS 差异单点，勿在其他模块分支 process.platform）+ `routes/`（sessions/message/attachments/hooks/approvals/pairing）+ `parsers-cc.js`（转录行判定纯函数，有单测）。前端 `public/`：`app.js` 组装根（boot/gate/路由/WS 帧语义）→ `js/`（state/api/ws/md/util）+ `js/views/`（toast/overlays/list/sessops/ctxring/composer/detail + transcript）。composer↔detail、list↔sessops、detail↔ctxring 为函数级循环 import（求值期零交叉）。**滚动三律与 renderTail 不变量在 transcript.js**。
- 本机细节：`LOCAL.md`；调试史：`docs/history.md`（均 gitignored，仓库不含）。
- 测试：`npm test` = 49 单测（parsers/turns/adapter/cost/commands/agents）+ 11 e2e（隔离桥 :3799 + 合成转录 + headless Edge CDP）。fixture 勿走 bash 内联（反斜杠被吃）；harness 的 api() 头必须合并非替换；harness 的 bridge stop 必须 `closeAllConnections()` + 等 close 回调——server.close() 不等 keep-alive 排空，Windows 允许双绑 :3799 → 新旧 bridge 竞态应答（幽灵 404，v109 实测翻车）。

## 快速开始

```powershell
cd claude-web
npm install
npm start          # node bridge/index.js，端口 3742
```

手机浏览器打开启动日志里的 URL 输 token；PC 端接管 `node cli/cr.mjs list` → `attach <序号>`（跨平台）；配对面板可装开机自启（EADDRINUSE 双开保护）。config（`bridge/data/config.json`，gitignored）键：`token`/`port`/`claudePath`/`defaultCwd`/`yolo`/`notify.ntfyTopic`。

## 运行机制速记

- **消息链路**：`POST /api/sessions/:id/message` → handoff 仲裁 → runner spawn `claude --resume -p --output-format stream-json --verbose`（完成即退，无驻留）。转录实时更新走 adapter 的 fs.watch；run 帧只管生命周期（新会话 id 取自 init 行）。
- **handoff 仲裁**：转录 8s 内新写入 → 409 `recent-local-write`；PC 持有 claim（cr attach）→ 409 `pc-claim`；自己的活 run 在跑时跳过 mtime 仲裁。
- **runner**：yolo 默认加 `--dangerously-skip-permissions`；perm=ask 走 `--permission-prompt-tool` + 内联 `--mcp-config`（approve-mcp.mjs 回调手机审批卡，3 分钟超时自动拒；另加 `--permission-prompts host`）；`--model`/`--effort` 直传；busy 入队（≤5，结束 800ms 自动派发；单条 API=快照/删/重排/runnow）；全局并发 ≤4；spawn env 前置探测 git 目录（**Windows BashTool 靠发现 Git Bash 落座**，桥从精简上下文启动会丢 PATH→全部手机会话缺 Bash）。PWA 选择持久化：`cr_model`(+label)/`cr_effort`/`cr_perm`。
- **附件**：图片走 `--input-format stream-json` stdin 图片块（**stdin 写完必须保持打开**，立即 close 挂死 CLI）；文本类 ≤24KB 内联进 prompt；CLI 会对图片消息多注入一条 `[Image: source]` user turn（adapter 已折叠）。
- **产物预览**：锁会话 cwd 内（resolve+不区分大小写前缀校验）+ 扩展白名单 + ≤2MB；html **默认仍 text/plain**（防模型写文件 XSS），仅 `render=1` 且扩展为 .html/.htm 时出 text/html，且必须带 `CSP: sandbox allow-scripts`。cwd 外不可预览（by design）。**v105 统一全屏预览页 `#html-prev`**：同源 http 链接（#chat 委托拦 miniMd 的 `<a>`）+ 产物文件（html=渲染/源码双 tab、文本=源码态）+ 附件文本，全走这一个 `.page` 级全屏页（进 history、popstate 吸收返回）；file-prev 半窗 sheet 已删除；iframe 一律 blob URL 或同源直连 + `sandbox="allow-scripts"`（**勿加 same-origin**）；**异源链接不拦**（X-Frame-Options 不可控，保持新标签）。**v106**：助手结论文本（final-card 与展开态结论节点）在 miniMd 渲染后用 `linkifyDom`（md.js：DOM 走查、跳过 a/code/pre）就地生成 `.flink`——裸路径直接可点；mid 文本一直走 `linkifyPaths` 无需改。**v107**：预览 iframe 一律 `srcdoc` 注入文本（同源链接先 fetch 取文）——**blob/直连 src 的 iframe 导航会往联合会话历史塞条目**（back 被静默的 iframe 步进吃掉，实测 len 递增），关闭只置 `srcdoc=""`、勿再动 src。**history 三裁定**：①pushState 用唯一 `#hp/N`（相邻同 (state,URL) 条目 Chromium 静默遍历、不触发 popstate）；②返回钮/ESC **直接 closeHtmlPreview，勿 fire-and-forget back**（遍历延迟提交会弹掉下一次 open 刚 push 的条目；残留陈旧 htmlprev 条目由 popstate 吞咽分支兜底）；③系统手势 back 走 popstate 尽力而为。**v108**：`#html-prev` 在 DOM 上嵌在 `#detail` 内部，**必须 `position:fixed; inset:0`**——static 时作为 detail（flex column+overflow hidden）的 flex 项被裁成"半屏预览"且 z-index 无效（e2e 有视口覆盖几何断言防回归）。
- **会话状态** = running（runner 内存）+ lastRun（桥重启即失）+ lastOutcome（转录 system 行推导，持久）。**所有 sessions 帧必须走 `mergedSessions()`**；它携带 `runId`（重载后仍可 cancel）。未注册非 GET 一律 405——新端点必须重启桥才加载。
- **子代理直播（v112 方案A）**：`bridge/agents.js` AgentTracker。数据面：`<slug>/<sessionId>/subagents/agent-<agentId>.jsonl`（+`.meta.json`：toolUseId/description/finished/requestShape）实时增量落盘，adapter 递归 watcher 里的 `subagents` 路径段**路由进 tracker、绝不进会话体系**（幽灵会话坑已堵，`_ensureSession` 双保险）。归属链：父转录 Agent tool_use 的 id ↔ meta.toolUseId；meta 在完成时才写 → 运行期靠 **FIFO 派生队列**（文件创建序=spawn 序）+ **迟到补认领**（`_adoptUnmatched`：文件事件跑赢父转录 drain 时反向配对），meta 落地后纠偏。完成信号双路：meta `finished:true` / 父转录 toolres（CLI 被杀也兜得住）；boot 重放 use+res 净零、只留真 pending（桥中途重启可恢复归属）。帧 `agent {id, agentId, toolUseId, desc, state, steps, act, startedAt}` 只走订阅者、`api-request*` blob 行永不解析。HTTP：`GET /api/sessions/:id/agents/:agentId/events`（同一 applyLine，气泡数据）+ messages 响应附带 `agents` 摘要（历史会话的完成态节点免帧即有「全文」入口）。前端：Agent/Task tool 节点=「代理」badge+desc 标题+**直播行（.agent-live，节点头下、折叠体外）**+活点呼吸；直播行/完成态 chip 点击开 `#agent-sheet` 气泡（BUBBLES 注册、scrim/back 通用关法）；帧到达=**就地 patch DOM，不碰 renderTail**（未渲染才走 renderTail(i+1)）；气泡=renderStepsInto 复用主视图节点渲染，活期 400ms 去抖重拉、底部跟随；transcript↔agentview 函数级循环 import（同 composer↔detail 先例）。**v114 补两裁定**：①**计时冻结**——tracker 记 `finishedAt`（meta/toolres 双路置位），帧/摘要全链路携带；前端一切时长=startedAt..finishedAt（完成态永远冻结，气泡头/节点 dur 曾用 Date.now() 滴答不停，实测翻车会话 884c3a2a 四个后台 agent）；②**设计稿对齐**——节点头 dur=活态时长（fallback 无状态时才显工具名）、后台徽章=meta.requestShape（实测 background 语义确认）、直播行=`↳ act · 第 N 步`+时长+右缘「全文 ›」（act 的文件路径**折 basename**，勿全路径刷屏）、标题截断。
- **等待横幅**：Notification hook **只认权限类**消息（"waiting for your input" 每轮必发且无清除时机，认了就常驻）；清除双路=该会话任何 append / Stop hook。
- **上下文探针**：按 (cwd, modelId) 缓存，跑一次性 `-p /context`；**归档在解析判定之前、成败都执行**。
- **重命名** = 往转录追加原生 `custom-title` 行（行尾无 `\n` 先补；不 bump lastActive）。**write-fence**：改名钉只被**活流**（emitAppends=true 的 drain）解除；boot 重放/readTranscript 无权解钉或夺标题。
- **列表交互**：行是真 `<button>`，内嵌交互元素必须用 span（嵌 button 会被 fragment 解析器提出去打碎布局）；右键有选区守卫；**列表行长按不选文本**（v97 裁定反转 v35——`.srow/.pgroup-head` user-select:none，输入框除外）。
- **审批卡**：Edit/Write/MultiEdit/NotebookEdit 渲染 ±diff，其余 JSON；**必须 createElement/textContent 构建**（模型产物拼 HTML 即 XSS 面）；「本次会话始终允许」→ 内存 Map 按会话放行。
- **历史分页**：`readTranscript(limit, before)` → `{events,total}`（400 条展示切片，盘上全量）；加载行 `#hist-more` 在 header 下、**必须挂 #chat 外**（renderTail 1:1 不变量）；跟手渐显：f=clamp((64−scrollTop)/64) 直驱行高/透明度/内字位移（**勿加 CSS transition**）；`parseOlderTurns` 纯重放（**勿复用 applyEventToTurns**）；切在轮中间时 mergeBotTurns 缝合；跨页 toolres 先进 `state.orphanToolRes` 暂存、prepend 后回填。
- **确认弹窗**：禁 window.confirm/alert——一律 `showConfirm({title,body,ok,danger,onOk,onCancel})`（底部 sheet 模态；danger=红钮+焦点落取消侧）。
- **费用面板**：header 费用文本即入口（珊瑚+变化脉冲）；**零价表设计**（官方无价格 API）：官方口径=cost-state 原值 / 倍率 / 自定义分模型单价；价格偏好存 localStorage 不进桥；桥侧留存 cost-state 的 models map。
- - **斜杠命令（v109）**：`GET /api/sessions/:id/commands` = 内置白名单（bridge/lib/commands.js 静态数据，14 条：context/compact/clear/usage/add-dir/mcp/autocompact/output-style/recap/skill-doctor/init/security-review/reload-skills/reload-plugins；可用性依据 2.1.308 二进制的 supportsNonInteractive 字段 + `-p` 冒烟实证）+ 自定义命令发现（`~/.claude/commands` 与 `<cwd>/.claude/commands` 递归扫描、子目录 `:` 命名空间、frontmatter 取 description/argument-hint、项目覆盖用户）。**派发=普通消息**：composer 组 `/name 参数` 直走现有链路（busy 队列串行），CLI（TUI）无链式多命令语法→不做多命令合并。前端：输入 `/` 唤起**平铺选单**（锚定气泡、无 scrim、来源徽章、点外部即收、不动 history）；点选→dock 内**单选标签 chip**（重开选单点选=替换；✕/空框退格整删；发 texto=`/name text`）；人工气泡渲染前导已知命令为标签 chip（state.cmdNames）。未收录内置命令=TUI 专用或原生 UI 已覆盖（model/rename/fork/resume/export/stop 等）。**v110 修四项**：①`<command-*>` 信封行前 CLI 会写一条**独立 caveat user 行**（`<local-command-caveat>…</local-command-caveat>`，实测转录确认两行分离）——stripReminder 剥离该标签、剥空即整行折叠（fixture 已按真实形状加 caveatLine）；②发送成功即清 chip（clearComposer 内，失败路径已会重置）；③选单命中子串按设计稿高亮（`.cm-name b` 珊瑚粗体）；④白名单 +goal/list-agents（-p 冒烟通过；plan/usage-credits headless 实测报 "isn't available in this environment"，不收）。**v111 命令块统一框架（勿再逐命令打补丁）**：命令执行的转录生命周期 = caveat user 行（折叠）→ 信封 user 行（归一 `/名 参数` 气泡）→ **stdout 行**（两种载体：user 行或 system/local_command 行，内容均被 `<local-command-stdout>` 包裹 → 提取正文发 `k:'cmdout'` 事件，渲染为命令气泡下方右对齐等宽输出面板）→ **机器注入 user 行**（goal 的 Stop hook 指令，前缀 "A session-scoped Stop hook is now active" → 折叠，模型回应即可见）→ assistant 正常响应。stdout 提取必须在 stripReminder **之前**（后者会整块删空）。v111 同时：命令 chip 与输入框同一行（`.input-line` flex）。**v112**：cmdout 输出面板改左对齐（圆角 4px 落左上）。**v113 全量命令审计**（白名单逐条 -p+--resume 实跑、按框架分类转录行）：usage/context/recap/autocompact/output-style/reload-skills/reload-plugins/mcp/skill-doctor/list-agents/goal/compact **全部落框架零适配**；compact 另有 compact_boundary system 行（非 stop 类、忽略无害）+ isCompactSummary（既有折叠）；clear 的信封/stdout 落**新会话文件**、旧文件零污染、新 sid 走 runner adoption；**未知命令实测=当纯文本发模型**（普通气泡+回复，D5 放行实证）；stop_hook_summary 已在 STOP_SUBTYPES；**add-dir 移出白名单**（headless 实测 "isn't available in this environment"，尽管二进制标注 supportsNonInteractive）。已知体验缺口（待拍板）：/clear 后手机留在旧会话视图，新会话静默出现在列表，不自动跳转（fork 有 pendingBranch 自动切换，普通派生会话没有）。**v114 prompt 型命令展开体折叠（补审计盲区）**：自定义命令/init/security-review 等 prompt 型命令派发时信封后紧跟**展开体 user 行**（.md 模板正文/官方 prompt 文案）——统一规则：信封行（归一成 /name args）武装 `rec._cmdEnv`，**紧邻的下一条纯文本 user 行折叠**（展开体永不成为第二个气泡）；user 载体 stdout（v111 拦截处）与任何非 user 行（assistant/system/toolres）**到达即解除武装**（local 型命令无展开体，防吞用户后续真消息）。武装必须在事件返回处（函数中段武装会自噬——信封行把自己折叠，实测踩坑）；展开体检查必须在 stdout/caveat/hook 拦截**之后**（local 型第一条跟班是 stdout，先查会吞输出）。goal 激活期 Stop hook 阻断循环全部走 stop_hook_summary system 行（231 次实测）、零额外 user 注入，无需适配。
- 其余功能（导出 MD、改动文件汇总、会话分支、搜索/批量、队列面板）见对应 routes/views 文件头注释。

## 已实测确认的数据事实（勿再调研）

**环境**

- CLI 不在 PATH：第三方客户端内置 `%LOCALAPPDATA%\Claude-3p\claude-code\<版本>\<hash>\claude.exe`（runner 取 mtime 最新，config `claudePath` 可钉；npm 全局装的同用）。实测 **2.1.308（Win）/ 2.1.197（Linux）**，行为强耦合：JSONL 格式 / resume 语义 / 旗标名 / `/context` 输出 / hooks 回调。
- 直接 spawn 报 "Not logged in"：`~/.claude/settings.json` 的 env 块**必须显式注入子进程**（密钥只进内存）。
- `--resume <id> -p` 追加写原 JSONL、不新建文件；`stream-json --verbose` 行序列：init（含 session_id）→ assistant → post_turn_summary → result。
- `/context` 在 `-p` 模式可用；**statusline 方案勿用**（仅交互会话触发、不热加载）。`claude://` deep link 被官方 Store 版接管（Phase 4 走 UIA）。Cowork 存储（`local-agent-mode-sessions/local_*.json`）字段齐全（Phase 3 可开工）。
- **Linux**：普通用户跑（root/sudo 拒跑 skip-permissions）；**先写 settings.json 再起桥**（env 空结果被缓存锁死）；递归 fs.watch 在 Node ≥20.13 可用；`*.sh` 已由 .gitattributes 钉 `eol=lf`。

**转录格式**

`~/.claude/projects/<工作区slug>/<sessionId>.jsonl`（追加式）；slug：`D:\foo\Bar` → `D--foo-Bar`。adapter 消费：

- `user`：**人机判定按内容**——含 tool_result 块即机器回合（origin 不可靠，2.1.308 的 tool_result 行 origin 为 null）；压缩续传（`isCompactSummary:true`）与技能注入（纯 text 数组 + 首段 "Base directory for this skill:"）折叠为标记；**勿按"origin 缺失"折叠**（手机 promptSource=sdk 的消息同样无 origin）；`<command-*>` 信封归一成 `/名 参数`；**信封行的前一行是独立 caveat user 行**（local-command-caveat，剥空折叠）。
- `assistant`：`message.content[]` = thinking/text/tool_use（**tool_use 的 `id` 是结果配对键**）；`message.model` 是显示模型名唯一来源；`message.usage` 是圆环唯一数据源（in/cacheRead/cacheCreate/out）。
- `cost-state`：聚合全部模型、**不覆盖** model 标签；相邻快照折叠保末值。`custom-title`、`system`（stop 类 subtype → idle + stop 标记事件）。

## PWA 硬约束（勿回退）

**折叠/滚动**

- 折叠 CSS 必须是 `.node:not(.open):not(.plain) .node-body{display:none}`——输出/结论文本是 plain 节点，漏 `:not(.plain)` 会藏掉全部输出。
- 限高只作用于 `.think/.tool-chip/.tool-out`，且必须由 `markCapped()` 动态加 `.capped`（固定挂 overflow 造手势死区）；display:none 元素 scrollHeight=0，胶囊/节点头点击里要局部重跑 markCapped。
- 滚动三律：`.page` 必须 `height:100dvh`；`#chat` 必须 `overflow-anchor:none`；**renderTail 只从 `prevLen-1` 重渲染**（chat 子节点与 state.turns 一一对应，多删即错位→全量重建→滚动跳顶）。
- 嵌套滚动：页级滚动器（.chat/.groups）`overscroll-behavior: contain`；**内嵌滚动器**（.capped 系、.fp-body）必须 `overscroll-behavior-y: auto`——contain 会切断链条造成手势卡死。
- 乐观上屏：同文折叠必须**幂等**（已确认同文 no-op，防双触发重复泡）；排队消息派发前不上屏（`queue-dispatched` 帧置 `expectQueuedUser`，折叠器见旗标跳过 no-op 推新泡）；run 结束仍有未确认孪生→呼吸点转红静态（行真落盘仍可折叠转实）；重放判定：**时间戳优先**（更晚 ts=真重复推新，同 ts=重放 no-op，无 ts 走结构兜底）。
- 轮次形状：渲染源是 `steps[]`（think/tool/text 按真实顺序交错；兼容桶必须与 steps 同步 push）；tool_result 按 tool_use_id 配对回填 `tool.out`；完成信号双路（run 帧 + stop 标记事件，sessions 帧做活跃度翻转兜底）。
- 触屏 Enter=换行（`IS_TOUCH`=pointer:coarse）。

**视觉纪律**

- 暖炭底/珊瑚橘 #D97757；**珊瑚橘只给发送钮/工具点/链接/活态**；阴影分层（--sh-1/2/3）不用边框盒（裁定例外：确认弹窗取消钮灰描边、P 徽章描边）；tabular-nums。
- 模型 chip 是唯一可收缩元素（`flex:0 1 auto; min-width:0`，`max-width:50vw` 兜底）；弹层=锚定气泡（`.overlay.bub`+`.sheet.bubble`），模态=全宽 sheet——分工勿混；气泡 open/close 均不动 history；**勿在 closeBubble 里 history.back()**；气泡宽度用 `flex:1 1 auto`，勿用 align-self:stretch。
- 品牌区：官方托盘模板图 CSS mask 着色（连接状态在图标内：珊瑚=已连 / 奶白↔珊瑚呼吸=连接中 / 奶白=断开）+ P 徽章（非官方标注）+ T4 词标 + PERSONAL 胶囊（版本号并在胶囊内）。

**缓存（改前端必读）**

- 改 `public/` 必须三处同版本 bump：index.html 的 `?v=N`（app.js+style.css）+ `#build` 徽章 + `bridge/pairing.js` 的 `BUILD`。口诀：徽章不对=HTML 缓存过期；徽章对但行为怪=真 bug。

**上下文口径**

- 圆环/明细 = `(in + cacheRead + cacheCreate) / 窗口`（与 CLI 一致）；窗口：探针实测优先，fallback 按 model id 含 `[1M]` 推 1M、否则 200k；明细分类表驱动 `CTX_CATS`；模型目录读 settings.json env 的 `ANTHROPIC_DEFAULT_*`。

**配对/hooks**

- `/api/pair/*` 仅同机；token 轮换热替换（同步 settings.json hooks + 备份 + 踢旧 WS）。仓库 `scripts/start-bridge.vbs` 是自定位模板、startup 里是 pairing.js 生成的绝对路径版——勿合并。
- hooks 命令必须指向 `bridge/hook-post.cmd` 且路径用**正斜杠**（PowerShell `@-` 会炸）；POSIX 用 `hook-post.sh`；两者端口写死 3742。

## 工程红线

1. 后端只允许 `ws` 一个运行时依赖；`public/` 免构建 vanilla JS，不引打包器。
2. `.ps1` 必须纯 ASCII（PS 5.1 按 GBK 解析）；**严禁用 PowerShell 读写含中文的文件**——一律 Edit/Write 或 bash。
3. 密钥/token 永不写日志；`bridge/data/` 永不入库。
4. 静态服务只允许 `public/`（路径穿越防护）；响应 no-cache+ETag 304。
5. Node ≥ 20 ESM；fs.watch(recursive) 不可用时自动降级轮询。
6. 手机驱动的开发会话长在 bridge 进程树里：会话内脚本杀 bridge=杀掉本会话；重启桥一律从 PC 侧做（会话内重启接受当前 turn 被切断）。

## 路线图

P0/P1 已收口（审批 diff、历史分页、always-allow、改动文件总览、导出 MD、费用面板、搜索批量、确认弹窗、品牌化）。**已裁定不做**：锁屏/推送通知。命令行类功能（/compact 等）后续会补充。PC 端 CLI 已跨平台化（cli/cr.mjs 取代 ps1）。之后 Phase 3（Cowork 数据面）、Phase 4（Cowork 控制面，UIA）。
