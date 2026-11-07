# CLAUDE.md — claude-web 工程手册

用手机（PWA）远程查看并操控本机 Claude Code 会话（LAN bridge + 免构建 PWA）。

> **手册纪律**：本文件只收录跨文件硬约束与固化事实，每次会话整体载入，保持精炼。机制细节住在所属模块的文件头注释（改哪个文件先读它），此处不重复。不写版本号、翻车叙事、时间线——那些进本地 `docs/history.md`（gitignored）。新裁定先蒸馏成一行规则再落笔；条目过时随手删除。

## 架构

- README「架构与消息流」双 mermaid 图 + 目录树。后端 `bridge/`：`server.js` 组装根 + `lib/`（router/wshub/auth/mime/models/**platform**=OS 差异单点，勿在其他模块分支 process.platform）+ `routes/` + `parsers-cc.js`（转录行判定纯函数，有单测）。前端 `public/` 免构建 vanilla JS：`app.js` 组装根（boot/gate/路由/WS 帧语义）→ `js/` + `js/views/`。函数级循环 import（求值期零交叉）：composer↔detail、list↔sessops、detail↔ctxring、transcript↔agentview。**滚动三律与 renderTail 不变量在 transcript.js 文件头**。
- 本机细节：`LOCAL.md`；调试时间线：`docs/history.md`（均 gitignored）。docs 里只有 `screenshots/`（README 截图）入库；设计稿（`docs/design/`、`docs/mockup-*`）与方案文档不入库。
- 测试：`npm test` = 125 单测（parsers/turns/adapter/cost/commands/agents/titlegen/runner/md/archives）+ 14 e2e（隔离桥 :3799 + 合成转录 + headless Edge CDP）。fixture 勿走 bash 内联（反斜杠被吃）；harness 的 api() 头必须合并非替换；harness 停桥必须 `closeAllConnections()` + 等 close 回调——server.close() 不等 keep-alive 排空，Windows 允许双绑 :3799 → 新旧桥竞态应答。场景只经 run-all 跑（结尾显式 process.exit）——单场景直跑会因残留句柄不退出（历史如此，勿误判为新回归）；预览类断言先断 `#html-prev`/`#lightbox` 容器（默认 hidden），**勿断 `#hp-frame`**（静态 HTML 无 hidden，异步 fetch 未完成即假通过——已三次踩中）。

## 快速开始

```powershell
cd claude-web
npm install
npm start          # node bridge/index.js，端口 3742
```

手机浏览器打开启动日志里的 URL 输 token；PC 端接管 `node cli/cr.mjs list` → `attach <序号>`（跨平台）；配对面板 `http://localhost:3742/pair`（API 仅同机）可装开机自启（EADDRINUSE 双开保护）。config（`bridge/data/config.json`，gitignored）键：`token`/`port`/`claudePath`/`defaultCwd`/`yolo`/`titleGen`/`notify.ntfyTopic`。

## 运行机制（跨文件硬规则）

- **消息链路**：`POST /api/sessions/:id/message` → handoff 仲裁 → runner spawn `claude --resume -p --output-format stream-json --verbose`（完成即退，无驻留）。转录实时更新走 adapter 的 fs.watch；run 帧只管生命周期（新会话 id 取自 init 行）。
- **handoff 仲裁**：转录 8s 内新写入 → 409 `recent-local-write`；PC 持有 claim（cr attach）→ 409 `pc-claim`；自己的活 run 在跑时跳过 mtime 仲裁（语义细节在 handoff.js）。
- **runner**：perm=ask 走 `--permission-prompt-tool` + 内联 `--mcp-config`（approve-mcp.mjs 回调手机审批卡，3 分钟超时自动拒）；yolo（默认）加 `--dangerously-skip-permissions`，**Linux root/sudo + yolo 在 spawn 前直接拒绝**（CLI 硬拒，提前给手机明确报错；root+ask 合法）；`--model`/`--effort` 直传。spawn env 前置探测 git 目录——**Windows BashTool 靠发现 Git Bash 落座**，桥从精简上下文启动会丢 PATH → 手机会话全缺 Bash；settingsEnv 按 mtime 缓存（settings.json 后补/后改自动生效，无需重启桥）；纯文本 run spawn 后立即 `stdin.end()`（CLI 对保持打开的 stdin 白等 3s；**仅 stream-json 图片形态必须保持打开**）。队列/并发参数见 runner.js。PWA 选择持久化：`cr_model`(+label)/`cr_effort`/`cr_perm`。
- **附件**：图片走 `--input-format stream-json` stdin 图片块（**stdin 写完必须保持打开**，立即 close 挂死 CLI）；文本类 ≤24KB 内联进 prompt；输入框 **Ctrl+V 粘贴文件=走附件管线**（v145，截图/资源管理器复制直传）；CLI 图片占位符两代都在解析层处理：`[Image: source]` 旧式独立行=折叠；2.1.308 `[Image: original WxH, displayed at WxH. Multiply coordinates…]` **纯标记独立行**=tool_result 图片的合成回显（模型自己 Read 图片也产生）折叠，**内嵌式（人类消息）逐字原样显示——v190 用户裁定：我的输入是文本，绝不剥离/改写/占位符化**；乐观孪生去重走标记不敏感比较（`sameUserText`，折叠时采纳转录原文保持重放一致）。正则锚定完整机器格式防引文误伤。
- **@ 远程引用（v192，v197 chip 化）**：数据面=`GET /api/sessions/:id/files`（git ls-files 全索引一次下发、客户端过滤 v109 先例；非 git 退 readdir 首层；白名单 `bridge/data/file-index-include` **逐行 `--exclude=` 直传——实测 `--exclude-from` 否定压不过 .gitignore，勿回退**）；发送代附=message 路由词边界扫 @token（prose 标点截断，前端 atDetect 是同语义镜像）→cwd 守卫→文本 ≤24KB 内联/图片 ≤2MB stdin/其余降级纯路径，上限 4、原文逐字不动（细节在 lib/fileindex.js 文件头）。前端 @ 气泡=cmd-menu 直系方案 A；**选中=v197 用户裁定固定 dock 标签（`#at-chips`，/ 命令 chip 同款：✕ 删除、发送即消费、失败路径恢复；旧「不做 chip」裁定作废）**——发送时前置组合 `/名 @ref 正文`；文件树 insertRef 同一标签语义；**选中呈现=v214 行卡（`.at-ref`：icon+文件名亮/路径灰双行，dock 带 ✕、气泡卡点=预览；手输 @path 同套卡）——替换旧珊瑚长胶囊；三处同构：dock 标签/气泡引用/（折叠行已移除——卡即承载引用信息）**；ftFileIcon 从 filetree.js 导出共享（transcript→filetree→composer 循环，求值期零交叉；测试桩需 dataset）；手输 @path 不经标签照常代附；**无命中=收起菜单不出空态列表（v198 用户裁定，/ 菜单同款——文本照常原文发送）**。**回显折叠（v197）**：runner 代附内联块标签 `[引用 @path]`（上传附件维持 `[附件 name]`），CLI 把整段 prompt 原样写进 user 行——解析层以**首个 `\n\n[引用 @`/`\n\n[附件 ` 词法切分**：标记前文本（含 @ 标签，乐观孪生因此仍精确匹配）=气泡、其后=机器附录折叠成 `k:'attref'` 标记行（sysline 渲染「已随消息附上 N 份」）；正文撞上完整机器格式≈主动伪造（v145 先例），勿加武装/解除机制。
- **项目文件树（v194/v195）**：手机=右缘遮挡抽屉 82vw+轻 scrim 挂 `#detail`（cwd=会话项目，切会话 resetFileTree 跟随重建；**不动 history**、收起即销毁；**v207 右缘拖拽收起**：6px 起步竖直判定让行树滚、跟手 translateX、松手 >1/3 宽或 >0.45px/ms 甩即收否则回弹——touchmove 用 window 级 non-passive 监听+cancelable preventDefault，closeFileTree 清内联 transform；宽屏面板形态不参与）；PC=第三栏 242px（`body.wide` 下 ft-drawer 转 static 列、scrim 隐；localStorage `cr_ft_panel` 记开关、**只由用户显式开关写入**；1024~1280 展开时左栏自动收窄 342→262）。数据面=`GET /api/sessions/:id/tree`：readdir 磁盘真相 + git **仅标注层**——tracked=纯 index（`trackedFileList`，**勿用 --others 混合索引**）、unt=porcelain `??` 折叠目录按前缀判定、ign=`check-ignore --stdin` 批查；「git 视角不筛 git」；**v200 全状态着色（VSCode 语系，状态即颜色）**：porcelain XY 码→`D>A>M` 优先级映射（del 红/mod 琥珀/add·unt 绿/ign 置灰，unt 角标同绿），**目录聚合取后代最强态**，**幽灵行**：已删除文件/目录磁盘上不存在→porcelain 注入虚拟行（整目录删除时 readdir 失败也照常服务幽灵子项；del 行禁预览/插入，点击提示走 git）；ftbar 带 `M/A/D` 彩色计数；状态与索引缓存同源 3s TTL（`clearIndexCache` 双清）。点文件=previewArtifact 管线全复用；⋯/右键（span role=button）=预览/插入 @（`composer.insertRef` 借力，v197 起加 dock 标签）/复制路径/复制文件名（**复制走 clipboard 竞速 1.2s+execCommand 兜底**——LAN HTTP 无 clipboard API，v206 翻车；row-actions 气泡壳复用）；护栏：单层 >500 截断、深度上限 12、目录计数=索引推得不触盘。
- **PC 双栏（v195，roadmap 13 定稿）**：≥1024px 两页同屏共挂——断点由 app.js `matchMedia` 单点驱动 `body.wide`（**CSS 只认类名，勿写重复媒体查询**）；`#detail-main` 包裹右栏主列（**窄屏 display:contents 零影响**，宽屏 flex:1 + position:relative 供 #act/#jump 钉内容列右缘）；左栏 `#list/#arch` 342px。history 语义：**宽屏切会话 replaceState 不 pushState**（栈不增长、back 不吃会话切换），#back 宽屏隐藏；popstate/删除/关闭的宽屏分支=右栏回空态（`updateDetailEmpty`，**provisional 不算空态**——新建任务落座前遮罩必须让位）而非隐藏。内容列 860px 居中（bar/背景不限宽）、气泡绝对上限 620/700；全宽模态与锚定气泡宽屏收窄 ≤620 居中；`syncSel` 左栏选中实时翻转；跨断点 resize **必恢复左栏常驻**（窄屏开会话/新建隐藏过 #list——v196 翻车：跨断点后详情全宽、composer 整窗居中）；Ctrl/Cmd+Enter 恒发送。**composer 窄屏=视口级 fixed（chat 用 paddingBottom 补偿），宽屏必须转锚 detail-main（absolute bottom）——fixed 包含块是整窗，860 列会按整窗居中脱离详情区（v196 翻车）**。focus-visible 基线只挂 button/[role=button]（**勿挂 input/textarea**——currentColor outline 在暖炭底=白边刺眼，v196 翻车）。#html-prev 维持 fixed 全屏覆盖双栏（by design）。**v199 精修**：①拖宽手柄 `.rg`（#rg-list 260-600 / #rg-ft 180-480，负 margin 叠栏不占布局宽；**z-index 10——ft-drawer 的 z9 在 flex 子元素 static 上照生效，z7 手柄曾被压住**；localStorage cr_list_w/cr_ft_w，窄屏必须清内联宽否则 .page 被压窄）；②wide 下主滚动器 `scrollbar-width:none`（滚轮/键盘不受影响，移动端 overlay 条不动）；③fab 28px、宽屏锚 detail-main 水平居中（left:50%+负 margin）；④文件树 ign **无文字标签只置灰**（unt 保留琥珀角标——两者同灰度不可分辨）；⑤树图标=**v201 真·文件树语系**：文件夹开/合双态（展开=开口文件夹，与旋箭头双表达）+ 文件按类型 5 族字形（代码`<>`/文档=页+行/配置`{}`/图片=相框/默认素页，`ftFileIcon` 单色不引入色相）；detail-bar 图标簇 -7px（1px 有效间距）对齐列表页。
- **标题**：截取自首条 user 文本（记录带 `titleFallback` 标记）。真标题=转录 `custom-title` 行：手动改名与 titlegen 自动标题**共用 `appendTitle`+`pinRename` 写入路径**（行尾无 `\n` 先补；不 bump lastActive；钉防 Desktop 回写）。**打开中的详情页标题实时更新走双路**：sessions 帧 → renderMeta（主）+ append `k:'title'` 事件直写 `d-title`（兜底，append 帧只达订阅者）。自动标题：手机新建会话首跑结束由 `titlegen.js` 一次性 `-p` 生成（机制见其文件头；cfg `titleGen`=false 关）。预览失败的 toast 按 HTTP 状态分类文案（403 目录外/404 不存在/413 过大/415 类型）。
- **write-fence**：改名钉只被**活流**（emitAppends=true 的 drain）解除；boot 重放/readTranscript 无权解钉或夺标题。
- **会话状态** = running（runner 内存）+ lastRun（桥重启即失）+ lastOutcome（转录 system 行推导，持久）。**所有 sessions 帧必须走 `mergedSessions()`**；它携带 `runId`（重载后仍可 cancel）。未注册非 GET 一律 405——新端点必须重启桥才加载。
- **等待横幅**：Notification hook **只认权限类**消息（"waiting for your input" 每轮必发且无清除时机，认了就常驻）；清除双路=该会话任何 append / Stop hook。
- **上下文探针**：按 (cwd, modelId) 缓存，跑一次性 `-p /context`；**归档在解析判定之前、成败都执行**。
- **列表交互**：行是真 `<button>`，内嵌交互元素必须用 span（嵌 button 会被 fragment 解析器提出去打碎布局）；右键有选区守卫；**列表行长按不选文本**（`.srow/.pgroup-head` user-select:none，输入框除外）。
- **归档（v185）**：纯视图过滤零文件操作（`bridge/data/archived.json`，pins 先例；mergedSessions 带 `archived` 标记）；主列表滤归档、**搜索照常覆盖**（中性「已归档」徽章）；归档页=独立 `.page` 复用 renderRow（history `#arch/N` 唯一条目先例）；**活跃反归档**：转录新 append 或手机发消息自动解除+toast；running 会话 ⋯ 不显示归档项；删除 drop 归档标记。
- **审批卡**：Edit/Write/MultiEdit/NotebookEdit 渲染 ±diff，其余 JSON；**必须 createElement/textContent 构建**（模型产物拼 HTML 即 XSS 面）；「本次会话始终允许」→ 内存 Map 按会话放行。
- **历史分页**：`readTranscript(limit, before)` → `{events,total}`；加载行 `#hist-more` **必须挂 #chat 外**（renderTail 1:1 不变量）；跟手渐显：f=clamp((64−scrollTop)/64) 直驱行高/透明度（**勿加 CSS transition**）；`parseOlderTurns` 纯重放（**勿复用 applyEventToTurns**）；跨页 toolres 先进 `state.orphanToolRes` 暂存、prepend 后回填。
- **确认弹窗**：禁 window.confirm/alert——一律 `showConfirm({title,body,ok,danger,onOk,onCancel})`（底部 sheet 模态；danger=红钮+焦点落取消侧）。
- **费用面板**：**零价表设计**（官方无价格 API）：官方口径=cost-state 原值 / 倍率 / 自定义分模型单价；价格偏好存 localStorage 不进桥。**时间轴不渲染成本快照行**（v145 裁定——"$x · in/out tok" 提醒已除；$ 数字只经 header 入口/面板，数据走 sessions 帧）。**结算输出速率（v191→v209）**：解析层按 assistant 行累加、按 `message.model` 分桶、随 cost-state `stats.rate` 下发（零新端点/帧）。**v209 去重（勿回退）**：同一条 API message 被 CLI 拆成多行（message.id 相同、每行重复整条 usage）——按 `message.id` 分组，out 只在组首计一次、间隔=基点（上一非 assistant 行 ts）→组末行 ts 收口（`commitRateGroup`，组边界链式推进基点防重叠）；无 id 行按单行组内联；无 ts/非正间隔整组跳过。**v213 补丁（勿回退）**：2.1.308 会把同一条 message 的后段 tool_use 写在该消息 **tool_result 之后**（7f1b929b 实证 127 个 id 非连续）——已提交组的同 id 迟到片段整行跳过（`_rateSeen` 有界表 >2048 清零），否则满额 out 与工具执行时长双双重复（Σout 曾虚高 30%、卡头反而低于分模型行）。展示=方案 D（v209 用户裁定）：费用面板全宽速率卡——卡头总均值大数字+计时/总量（**分子=v211 裁定走 cost-state outTok 与五格恒等，最近一轮不进速率；分母=解析层 Σms**），分模型相对速率横条（中性 raise 填充）、**最快模型数值珊瑚高亮（随 D 裁定的例外）**；单模型退化只有卡头；分模型行不再尾补 tok/s。**实时速率不做**（弹窗瞬态，裁定；真要做归宿=run-status 行）。**债会话认账不动（v213 裁定）**：跨配置时代的老会话 cost-state 账本有历史债——同模型多键并存（`[1m]`/`[1M]`/裸 id 时代漂移）、早年杀 run 少记甚至倒退（9c150709 实证官方账少 22%、卡头可低于分模型行）；**不修不改不特判**，面板数字即官方账口径，v213 后新会话干净（解析器行形态修复对古今一律有效）。
- **子代理直播**：adapter 递归 watcher 里 `subagents` 路径段**路由进 tracker、绝不进会话体系**（`_ensureSession` 双保险）；归属/完成信号/boot 重放机制见 agents.js 文件头。前端硬规则：帧到达=**就地 patch DOM，不碰 renderTail**（未渲染才走 renderTail）；一切时长=startedAt..finishedAt（**完成态冻结，勿用 Date.now() 滴答**）；`#agent-sheet` 全宽 sheet（v122 起非锚定气泡）复用主视图节点渲染。
- **活动悬浮件（v154）**：`#act` 挂 `#detail` **直接子节点**（v203 移出 detail-main——胶囊以整个详情页为定位基准 right:20px，窄屏 display:contents 本就穿透锚 #detail 行为等价；非 #chat 子节点——renderTail 1:1）；**非模态**（无遮罩、不拦会话交互），胶囊/面板两态互斥。待办板=桥侧状态机（parsers-cc `applyBoard`：Task* 增量+TodoWrite 全量；**真实枚举无 cancelled，deleted=移出板**；**v203 批次周期**：上一批全部 completed 后的新 TaskCreate=新周期，历史完成项清出板——部分完成时的新 create=同批补充不清；TodoWrite 覆写天然独立；转录内历史节点逐事件渲染不受板影响），快照照 v145 `f:[]` 先例走解析层 `tb` 字段随 messages + `tasks` 帧下发，前端禁 parse chip；**-p 无 Task*/TodoWrite 工具**——待办数据只来自 TUI/桌面会话转录。转录待办节点**静态渲染**（badge「待办」，TaskUpdate 一行无展开体，进行中=珊瑚无呼吸灯——活态动画专属运行中代理）。
- **产物预览**：锁会话 cwd 内（resolve+不区分大小写前缀校验）+ 扩展白名单 + ≤2MB；html **默认 text/plain**，仅 `render=1` 且 .html/.htm 才 text/html + `CSP: sandbox allow-scripts`；cwd 外不可预览（by design）。`.md`（v139）与 `.csv/.tsv/.json/.diff/.patch`（v142）产物/附件有渲染态：统一 `md.js` 构建器（共享 `docShell` 外壳、先转义纪律）注入 srcdoc——md=剥 frontmatter（护栏：无闭合栅栏或无 `key:` 行不吞）+miniMd，**唯一加 allow-popups**；csv=RFC4180（引号字段/内嵌换行/CRLF/BOM）+首行表头+500 行截断；json=美化+四色 token（解析失败退化为带提示的原样）；diff/patch=**行对模型**（v143：hunk 内 ctx 双指针配对、del/add run 按序两两配、长侧单边溢出）双布局同渲染——默认上下式 + 并排 grid，**纯 CSS checkbox 切换**；±统计；v144 **分块加载**：首块 2000 行、其余以 JSON 载荷（预构建 [上下,并排] HTML 对、`<` 转 `<` 防拆宿主 script 标签）+ 自有内联脚本按块追加（模型内容在建载荷时已 ESC，脚本不碰原文），硬上限 10000 行、超出指路源码 tab——**小 diff 仍零脚本**；git patch 散文行（From/index/diffstat/裸 `---`/签名 `-- `）走全宽行，**勿按 `-` 前缀误判为 del；hunk 内代码行可能撞 meta 前缀，flush 判定只认 `diff --git `/`-- `**；`.svg`（v142）白名单放行但**桥仍回 text/plain**，客户端 blob 重定型进 `<img>` 灯箱（图片上下文不执行 svg 脚本，「桥不下发 markup」裁定不破）；html 维持 allow-scripts，openHtmlPreview 每次 open 重设 sandbox。全屏预览页 `#html-prev` 统一入口（同源链接/产物文件/附件文本），DOM 嵌在 #detail 内、**必须 `position:fixed; inset:0`**（static 会被 flex 裁成半屏且 z-index 无效；e2e 有几何断言）。iframe 一律 `srcdoc` 注入文本 + `sandbox="allow-scripts"`（**勿加 same-origin**；blob/直连 src 的导航会污染联合会话历史）；**每次 open 在已显形的 `#html-prev` 内重建 iframe 节点**（旧节点自 boot 起泡在 display:none 容器里、合成层状态卡死，手机上持续空白，切 tab 的 display 翻转才救活；仅"先显形再赋 srcdoc"不够，v140 真机实测失败→v141 改重建节点）；沙箱 opaque origin 下外链 **module script 必被 CORS 拦**（module 获取走 cors 模式、无 ACAO 头）——module 型 SPA（含本 app 的 index.html：壳全 hidden、无 JS 即空白）渲染态只剩静态壳，by design，server 端 CSP 沙箱同样 opaque 无出路；关闭只置 `srcdoc=""`、勿再动 src；异源链接不拦（新标签）。history 三裁定：pushState 用**唯一 (state,URL)**——`#hp/N`（预览）与 `#s/N`（detail，`state.detailSeq` 计数）皆然，相邻同款条目 Chromium 静默遍历、吃掉 back；返回钮/ESC **直接 closeHtmlPreview，勿 fire-and-forget back**，且 close 时把当前 htmlprev 条目 `replaceState` 原地转成 detail 条目（僵尸 `#hp` 条目压在 detail 下会吃首按）；手势 back 走 popstate 尽力而为。`#back` 处理器带兜底：back() 后 250ms 仍停在同一条目（traversal 被吞）则直接 closeDetail——app 按钮不依赖 traversal 语义。助手结论 miniMd 渲染后用 `linkifyDom`（DOM 走查、跳过 a/code/pre）生成 `.flink`。
- **斜杠命令**：菜单=`GET /api/sessions/:id/commands`（内置白名单 `lib/commands.js`，收录标准=supportsNonInteractive + `-p` 冒烟实证；+ 自定义命令发现，项目覆盖用户；+ 技能发现 `~/.claude/skills` 与 `<cwd>/.claude/skills` 的 `<名>/SKILL.md`，行尾 kind 徽章区分 技能/命令）；**派发=普通消息**（composer 组 `/名 参数` 直走消息链路，无多命令合并）。**命令块框架（勿逐命令打补丁）**四条硬规则（转录行序见 parsers-cc.js 注释）：①stdout 提取必须在 stripReminder **之前**（后者整块删空）；②`_cmdEnv` **武装必须在事件返回处**（中段武装自噬——信封行折叠自己）；③展开体=武装后紧邻的下一条纯文本 user 行折叠，user 载体 stdout 与任何非 user 行**到达即解除武装**（防吞用户真消息）；④展开体检查必须在 stdout/caveat/hook 拦截**之后**。clear 的信封/stdout 落新会话文件、新 sid 走 runner adoption；旧文件仅追加 queue-operation/cost-state 记账行（对话内容不动）；派生会话转录**无 custom-title**（列表标题走 fallback，显示为 `/clear`）；未知命令=当纯文本发模型。**`clear` 已移出内置菜单**（v151 裁定：与新建会话功能重复、流内会话切换跟踪 bug 面大，runner 不再跟随 mid-run session 切换、前端无跳转逻辑）——手输 `/clear` 仍会被 CLI 执行并重置进新转录文件，app 保持旧视图不跳转（新会话仅出现在列表，标题 fallback），by design 勿再修。
- 其余功能（导出 MD、改动文件汇总、**会话分支**、搜索/批量、队列面板）见对应 routes/views 文件头注释。**分支标题=v212 必须钉**（`titleFork` 经 `pinRename(newId, title, prev=源标题)`）——fork 转录是父会话拷贝，CLI 每次 resume 会回显缓存的父标题覆掉 Fork- 前缀（4aa28a42 实证写 1 次被覆写 19 次）；显式 prev 让 fence 确定性命中 stale 分支（记录解析竞态下记录读不可靠）。

