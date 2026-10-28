# 版本演进与调试史（症状 → 根因）

## 2026-10-27 · 排队消息不再立即上屏（v37）

用户报：运行中排队发送的消息点完立即出现在时间轴，应该等上一任务完成、排队任务真正执行时再上屏。根因：`_send` 的乐观路径（v21）不区分 queued——202 `queued:true` 后半透明气泡一直挂到派发折叠。修法：202 queued 时 `retractOptimisticUser`（race-safe：若派发已抢先折叠则 optimistic=false 变 no-op）。

连带修一个折叠判定坑：气泡收回后，派发落盘的 user 事件没有乐观孪生，靠"最近 12 轮同文本"判重放会把**同文本的旧回合**误判成重放而吞掉新泡（连发两条"继续"必踩）。加 `state.expectQueuedUser` 旗标（`queue-dispatched` 帧置位、折叠器遇首条 user 事件消费）：置位期间跳过同文 no-op 推新泡；旗标即耗尽，双发去重依旧成立（第二份走普通 no-op）。turn-model 判定新增单测 turns.test.mjs（5 条：重放 no-op / 排队推新 / 双发去重 / 旗标消费 / 乐观孪生仍折叠）——node 跑 DOM 前端模块的取经：transcript.js 拉 overlays.js（模块顶层接线 scrim 点击），须 stub `document`/`window`/`matchMedia`/`localStorage` 四件套再动态 import；`node --test` 目录参数在此 Node 不奏效，package.json 显式列两个文件。

## 2026-10-27 · 工具栏 overflow 修复 + 推理等级并入模型弹窗（v36）

用户报：模型名稍长，工具栏右侧元素被挤出屏。根因：`.cbtn` 全员 `flex:none`，attach+4×tdot+perm+ring+model+effort 六个固定宽度件在 375px 屏已超宽（模型名 cap 96px 也救不回来）。修法：**模型 chip 成为唯一可收缩元素**（`flex:0 1 auto; min-width:0`，名字 span 同链 `min-width:0 + ellipsis`，按钮 `max-width:50vw` 兜底）——flex 收缩要求从按钮到 span 全程允许缩，断一处即失效。

同时按用户裁定把**推理等级并入模型弹窗**：弹窗=「模型与推理」，上段模型 opt 行（点选=确认并收起），`ms-sub` 小节标题带分隔线，下段 `.seg.effort-row` 六粒等级 pill（点选=**就地生效不关弹窗**，可继续调模型；两项关系写进 sheet-note）。等级从工具栏摘除后，chip 内新增 `c-effort-tag` 静音小胶囊（`·高`，默认隐藏；用 `--dim` 不占珊瑚——注意力纪律）。effort-sheet 弹窗删除（overlays BUBBLES 同步），EFFORTS/openEffortSheet 从 composer.js 迁入 ctxring.js（模型归属地）。

测试坑：headless Edge 默认 ~800px 宽**桌面视口**，几何断言永远不触发收缩——harness 补 `resize()`（CDP `Emulation.setDeviceMetricsOverride`），375px 移动视口下断言「send 在工具栏内 + 模型 chip 收缩 <200px + 六粒 pill + 等级就地生效/chip 小标签挂·摘」。

## 2026-10-27 · 实测修复：长按与选文本冲突 + 重命名 405（v35）

v34 上真机用出来的两个缺陷：

① **长按操作与选择文本冲突**：长按是「呼出操作」和「选择文本」的同一手势，不可兼得。裁定：**长按还给选文本**（系统级习惯能力优先于 app 功能），触屏主路径改**行尾显式 ⋯ 按钮**；桌面右键保留但加**选区守卫**——有选中文本时 contextmenu 不 preventDefault，原生复制菜单优先。实现坑：行本身是 `<button>`，**内嵌 `<button>` 会被 HTML fragment 解析器提到外层外**打碎行布局——⋯ 用 `span role=button tabindex=0`（Enter/Space 手动激活）。连带删掉整套长按定时器 + document 捕获段 click 吞噬（不再需要，代码反而简单了）。

② **重命名 405**：不是路由代码 bug。router 对未注册的非 GET 一律 405（server.js 兜底 `if (req.method !== 'GET')`），而**运行中的 bridge 还是 v34 之前重启的老进程**——静态文件实时从盘上读（v34 前端 UI 已生效，所以重命名弹窗看得见），但路由表在内存里是旧的。PC 侧重启即愈。教训：**后端新增端点必须重启 bridge 才加载；"前端新功能可见、后端 405" = 老进程症状**，先查进程再查代码。

## 2026-10-27 · 列表页会话操作（v34：长按/右键 → 操作气泡）

会话操作成套补齐——**停止运行 / 重命名 / 删除**在列表行长按（触屏）或右键（桌面）呼出的操作气泡直达，不必先进会话。功能清单梳理：列表语境下有意义的操作就这三个（复制 ID 小众、置顶无后端、导出属 P1，均不进本批）；打开=单击不变。

