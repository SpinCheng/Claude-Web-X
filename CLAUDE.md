# CLAUDE.md — claude-remote 工程上下文（Code 会话交接文档）

用手机（PWA）远程查看并操控本机 Claude Code 与 Claude Desktop（Cowork）任务的插件工程。架构基准：`docs/方案-v2.md`（先读它的第 4 节架构图与第 7 节接管模型）。

## 当前状态（2026-10-25，PWA 产品化改版完成）

- **Phase 1 已验证跑通**：bridge（HTTP/静态/鉴权/路径穿越防护、会话列表、转录详情）+ WS 实时 append 推送 + hooks→notify 链路全部实测通过。
- **Phase 2 已实现并通过端到端实测**：`bridge/runner.js`（无驻留执行器）、`bridge/handoff.js`（接管仲裁）、发送/新建/取消/驱动者 API、`cli/cr.ps1`（list/attach/release/url）。
- **PWA 功能层（2026-10-25 定稿）**：视觉**回归 v0 风格**（用户裁定：深色 #0e1116 + 蓝主色 #4f8cff + 卡片列表 + 气泡转录；状态灯语义沿用旧版：运行=琥珀呼吸/失败=红/停止=琥珀弱化/空闲=灰），在此之上保留新功能：按项目分组折叠列表（组头灯+计数徽章+行状态词）、系统返回键回列表（pushState）、跟随流式滚动+跳最新 FAB、图标化发送/停止按钮（跟随运行态）、思考过程折叠区（限高 42dvh + overscroll-contain）、`#open=<id>` 深链、401 自动回配对页、toast、PWA manifest+图标（`scripts/make-icons.mjs` 蓝色调）。
- **会话页时间线改版（2026-10-25，用户裁定：参考 ZCode_And `docs/design/fold-hierarchy-mockups-4.html` + Claude 暗色主题）**：全局调色板换 **Claude 暗色**（暖炭底 `#1F1E1D`、面板 `#2A2927`、Claude 珊瑚橘 `#D97757` 主色、`#E0896A` 强调文本色，manifest/图标/配对面板同步）。**v8 视觉工艺重做（纯 CSS、DOM 零改动）**：阴影分层代替边框盒子（--sh-1/2/3 + inset 顶高光）、字阶系统（人声 sans 15/机声 mono 10.5-13 + tabular-nums）、结论卡签名元素（品牌色左侧渐隐刻线 .final-card::before）、时间线渐隐轨道 + 工具点光晕（--acc-tint halo）、节点徽标去盒子化（纯文字 mono）、用户气泡无描边暖石色、dock 悬浮岛（--sh-3）、折叠/展开 rise 微动效（prefers-reduced-motion 全关）、gate 径向渐变仪式感。注意力纪律：珊瑚橘只给发送钮/工具点/链接/活态四处。CDP 12 项验证全过（含行为回归：折叠/滚动容器/圆环）。转录结构改为**胶囊一级折叠 + 时间线类型节点**：每轮 = 触发胶囊（"过程 · N 步"，收起时勾/展开时时钟图标）→ 时间线（思考=空心圆/工具=品牌色方块/输出=小圆点/结论=对勾；节点头带类型徽标+工具名+路径/命令链接；Edit/Write 显示 `+N −N` 行数徽标；各节点头独立二级折叠，整行可点）→ **结论永不折叠**（展开时是时间线末尾"结论"节点，收起时是 final-card 卡片）。工具输出限高 34dvh 内滚 + overscroll-contain。底部 **dock 式输入栏**（圆角卡内 textarea + 工具行：权限盾[自动/审批，对应 data-v 色]、模型名、发送/停止）。渲染函数：renderTurn + nodeEl/toolLink/toolDiff（app.js）；活轮次自动展开带光标、结束自动收起。**关键 CSS 约束（勿回退）**：折叠规则必须是 `.node:not(.open):not(.plain) .node-body{display:none}`——"输出/结论"是 plain 节点（不可折叠、永不带 open 类），漏掉 `:not(.plain)` 会把它们的内容全部藏掉（症状：输出节点全空、展开后结论消失，2026-10-25 已修）；文本入栈前过滤纯空白（`p.v.trim()`）。**限高滚动必须由 `markCapped()` 动态加 `.capped`**（仅 `.think/.tool-chip` 两类；结论与输出文本不限高——用户裁定）——固定挂 max-height+overflow+overscroll-contain 会把内容不够高的展开面板变成手势死区（自身无内容可滚、contain 又切断向页面冒泡，症状：展开面板内手势失效，2026-10-25 已修）。**隐藏元素 scrollHeight=0**：已完成轮次渲染时时间线 display:none，rAF 测量全为 0 不会加 capped——因此**胶囊点击和节点头点击的 onclick 里必须局部重跑 `markCapped(wrap)/markCapped(node)`**（漏掉则展开思考节点无限高，2026-10-25 已修）。CDP 实测：全部展开后 52/52 思考、111/111 工具正确限高，0 短误标。**滚动三律（2026-10-25 CDP 实测全过，勿破坏）**：① `.page` 必须 `height:100dvh`（min-height 会让 body 变成滚动容器、#chat 的 scroll 监听全部失效）；② `#chat` 加 `overflow-anchor:none`（防 DOM 尾部手术时的滚动锚定干扰）；③ **renderTail 对齐不变量**：chat 子节点必须与 state.turns 一一对应——只从 `prevLen-1`（上一尾轮）起重渲染，多删任何节点都会错位、触发下次 append 的 renderAllTurns 全量重建（瞬时清空 DOM 把 scrollTop 钳到顶部、atBottom 误判，症状：滚上去仍被拽走）。验证脚本模式：CDP 驱动 Edge headless（node+ws）实测 scrollTop/FAB，含真实 WS 追加流（曾用 .tmp-cdp-scroll-test.mjs，跑完即删）。Edge headless 实测：17 胶囊/17 时间线/106 节点/21 完成轮默认收起/1 活轮展开，15 项断言全过。**轮次数据形状仍为 `{think[], tools[], texts[]}`（texts 末位=结论），勿回退 mids/final 旧形状**。**活轮次（最后一轮）也必须可折叠（2026-10-25 v4 修）**：CSS 必须同时有 `.turn.done:not(.open) .timeline{display:none}` **和** `.turn.live:not(.open) .timeline{display:none}`（漏掉 live 规则=最后一轮点不动——sessionLive 判定 3 分钟内有写入即 active，最后一轮常为 live 态）；用户手动收起活轮次要被尊重：`state.userCollapsedLive` 让流式重渲染保持收起，新 user 消息/closeLiveTurn/openDetail 时重置为 false。**完成自动收起（v5 修）**：结束信号有两条路——手机 run 帧（handleRunFrame end）与 **adapter 的 stop 标记事件**（system stop 行 → `{k:'stop'}` 进 append events，handleAppend 检测到即强制 `liveTurnOpen=false` 并重渲染尾轮为 done）——后者覆盖桌面端/CLI 驱动的对话（无 run 帧）；另在 sessions 帧里做活跃度翻转兜底（liveTurnOpen && !sessionLive → closeLiveTurn + renderTail）。
- **工具行 v10/v11（圆环 + 模型选择，2026-10-25）**：**token 圆环 = 已用上下文/窗口**（`ctxUsed = in+cacheRead+cacheCreate`，来自最近一条 assistant 行的 `message.usage`；窗口大小从 `/api/models` 的 `ctx` 取——id 含 `[1M]` 即 1M，否则 200k，`state.modelCatalog` 缓存、openDetail 时 `ensureModels()` 拉取）。圆环压力变色：≥80% 琥珀、≥95% 红。**上下文明细面板（v11，参考 Codex 式布局）**：hero 大数字（已用/窗口+% 胶囊）→ 细堆叠条（工具=珊瑚/思考=琥珀 `--warn`/对话=石板蓝 `#7FA3B8`）→ 色块图例行（含"剩余可用"）→ meta 区（模型/累计/缓存/费用）。构成估算：adapter 在会话记录上累计 `est={tools,think,prose}` 字符数（**tool_result 也计入 tools**——非 human 的 user 行内容长度；human/assistant 文本→prose、thinking→think、tool_use 输入→tools），前端 chars/2.5 折 token 后**按 API 实际用量等比缩放**对齐。**模型列表（v11 修）**：`/api/models` 读 `ANTHROPIC_DEFAULT_<TIER>_MODEL_NAME`（真实名 glm-5.3/glm-5.3-flash）作 label，配对 `_MODEL` id（claude-opus-5[1M] 等，传给 `--model` 的是它）与 ctx；按 label 去重、opus>sonnet>haiku。选择项含"默认"；选中后 localStorage 存 `cr_model`（id）+`cr_model_label`（显示名），芯片显示 label。CDP 16 项断言全过（ring 数学/面板数值/模型列表/选择联动）。
- **上下文口径对齐桌面端（v12，2026-10-25）**：从 CLI 二进制（claude.exe SEA）逆向出 CC 的上下文显示算法——`used% = (input_tokens + cache_read + cache_creation) / 窗口`，与 PWA 圆环公式**完全一致**（y7n 函数：`r=e.input_tokens+e.cache_creation+cache_read_input_tokens; s=Math.round(r/n*100)`）。**CC 分类模型**（statusline/`/context` 共用）：System prompt / System tools / MCP tools(+deferred) / MCP server instructions / Memory files / Skills / Custom agents / **Messages**（= used − 固定段，从 API 用量倒推）/ Autocompact buffer / **Free space**（= 窗口 − used − buffer）；**MCP 工具 schema 多为 deferred、不占 used**（本机 REA 等大 schema 因此不计入）。**"usage 按 resolved autocompact window 计量"**（CLI 内文案），即桌面端分母可能是压缩窗口（< 模型窗口）——这是 PWA/桌面数值可能仍有小差异的根源。PWA v12：分类改为**系统与工具/消息/剩余可用**（fixed = 会话首请求 in+cacheRead+cacheCreate − 首条用户消息；adapter 记 `fixedTok`/`usageFirst`/`firstUserChars`，一次性推导），剩余用虚线纹轨道（repeating-linear-gradient）。（v12 遗留的"分母未知"与临时 statusline 探针已被 v13 的 /context 探针方案取代并移除。）
- **上下文口径对齐桌面端（v13 定稿，2026-10-25）**：**决定性发现——CLI 的 `/context` 命令在 `-p` 模式下可用**（`claude -p --model <id> /context --output-format stream-json --verbose`）：init 行带 session_id、result 行带 markdown 表格，一次拿全 Desktop 弹窗同源的精确数字。本机实测（claude-remote 项目 + claude-opus-5[1M]）：**窗口 1M**、固定开销 = 系统提示 3k + 系统工具 33.1k + MCP 工具 5.6k + MCP 指令 206 + 记忆 4.2k + 技能 2.5k = **48.6k**、**autocompact buffer 33k**；Free space = 窗口 − used − buffer（v12 推断已被实测证实）。`bridge/ctxprobe.js`：`GET /api/sessions/:id/context` → 按 (cwd, modelId) 缓存（内存 + `bridge/data/ctx-probe.json`）跑一次性 `-p /context` 丢弃会话（解析完即 `adapter.archiveSession` 回收，不残留列表），首次 ~6s、缓存后 28ms；固定段只取决于 (cwd,model) 与会话无关。PWA 面板（v13）：打开先显示首请求估算 + "正在测量"，探针返回后原位替换为**实测值**——系统与工具（含 系统/MCP/记忆技能 子注）/ 消息（= used − 固定）/ 自动压缩保留（buffer）/ 剩余可用（= 窗口 − used − buffer）；`state.ctxProbe` 命中时圆环分母也用实测窗口。CDP 8/8 过（含探针落地+子注+buffer 行）。**勿用 statusline 方案**（仅交互会话触发、配置不热加载、SendKeys 驱动不可靠——均已实测踩坑；探针已从 settings.json 移除，备份 `settings.json.bak-slprobe` 保留）。垃圾会话注意：手工跑 `/context` 或交互探针测试会留 jsonl，用 `DELETE /api/sessions/:id` 回收。
- **上下文面板细化 + 工具栏设计稿（v14，2026-10-25）**：明细分类按探针逐项拆开（系统提示/系统工具/MCP 工具/MCP 指令/记忆文件/技能/消息/自动压缩保留/剩余可用，行与堆叠条均 JS 动态生成——`renderContextSheet` 用 `CTX_CATS` 表驱动 + 分类色板 `.sw-sys/.seg-sys` 等：暖色系=固定开销、石板蓝=消息）；**删除了与上下文无关的行**（当前模型/累计 tokens/缓存读取/费用——费用仍在会话头 meta）。**输入框工具栏四版交互设计稿**：`public/composer-mockups-v2.html`（免鉴权可直接访问，手机也能开）——A 胶囊组+锚定气泡弹层 / B 图标轨(44px+微型值标)+泊位联板 / C 单行融合+居中浮卡 / D 常驻状态条+居中卡；每版三个工具（权限/上下文/模型）可点击、弹层内容为 v14 同款真实数据，CDP 12 项几何校验全过（框内/不遮 dock/高度适配）。待用户选定后落地。
- **方案 E 落地 + 推理等级（v15，2026-10-25，用户裁定）**：输入框工具栏 = **无框胶囊**（图标+数值直接坐在 dock 上，`.tdot` 中点分隔 ×3，按下才现轻底色；权限=珊瑚/琥珀、其余弱灰）+ 四工具：**权限/上下文(%值)/模型/推理等级**。所有工具弹层改为**锚定气泡**（`.overlay.bub` + `.sheet.bubble`：margin-bottom 104px 悬于 dock 上方、底部小尾巴、bubIn 弹簧动画、max-height 62dvh 内滚）——**勿回退为底部全宽 sheet**。弹层行样式全面**去拟物**（用户点名）：`.opt` 平铺行（透明底、无阴影、hairline 分隔、右对勾弹簧、active 仅 label 变珊瑚色），权限/模型/推理等级三弹层共用。**推理等级**：CLI 实测旗标 `--effort low|medium|high|xhigh|max`；runner `_spawnRun` 白名单校验后追加旗标（send/start/queue 全链路传 effort）；PWA `cr_effort` localStorage + 中文等级（低/中/高/超高/最高）。**气泡历史管理（防竞态，勿回退）**：open/close 均**不动 history**；popstate 时若有气泡开着→只关气泡并 `pushState({cr:'detail'},'#s')` 补回条目（"返回键先关弹层"），**不要**在 closeBubble 里 history.back()——异步 back 会与快速切换气泡竞态误关新弹层（v15 开发中实测踩坑）。气泡宽度用 `flex:1 1 auto` 填主轴（**勿用 align-self:stretch**——row-flex 下那是竖向拉伸，会把所有弹层拉到同高）。CDP 16 项全过。设计稿存档：`public/composer-mockups-v2.html`（A/B/C/D/E 五帧可交互）。
- Phase 0 六项实测**已完成**，报告：`docs/phase0/PHASE0-REPORT.md`。bridge 常驻后台（端口 3742，开机自启装好后随登录拉起）。