## 已实测确认的数据事实（勿再调研）

**环境**

- CLI 不在 PATH：第三方客户端内置 `%LOCALAPPDATA%\Claude-3p\claude-code\<版本>\<hash>\claude.exe`（runner 取 mtime 最新，config `claudePath` 可钉）。实测 2.1.308（Win）/ 2.1.197（Linux），行为强耦合：JSONL 格式 / resume 语义 / 旗标名 / `/context` 输出 / hooks 回调。
- 直接 spawn 报 "Not logged in"：`~/.claude/settings.json` 的 env 块**必须显式注入子进程**（密钥只进内存）。
- `--resume <id> -p` 追加写原 JSONL、不新建文件；`stream-json --verbose` 行序列：init（含 session_id）→ assistant → post_turn_summary → result。
- `/context` 在 `-p` 模式可用；statusline 方案勿用（仅交互会话触发、不热加载）。`claude://` deep link 被官方 Store 版接管（Phase 4 走 UIA）。Cowork 存储（`local-agent-mode-sessions/local_*.json`）字段齐全（Phase 3 可开工）。
- **Linux**：普通用户跑（root/sudo 拒跑 skip-permissions，runner 已前置拦截）；先写 settings.json 再起桥仍为佳（env 缺失已可自愈，但空窗期 run 报未登录）；递归 fs.watch 在 Node ≥20.13 可用；`*.sh` 已由 .gitattributes 钉 `eol=lf`。

