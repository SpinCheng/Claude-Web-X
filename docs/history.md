# 版本演进与调试史（症状 → 根因）

## 2026-10-27 · 会话列表不可滚（v31）

症状：列表页无法滚动。根因两层：① `.groups` 从 v16 起就没有 overflow/min-height——flex 列里 main 默认 `min-height:auto`，内容超出即被 `.page` 的 `overflow:hidden` 剪掉，**从来没有真正的滚动容器**（此前分组多折叠态没暴露）；② 补 `overflow-y:auto` 后又踩 flex 第二坑——`.pgroup` 作为滚动容器的 flex 子项且自带 `overflow:hidden`（min-height 退化为 0），被**压缩**到视口高（14 行只显 5.7 行）而不是撑开滚动。完整修复=滚动容器+子项不缩：`.groups { overflow-y:auto; min-height:0 }` + `.pgroup { flex:none }`。E2E 新增 list 场景（14 会话断言 sh>ch+300 且 scrollTop 生效）。教训：**flex 布局里"可滚"=容器约束(overflow+min-height:0)+子项不缩(flex:none)成对出现**，缺一半就是"剪掉"或"压扁"。

## 2026-10-27 · step-4 回归炸停产线（症状：换血后手机连不上）

症状：重构 step 0-4 提交、脱离重启器换血后 bridge 起不来，手机全部失联；且本轮 turn 仍活着（**runner 死后 `-p` 模式不再读 stdin，管道断裂杀不掉已派发的 turn**——"杀 bridge=杀 turn"只对进行中读写窗口成立，对纯输出阶段不成立）。根因：抽取脚本把 assistant 分支的 `const rec0 = this.store.get(id)` 删了但引用还在——`ReferenceError: rec0 is not defined`，**每条真实 assistant 行都带 message.usage**，启动 drain 必炸。测试盲区：单测与 E2E 的 assistant fixture 都没带 usage 字段，崩溃行从未执行——14 测全绿带雷上线。修复 + 两个回归单测（usage 推导有/无预置记录）+ E2E fixture 的 assistant 一律带 usage（此后该路径永远被踩）。教训两条：①机械搬运脚本的变量改名 replace 必须 grep 残留引用再收工；②**fixture 字段保真度=测试有效性**——缺 usage 这种"真实必有、合成常无"的字段就是盲区清单。另：启动横幅含 token，诊断重定向日志只可进 %TEMP%（勿进仓库），常态重启一律不重定向。

## 2026-10-27 · 分层重构 step 0-5（用户裁定：可维护性整改）

动机：app.js 1880 行 26 分区、server.js 604 行 6 类职责混居；路线图功能（审批 diff/分页/搜索/导出/Phase 3 cowork）全要动这两块公共区。方案先行讨论后按步执行，每步独立提交、套件护航：

- **step 0 安全网**：E2E 冒烟套件落地（`test/e2e/`：harness 隔离实例+CDP 驱动+合成转录 fixture，6 场景）。踩坑三枚：api() 助手 `...opts` 展开会**替换**掉 auth 头（401 假失败）；`#open=` 深链在 fixture 被发现前打过去=永久空白（waitSession 门）；projects 目录须在 adapter.start 前存在（fs.watch 对缺失目录静默降级轮询）。
- **step 1**：app.js 转 ES module 入口，md/linkify 纯函数入 `js/md.js`（零构建不破——原生 module，无打包器）。
- **step 2**：`js/state.js`（可变单例）/`js/api.js`（401 回调注入，无视图逻辑）/`js/ws.js`（传输与帧语义分离，handlers 注入）。
- **step 3**：server.js 604→106 行组装根；`lib/`（router 33 行含 `*` 通配、wshub、auth、mime、models）+ `routes/` 六域。新增路由级 try/catch（原来 route 抛错=进程级 unhandled）。踩坑：guard 闭包里取 `r.res` 而 r 无 res——签名 (req,res,r)。
- **step 4**：`parsers-cc.js` 纯函数化（applyLine 整个 switch，rec 作参数注入），adapter 只剩生命周期 204 行；12 个单测把 v22/24/26/28 判定坑全部钉死。踩坑：heredoc 嵌模板字符串生成正则必丢反斜杠（`\\s`→`s`）——**生成含正则的代码一律 Edit 直写**（同 bash 内联 fixture 教训一族）。

