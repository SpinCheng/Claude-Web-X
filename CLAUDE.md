# CLAUDE.md — claude-remote 工程手册

用手机（PWA）远程查看并操控本机 Claude Code 会话的插件工程（LAN bridge + 免构建 PWA）。

- 架构基准：`docs/方案-v2.md`（第 4 节架构图、第 7 节接管模型）；2026-10-27 分层重构（step 0-5 已落地）：**后端** `server.js`=组装根（106 行）→ `lib/`（router/wshub/auth/mime/models）+ `routes/`（sessions/message/attachments/hooks/approvals/pairing）+ `parsers-cc.js`（转录行判定纯函数，单测覆盖）；**前端** `app.js`=组装根（244 行：boot/gate/视图路由/WS 帧语义）→ `js/`（state 单例含 currentModel/currentEffort 持久化读取器 / api 带 401 回调 / ws 传输注入 handlers / md+util 纯函数）+ `js/views/`（toast / overlays 气泡·灯箱·预览·审批卡 / list 分组列表 / sessops 列表行操作·行尾 ⋯ 气泡 / ctxring 圆环·明细·模型·等级弹窗 / composer 输入区·附件·队列·新会话 / detail 视图壳 + transcript 轮次模型·renderTail 脆核——**滚动三律与 renderTail 不变量在 transcript.js**；composer↔detail 与 list↔sessops 是函数级循环 import，均求值期零交叉）。
- 本机专属事实（路径/中转环境）：`LOCAL.md`（gitignored）
- 版本演进与调试史（症状→根因）：`docs/history.md`
- E2E 冒烟套件（改桥/PWA 必跑）：`npm test` → `test/unit/`（parsers 14 + turns 5 判定单测）+ `test/e2e/`（隔离实例 :3799 + 合成转录 + headless Edge CDP，8 场景：时间轴/md渲染/折叠标记/产物预览/API面/三态钮/列表滚动/列表操作；fixture 勿走 bash 内联——反斜杠会被吃；harness 的 api() 头必须合并非替换；headless 自动 dismiss confirm，harness 已代答 accept）
- 功能缺口 Backlog：README「路线图/Backlog」节

## 快速开始

```powershell
cd claude-remote
npm install
npm start          # node bridge/index.js，端口 3742
```

手机浏览器打开启动日志里的 URL 输 token。PC 端接管：`powershell -ExecutionPolicy Bypass -File cli\cr.ps1 list` → `cr attach <序号>`。bridge 常驻后台（配对面板可装开机自启，EADDRINUSE 双开保护）。config（`bridge/data/config.json`，gitignored）键：`token`/`port`/`claudePath`/`defaultCwd`/`yolo`/`notify.ntfyTopic`。

## 运行机制速记

