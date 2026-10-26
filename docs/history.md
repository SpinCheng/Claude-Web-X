# 版本演进与调试史（症状 → 根因）

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



## 2026-10-26 · 时间轴交错 + 工具产出 v22

用户报两个问题：① 输出节点全堆在轮次末尾——渲染按类型分桶（think 全部→tools 全部→texts 全部）而非真实顺序；② 工具产出（图片/文本）完全不可见——tool_result 只被拿去算上下文估算后丢弃。修复：轮次加 `steps[]` 交错序列作渲染源（桶保留兼容）；tool_use 带 id，`toolres` 事件按 id 配对回填 `tool.out`（文本 ≤4KB、图片 ≤4 张内联+灯箱、`.tool-out` 入 markCapped）。

关键发现：**2.1.308 本地工具的 tool_result 行 origin 为 null**（MCP 结果才有 origin.kind），原来只认 `origin.kind!=='human'` 的人机门把这些结果全漏了——判定改为按内容含 tool_result 块。测试侧：中转环境下 Bash 被关在 ToolSearch 后面（提示词逼不出），改用合成转录（手写 tool_use/tool_result JSONL 放进监听目录）做确定性断言，[工具→结论] 顺序 + echo 输出全链路 PASS。



## 2026-10-26 · 公开化整改

隐私扫描清除三处（vbs 写死管理员路径/中转商端点/绝对路径）→ LOCAL.md 承接本机事实；自启 vbs 改"仓库自定位模板 + pairing 现场生成绝对路径版"双职责；补 LICENSE/SECURITY/CONTRIBUTING/.gitattributes/.editorconfig/CI；phase0 → docs/phase0。运行环境表修正：桌面客户端不是依赖（bridge 从不与桌面 App 通信），CLI 才是（版本强关联，README 有对照清单）。