- **step 5**：app.js 1735→244 行组装根（boot/gate/popstate 路由/WS 帧语义/delete），视图拆入 `js/views/`：toast / overlays（气泡+灯箱+预览+审批卡）/ list（分组列表）/ ctxring（圆环+明细+模型目录）/ composer（输入区+附件+队列面板+新会话弹窗）/ detail（视图壳）+ transcript（轮次模型+renderTail 脆核）——detail 拆两半是超计划项（单文件会 ~800 行，脆核单独成层可测可审）。currentModel/currentEffort 读取器并入 state.js（"持久化键在此读"宪章）；util.js 收 $ + 格式化。**composer↔detail 唯一函数级循环 import**（renderDriverChip↔updateComposer/renderAttachChips/fetchQueue）——ESM 函数声明在实例化期即初始化、事件期才调用，两文件头注已声明"求值期零交叉"红线。死代码 togglePerm 丢弃（全工程零引用）。对账制度化（step-4 rec0 教训）：import↔export 双向脚本对账 + 新旧函数清单 diff，审计脚本 .tmp-* 用完即删。改动仅搬运+导出声明，v32，14 单测 + 7 场景全绿。

CLAUDE.md 只保留当前事实与硬约束；这里的叙事按时间线归档。根因分析对新会话仍有诊断价值，规则本身已提炼进 CLAUDE.md。

## 2026-10-25 · Phase 0/1/2（架构定形）

- Phase 0 六项环境实测：CLI 不在 PATH（用客户端内置副本）；`--resume -p` 追加写原文件；Stop hook 可达；Cowork 字段齐全；`claude://` deep link 被官方 Store 版截获（第三方客户端收不到）→ Phase 4 改 UIA 路线。报告：`phase0/PHASE0-REPORT.md`（gitignored）。
- Phase 1：bridge（HTTP/静态/鉴权/穿越防护）+ WS append 推送 + hooks→notify 实测通过。
- Phase 2：runner（无驻留执行器）/ handoff（仲裁+PC claim）/ cr.ps1 端到端实测，含 claim→409→release 全链路。

## 2026-10-25 · PWA 视觉三轮

1. **v0 风格**（深色 #0e1116 + 蓝主色 #4f8cff）：分组折叠列表、返回键回列表、跟随滚动+FAB、折叠思考区。
2. **Claude 暗色改版**（用户裁定参考 ZCode_And 设计稿）：暖炭底 #1F1E1D/面板 #2A2927/珊瑚橘 #D97757。v8 视觉工艺：阴影分层替代边框、字阶系统、结论卡左侧渐隐刻线、时间线渐隐轨道+工具点光晕、节点徽标去盒子化、dock 悬浮岛、rise 微动效（prefers-reduced-motion 全关）、gate 径向渐变。
3. **胶囊折叠时间线**：触发胶囊（"过程 · N 步"）→ 类型节点（思考空心圆/工具方块/输出圆点/结论对勾；Edit/Write 带 +N −N 行数徽标）→ 结论永不折叠。工具输出 34dvh 内滚。

## 2026-10-25 · 折叠/滚动系列坑（全部 CDP 实测修复）