- **消息链路**：`POST /api/sessions/:id/message {text, force, perm, model, effort, attachments}` → handoff 仲裁 → runner spawn `claude --resume <id> -p --output-format stream-json --verbose`（完成即退，无驻留）。转录实时更新走 adapter 的 fs.watch 管道；runner 只发 run 生命周期帧（新会话 sessionId 从 init 行捕获）。
- **附件（v19）**：`POST /api/sessions/:id/attach?name=` raw body（≤10MB）→ `data/uploads/<sid>/`；`GET /files/...` token 鉴权静态服务。message 带 `attachments:[{file,name,type}]`（server 校验须属本会话）。runner：**图片走 `--input-format stream-json` stdin 图片块**（2.1.308 实测可用；**stdin 写完必须保持打开**，立即 close 会挂死 CLI）；文本类附件 ≤24KB 直接内联进 prompt。PWA：📎 选文件→图片 canvas 压到 1568px/JPEG（≤400KB 原样透传）→上传→chips；转录 user 气泡渲染 image 块（data: URL）+灯箱；文本 chip 点击弹预览。**CLI 附加行为**：图片消息会多注入一条 `[Image: source: <临时路径>]` user turn（adapter 已折叠），图片本身仍在真实 human turn 的 image 块里。**中转模型实测对图是盲的**（Read 拿到图仍去 hexdump 字节）——链路就绪，视觉取决于后端模型。
- **产物预览（v23）**：工具文本里的 Windows 绝对路径自动链接化（工具 chip/工具输出/中途输出节点；路径正则分隔符容忍 JSON 双反斜杠，扩展须在白名单内才链）→ `GET /api/sessions/:id/preview?p=`：**锁会话 cwd 内**（resolve+大小写不敏感前缀校验，UNC/绝对路径在外直接 403）、扩展白名单（图片直出；**html/svg 一律 text/plain 出，防模型写文件 XSS**）、≤2MB。PWA：图片→灯箱（blob URL，旧的 revoke）、文本→预览弹层（≤64KB）。cwd 外的文件不可预览（by design，安全边界即项目目录）。
- **handoff 仲裁**：转录 mtime 8s 内有新写入且非本 bridge 刚完成的 run → 409 `recent-local-write`（PWA 确认后 force）；PC 持有 claim（`cr attach`）→ 409 `pc-claim`；attach 退出 finally 自动 release（锁 `bridge/data/locks/<id>.json`，TTL 12h）。**自己的活 run 在跑时跳过 mtime 仲裁**（server 先查 `runner.activeRunFor`）。
- **runner**：① yolo 默认开——固定加 `--dangerously-skip-permissions`（headless 无人审批，不加则工具调用永久卡死）；② perm=ask 走 `--permission-prompt-tool` + 内联 `--mcp-config`（approve-mcp.mjs 回调 `/internal/approval`，手机审批卡，3 分钟超时自动拒）；③ `--model`/`--effort` 直传（effort 白名单 low|medium|high|xhigh|max）；④ busy 时入队（上限 5，run 结束 800ms 后自动派发）。**队列单条管理（v17）**：条目带 id，任意变更推 WS `queue` 帧（快照 {id,text}）；API：`GET/DELETE /api/sessions/:id/queue`（快照/整队清）、`DELETE .../queue/:qid`（删单条）、`POST .../queue/reorder {order:[ids]}`（拖动重排）、`POST .../queue/:qid/runnow`（插队=移到队首+中断当前 run，排空时先发它）。PWA：dock 内队列面板（头部计数/清空/待上屏，最多 3 行）、行操作 ▶✏🗑、grip 拖动排序、三态发送钮（空闲=发送 / 运行+空=停止 / **运行+有字=仅琥珀发送**）。⑤ 全局并发 ≤4。PWA 侧选择持久化：`cr_model`+`cr_model_label`、`cr_effort`、`cr_perm`（localStorage）。
- **会话状态** = `running`（runner 内存）+ `lastRun`（bridge 重启即失）+ `lastOutcome`（转录 system 行推导，随文件持久：interrupt→stopped / error·max_turns·permission_denied→failed / stop→ok）。
- **等待横幅（v21）**：PC 交互会话卡在权限确认时 CLI 不写转录、手机无从得知——Notification hook（message 含 "permission to use X"/"needs your approval"；**只认权限类**——空闲提示 "waiting for your input" 每轮跑完必发且清除时机都已过去，认了横幅就常驻，勿加回）→ `waitings` Map → WS `wait` 帧 + `/api/sessions` 的 `waiting` 字段 + 详情页横幅 + 列表「待确认」灯。清除双路：该会话任何转录 append、Stop hook。**所有 sessions 帧（WS 初始/broadcast/HTTP）必须走 `mergedSessions()`**——曾因 broadcast 发未合并的 `store.list()` 导致 WS 侧永远看不到 running/queued/waiting。
- **上下文探针（ctxprobe.js）**：`GET /api/sessions/:id/context` → 按 (cwd, modelId) 缓存（内存 + `bridge/data/ctx-probe.json`）跑一次性 `-p /context`，解析后 `adapter.archiveSession` 回收丢弃会话（首次 ~6s，缓存后毫秒级）。固定开销只取决于 (cwd, model)。**归档在解析判定之前、成败都执行**（v41c：曾只在成功路径归档，探针跑挂→边车漏成无对话僵尸会话，列表冒出"只有 slug 没路径"的怪分组）。
- **会话删除**：转录移入 `bridge/data/trash/`（可找回）+ 墓碑防 fs.watch 复活；运行中 409。批量删除（v43）逐个走同接口，busy 自动跳过并在 toast 报数。
- **列表搜索（v43）**：header 下搜索框，纯本地过滤（标题/cwd/项目 slug/id，不区分大小写）；命中平铺展示（无分组头），清空恢复分组。与批量管理共用 `visibleSessions()`。
- **分支（v40/v40b）**：结论卡分支钮武装 composer → 下一条消息 `POST /api/sessions/:id/message {branchFrom}` → runner `_spawnRun(['--resume', src, '--fork-session'], ..., sessionId=null)` → init 行采纳真实新 sid → `adapter.titleFork` 追加 `Fork-<源标题>` custom-title（1.2s×4 重试等文件发现）。**busy 拒绝不排队**（排队 fork 会每次排空都 fork）。
- **会话操作（v34/v35）**：列表行尾 **⋯ 按钮**（span role=button——行是真 `<button>`，内嵌 button 会被 fragment 解析器提出去打碎布局；组头同理，v41 的组头 ➕ 也是 span）或右键 → 操作气泡（sessops.js：停止/重命名/删除，停止单只在手机驱动的 run 存在时出现）；右键有选区守卫（选中文本=原生复制菜单优先）；**长按不占用——还给文本选择**（v35 实测裁定）。**重命名 = `POST /api/sessions/:id/rename` 往转录 JSONL 追加原生 `custom-title` 行**（桌面端改名同款记录）：落盘即持久、每次 boot/drain 重放生效；行尾无 `\n` 先补边界（防坏行拼接）；行不带时间戳 → 不 bump lastActive/status。**改名钉 write-fence（v39+v40c）**：rename 后 `pinRename` 记 {title, prev} 持久化 `bridge/data/renames.json`；`fenceTitle` 纯函数判 stale（===prev，Desktop/CLI 回冲旧值）吞掉、真新值 disarm——**钉只能被活流（emitAppends=true 的 drain）解除**，boot 全量重放/readTranscript 无权解钉也无权夺标题（否则历史旧行会误杀钉：v40c 教训，"持久化状态+全量重放"必须区分重放与活流的变更权限）。**mergedSessions 携带 `runId`**——重载后没见过 run 帧也能 cancel（列表停止与 composer 停止共用）。headless confirm 自动 dismiss——harness 代答 accept。**未注册非 GET 一律 405**（server.js 兜底）：后端新增端点必须重启 bridge 才加载——"前端新功能可见、后端 405" = 老进程症状。
- **v44/v45 五件套**：① **审批卡 diff（方案B）**：Edit/Write/MultiEdit/NotebookEdit 的 input 渲染 ±diff（`buildApprovalDiff`，统计行 + `<details>` 展开；**必须 createElement/textContent 构建**——内容是模型产物，拼 HTML 即 XSS 面；行上限 120 截断报余量），其余工具仍 JSON 明细。② **会话级 always-allow**：卡上勾选「本次会话始终允许」→ `hub.allowSessionTool`（**内存 Map**，bridge 重启即重新布防）→ `askApproval` 同 (session,tool) 直接 allow 不再弹卡。③ **历史回看分页**：`readTranscript(limit, before)` 返回 `{events,total}`（400 条 cap 是 bridge 侧切片，盘上全量）；PWA `#hist-more` pill（**必须挂 #chat 外**——前插子节点破 renderTail 1:1 不变量）+ 顶部下拉 70px 双触发；`parseOlderTurns` 纯重放（**勿复用 applyEventToTurns**——那会碰乐观折叠/queued 旗标）+ `prependTurns`（turns unshift 与 insertBefore 等量 + `scrollTop += scrollHeight` 差值锚定视口）。④ **导出 MD**：`GET /api/sessions/:id/export?scope=full|summary`（summary=每轮提问+末条结论；full=全部文本+工具单行引注，thinking 略）——⋯ 气泡二级范围选择，blob+a[download]（PWA webview 对 attachment 头不可靠）。⑤ **改动文件汇总（总结卡内，6C+6B 合体）**：done 轮结论卡下 `details.fsum`（默认一行「改动 N 个文件 +a −d ▾」，展开=每文件 ± 行数，行点击=产物预览）；`fileChanges(turn)` 纯函数聚合 steps 里 Edit/Write/MultiEdit 输入 JSON（**路径身份按 lower() 合并**，Write 全记增），每次渲染现算不缓存——**纯前端，无新 API**；展开体 >12 文件截断报余量（**勿进 markCapped 体系**，那是 .think/.tool-chip/.tool-out 专属，新元素硬挂 overflow 造手势死区）。