形态选**锚定气泡**而非滑动操作或行内按钮，三重依据：① UX 规则「主内容横向 swipe 与垂直滚动手势冲突」（ui-ux-pro-max Touch/Gesture Conflicts，vertical scroll primary）；② 工程事实 renderList() 每次 sessions 帧全量重建 DOM——swipe 展开态会被秒关，气泡是覆盖层不受重建影响；③ 触屏无 hover，「悬停显隐按钮」路线天然出局（High severity 规则）。破坏性删除保持 window.confirm 双确认（沿用既有惯例）。气泡/重命名弹层进 BUBBLES 数组——scrim 点击、系统返回吞噬、Esc 全部白得。

实现要点：**重命名 = 原生 custom-title 行**——`POST /api/sessions/:id/rename` 往转录 JSONL 追加 `{type:'custom-title'}`（桌面端改名写的同一记录类型）：落盘即持久、每次 boot/drain 重放即生效；行尾无 `\n`（写崩残留）时先补边界再追加，防拼接出坏行；行不带时间戳 → 解析器不 bump lastActive/status。**mergedSessions 补 runId**——顺手修掉「页面重载后停止按钮失灵」老缺口（没见过 run 帧就无从 cancel），列表停止与 composer 停止共用此回退。**长按的尾随 click 吞噬必须挂 document 捕获段**——at-target 监听按注册序执行，renderRow 先赋 el.onclick，行上拦截来不及（长按会连开详情）；arm 于手势结束 + 700ms 过期，防无尾点击的手势（iOS 长按不出 click）误吞下一次主动点击。

测试坑：headless 对 window.confirm 自动 **dismiss（返回 false）**——harness CDP 客户端补 `Page.javascriptDialogOpening` → `handleJavaScriptDialog{accept:true}`，删除链路才可 E2E（sessops 场景第 8 个：气泡条件行 idle 无停止/运行有停止、重命名乐观上屏 + **重载后仍在**（转录重放验证）、停止 toast、删除后行消失）。

## 2026-10-27 · 会话列表重排（v33，ui-ux-pro-max 技能驱动）

主动重设计（非修 bug）。布局决策：①状态词右置成独立着色槽位（idle 不渲染减噪；色彩+文字双通道）；②行改语义 `<button>`（键盘可达+focus-visible 弱珊瑚环），min-height 52px/组头 48px/touch-action:manipulation；③去掉每行 go 箭头（全行可点+按压反馈已表达）；④组头 tally 补 waiting 计数（acc 色排最前，折叠时仍可见——待确认是手机端唯一可行动状态）+ aria-expanded；⑤空态=图标+文案+全屏唯一珊瑚 CTA 直开新会话弹窗。刻意不做入场 stagger：renderList 每次 sessions 帧全量重建，动画=闪烁+费帧。视觉纪律未破（沿用既有 token，珊瑚只给唯一 CTA）。

验证方式：Read 本会话不支持看图 → 改 CDP 数值验收（10 断言：几何/右槽对齐/折叠/空态 CTA 配色线宽）全过。**harness 事实**：`fakeRun` 直接 `runner.emit` 绕过内部 runs map，mergedSessions 的 running 只来自真实 spawn 生命周期——E2E 断言列表 running 态必须**先开页再 fakeRun**（客户端 state.runs 经 run 帧+sessions 重广播兜住）。

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

## 2026-10-27 · v38 项目组头：文件夹图标 + 路径副行

用户点名两处列表改进：组头前导状态灯改**文件夹图标**（态色沿用 lamp 调色板：running=warn/waiting=acc 且保呼吸动画、failed=err、stopped=warn 半透明——组态信息零丢失，tally 仍给精确计数；呼吸动画纳入 reduced-motion 列表）；标题下方加**完整 cwd 路径副行**（mono 10px faint，ellipsis，无 cwd 的组不渲染该行）。结构上 `.pgroup-name` 让出 `flex:1` 给新 `.pgroup-main` 两行容器（与 `.srow-main` 同构）。e2e list 场景补两条断言（图标存在 + 路径副行以 `D:` 开头、`e2e` 结尾——断言里不写反斜杠，规避老坑）。纯静态改动，无需重启 bridge。

## 2026-10-27 · v39 改名防回冲（Desktop 标题缓存回写）+ 组头缩进

用户报：手机重命名当时生效、过一会又被还原。实锤触发路径（本机转录直接取证）：Desktop 对打开中的项目缓存会话标题，每次元数据冲刷（last-prompt/agent-name/mode/atis-latch 成束追加）都把**缓存里的旧标题**重写进 JSONL——单个转录里同款旧值 custom-title 重写了 **97 次**；两次手机改名（L1943→L1945、L18515→L18516）都在 1-2 行之内被回冲。解析器文件序 last-writer-wins → 改名被旧值覆盖。修复 = **改名钉 write-fence**：rename 路由追加后调 `adapter.pinRename(id, title)` 记 {title, prev=改名前标题}（持久化 `bridge/data/renames.json`，Desktop 的缓存跨 bridge 重启存活，钉也必须跨）；`fenceTitle()`（parsers-cc 纯函数）：custom-title 值===prev → 判 stale 吞掉（patch.title/事件 title 都回写为钉值）；值是**新**标题 → 判 disarm（真·桌面端改名，桌面接管，钉解除）；值===钉值/无钉/空白 → 不动。顺带加固：custom-title 空白值不再清空当前标题（旧代码 `|| ''` 会清）。生命周期：会话删除时清钉；e2e sessops 验证全链路（flush 行数计数注意 rename 本身也追加一行——3 fixture+1 rename+2 flush=6 行，断言先写 5 行等空转）。组头缩进：padding-left 9px 使文件夹图标外凸 6px、标题文字仍与会话行标题 35px 精确对齐（嵌套暗示）。**后端改动，需重启 bridge 加载。**