| 症状 | 根因 | 修复 |
|---|---|---|
| 输出节点全空、展开后结论消失 | 折叠选择器漏 `:not(.plain)`，把不可折叠的输出/结论也 display:none 了 | 选择器必须是 `.node:not(.open):not(.plain) .node-body` |
| 展开面板内手势失效（死区） | 固定挂 max-height+overflow+overscroll-contain：内容不够高时自身无内容可滚、contain 又切断向页面冒泡 | `markCapped()` 动态加 `.capped`，仅 think/tool-chip |
| 已完成轮展开思考节点无限高 | display:none 时 rAF 测 scrollHeight=0，不会加 capped | 胶囊/节点头点击里局部重跑 markCapped |
| 滚上去仍被拽回底部 | renderTail 多删了一个 DOM 节点→与 state.turns 错位→下次 append 触发全量重建（清空 DOM 把 scrollTop 钳顶、atBottom 误判） | 严格只从 prevLen-1 重渲染 |
| 最后一轮点不动（不能折叠） | 只写了 `.turn.done` 折叠规则，漏 `.turn.live`（sessionLive=3 分钟内有写入即 active） | 两条规则都要；`userCollapsedLive` 尊重手动收起 |
| 完成后不自动收起（桌面/CLI 驱动的会话） | 只有手机 run 帧一条结束信号 | adapter 加 stop 标记事件（system stop 行→`{k:'stop'}`）+ sessions 帧活跃度翻转兜底 |

滚动容器前提：`.page` 必须 `height:100dvh`（min-height 会让 body 变滚动容器、#chat 监听失效）；`#chat` 加 `overflow-anchor:none`。验证模式：CDP 驱动 Edge headless（node+ws）实测 scrollTop/FAB/折叠，脚本 .tmp-* 用完即删。

## 2026-10-25 · 缓存幽灵 bug

无缓存头时手机端新旧 JS/CSS 混搭 → "折叠失效"类假 bug。修复三重保险：`?v=N` 资源版本 + `#build` 徽章 + 配对链接 `?_b=N` 穿透 + 静态 no-cache/ETag 304。诊断口诀：徽章不对=HTML 过期，徽章对=真 bug。

另：**严禁 PowerShell 改含中文文件**——曾把 index.html 读成 GBK 乱码、乱码吞掉属性引号致 script 标签解析消失、整个 app 静默不加载（症状：ASCII 徽章在但列表空白）。

## 2026-10-25 · 上下文口径四轮（v10→v14）

1. v10：圆环=输出占比（错）；cost-state 只读第一个模型（多模型会话数值错）；cost-state 与 assistant 行互相覆盖 model 标签（glm-5.3/opus 闪烁）→ 修复：全模型聚合 + assistant 行独占标签。
2. v11：圆环改真实上下文占用（in+cacheRead+cacheCreate）；构成用转录字符估算（est）等比缩放；模型列表读 `_MODEL_NAME`；窗口按 `[1M]` 后缀推 1M。根因发现：旧版 200k 假分母，会话实际 363k 永远钳 100%。
3. v12：逆向 CLI 二进制（claude.exe SEA）证实 CC 公式与 PWA 逐字一致（y7n 函数）；CC 分类模型（System prompt/Tools/MCP/Memory/Skills/Messages=used−固定/Autocompact buffer/Free space）；MCP schema 多为 deferred 不占 used。statusline 探针尝试失败（仅交互会话触发、不热加载、SendKeys 不可靠）。
4. v13/v14 定稿：`/context` 在 `-p` 模式可用（决定性发现）→ ctxprobe 按 (cwd,model) 缓存实测，明细拆到 9 类，删除与上下文无关行（模型/累计/缓存/费用——用户裁定）。

## 2026-10-25 · 输入区方案 E（v15/v16）

四版设计稿（A 胶囊组/B 图标轨/C 单行融合/D 状态条 → composer-mockups-v2.html 五帧可交互存档），用户选 A 去框版=**E 无框胶囊**。弹层行去拟物（用户点名：盒子+阴影与 app 风格不符）→ .opt 平铺行。开发中两个真坑：

- **气泡关闭竞态**：closeBubble 里 history.back() 是异步的，快速"关 A 开 B"时迟到的 pop 事件会误关 B → 改为 open/close 均不动 history、popstate 时关气泡并 pushState 补回条目。
- **align-self:stretch 竖向拉伸**：row-flex 下 stretch 是竖向，把所有弹层拉到同高（症状：四个弹层高度完全相同 419px）→ 主轴填充用 `flex:1 1 auto`。
- v16：应用户要求移除弹层内滚（max-height/overflow 全删），弹层纯内容自适应。