## 已实测确认的数据事实（勿再调研）

**环境**

- CLI 不在 PATH：第三方客户端内置 `%LOCALAPPDATA%\Claude-3p\claude-code\<版本>\<hash>\claude.exe`（runner 取 mtime 最新，config `claudePath` 可钉版本；npm 全局安装的 CLI 同样可用）。**实测版本 2.1.308，行为强关联**（JSONL 格式 / resume 语义 / 旗标名 / `/context` 输出 / hooks 回调——升级后出问题先对照 README「运行环境」清单）。
- 直接 spawn 报 "Not logged in"：`~/.claude/settings.json` env 块（见 LOCAL.md）**必须显式注入子进程**（runner/cr.ps1 已实现，密钥只进内存）。
- `--resume <id> -p` 追加写原 JSONL、不新建文件；跨 resume 上下文保持。
- Desktop 列表按工作目录分组：手机/CLI 新建会话要在 Desktop 可见，需 Desktop 打开过对应文件夹；Desktop 打开中的视图不实时重放外部追加，重开即见。
- `stream-json --verbose` 行序列：`system/init（含 session_id）→ assistant → system/post_turn_summary → result`。
- `claude://` deep link 被官方 Store 版接管，第三方客户端收不到（Phase 4 改走 UIA）。
- Cowork 存储（`Claude-3p\local-agent-mode-sessions\local_*.json`）字段齐全（sessionId/cliSessionId/cwd/title/createdAt/lastActivityAt/ms/model/permissionMode/isArchived）——Phase 3 可开工。
- CLI 的 `/context` 在 `-p` 模式可用（stream-json：init 带 session_id、result 带 markdown 表）；**statusline 方案勿用**（仅交互会话触发、配置不热加载，已实测排除）。手工跑 /context 会留垃圾 jsonl，用 DELETE API 回收。