## 快速开始

```powershell
cd claude-remote
npm install
npm start          # node bridge/index.js
```

启动日志打印局域网 URL 与 token（存于 `bridge/data/config.json`，已 gitignore；新增键 `claudePath`/`defaultCwd` 会自动迁移合并）。手机浏览器打开 URL 输 token。电脑端接管：`powershell -ExecutionPolicy Bypass -File cli\cr.ps1 list` → `cr attach <序号>`。

**token 与配对（配对面板）**：PC 浏览器打开 `http://localhost:3742/pair`（**同机任意地址均可**：`/api/pair/*` 校验 `remoteAddress === localAddress`（含 loopback），电脑上用局域网 IP/Tailscale IP 打开也行；手机/其他设备仍 403——页面会提示"仅限本机访问"，建议收藏）——页面用 `public/vendor/qrcode.js`（vendored 的 MIT 库 qrcode-generator@1.4.4，客户端渲染，非后端依赖）渲染当前配对链接二维码（可切换网卡），并提供：**token 轮换**（`POST /api/pair/rotate`：免重启热轮换——同一 cfg 对象内存换 token + 写回 config.json + 自动同步 settings.json hooks（先备份 `.bak-rotate-*`）+ 踢掉全部旧 WS 客户端；已实测含 LAN 403 拒绝）与**开机自启安装**（`POST /api/pair/autostart`：**生成**绝对路径版 vbs 进 shell:startup——仓库里的 `scripts/start-bridge.vbs` 是自定位模板（node 取 PATH、项目根按脚本位置推导），启动文件夹里的副本由 pairing.js 用 `process.execPath` + 实际项目路径现场生成，两份职责不同勿合并；bridge 有 EADDRINUSE 双开保护）。token 不轮换就永不变化，手机配对链接永久有效。CLI 备选：`cli\cr.ps1 url`、`scripts\rotate-token.ps1`。