## 2026-10-26 · 排队交互 v17（Z.ai 模式落地）

参考图识读（GLM MCP 对任何图都报 1210——服务端问题，换模型自带识图解决）→ 三版设计稿被否 → R1 定稿：队列面板贴输入框上方（平铺行+发丝线，去卡片嵌套）、头部计数/清空/「N 条待上屏」、上限 3 行、行操作 ▶✏🗑+grip 拖动、三态发送钮（运行+有字=仅琥珀发送，停止隐藏）。

- 实现坑：`arr.map(row)` 把索引当第二参传入 `row(t, icon)` → 图标全 undefined（设计稿阶段踩的，map 语义警钟）。
- 测试坑：CDP 从 `/#open=` 二次导航是**同页 hash 跳转，boot 不重跑**——deep link 测试必须带 query（`?_b=N#open=`）强制整页加载；countdown 任务 ~9 秒就跑完，UI 竞态用「页面先打开、从输入框 UI 发起慢任务」的确定性时序解决。
- 顺手抓出真 bug：**WS `sessions` 帧处理器不调 `updateComposer`**——中途打开一个已在跑的会话（无 run 帧推送），发送/停止按钮态永远停在初始的空闲渲染。已修（sessions 分支补 updateComposer）。
- 端到端：API 8 步（排队/快照/删单条/重排/坏重排 400/插队中断+派发）+ UI 7 断言（面板/占位切换/三态/删行/拖动/▶确认框）全过，真实 run 驱动。

## 2026-10-26 · 附件/手机发图 v19

勘测先行的 P0 项。结论三条：① `--input-format stream-json` 在 2.1.308 可用，**但 stdin 写完必须保持打开**——写完立即 close 会连 init 都不出地挂死（产线策略：不 end，child 退出自然回收）；② `--resume` 下图片块完整落转录 human turn，CLI 另注入一条 `[Image: source: <临时路径>]` user turn（adapter 按模式折叠）；③ **中转模型对图是盲的**——Read 工具拿回 image 块后模型仍去 PowerShell hexdump PNG 头（IHDR/IDAT），工程链路照建，视觉即插即用。

实现：raw 上传（readRawBody ≤10MB → data/uploads/<sid>/）+ /files 鉴权静态服务 + 附件校验（须属本会话）；runner 图片走 stdin 块、文本附件 ≤24KB 内联 prompt（盲模型也能读）；PWA 📎 → 图片 canvas 压 1568px/JPEG（≤400KB 透传）→ chips → 发送携带 → 转录气泡 data:URL 渲染 + 灯箱 + 文本预览。E2E：CDP `DOM.setFileInputFiles` 喂真实文件，chips/清空/上传/气泡图/灯箱/占位折叠全过。

测试事故两起：① 会话选择从列表猜——同 cwd 列表第一个是**当前 harness 会话**，测试差点把本会话发进回收站（409 recent-local-write 意外救场：headless confirm 自动取消）；改用 runId→run 帧确定性捕获。② 杀残留进程 `wmic name='claude.exe'` 把宿主 App 一起杀了（本机 Claude.exe 名字冲突）——清进程必须按命令行过滤。

## 2026-10-26 · 乐观上屏 v20

症状：v18 只在点击瞬间清空输入框，消息气泡仍要等 CLI 启动+写转录（2-5 秒）才出现，用户感觉「卡住」。修复：POST 202 即 push `optimistic` user turn（pending 半透明）；转录 user 事件按文本匹配原地折叠。两个坑：① 去重必须幂等——fs.watch+轮询会双触发同一事件，第一版对已确认气泡直接 break 推了重复气泡；② fold 改的是尾部之前的 turn，handleAppend 固定渲染尾帧会漏掉它——引入 editStart（本批最早被改索引）。测试教训：断言数 `.bubble.user` 时忘了会话创建的引导消息也是 user 气泡，total:2 被误判为重复（state.turns vs DOM 转储一步定位）。