**转录格式**

`%USERPROFILE%\.claude\projects\<工作区slug>\<sessionId>.jsonl`（追加式）。adapter 消费：`user`（**人机判定按内容：2.1.308 本地工具的 tool_result 行 origin 为 null，只看 `origin.kind==='human'` 会漏配对——含 tool_result 块即机器回合**；**压缩续传摘要行 origin 缺失 + `isCompactSummary:true` → 折叠为 `{k:'compact',n}` 标记**；**技能注入行 origin 缺失 + 纯 text 数组 + 首段 "Base directory for this skill:" → 折叠为 `{k:'skill',name,n}` 标记**（name=路径末段）——勿按"origin 缺失"折叠：手机端 promptSource=sdk 的消息同样无 origin，必须保留气泡，只能认显式标记；`<command-*>` 信封归一成 `/名 参数`（勿再显示标签汤）；content 字符串或数组）、`assistant`（`message.content[]`：thinking/text/tool_use——**tool_use 的 `id` 是结果配对键**；`message.model` 是显示模型名的**唯一来源**；`message.usage` 是圆环**唯一数据源**：in/cacheRead/cacheCreate/out）、`custom-title`、`cost-state`（**聚合全部模型**，且**不覆盖** model 标签——曾致模型名闪烁；进程退出时偶发连写两行快照，39 次中见 1 次——**adapter 相邻折叠保末值**，中间隔其他事件则都保留）、`system`（stop 类 subtype → idle + `{k:'stop'}` 标记事件）。slug：`D:\foo\Bar` → `D--foo-Bar`。