**转录格式**

`~/.claude/projects/<工作区slug>/<sessionId>.jsonl`（追加式）；slug：`D:\foo\Bar` → `D--foo-Bar`。adapter 消费：

- `user`：**人机判定按内容**——含 tool_result 块即机器回合（origin 不可靠，tool_result 行 origin 为 null）；压缩续传（`isCompactSummary:true`）与技能注入（纯 text 数组 + 首段 "Base directory for this skill:"）折叠为标记；**勿按"origin 缺失"折叠**（手机 promptSource=sdk 的消息同样无 origin）；`<command-*>` 信封归一成 `/名 参数`。**cwd 采集=v212 首见锚定后锁定**（CLI 会把模型 shell 的 cd 写进后续行——「最后胜出」曾把 cd 进子目录的会话甩进新项目组，fork 4aa28a42 实证 149 行；锁定值经 `patch.cwdSet` 跨 drain 传递，boot 重放自愈错锚记录）。
- `assistant`：`message.content[]` = thinking/text/tool_use（**tool_use 的 `id` 是结果配对键**）；`message.model` 是显示模型名唯一来源；`message.usage` 是圆环唯一数据源（in/cacheRead/cacheCreate/out）。改动文件 ± 摘要在**解析层**算好随事件下发（`f:[{path,add,del}]`，Edit/Write/MultiEdit/NotebookEdit；v145）——chip 文本 `v` 被 briefJson 截到 300 字符，**勿在前端 JSON.parse(v) 做汇总**（截断串必炸，v145 前超限输入的文件全被静默丢出汇总）。**v212 汇总只收会话 cwd 锚内的文件**（Temp 等临时中间件不进；锚=锁定 cwdSet，大小写不敏感前缀；无锚不滤）。**v215 公共前后缀行修剪（勿回退）**：Edit 的 old_string 常带未改动上下文行——`trimCommonLines` 剥离（editDelta 与 synthesizeFileDiff 共用 → 列表 ± 与详情 ± 恒等；空串=0 行，旧口径 `''.split('\n')=['']` 曾把纯插入计 −1）；synthesize 三禁：**①只收 EDIT_TOOLS 白名单**（Read/Grep 的 input 也带 file_path，不过滤混进调用序列错位）；**②ctx 行加前导空格**（标准 unified 语义——markdown 列表行内容自带 `- ` 前缀，无空格被 diffRows 误判 del）；**③filediff 合成与汇总同锚**。CLI 合成哨兵行（text 精确等于「No response requested.」）= 被杀 turn 的记账（kill 路径/resume 补记），**解析层已折叠**（v158；长回复含该短语不折）。汇总行 ± 点击=`GET /api/sessions/:id/filediff`（v146）——adapter 重读 JSONL **原文**现场合成该文件全部编辑的 unified diff（Write/NotebookEdit 只出新增侧；不读盘故无 cwd 锁；hunk 头数字仅供渲染），前端走 diffDoc 双 tab。
- `cost-state`：聚合全部模型、**不覆盖** model 标签；相邻快照折叠保末值。`custom-title`、`system`（stop 类 subtype → idle + stop 标记事件）。