## 2026-10-27 · v40 草稿持久化 / 气泡 meta 行（复制·分支·时间外提）/ 新建弹窗 bug

三项。**① 草稿**：composer 输入按会话存 localStorage（`cr_draft_<sid>`，250ms 防抖、20KB 上限），openDetail → `setDraft(id)` 回填（顺带修掉切换会话残留上会话文字的老问题）；发送清键、失败 restore 时回存、队列"取回编辑"同步存。**② 气泡 meta 行**：user 泡与结论卡的**时间标签外提**到气泡下方 meta 行（`.turn.user` 包一层——renderTail 1:1 不变量保持，顺带给裸 user 泡补了 `.turn` 的 10px 间距）；复制图标复用 copyText 的 .ok 动画机制；结论卡多一个**分支图标**。**分支 = 真分叉**：CLI 实测支持 `--resume <id> --fork-session`（新 session id、继承上下文）；UX = 点分支钮武装 composer（珊瑚橘 chip 提示），下一条消息走 fork：路由校验 branchFrom===URL id → runner.send 带 forkFrom → `_spawnRun(['--resume', src, '--fork-session'], ..., sessionId=null)` → init 行采纳真实新 id（与 start() 同机制）→ app.js `pendingBranch` 旗标采纳导航（202 与 WS 帧竞态容忍：runId 未知时接受窗口内任意异会话 running 帧）。**fork 不排队**（busy 拒绝——排队 fork 会在每次排空时都 fork 一次）。**③ 新建弹窗 bug**：`#new-modal` 原来在 `#detail` 容器**内部**——列表页点"+"时 modal 的 hidden 被移除但父页 hidden，视觉上"没反应"，进入任一会话后 detail 显示、modal 才"迟到"冒出。移到 body 级（HTML 注释写明原因）。e2e：markdown 场景补 meta 行/复制/分支武装断言，list 场景补"+"当场开弹窗断言。**后端改动（runner/message 路由），重启 bridge 后分支功能才可用。**

## 2026-10-27 · v40b 分支会话 "Fork-" 前缀

分支会话标题 = `Fork-<源标题>`：runner 从 init 行采纳 fork 真实 sid 的那一刻（server.js 接线 `_emit` 新增的 `forkFrom` 字段）→ `adapter.titleFork(forkFrom, newId)` 往**新**转录追加原生 custom-title 行——若 CLI 把源历史（含源 custom-title）拷进 fork 文件，我们的行在文件序最后、必胜。时机约束：adopt 时 adapter 可能尚未发现新文件（fs.watch 200ms 防抖）→ `appendTitle` 返回 false 时 1.2s×4 重试。不钉（Desktop 对全新 sid 无缓存可回冲）；前缀幂等（对已带 Fork- 的源再分支不叠加）。顺带重构：改名路由的"补换行边界再追加"逻辑提取为 `adapter.appendTitle(id, title)`，rename 路由与 fork 命名共用（sessops e2e 对真实服务端验证该链路）。纯后端，无版本 bump，需重启 bridge。

## v40c — 重命名还原（第二幕）：boot 重放误杀钉（2026-10-27）

- 症状：用户已关闭全部桌面客户端，改名 main-chat 后 bridge 重启（部署 v40b），标题又被还原；且 `renames.json` 变回 `{}`。
- 取证：转录 raw 行显示回冲 bundle（last-prompt/cost-state/queue-operation/custom-title）**带本会话自己的 sessionId**、落在 bridge 拉起的 resume turn 期间 → 写入者是 CLI resume 进程本身（关桌面客户端无效）；回冲值恒为 1149477e 的自动标题（跨会话串值）。
- 根因：fence 的 `disarm` 分支不看行的新旧。**boot 全量重放**（`_ensureSession` 的 backfill drain / `readTranscript`）会重放历史里所有 custom-title 行——只要存在一条既 ≠ pin.title 又 ≠ pin.prev 的旧行（本例是前一天的测试值 "new"，L18515），重放就误判"真·新改名"→ 解除钉并写盘 → 随后两条回冲行不再受拦，标题还原。16:49 的钉就是这样死于 16:54 的启动重放。
- 修复：`_applyLine` 增加 `live` 形参（`_drain` 传 `emitAppends`，backfill/readTranscript 为 false）。**钉只能被活流新到的行解除**（桌面端真改名必然发生在钉建立之后）；历史行里的未知值一律视为过期——不但不解钉，还强制 `patch.title = pin.title`（历史无权重过钉）。测试：test/unit/adapter.test.mjs（4 例：历史不解钉+不夺标题 / 历史过期值吞掉 / 活流真改名解钉 / 活流过期值吞掉）。
- 恢复现场：写入 pin + 追加一条 main-chat custom-title 行（Title 用户的最后一次改名意图），重启后 fence 重建标题。
- 教训：**凡是"持久化状态 + 全量重放"的设计，重放路径必须与活流路径在状态变更权限上有所区分**——判定函数（fenceTitle 纯函数）没错，错在调用侧没把"这行是新到的还是重放的"传进去。