## PWA 硬约束（勿回退，详见 docs/history.md 的根因）

**折叠/滚动**

- 折叠 CSS 必须是 `.node:not(.open):not(.plain) .node-body{display:none}`——输出/结论文本是 plain 节点（不可折叠），漏 `:not(.plain)` 会藏掉全部输出。
- 限高只作用于 `.think/.tool-chip`（结论/输出不限高），且必须由 `markCapped()` 动态加 `.capped`——固定挂 overflow 会造手势死区。display:none 元素 scrollHeight=0：**胶囊与节点头点击里必须局部重跑 markCapped**。
- 滚动三律：`.page` 必须 `height:100dvh`；`#chat` 必须 `overflow-anchor:none`；**renderTail 只从 `prevLen-1` 重渲染**（chat 子节点与 state.turns 一一对应，多删即错位→全量重建→滚动跳顶）。
- 乐观上屏（v20）：发送 202 即 push `optimistic` user turn（pending 半透明）；转录 user 事件按文本匹配**原地折叠**（匹配必须是幂等的——已确认的同文要 no-op，否则 fs.watch+轮询双触发会推出重复气泡）；fold 改的是尾部**之前**的 turn，handleAppend 用 `editStart`（本批最早被改索引）调 renderTail，默认仍是尾帧。**排队消息不上屏（v37）**：202 `queued:true` 时立即 retract 乐观气泡——消息没进转录，要等派发真正落盘；`queue-dispatched` 帧置 `state.expectQueuedUser`，折叠器见到它就跳过同文 no-op 推新泡（否则连发两条"继续"时后一条会被误判成重放吞掉），旗标首条 user 事件即消费，双发 dedupe 依旧成立。turn-model 判定有单测（test/unit/turns.test.mjs，stub 掉 matchMedia/localStorage/document/window 供 import 期接线）。
- 轮次形状：**渲染源是 `steps[]`（v22 起按真实发生顺序交错：think/tool/text 任意排列）**，`think[]/tools[]/texts[]` 桶仍在但只作兼容（markLiveTurn/lastLiveToolName 用），两者必须同步 push。结论=最后一个 text step，其余 text step=输出节点。**tool_result 事件（`{k:'toolres',items:[{id,text,err,images}]}`）按 tool_use_id 配对回填 `tool.out`**（文本 ≤4KB 截断、图片 ≤4 张内联+灯箱，`.tool-out` 纳入 markCapped 限高体系）；配对改动的是尾部之前的内容，handleAppend 的 editStart 机制复用。done 与 live 轮都要有折叠规则；`state.userCollapsedLive` 尊重手动收起；完成信号双路：run 帧 + stop 标记事件（后者覆盖桌面/CLI 驱动），sessions 帧做活跃度翻转兜底。
- 触屏 Enter=换行（`IS_TOUCH`=pointer:coarse）。

**视觉纪律**

- Claude 暗色（暖炭底/珊瑚橘 #D97757）。注意力纪律：**珊瑚橘只给发送钮/工具点/链接/活态**。阴影分层（--sh-1/2/3）不用边框盒子；tabular-nums。
- 工具栏=无框胶囊（图标+值+.tdot 中点分隔）；**模型 chip 是唯一可收缩元素**（`flex:0 1 auto; min-width:0` 链到名字 span，`max-width:50vw` 兜底）——防长模型名把发送钮挤出屏（v36）；已设推理等级显示为 chip 内静音小胶囊 `c-effort-tag`。弹层=锚定气泡（`.overlay.bub`+`.sheet.bubble`，悬于 dock 上方+小尾巴+弹簧）。**勿回退全宽底部 sheet；弹层行=.opt 平铺行（去拟物，用户裁定）**；模型弹窗含等级 pill 段（选模型=确认收起，选等级=就地生效，v36）。
- 气泡历史：open/close 均不动 history；popstate 有气泡开着→只关气泡并 `pushState` 补回条目；**勿在 closeBubble 里 history.back()**（异步竞态误关新弹层）；气泡宽度用 `flex:1 1 auto`，**勿用 align-self:stretch**（竖向拉伸）。