**hooks 推送已配置**（Stop + Notification 已写入 `~/.claude/settings.json`，原文件备份 `settings.json.bak-pre-claude-remote`）。关键实现事实：本机 CC 用 **PowerShell 执行 hook 命令**，curl 的 `--data-binary @-` 会炸（`@-` 是 PS 语法）；命令必须指向 `bridge/hook-post.cmd`（.cmd 恒由 cmd.exe 解析），且路径用**正斜杠**（反斜杠会被多层转义吃掉——手工改配置时切记）。hook-post.cmd 内写死端口 3742，改端口需同步改它。

## 已实测确认的数据事实（勿再调研）

**环境（Phase 0，2026-10-25）**

- `claude` CLI **不在 PATH**。第三方客户端内置完整 CLI：`%LOCALAPPDATA%\Claude-3p\claude-code\<版本>\<hash>\claude.exe`（当前 2.1.308；升级换目录，runner.js 动态取 mtime 最新）。
- 直接 spawn 该 CLI 报 "Not logged in"：`~/.claude/settings.json` 的 `env` 块（`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`，中转端点与密钥名见 `LOCAL.md`，不入库）不用于鉴权，**必须显式注入子进程 env**（runner.js/cr.ps1 均已实现，密钥只进内存）。
- `claude --resume <id> -p` 追加写原 JSONL、不新建文件（含对 Desktop 活跃会话注入的压力测试）；跨 resume 上下文保持。
- **Desktop 会话列表按工作目录（项目）分组**：手机/CLI 新建的会话只在 Desktop 中"打开该文件夹对应项目"时可见（**用户已实测确认**：claude-remote 工作区内手机新建的会话刷新后出现在 Desktop 列表）；cwd 落在未打开目录（如默认主目录）的会话 Desktop 不显示（数据仍在 JSONL）。Desktop 正打开的会话视图不会实时重放外部追加，**重开会话即见**（用户实测确认）。PWA 新建会话为 cwd 选择器（列出已知项目，默认最近活跃会话的 cwd）。
- **会话删除**：`DELETE /api/sessions/:id` → 转录移入 `bridge/data/trash/`（可找回）+ 墓碑机制防 fs.watch 删除事件复活记录（PWA 详情页 🗑 按钮）。运行中的会话拒绝删除（409 busy）。
- `--output-format stream-json --verbose`：每行 JSON 均带 `session_id`，序列 `system/init → assistant → system/post_turn_summary → result`。
- `claude://` 协议被**官方 Store 版 App** 接管，第三方客户端收不到 deep link（Phase 4 需换路线）。
- Cowork 存储（Claude-3p\local-agent-mode-sessions）：`local_*.json` 含 `sessionId`/`cliSessionId`/`cwd`/`title`/`createdAt`/`lastActivityAt`(ms)/`initialMessage`/`model`/`permissionMode`/`isArchived`——Phase 3 字段齐全。