## PWA 硬约束（勿回退）

**折叠/滚动**

- 折叠 CSS 必须是 `.node:not(.open):not(.plain) .node-body{display:none}`——输出/结论文本是 plain 节点，漏 `:not(.plain)` 会藏掉全部输出。
- 限高只作用于 `.think/.tool-chip/.tool-out`，且必须由 `markCapped()` 动态加 `.capped`（固定挂 overflow 造手势死区）；display:none 元素 scrollHeight=0，胶囊/节点头点击里要局部重跑 markCapped。
- 滚动三律：`.page` 必须 `height:100dvh`；`#chat` 必须 `overflow-anchor:none`；**renderTail 只从 `prevLen-1` 重渲染**（chat 子节点与 state.turns 一一对应，多删即错位→全量重建→滚动跳顶）。
- 嵌套滚动：页级滚动器（.chat/.groups）`overscroll-behavior: contain`；**内嵌滚动器**（.capped 系、.fp-body）必须 `overscroll-behavior-y: auto`——contain 会切断链条造成手势卡死。
- 乐观上屏：同文折叠必须**幂等**（防双触发重复泡）；排队消息派发前不上屏（`queue-dispatched` 帧置 `expectQueuedUser`，折叠器见旗标跳过）；run 结束仍有未确认孪生→呼吸点转红静态；重放判定：**时间戳优先**（更晚 ts=真重复推新，同 ts=重放 no-op，无 ts 走结构兜底）。
- 轮次形状：渲染源是 `steps[]`（think/tool/text 按真实顺序交错；兼容桶必须与 steps 同步 push）；tool_result 按 tool_use_id 配对回填 `tool.out`；完成信号双路（run 帧 + stop 标记事件，sessions 帧做活跃度翻转兜底）。
- 触屏 Enter=换行（`IS_TOUCH`=pointer:coarse）。