## 2026-10-26 · 等待横幅 v21（PC 权限卡手机不可见）

用户截图：PC 端弹「Claude needs your permission to use Bash」确认卡时手机只会看到会话干等——权限提示只存在于 PC 交互 UI、**不落转录**。修复：Notification hook 的 message（permission to use X / waiting for your input）解析成会话级 `waiting` 状态 → WS `wait` 帧 + `/api/sessions` 合并字段 + 详情页横幅 + 列表「待确认」琥珀灯；清除双路 = 该会话任何转录 append（PC 批准后 CLI 继续写）或 Stop hook。E2E 用伪造 hook payload 驱动（真实交互提示无法 headless 触发），置位/横幅/清除全过。

顺手抓出老根：**`broadcastSessionsSoon` 和 WS 初始帧发的都是未合并的 `store.list()`**——WS sessions 帧从来不含 running/queued/waiting，手机列表灯对 PC 驱动会话一直是错的，「中途打开会话按钮态不刷新」的 v17 修复也只补了一半。三处（broadcast/初始帧/HTTP）统一走 `mergedSessions()`。

后续修正（同日）：v21 初版把空闲通知（"waiting for your input"）也算 waiting——它每轮跑完 ~60s 后必发，而两条清除路径（转录 append / Stop hook）的时机都在它**之前**已经过去，横幅从此常驻（症状：用户手机上本会话一直挂「会话已暂停」，实际只是 PC 端跑完在等输入=交互会话的常态）。修复：extractWaiting 只认权限类通知。教训：**置位型状态必须先问"谁来清、何时清"**——清除时机全部早于置位时机的信号等于永不清除。

排查此 bug 时被同一陷阱反咬两次：手机驱动的开发会话本身就是 bridge 的 runner 子进程，脚本里 `Stop-Process` 杀 bridge = 杀掉正在跑的会话（stdin 管道断裂，两次中断都精确落在杀进程那一步）；脱离的 PowerShell 不被连坐、继续跑完 kill+拉起，所以 bridge 每次"自己恢复了"。规则已进 CLAUDE.md 工程红线第 6 条。

## 2026-10-26 · 成本行双显（cost-state 连写）

用户报「最后这个文本输出了两次：成本 $314.30 · in 20709533 / out 665270 tok」。取证：转录文件里就有**两行紧邻的 cost-state**（全文件 39 处仅此一对，位于该轮 stop_hook_summary 之后）——2.1.308 进程退出时偶发连刷两个快照，且值不同（in 20798717/$305.04 → in 20709533/$314.30，用户引的是末值）。adapter 忠实各渲染一条 → 两条成本行。修复：`_applyLine` 产出 stats 事件时若上一条显示事件也是 stats，先 pop 再返回新事件（相邻折叠、保末值；中间隔任何其他显示事件则两条都保留——那是正常的每轮一条）。教训：显示层报"重复"，先查数据源是否本身就重复——本例根因在 CLI 侧而非 PWA。



## 2026-10-26 · 时间轴交错 + 工具产出 v22

用户报两个问题：① 输出节点全堆在轮次末尾——渲染按类型分桶（think 全部→tools 全部→texts 全部）而非真实顺序；② 工具产出（图片/文本）完全不可见——tool_result 只被拿去算上下文估算后丢弃。修复：轮次加 `steps[]` 交错序列作渲染源（桶保留兼容）；tool_use 带 id，`toolres` 事件按 id 配对回填 `tool.out`（文本 ≤4KB、图片 ≤4 张内联+灯箱、`.tool-out` 入 markCapped）。

关键发现：**2.1.308 本地工具的 tool_result 行 origin 为 null**（MCP 结果才有 origin.kind），原来只认 `origin.kind!=='human'` 的人机门把这些结果全漏了——判定改为按内容含 tool_result 块。测试侧：中转环境下 Bash 被关在 ToolSearch 后面（提示词逼不出），改用合成转录（手写 tool_use/tool_result JSONL 放进监听目录）做确定性断言，[工具→结论] 顺序 + echo 输出全链路 PASS。