**CC 转录格式（Phase 0/02）**

CC 会话转录在 `%USERPROFILE%\.claude\projects\<工作区slug>\<sessionId>.jsonl`（追加式明文 JSONL）。行 `type` 共 14 种，adapter 消费：`user`（`origin.kind==='human'` 才是真人消息；content 字符串或数组；含 `cwd`/`timestamp`/`entrypoint`）、`assistant`（`message.content[]`：thinking/text/tool_use；`message.model` 为第三方标签如 glm-5.3）、`custom-title`、`cost-state`（totalCostUSD + modelUsage）、`system`（stop 类 subtype 置 idle）。其余忽略。slug 规则：`D:\dev_workspaces\ZCode_And` → `D--dev-workspaces-ZCode-And`。本机 CC 会话多为 Desktop 内开（entrypoint=claude-desktop-3p），同样落此目录。

## Phase 0 待验证清单：全部关闭 ✅

1. ✅ CLI 在 PATH？——不在；用内置路径 `%LOCALAPPDATA%\Claude-3p\claude-code\*\*\claude.exe`（runner 自动解析，config `claudePath` 可覆盖）。
2. ✅ resume 追加原文件？——是（官方机制，实测多次，含活跃会话）。
3. ✅ Stop hook 回调可达？——是（`--settings` 临时文件实测；04 脚本自身读 body 有 bug 但不影响结论）。
4. ✅ Cowork 存储结构？——字段见上，Phase 3 可开工。
5. ⚠️ deep link？——协议被官方 App 截获、3p 客户端未注册，**当前不可用**；Phase 4 dispatcher 需改路线（UIA 优先 / 改协议注册，待决策）。