**视觉纪律**

- 暖炭底/珊瑚橘 #D97757；**珊瑚橘只给发送钮/工具点/链接/活态**；阴影分层（--sh-1/2/3）不用边框盒（裁定例外：确认弹窗取消钮灰描边、P 徽章描边）；tabular-nums。
- 模型 chip 是唯一可收缩元素（`flex:0 1 auto; min-width:0`，`max-width:50vw` 兜底）；弹层=锚定气泡（`.overlay.bub`+`.sheet.bubble`），模态=全宽 sheet——分工勿混；气泡 open/close 均不动 history；**勿在 closeBubble 里 history.back()**；气泡宽度用 `flex:1 1 auto`，勿用 align-self:stretch。
- 品牌区：官方托盘模板图 CSS mask 着色（连接状态在图标内：珊瑚=已连 / 奶白↔珊瑚呼吸=连接中 / 奶白=断开）+ P 徽章（非官方标注）+ T4 词标 + PERSONAL 胶囊（版本号并在胶囊内）。配对面板用同款品牌套件（`/brand-mark.png` mask）。

**缓存（改前端必读）**

- 改 `public/` 的 app.js/style.css 必须三处同版本 bump：index.html 的 `?v=N` + `#build` 徽章 + `bridge/pairing.js` 的 `BUILD`。口诀：徽章不对=HTML 缓存过期；徽章对但行为怪=真 bug。pair.html 独立 no-cache 直出、不参与此规则。

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
6. 手机驱动的开发会话长在 bridge 进程树里：会话内脚本杀 bridge 切断的是当前 turn 的输出管道——CLI 子进程不死、转录为准、可被新桥按 `--resume` 接管；重启桥一律从 PC 侧做，例外=用户同意后走 detached 看护脚本自重启（缓冲→杀→等端口→startup vbs→HTTP 验版本，v151 实测全程 ~9s）。

## 路线图

**已裁定不做**：锁屏/推送通知。下一步：Phase 3（Cowork 数据面）→ Phase 4（Cowork 控制面，UIA）。