## 2026-10-27 · v41c 僵尸分组：探针边车泄漏 + cwd 收割面太窄

用户报列表出现"D--dev-workspaces-claude-remote"分组（无路径、无 ➕）。取证链：live API 找到无 cwd 记录 38f95cbf（7 行、标题 (loading)）→ 转录内容全是 `mode`/`permission-mode`/`system local_command`(isSidechain)/`cost-state`——**没有任何对话行**。定性：ctxprobe 在 `-p` 模式跑 `/context` 的边车转录；归档代码原在**成功路径内**（parseContextReport 通过后才 archiveSession），探针失败（超时/中转抖动）→ reject 跳过归档 → 边车永久泄漏。为什么显示成 slug：解析器只在 user 行取 `obj.cwd`，纯边车没有 user 行 → 记录无 cwd → 分组键退回 `s.project`（工作区 slug）。双修：① archiveSession 挪到解析判定之前（sessionId 在行扫描阶段已拿到，成败都归档）；② parser 的 cwd 收割上提到 applyLine 开头——**任意行类型带 cwd 都入账**（system/local_command 本来就带）。测试：parsers 增"边车形状"单测（无 user 行也能收割 cwd）。顺带清了两只僵尸（38f95cbf 边车 + dd864ceb 前天的权限测试会话，均走 DELETE API 进 trash）。教训：**"用完即删"的资源，清理必须挂在成败都会经过的路径上**；分组/显示的兜底路径（slug fallback）会让"数据缺失"伪装成"新分组"，排查时先看记录字段而不是猜前端。

## 2026-10-27 · v41/v42/v43 组头 ➕、输入区微调、列表搜索+批量管理

三批 UI 迭代。**v41**：项目组头右侧 ➕（span role=button——组头是真 `<button>`，嵌套 button 会被 fragment 解析器拆掉；stopPropagation 防误触折叠；Enter/Space 键盘可达）→ `openNewModal(presetCwd)` 预选项目目录（onclick= 直接赋值会传入 event 对象——新参数必须做 `typeof !== 'string'` 守卫）。**v42**：模型 chip 色阶 `--faint`→`--dim`（与附件图标一致）；队列插队 ▶ 13→18px（CSS 覆盖 svg 属性）。**v43**：列表搜索（`visibleSessions()` 本地过滤：标题/cwd/slug/id，命中平铺+最新序，无命中空态；输入行与批量共用同一过滤函数——先搜索缩小范围再全选）+ 批量管理（header 管理钮 → `state.batchMode/batchSel` → 行首圆圈勾选、点行=切换（不开会话、不渲染 ⋯）、底部栏 全选/清空 + 计数 + 删除 + 完成；删除逐个走 DELETE API，409 busy 跳过并 toast 报数）。e2e list 场景累计新增 14 条断言。全部纯前端 + pairing BUILD bump；组头 ➕ 与批量删除均无需后端改动（复用既有接口）。

## v44（2026-10-27）审批 diff / 会话白名单 / 历史分页 / 导出 MD

- P0/P1 评审定案：1 锁屏通知不做、3 /compact 不做；2B（审批 diff 统计+点击展开）、4A（历史分页 pill+顶部下拉双触发）、5A（会话级白名单审批卡勾选）、7A（导出范围确认层）落地；6（改动文件总览）改落点到任务完成总结卡片，三案新稿待拍板（design-drafts.html P1-6R）。
- 审批 diff 全程 createElement/textContent，innerHTML 仅用于清空容器——卡片展示的是模型生成的文件内容，字符串拼 HTML 是自带 XSS 的路。
- 分页 pill 挂 #detail 直下而非 #chat 首子：renderTail 不变量（chat 子节点与 turns 一一对应）会把多出来的节点数进去，尾部渲染错位；前插后 scrollTop += scrollHeight 差值保视口锚定（#chat 本就 overflow-anchor:none）。
- parseOlderTurns 刻意不复用 applyEventToTurns：活流路径带乐观折叠和 expectQueuedUser/userCollapsedLive 旗标写入，历史重放碰旗标会污染活流状态；两路共用抽出的 newBotTurn/addAssistantPart/pairToolResults/sysMarkerTurn 纯构造器。
- 白名单放 wshub 内存 Map、不落盘：会话级信任应随 bridge 生命周期过期，落盘会退化成永久放行。
- 导出走 blob + a[download]，Content-Disposition 只作 hint：PWA webview 对 attachment 头处理不可靠。

## v45（2026-10-27）总结卡内改动文件汇总