## 工程约定

- Node ≥ 20，ESM，后端**只允许 ws 一个运行时依赖**（保持零构建、易审计）；fs.watch(recursive) 不可用时 adapter 自动降级轮询。
- `public/` 是免构建 vanilla JS，不要引入打包器。
- **给本机写 .ps1 必须纯 ASCII**（PS 5.1 按 GBK 解析无 BOM UTF-8，中文必炸）；JS/MD 无此限制。**严禁用 PowerShell Get-Content/Set-Content 改含中文的工程文件**（v6 时曾把 index.html 读成 GBK 乱码、乱码吞掉属性引号导致 script 标签解析消失、整个 app 静默不加载——症状：徽章在（ASCII）但列表空白圆环为 0）；改文件一律用 Edit/Write 工具或 bash sed（字节级安全）。
- API 密钥/token 永不写日志；`bridge/data/` 已 gitignore。
- 静态服务只允许 `public/` 目录内文件（server.js 有路径穿越防护，改动时保持）。**静态响应带 `Cache-Control: no-cache` + ETag（mtime+size），支持 304 再验证**——此前无缓存头导致手机端新旧 JS/CSS 混搭缓存，出现"折叠失效"类幽灵 bug（2026-10-25 已修；改版后若手机异常，先强刷一次）。**缓存三重保险（2026-10-25 v3 起）**：① 前端每次改动必须 bump `index.html` 里 `app.js/style.css` 的 `?v=N` 与列表头 `#build` 徽章（三者同版本）；② 配对链接（lanUrls）带 `?_b=N` 穿透参数，扫码导航必拉新 HTML；③ `/api/pair/*` 为同机任意地址可访问（`remoteAddress===localAddress`）。诊断口诀：让用户看列表头版本徽章——徽章不对=HTML 缓存过期，徽章对但行为怪=真 bug。