## 2026-10-26 · 产物预览 v23

用户追问 v22 是否真完成「中途输出的图片、文本等文件无法查看」——只完成了一半：工具结果里的**内联**文本/图片（v22 toolres 配对）能看，但运行中**写到磁盘**的文件（Write/Edit 产物、脚本截图）在转录里只是路径字符串，`/files` 又只服务手机上传的附件目录。v23 补齐：PWA 侧路径正则链接化（仅白名单扩展才链、分隔符容忍 tool chip 里 JSON.stringify 的双反斜杠）；bridge 侧 `preview` 端点锁会话 cwd（resolve+前缀校验，`..`/绝对路径在外/UNC 全 403）。

安全取舍：html/svg 即使白名单也**按 text/plain 出**（模型写的文件当 markup 渲染=自造 XSS）；图片直出；≤2MB；cwd 外不可预览（~/.claude 等故意排除）。测试：隔离实例（:3799，不碰生产 bridge，规避红线 6）curl 9 断言（401/200/415/403×3/404）+ CDP headless E2E（badge v23、4 条链接、txt 弹层含正文、png 灯箱 blob URL）全过。教训：**「显示层缺功能」先分清数据在不在转录里**——内联结果在（v22 够），磁盘文件不在（需要服务端取，v23）。

## 2026-10-26 · 压缩摘要折叠 v24

用户报：某种状态下一大串生成文本以右侧气泡上屏——即上下文耗尽压缩后的**续传摘要**。取证（本会话文件 3 处）：该行 `type=user`、**origin 字段缺失**、`isCompactSummary:true`、`isVisibleInTranscriptOnly:true`、纯字符串 content；现有门只查 `origin.kind`，缺失即漏进真人分支渲染成大气泡。关键坑：**origin 缺失 ≠ 可折叠**——手机经 runner 发的消息（promptSource/turnOrigin=sdk）同样没有 origin 字段，按缺失折叠会把真消息吞掉，只能认显式 `isCompactSummary`。另发现 66 条 sdk 探针类 user 行（如 passphrase 探测）与手机消息同签名，无法字段区分，维持气泡。PWA 渲染为 sysline 标记「⟲ 上下文已压缩（续传摘要 N 字，已折叠）」。隔离实例验证：API 层 compact=1/user=2/零泄漏 + CDP DOM 六断言全过。

## 2026-10-26 · 结论卡 Markdown 渲染 v25