- 用户拍板 P1-6R：默认 6C（一行折叠「改动 N 个文件 +a −d ▾」），展开即 6B（每文件 ± 行数明细，行点击=产物预览）；评审页 design-drafts.html 随拍板删除（未入库）。
- 纯前端聚合（fileChanges 纯函数，turns.test.mjs 有单测）：转录 tool_use 输入已含 file_path/old/new，不需要 bridge 按 run 聚合——少一个 API、少一份 run 边界状态机。
- 路径身份按 lower() 合并（Windows 大小写不敏感），显示名取最后一次拼写；Write 全记增（旧内容行数从输入不可知）。
- 展开体 >12 文件截断报「还有 N 个」——刻意不进 markCapped 体系：限高纪律只认 .think/.tool-chip/.tool-out，新元素硬挂 overflow:max-height 会造手势死区，平铺截断行永不长出滚动器。
- timeline fixture 追加 Edit 第二轮，e2e 断言 fsum 汇总行与文件名（badges 串相应扩为五节）。

## v46（2026-10-27）历史加载行改版 + 分页切轮缝合

- 用户反馈三连：①悬浮 pill 存在感太强 → 改 header 下加载行，滚到顶（≤48px）才 height/opacity 过渡展开、离开收起；show/hide 只改变 #chat 高度，scrollTop 数值不动，阈值判定单调不振荡。②确认 400 条展示切片自初始提交 e009630 就有（v44 未改）——以前超出部分不可见，分页入口让它第一次可见。③分页切在轮中间会把同一段对话拆成两个「过程」胶囊。
- 缝合：older 尾 bot 与当前首 bot 相邻 ⟺ 切点落在一轮 assistant 流中间（user 会以 role:'user' 出现在任一侧，stop/sys 都不建 turn）→ mergeBotTurns 拼接（桶+steps concat，ts 取早）；frag 末尾携带合并节点，insertBefore 后删除右移一位的旧首子节点——DOM/turns 仍 1:1，renderTail 无感。
- 跨页配对：切点恰在 tool_use 与 tool_result 之间时 res 先到，进 state.orphanToolRes（上限 1000 防御），prepend 后 drainOrphanRes 按 id 回填；pairToolResults 顺势改 per-item 独立搜索——原「配到即停」语义会遗弃同批后续 item。
- e2e 新增 paged 场景（140 轮 fixture）：首屏 266 turns、滚顶出加载行（带剩余计数）、点击后 280、排空收起、最老轮在顶。

## v47（2026-10-27）历史加载行方案A（拍板：极简融入）

- 用户嫌 v46 加载行「背景色与过渡突兀」。ui-ux-pro-max skill 数据定位两病根：①双向同曲线同时长（数据条目：进场 ease-out / 离场加速；「一个时长抄所有过渡」是反模式）；②height 做动画主角且整宽色块压下像弹窗。评审页 design-histbar.html 四稿可交互演示（A 纯文字 / B hairline 生长 / C 弹簧胶囊 / D raise 材质），拍板 A。
- 实现：无底色纯 dim 文字 38px 槽位；进场槽位 height/opacity/margin 走 ease-out（.3s cubic-bezier(.22,1,.36,1)）+ 内层 .in span translateY(-9px)→0 滑落（opacity 延迟 .05s）；离场一律加速收走（height .18s ease-in / opacity .13s）——不对称时序。文字位移走 transform；transform 挂内层 span 而非按钮自身（transform 建 stacking context 会盖过 header 底边），detail.js 文案改写 firstElementChild 防 span 被 textContent 清掉。prefers-reduced-motion 降为瞬时。
- 纯样式改版，机制（≤48px 显隐、切轮缝合、孤儿配对）未动；三处 bump v47，评审页随拍板删除（未入库）。

## v48（2026-10-28）费用/统计面板（方案 C 拍板落地）

- 入口裁定：header 现有费用文本本身即入口（不新增 chip），感知用 M2+M1 组合——珊瑚着色 + 虚线下划的静态可供性，数值变化瞬间 pulse（scale+提亮，动态教学）。面板从 header 下方落下（.overlay.top + topIn ease-out 0.3s）；cost-sheet 收编进 BUBBLES（scrim 点击/系统 back/气泡互斥全复用）。
- 「直接获取单价」实测否决：官方无价格 API（/v1/models 不含价格字段，本机可连通但不给价）；社区 LiteLLM 价目表 raw.githubusercontent 直连超时；ntfy.sh 亦不通。→ 零价表设计：官方口径 = cost-state 原值；倍率（预填 0.07 = DeepSeek V3.2 价目对 Sonnet 官方价的用量加权比，缓存读为主的真实结构：48k in/12.6k out/892k 缓存读/31k 缓存写 → 官方 $0.72 vs DeepSeek $0.052）；自定义单价 = 分模型 4 价（输入/输出/缓存读/缓存写）。价格偏好存 localStorage（cr_cost_mode/cr_cost_mult/cr_cost_prices）——显示偏好不进 bridge、多设备独立。
- 分模型账目：cost-state 的 modelUsage 本来就按模型分账，parsers 原先求和丢弃——v48 留存 models map 随 mergedSessions 下发（mergedSessions 展开 {...s} 自动携带）。面板「分模型」段仅多模型会话出现（单模型零噪音）；自定义单价编辑器按会话模型自动列块 + 默认行兜底（按模型 id 记忆跨会话共用）。模型切换各归各账，不靠估算。
- 体积构成条与次数行纯前端现算（compOfTurns：工具=tool_use 输入 JSON+输出文本字符，思考=think 字符，对话=user+text 字符；口径=字符占比非 token，UI 有标注）。
- detail↔ctxring 新增一条函数级循环 import（refreshCostUI→renderMeta vs renderMeta→openCostPanel/costDisplay），同 composer↔detail 安全模式（求值期零交叉）。cost.test.mjs 入库：stub 元素必须带 dataset——ctxring→detail→composer 链会让 composer 在模块评估期跑 setPerm 写 dataset。
- README Backlog 大扫除：审批 diff/历史分页（v44）、always-allow（v44）、改动文件总览（v45）、导出 MD（v44）、费用面板（v48）勾掉；锁屏通知与手动 /compact 标记已裁定不做（2026-10-28）。