**缓存（改前端必读）**

- 改 `public/` 必须三处同版本 bump：index.html 的 `?v=N`（app.js+style.css）+ `#build` 徽章 + `bridge/pairing.js` 的 `BUILD`（配对链接 `?_b=N` 穿透）。诊断口诀：徽章不对=HTML 缓存过期，徽章对但行为怪=真 bug。

**上下文口径**

- 圆环/明细 = `(in + cacheRead + cacheCreate) / 窗口`（与 CLI 算法逐字一致，已逆向验证）。窗口：探针实测优先，fallback 按 model id 含 `[1M]` 推 1M、否则 200k。
- 明细分类（探针实测值）：系统提示/系统工具/MCP 工具/MCP 指令/记忆文件/技能/消息（=used−固定）/自动压缩保留/剩余可用（=窗口−used−buffer）；渲染表驱动 `CTX_CATS`+分类色板。无探针时 fallback：`fixedTok`（会话首请求推导，adapter 记录）+ `est` 字符估算。
- 模型目录：`/api/models` 读 settings.json env——`ANTHROPIC_DEFAULT_<TIER>_MODEL_NAME` 作显示名，配对 `_MODEL` id 传给 `--model`；按名去重、opus>sonnet>haiku。选中存 `cr_model`+`cr_model_label`。

**配对/hooks 实现事实**

- `/api/pair/*` 仅同机（remoteAddress===localAddress，含 loopback）；token 轮换热替换（同步 settings.json hooks，备份 `.bak-rotate-*`，踢旧 WS）。
- vbs 双份职责：仓库 `scripts/start-bridge.vbs` 是自定位模板；shell:startup 里的副本由 pairing.js 现场生成绝对路径版——勿合并。
- hooks：本机 CC 用 PowerShell 执行命令，`@-` 会炸——命令必须指向 `bridge/hook-post.cmd` 且路径用**正斜杠**；hook-post.cmd 写死端口 3742。

## 工程红线

1. 后端只允许 `ws` 一个运行时依赖；`public/` 免构建 vanilla JS，不引打包器。
2. **.ps1 必须纯 ASCII**（PS 5.1 按 GBK 解析）；**严禁用 PowerShell Get-Content/Set-Content 改含中文的文件**（曾把 index.html 读成乱码致 app 静默不加载）——一律 Edit/Write 或 bash sed。
3. 密钥/token 永不写日志；`bridge/data/` 永不入库。
4. 静态服务只允许 `public/`（路径穿越防护）；响应 no-cache+ETag 304。
5. Node ≥ 20 ESM；fs.watch(recursive) 不可用时自动降级轮询。
6. **手机驱动的开发会话长在 bridge 进程树里**（runner 的 `--resume -p` 子进程）：会话内脚本杀 bridge = 杀掉本会话（stdin 管道断裂、turn 无结果中断，脱离的脚本仍会跑完拉起——bridge"自己恢复了"是假象）。重启 bridge 一律从 PC 侧做；确需会话内重启，接受当前 turn 被切断。

## 路线图（候选下一批 = PWA·P0，详见 README Backlog）

P0 核心闭环：锁屏通知（ntfy 就绪）/ 手动 /compact / 审批 diff 视图 / 历史回看分页。P1：always-allow 白名单、改动文件总览、导出 MD（重命名、队列单条管理、会话搜索+批量管理 v43 已落地）。之后 Phase 3（Cowork 数据面，adapter-cowork.js + 轮询）、Phase 4（Cowork 控制面，UIA 主路线）。