miniMd 从"围栏码+行内码+加粗"升级为块级解析：标题/分割线/引用/无序有序列表/表格 + 行内（码/**粗**/*斜体*/链接），段落保留聊天式换行。安全边界：**转义先行**（含 `"`→`&quot;`，防 href 属性逃逸）、**链接只认 https?**（`javascript:` 死在正则之外）、模型注入的 `<script>` 原样变文本。排版循视觉纪律：链接珊瑚橘虚线下划线（同 .flink）、表格发丝线+tabular-nums、引用左侧刻线用中性色（珊瑚只留给链接/活态）、列表/表格字重 400 与结论 600 形成层级。隔离实例 CDP 15 断言全过（badge/h2/双 h3/5 li/表头表体/引用/hr/链接 rel/jsLink=false/scriptTag=0/** 不残留/斜体/行内码）。

## 2026-10-26 · 代码块样式作用域 + 重放 live 误判 v26

用户报「代码块没有正常渲染」。取证两处根因，都不在 miniMd 本身：① **CSS 只写了 `.final-card`**——展开过程后的时间线「结论」节点（`.final`）里 pre/code 是裸默认样式（无深底/内边距，v25 之前就这样）；而 v25 新加的 md 块样式又只写了 `.final`，主视图 final-card 的列表/表格/标题反而走浏览器默认（ul 40px 缩进、p 1em 边距）。修复：整套 md 样式统一 `.final, .final-card` 双选择器。② 顺手抓出 **buildTurns 重放 bug**：初始加载重放事件后无条件 `markLiveTurn()`，stop 标记只在 append 路径生效——刚跑完 3 分钟内重开会话，末轮仍按 live 渲染（结论变「输出」节点+闪烁光标）。修复：重放时跟踪 trailing stop（其后有新 user 事件则重置），有 trailing stop 不再 markLiveTurn。

测试坑：合成转录的时间戳写成"未来"导致 sessionLive 恒真（Date.now()−lastActive 为负仍 <180s），反而把这个重放 bug 钉死了——确定性时序有时靠意外。隔离实例断言：时间线结论节点 pre×2 带深底、行内 code 存在、final-card ul 缩进 20px、mdh2 15.5px、无 ``` 残留。

## 2026-10-26 · UI/UX 审计与 a11y 修补 v27

跑 ui-ux-pro-max 审计（重点：v22-v26 落地的详情页/结论卡）。**对比度实测全部达标**：正文 13-14、次级 dim 5.4-6.9（含表头/工具输出）、链接 4.5-5.0、warn 7.5；仅两个次级 token 低于 AA——`--faint` 3.05（10px 机注行/队列头/徽章）、`--err` 4.21（错误输出）——均为 v8 定稿设计语言（最弱层/错误红），记录在案未擅动。修了四处机械问题：① 链接 `word-break: break-all` → `overflow-wrap: anywhere`（break-all 会把英文链接文本从词中切断，违反 long-token-wrapping；机串场景的 tool-chip/ap-input 保留 break-all 是对的）；② 8 个图标钮补 aria-label（原来只有 title）；③ `.flink`/结论卡链接补 `:focus-visible` 焦点环（触屏永不见）；④ Esc 关闭灯箱/文本预览（键盘逃生口，输入框聚焦时不劫持）。CDP 断言 9 项全过。教训：断言裸 `return` 在 Runtime.evaluate 顶层非法；`word-break:break-word` 是 final-card 既有继承值（等价 overflow-wrap 旧行为），断言目标应是"不再是 break-all"而非"必须是 normal"。

## 2026-10-26 · 技能注入折叠 + 命令信封归一 + 行内码 chip v28

用户报两问题：① 行内代码无"被包裹"观感——CSS 只有 mono 字体，无底色/内边距；加 `rgba(255,250,240,.07)` tint + 5px 圆角内边距（**pre 内 code 必须重置**，否则块代码双重底色）；② 调用技能时技能描述以右侧大气泡出现——与压缩摘要同族：**技能体注入行 = origin 缺失 + 纯 text 数组 + 首段 "Base directory for this skill:"**（实测 54k 字），折叠为 `✧ 技能 <名> 已注入（N 字，已折叠）` sysline（名取路径末段）。连带修复：`<command-*>` 信封原来只剥 command-name，用户 `/命令` 气泡显示标签汤——现归一成 `/名 参数`（/goal、/model、/compact 全受益）。

测试坑（记两次了）：**bash 内联双引号里的 `\\\\` 会被逐层吃光**——fixture 路径反斜杠全丢、技能名提取跟着"假错"；含反斜杠的合成数据一律 Write 脚本文件 + `String.raw` 生成，勿 node -e 内联。隔离实例断言：unit（name=sample-skill）+ API（skill=1/零泄漏/命令归一）+ CDP（标记行/无大气泡/干净命令气泡/chip 底色 5px 字重 400）。

## 2026-10-26 · 公开化整改

隐私扫描清除三处（vbs 写死管理员路径/中转商端点/绝对路径）→ LOCAL.md 承接本机事实；自启 vbs 改"仓库自定位模板 + pairing 现场生成绝对路径版"双职责；补 LICENSE/SECURITY/CONTRIBUTING/.gitattributes/.editorconfig/CI；phase0 → docs/phase0。运行环境表修正：桌面客户端不是依赖（bridge 从不与桌面 App 通信），CLI 才是（版本强关联，README 有对照清单）。