## v51（2026-10-28）window.confirm 全量替换为应用内确认弹窗

- 用户裁定：系统 alert/confirm 弹窗不符合 app UI 规范。清点=7 处 window.confirm（队列清空/▶插队、handoff 409 双问、批量删除、列表删除、详情删除），无原生 alert。skill 数据核对：破坏性操作前确认=正确模式（保留确认、只换皮）、成功反馈勿静默（已有 toast）。
- 组件 `showConfirm({title,body,ok,danger,onOk,onCancel})`（overlays.js）：沿用底部 sheet 模态语言（rename/new-modal 同款 grammar——弹层=气泡、模态=全宽 sheet 的既有分工不动）；危险确认=红实底主钮（`.btn.danger`，--err）、普通确认（仍然发送/切换驱动）=珊瑚主钮；**焦点落安全侧**（danger 时 focus 取消钮，Enter=取消；非 danger focus 确认钮）；Escape/scrim/取消三路关闭；aria dialog/labelled。markup 挂 body 级（列表页与详情页都要用，同 new-modal 先例）。
- 调用点改回调式：list.batchDelete/app.deleteSession 拆两函数（confirm→runBatchDelete/doDeleteSession）；composer handoff 双问的取消路径接 onCancel:fail()（原先 else fail() 语义不变）。
- e2e：sessops/list 删除段改为断言 confirm-modal 出现+点 #cf-ok（原先靠 harness 代答原生 dialog）；harness 的 javascriptDialogOpening 处理保留作兜底。**教训：bash heredoc 里嵌 JS 模板字面量（反引号+${}）会被吃——补丁走临时 .py 文件执行后删除。**

## v54（2026-10-28）历史加载行改跟手渐显

- 用户提出：显示/隐藏能否跟随滚动手势渐变。原 v46/v47 为「≤48px 阈值 + CSS 过渡」二值切换。
- 实现：updateHistoryPill 每 scroll 事件按 f=clamp((64−scrollTop)/64) 直接写行高/opacity/margin/内字位移（setHistRow；.in 的 translateY(-9px) 滑落保留为 f 驱动）；**CSS transition 全删**——过渡会让行高滞后手指一个时长，1:1 跟随感即失效。RAMP 48→64（连续映射下可放宽，手感更顺）。
- 无振荡论证升级：行在 #chat 外，行高只缩 #chat 盒高、永不改其 scrollTop——连续映射单调性由构造保证（原阈值法的论证是它的特例）。
- 加载中钉满 38px（反馈不变）；排空即 0；.show 语义收窄为 f>0.1 时开 pointer-events。行左右 margin 12→14 对齐 v53 页面网格。paged e2e 加中段断言（scrollTop=32 → 计算高 1~37px 之间，证 1:1）。

## v55（2026-10-28）权限钮两态区分 + 文案

- 用户反馈：选「需要审批」后按钮的文本颜色和图标需要换；文案「需要时手机审批」→「需要时审批」。
- 根因：auto=珊瑚 #E8926F、ask=琥珀 #D9A262——色相明度近似（肉眼难分），且两态共用同一枚盾牌图标，区分全靠「自动/审批」两个字的差异。
- v55 双通道区分：auto 回落 .cbtn 基础中性色（与附件/圆环/模型钮统一；珊瑚纪律只留活态）+ 盾牌；ask=琥珀 + **问号圆圈图标**（svg.q/shield 按 data-v 显隐切换）。色觉障碍下图标仍可分。
- 文案 4 处统一（toggle title、perm-sheet 选项、new-modal seg）。

## v56（2026-10-28）v55 修正：权限钮高亮归属

- 用户裁定 v55 搞反了：**自动执行=高亮态**（珊瑚+盾牌，默认态就该亮着），需要审批=琥珀+问号（警示但非主态）。v55 原意「默认态用中性色省注意力」与用户语义相反——这里的高亮语义是「当前档位激活」而非「需要注意力」，撤回。

## v57（2026-10-28）v56 微调：审批态去高亮

- 用户裁定：审批态不要高亮（琥珀也撤）——高亮只属于自动执行档。审批态=中性 dim + 问号图标，状态差异全由图标承载（盾=珊瑚高亮默认，问号=静默非默认）。

## v58（2026-10-28）审批卡 Bash 命令直读 + 口径文案澄清