## Phase 2 架构速记（已实现）

- `POST /api/sessions/:id/message {text, force}`：先 handoff 仲裁（转录 mtime 8s 内有新写入且非本 bridge 刚完成的 run → 409 `recent-local-write`，PWA 弹确认后 force 重发；运行中 → 409 `busy`）→ runner spawn `claude --resume -p --output-format stream-json`，完成即退。转录取实时更新走 adapter 管道，runner 只发 run 生命周期帧（WS `type:'run'`，新会话的 `sessionId` 从 init 行异步捕获）。
- **YOLO 模式（派发任务的核心前提，2026-10-25）**：runner spawn 时固定加 `--dangerously-skip-permissions`（此内置 CLI 实测支持官方旗标名；help 里的 `--allow-dangerously-skip-permissions` 是另一个开关）——headless 子进程没人批权限提示，不加则任务一碰到工具调用就永久卡死。config 键 `yolo: true`（默认开，false 关闭）。已实测：经手机 API 派发"创建文件"任务，子进程自主执行 Write 工具并完成。
- `POST /api/sessions/new {text, cwd}`、`POST /api/runs/:id/cancel`、`GET/POST /api/sessions/:id/driver`（claim-pc/release 供 cr.ps1）、`DELETE /api/sessions/:id`（回收站删除）。
- **PC claim 拦截（路径 A 落地，2026-10-25）**：`cr attach` 期间 PC 持有 advisory claim → 手机发送先收到 409 `pc-claim`（PWA 弹"电脑端已接管，切换为手机驱动？"确认后 force）；`cr attach` 退出时**自动 release**（finally 块，bridge 不可达时提示手动 cr release），不会残留"电脑端已接管"。实测链路：claim → 手机 409 → driver:pc → release → free → attach 桩测试（claim→启动→退出自动释放）全过。
- **会话状态模型**：`/api/sessions` 每条记录合并 `running`（runner 内存活 run）+ `lastRun {state: ok|failed|stopped, exitCode}`（runner 记忆，bridge 重启即失）+ `lastOutcome`（转录 system 行推导：interrupt→stopped / error·max_turns·permission_denied→failed / stop→ok，随文件持久）。spawn 失败（cwd 不存在等）发生在会话创建之前、无会话可挂状态——PWA 经 run 帧 toast 提示。
- 锁文件 `bridge/data/locks/<id>.json`（PC 端 advisory claim，TTL 12h）；手机侧驱动态由 runner 内存跟踪。单会话全局并发 ≤4。
- **消息排队（2026-10-25 v6）**：运行中发送不再拒绝/禁言——`runner.send` busy 时入队（`queues` Map，上限 5 条），run 结束 800ms 后 `_drainQueue` 自动派发（WS `queue-dispatched` 帧 + sessions 帧带 `queued` 计数；`DELETE /api/sessions/:id/queue` 清队，PWA 队列徽章点击取消）。**自己的活 run 在跑时跳过 mtime 仲裁**（server 消息路由先查 `runner.activeRunFor`，否则 recent-local-write 会误拦自己的排队）。PWA：输入框运行中保持可用；触屏设备 Enter=换行（`IS_TOUCH` = pointer:coarse）。**v10 输入区四件**：① 代码块复制按钮=图标+`.codeblock` 包裹钉住（代码滚动按钮不动）；② token 圆环只显示环不显示数字——进度=**最近一次请求的上下文占用**（assistant 行 `message.usage` 的 in+cacheRead+cacheCreate，adapter 传 `s.usage`；无 usage 时回退累计输出占比），点击弹**上下文明细面板**（当前上下文/累计 in·out/缓存读/费用/转录体积构成条：工具·思考·对话字符占比）；③ cost-state **跨模型聚合**（旧版只读第一个模型的用量，多模型会话数值错；且 cost-state 不再覆盖 model 标签——assistant 行的 `message.model` 是唯一显示来源，曾致 glm-5.3/opus-5.5 闪烁）；④ 模型芯片点击弹**模型选择列表**（`GET /api/models` 从 settings.json env 的 `ANTHROPIC_MODEL` + `ANTHROPIC_DEFAULT_*_MODEL` 解析；选中存 localStorage `cr_model`，发送/新建/排队都带 `model`，runner 加 `--model` 旗标）。

