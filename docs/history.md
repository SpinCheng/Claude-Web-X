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

## 2026-10-26 · 公开化整改

隐私扫描清除三处（vbs 写死管理员路径/中转商端点/绝对路径）→ LOCAL.md 承接本机事实；自启 vbs 改"仓库自定位模板 + pairing 现场生成绝对路径版"双职责；补 LICENSE/SECURITY/CONTRIBUTING/.gitattributes/.editorconfig/CI；phase0 → docs/phase0。运行环境表修正：桌面客户端不是依赖（bridge 从不与桌面 App 通信），CLI 才是（版本强关联，README 有对照清单）。