- 用户截图：Bash 审批卡显示 JSON 转义汤（heredoc 的真实换行全成字面 反斜杠+n）。根因：v44 分工里非 Edit 类一律 JSON.stringify(input,null,2)——JSON 字符串转义对 command 类多行文本不可读。v58：input.command 为字符串时直读命令原文（真实换行，pre-wrap 滚动盒，2000 字上限），其余未知工具仍 JSON 兜底。
- 用户追问「官方价格是 CC 传过来的吗」→ 是（CC 内置价表算好随 cost-state 传回，项目零价表）；两处 sheet-note 文案按此改写（谁算的、怎么来的讲明）。

## v59（2026-10-28）跳最新按钮居中 + 贴合输入栏

- 用户要求：fab 水平居中、与输入框边距减半。静态 136px 改为 JS 锚定 composer 实时 top +12px（rect 为视口坐标，safe-area 自动随行）；queue/attach/fork 行撑高 dock 时由 ResizeObserver 跟随重算——静态魔数在 dock 长高时本来就会重叠。水平居中用 left/right:0 + margin auto（不用 transform，避免与 :active scale 打架）。

## v60（2026-10-28）跳最新按钮对比度补偿

- 用户反馈 v59 居中后按钮不明显。查证颜色未改（raise+sh-2 与历史一致）——变淡是视错觉：右缘时衬纯 --bg 暗底，居中后悬于 panel2 卡片/文字上方，同色对比塌了。补偿：表面 color-mix raise 82%+fg 提亮一档，阴影 sh-2→sh-3（纪律：不加边框，全靠阴影分层）。

## v62（2026-10-28）runner 注入 Git PATH——手机会话 Bash 工具失踪根因修复

- 症状：桥重启（经 wscript 链）后，所有手机驱动会话（含新会话）的 Bash 工具消失（「source removed or disconnected」），Read/Edit 等正常；用户自测新会话同样缺失。
- 根因链（全部实证）：CC 的 BashTool 在 Windows 上要能发现 Git Bash——`~/.claude/debug/*.txt` 明写「Git Bash not found; BashTool will be unavailable」。本机 Git 是 hermes 用户级安装（`%LOCALAPPDATA%\hermes\git\bin\bash.exe`），不在 Program Files（CLI 标准位置探测不到），全靠启动上下文的 PATH 携带。桥从终端手动启动（hermes PATH 在）时一切正常；经精简上下文（wscript 链/开机自启）重启后 PATH 无 Git → 之后 spawn 的每个 claude 进程都装不上 BashTool。10-24 起两份 debug 日志证明 hosted 会话一直就是这个状态。
- 修复：platform.js 新增 `findGitRoot()`（hermes current → hermes tools/git-* → Program Files×2 依次探测 bin/bash.exe，结果缓存）+ `bashToolEnv(baseEnv)` 返回「git cmd/bin 前置后的完整 PATH」；runner spawn env 末位合入——桥无论从什么上下文启动，子会话 Bash 必落座。POSIX 返回 {}（bash 常在）。
- 附带建议（用户侧、可选）：hosted 会话（Claude-3p 直接驱动）要 Bash 同理需客户端上下文带 Git PATH，或把 hermes git 目录加进系统 PATH。

## v61（2026-10-28，另一会话产出、本会话审查后入库）跨平台收敛：lib/platform.js

- OS 差异收敛到 `bridge/lib/platform.js` 单一归属（IS_WIN / CI_PATHS / findClaudeBinary / hookCmdPath / installAutostart / autostartInstalled），其余模块不得分支 process.platform（已 grep 验证干净）。Windows 逻辑 verbatim 搬迁；POSIX 为附加分支：CLI 发现 `~/.local/bin/claude`、hook 走 `hook-post.sh`（curl 直 POST，对应 PowerShell `@-` 破 curl 的坑）、autostart 明确未实现（面板报 not installed）。
- CI_PATHS = 非 linux 大小写不敏感（NTFS/APFS）：preview 前缀守卫两侧同 ci()；md.js 的 ART_PATH_RE 增补 `/`-根 POSIX 绝对路径链接化（lookbehind 守卫保留）。
- runner.resolveClaude → findClaudeBinary（claudePath 配置语义保留：override 存在则用，失效静默落回自动发现）。ask 分支新增旗标 `--permission-prompts host`（审查标记：2.1.308 行为未实测，需 ask 实跑验证一次）。
- ⚠ hook-post.sh 需可执行位（Windows 无法 chmod）：入库时 `git update-index --chmod=+x bridge/hook-post.sh`；POSIX 裸 checkout 若丢位则手动 chmod。
- 剩余：cr.mjs（PC CLI 仍 .ps1）、Linux fs.watch 实测、POSIX 实机验证。


## v63（2026-10-28）新会话创建过渡态 + 项目更名 claude-web