## 路线图（候选下一批 = PWA·P0 能力补全）

Phase 2 收尾已基本完成（cwd 选择器、自检优化、可安装 PWA 均已落地）；剩余：手机真机长期手感反馈。

**PWA 能力补全（2026-10-26 梳理，对标 CLI/桌面/OpenCode 等定档，详细清单以 README Backlog 为准）**：

- **P0 核心闭环**：①锁屏/后台完成通知（ntfy 代码已就绪，`notify.ntfyTopic` 配置即用；进阶 Web Push）；②手动 /compact 按钮（`-p` 斜杠命令路线已被 /context 探针验证，勘测压缩返回行为）；③审批卡 diff 视图（复用 toolDiff 渲染 Edit 的 old/new_string）；④历史回看分页（去 `readTranscript` 的 400 事件上限）；⑤手机发图（`--input-format stream-json` 发 image block，**先勘测中转多模态**）。
- **P1**：always-allow 工具白名单（approve-mcp 按 tool_name 放行）、会话改动文件总览（转录聚合或 git status）、会话重命名（本地覆盖）、队列单条管理、会话搜索、导出 Markdown。
- **P2**：斜杠命令面板、token/费用统计面板、配额/速率显示（statusline rate_limits 探测）、离线 PWA shell、cr.ps1 status/watch、检查点回滚（勘测 headless 可用性）、多设备 token（安全模型需重估，缓行）。

Phase 3：`adapter-cowork.js` 接入统一模型（字段已实测），轮询状态机（Cowork 无 hooks）。
Phase 4：Cowork 控制面——deep link 已判不可用，主路线 UIA（07 号勘探），CLI 接管（`cliSessionId`）为备选；Tailscale HTTPS（当前 http 局域网下 Chrome 不给安装提示，"添加到主屏幕"可用）。