- 用户反馈：新建会话点「开始」后弹窗即关、等 spawn/init 的 1~5 秒页面零反馈。v63：POST 成功后**弹窗保持打开转「创建中」态**——开始钮 spinner（线性旋转）+ 禁双击、取消钮同步禁用；run 帧采纳 sessionId 时才关弹窗进详情（app.js 两处：成功关/失败解锁）；30 秒兜底超时防 run 帧丢失锁死弹窗；openNewModal 每次开先 setNewPending(false) 复位。
- 更名 claude-remote → claude-web：可见面全部换（PWA title/品牌字/manifest、package.json、README H1+示例、SECURITY、CLAUDE.md 标题）。**文件夹有意不改名**——settings.json hooks 命令、开机自启 vbs 绝对路径、转录 slug（D--dev-workspaces-claude-remote）分组连续性、LOCAL.md 都锚在旧路径上，改名需要一次协调迁移，待用户另行拍板。


## v64（2026-10-28）新会话三连修（创建提示按用户裁定改版 / 首条不上屏竞态 / 标题截断）

- 实测复现（真桥 curl 建会话）：新会话从 POST 到转录第一行耗时 **3 分 24 秒**（CLI 冷启动静默期——写 queue-operation 前毫无输出；期间无 sessionId、无 events、无标题），这就是等待感的本体；后续跟进（resume）无此静默。冷启动慢因未深查（疑与中转无外网、CLI 启动期联网检查超时有关），记档待查。
- 创建提示 v63 方案（弹窗保持+按钮 spinner）废弃，按用户裁定改：**点开始弹窗即关，悬浮胶囊提示「正在创建会话…」**（居中 38%、pointer-events none 不挡交互；采纳/失败/30s 丢帧兜底三路关闭）；POST 期间按钮短暂禁用防双击。
- 首条输入不上屏 = 竞态：转录 user 行与 adoption run 帧几乎同毫秒落盘，首屏 events 拉取可能扑空、append 广播又可能抢在 subscribe 前。修法复用乐观机制：submitNewSession 存 `state.pendingNewText`，openDetail 首屏无 user turn 时 `pushOptimisticUser` 种泡，真实事件到达由同文折叠原地确认（v20/v37 幂等语义，双发 dedupe 依旧成立）。
- 标题 fallback：首条 human 文本 slice(0,48) → **首行 + 24 字硬上限 + 省略号**（多行只取首行）；单测同步改写。


## v65（2026-10-28）新会话乐观进页（用户裁定，取代 v64 悬浮胶囊）

- 用户裁定：点创建**直接切到会话页乐观上屏**，与普通发送的乐观机制同构——悬浮胶囊废弃删除。
- 架构：sessionId 在 CLI 写 init 行前不存在（冷启动 3 分 24 秒实测），详情页一切接口都挂 id → **无 id 乐观进页 + adoption 原地重绑**：openDetailProvisional 切页+种乐观泡+标题取首行 24 截断（客户端镜像 v64 桥侧规则）+meta「创建中…」；run 帧到达走普通 openDetail（fetch 重建 chat + v64 种子同 tick 重现气泡，无闪烁）。
- 守卫：provisional 期间 sendMessage 拦截并提示「会话创建中」；失败/30s 超时若还在乐观页则 closeDetail 回列表（pendingNewText 保留→adoption 自动开真实会话）；openDetail/closeDetail 显式清 provisional 旗标。
- composer↔detail 循环 import 新增两符号（openDetailProvisional/closeDetail），仍求值期零交叉。


## v66（2026-10-28）乐观泡永久灰态补丁（v65 残留竞态）

- 症状：乐观上屏后气泡一直半透明灰，结果都返回了也不转实。根因：转实靠同文折叠（append 事件），但转录 user 行的 append 广播可能早于 adoption 后的 subscribe（v65 无 id 乐观页期间根本没订阅），首屏 fetch 又可能扑空——种子泡没有任何事件能确认它。
- 修法：种泡后 3 秒 reconcileFirstPage 一次性重拉首页——盘上有 user 事件则整体重建（真实实心 turn 替换种子）；折叠已确认或盘上仍无则 no-op。atBottom 捕获防滚动跳变。


## v67（2026-10-28）乐观泡菊花 loading

- 用户要求：转实等待期在气泡前面加菊花样式 loading（明确不要圆环转动）。实现：12 棒菊花（2×6px 棒，rotate k*30° + animationDelay -1+k/12s 的线性渐隐扫动），挂在 .u-line 弹性行上、气泡左侧；棒元素 JS 现造（CSS 只写基础规则，避免 12 条 nth-child）。
- 不变量安全：菊花在 turn 元素内部，renderTail 1:1 不受影响；折叠确认/v66 对账把 pending 样式与菊花一并摘除。prefers-reduced-motion 降为静态均匀淡棒。


## v72（2026-10-29）排队消息派发即乐观上屏

- 用户反馈：排队任务开始执行时直接以转实状态上屏（v37 设计即如此——排队不发乐观泡，等派发落盘）。按裁定改为：queue-dispatched 帧到达即 pushOptimisticUser(d.text)（含菊花），真实 user 行落地由同文折叠原地转实；expectQueuedUser 旗标保留兜底（乐观 push 失败时仍走推新泡路径）。
- 桥侧：queued-dispatch 广播补发 text 字段（原转发丢弃）。30s 兜底 retract（retract 对已确认泡是 no-op，天然安全）。
