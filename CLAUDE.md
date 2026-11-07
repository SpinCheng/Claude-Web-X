# CLAUDE.md — claude-web 工程手册

用手机（PWA）远程查看并操控本机 Claude Code 会话（LAN bridge + 免构建 PWA）。

> **手册纪律（文档职责分工，更新前先对号入座）**
> - **本文件**（入库）：只收**跨文件硬约束**与**已实测数据事实**，每次会话整体载入。新裁定先蒸馏成一行规则再落笔；条目过时随手删除，勿留墓碑。不写版本号、时间线、翻车叙事、单模块实现细节。
> - **模块文件头注释**：机制细节的第一归属地——改哪个文件先读它的头，改动先落那里。
> - **README.md**（入库）：面向初见者——架构总览、消息流图、目录树、快速开始/部署。不收硬约束细则。
> - **`docs/history.md`**（gitignored）：版本号、调试时间线、翻车复盘的唯一归宿。
> - **`LOCAL.md`**（gitignored）：本机路径/端口/环境特例。
> - **`docs/`**：只有 `screenshots/` 入库（README 截图）；设计稿与方案文档不入库。
> - 落笔分流：跨文件约束→本文件（一行蒸馏版）；单模块机制→文件头；叙事与版本→history.md；不建平行文档。

## 架构

- README「架构与消息流」双 mermaid 图 + 目录树。后端 `bridge/`：`server.js` 组装根 + `lib/`（router/wshub/auth/mime/models/**platform**=OS 差异单点，勿在其他模块分支 process.platform）+ `routes/` + `parsers-cc.js`（转录行判定纯函数，有单测）。前端 `public/` 免构建 vanilla JS：`app.js` 组装根（boot/gate/路由/WS 帧语义）→ `js/` + `js/views/`。函数级循环 import（求值期零交叉）：composer↔detail、list↔sessops、detail↔ctxring、transcript↔agentview。**滚动三律与 renderTail 不变量在 transcript.js 文件头**。
- 测试：`npm test` = 125 单测（parsers/turns/adapter/cost/commands/agents/titlegen/runner/md/archives）+ 14 e2e（隔离桥 :3799 + 合成转录 + headless Edge CDP）。fixture 勿走 bash 内联（反斜杠被吃）；harness 的 api() 头必须合并非替换；harness 停桥必须 `closeAllConnections()` + 等 close 回调——server.close() 不等 keep-alive 排空，Windows 允许双绑 :3799 → 新旧桥竞态应答。场景只经 run-all 跑（结尾显式 process.exit），单场景直跑因残留句柄不退出，勿误判为新回归；预览类断言先断 `#html-prev`/`#lightbox` 容器（默认 hidden），**勿断 `#hp-frame`**（异步 fetch 未完成即假通过）。

## 快速开始

```powershell
npm install
npm start          # node bridge/index.js，端口 3742
```

手机浏览器打开启动日志里的 URL 输 token；PC 端接管 `node cli/cr.mjs list` → `attach <序号>`（跨平台）；配对面板 `http://localhost:3742/pair`（API 仅同机）可装开机自启（EADDRINUSE 双开保护）。config（`bridge/data/config.json`，gitignored）键：`token`/`port`/`claudePath`/`defaultCwd`/`yolo`/`titleGen`/`notify.ntfyTopic`。

## 运行机制（跨文件硬规则）

- **消息链路**：`POST /api/sessions/:id/message` → handoff 仲裁 → runner spawn `claude --resume -p --output-format stream-json --verbose`（完成即退，无驻留）。转录实时更新走 adapter 的 fs.watch；run 帧只管生命周期（新会话 id 取自 init 行）。
- **handoff 仲裁**：转录 8s 内新写入 → 409 `recent-local-write`；PC 持有 claim（cr attach）→ 409 `pc-claim`；自己的活 run 在跑时跳过 mtime 仲裁（语义细节在 handoff.js）。
- **runner**：perm=ask 走 `--permission-prompt-tool` + 内联 `--mcp-config`（approve-mcp.mjs 回调手机审批卡，3 分钟超时自动拒）；yolo（默认）加 `--dangerously-skip-permissions`，**Linux root/sudo + yolo 在 spawn 前直接拒绝**（CLI 硬拒，提前给手机明确报错；root+ask 合法）；`--model`/`--effort` 直传。spawn env 前置探测 git 目录——**Windows BashTool 靠发现 Git Bash 落座**，桥从精简上下文启动会丢 PATH → 手机会话全缺 Bash；settingsEnv 按 mtime 缓存（settings.json 后补/后改自动生效，无需重启桥）；纯文本 run spawn 后立即 `stdin.end()`（CLI 对保持打开的 stdin 白等 3s；**仅 stream-json 图片形态必须保持打开**）。队列/并发参数见 runner.js。PWA 选择持久化：`cr_model`(+label)/`cr_effort`/`cr_perm`。
- **附件**：图片走 `--input-format stream-json` stdin 图片块（**stdin 写完必须保持打开**，立即 close 挂死 CLI）；文本类 ≤24KB 内联进 prompt；输入框 Ctrl+V 粘贴文件=走附件管线（截图/资源管理器复制直传）；CLI 图片占位符两代都在解析层处理：`[Image: source]` 旧式独立行=折叠；2.1.308 `[Image: original WxH, displayed at WxH. Multiply coordinates…]` **纯标记独立行**=tool_result 图片的合成回显（模型自己 Read 图片也产生）折叠，**内嵌式（人类消息）逐字原样显示——用户裁定：我的输入是文本，绝不剥离/改写/占位符化**；乐观孪生去重走标记不敏感比较（`sameUserText`，折叠时采纳转录原文保持重放一致）。正则锚定完整机器格式防引文误伤。
- **@ 远程引用**：数据面=`GET /api/sessions/:id/files` + 发送代附（词边界扫 @token→cwd 守卫→文本 ≤24KB 内联/图片 ≤2MB stdin/其余降级纯路径，上限 4、原文逐字不动），细节在 lib/fileindex.js 文件头；白名单 `bridge/data/file-index-include` **逐行 `--exclude=` 直传——`--exclude-from` 否定压不过 .gitignore，勿回退**。前端：**选中=固定 dock 标签**（`#at-chips`，/ 命令 chip 同款：✕ 删除、发送即消费、失败路径恢复；发送时前置组合 `/名 @ref 正文`）；**呈现=行卡 `.at-ref`**（icon+文件名亮/路径灰双行；dock 标签/气泡引用同构，卡点=预览；手输 @path 同套卡、不经标签照常代附；文件树 insertRef 同一标签语义）；ftFileIcon 从 filetree.js 导出共享（函数级循环，求值期零交叉；测试桩需 dataset）；**无命中=收起菜单不出空态列表**（用户裁定，/ 菜单同款——文本照常原文发送）。**回显折叠**：runner 代附内联块标签 `[引用 @path]`（上传附件=`[附件 name]`）——解析层以**首个 `\n\n[引用 @`/`\n\n[附件 ` 词法切分**：标记前文本=气泡（乐观孪生因此仍精确匹配）、其后=机器附录折叠成 `k:'attref'` 标记行（sysline「已随消息附上 N 份」）；正文撞完整机器格式≈主动伪造，勿加武装/解除机制。
- **项目文件树**：手机=右缘遮挡抽屉 82vw+轻 scrim 挂 `#detail`（cwd=会话项目，切会话跟随重建；**不动 history**、收起即销毁；右缘拖拽收起见 filetree.js，宽屏面板形态不参与）；PC=第三栏（`body.wide` 下转 static 列、scrim 隐；localStorage `cr_ft_panel` 记开关、**只由用户显式开关写入**）。数据面=`GET /api/sessions/:id/tree`，细节在 lib/fileindex.js：readdir 磁盘真相 + git **仅标注层**（tracked=纯 index，**勿用 --others 混合索引**；「git 视角不筛 git」；全状态着色 del 红/mod 琥珀/add·unt 绿/ign 置灰，目录聚合取后代最强态；**幽灵行**=磁盘上已不存在的删除项，del 行禁预览/插入）；状态与索引缓存同源 3s TTL（`clearIndexCache` 双清）。点文件=previewArtifact 管线全复用；⋯/右键（span role=button）=预览/插入 @/复制路径/复制文件名（**复制走 clipboard 竞速 1.2s+execCommand 兜底**——LAN HTTP 无 clipboard API；row-actions 气泡壳复用）；护栏：单层 >500 截断、深度上限 12、目录计数=索引推得不触盘。
- **PC 双栏**：≥1024px 断点由 app.js `matchMedia` 单点驱动 `body.wide`（**CSS 只认类名，勿写重复媒体查询**）；`#detail-main` 包裹右栏主列（窄屏 display:contents 零影响）。history：**宽屏切会话 replaceState 不 pushState**、#back 宽屏隐藏；宽屏空态=`updateDetailEmpty`（**provisional 不算空态**）。内容列 860px 居中、气泡绝对上限 620/700；跨断点 resize **必恢复左栏常驻**；**composer 窄屏=视口级 fixed（chat 用 paddingBottom 补偿），宽屏必须转锚 detail-main（absolute bottom）**；focus-visible 只挂 button/[role=button]（**勿挂 input/textarea**）；Ctrl/Cmd+Enter 恒发送。拖宽手柄 `.rg`（#rg-list 260-600 / #rg-ft 180-480，负 margin 叠栏；**手柄 z-index 10 必须压过 ft-drawer z9**；localStorage cr_list_w/cr_ft_w，窄屏必须清内联宽）；wide 主滚动器 `scrollbar-width:none`；文件树 ign 无文字标签只置灰（unt 保留琥珀角标）；树图标=文件树语系（文件夹开合双态+按类型 5 族字形，`ftFileIcon` 单色）。
- **标题**：截取自首条 user 文本（记录带 `titleFallback` 标记）。真标题=转录 `custom-title` 行：手动改名与 titlegen 自动标题**共用 `appendTitle`+`pinRename` 写入路径**（行尾无 `\n` 先补；不 bump lastActive；钉防 Desktop 回写）。**打开中的详情页标题实时更新走双路**：sessions 帧 → renderMeta（主）+ append `k:'title'` 事件直写 `d-title`（兜底，append 帧只达订阅者）。自动标题：手机新建会话首跑结束由 `titlegen.js` 一次性 `-p` 生成（机制见其文件头；cfg `titleGen`=false 关）。预览失败的 toast 按 HTTP 状态分类文案（403 目录外/404 不存在/413 过大/415 类型）。
- **write-fence**：改名钉只被**活流**（emitAppends=true 的 drain）解除；boot 重放/readTranscript 无权解钉或夺标题。
- **会话状态** = running（runner 内存）+ lastRun（桥重启即失）+ lastOutcome（转录 system 行推导，持久）。**所有 sessions 帧必须走 `mergedSessions()`**；它携带 `runId`（重载后仍可 cancel）。未注册非 GET 一律 405——新端点必须重启桥才加载。
- **等待横幅**：Notification hook **只认权限类**消息（"waiting for your input" 每轮必发且无清除时机，认了就常驻）；清除双路=该会话任何 append / Stop hook。
- **上下文探针**：按 (cwd, modelId) 缓存，跑一次性 `-p /context`；**归档在解析判定之前、成败都执行**。
- **列表交互**：行是真 `<button>`，内嵌交互元素必须用 span（嵌 button 会被 fragment 解析器提出去打碎布局）；右键有选区守卫；**列表行长按不选文本**（`.srow/.pgroup-head` user-select:none，输入框除外）。
- **归档**：纯视图过滤零文件操作（`bridge/data/archived.json`；mergedSessions 带 `archived` 标记）；主列表滤归档、**搜索照常覆盖**（中性「已归档」徽章）；归档页=独立 `.page` 复用 renderRow；**活跃反归档**：转录新 append 或手机发消息自动解除+toast；running 会话 ⋯ 不显示归档项；删除 drop 归档标记。
- **审批卡**：Edit/Write/MultiEdit/NotebookEdit 渲染 ±diff，其余 JSON；**必须 createElement/textContent 构建**（模型产物拼 HTML 即 XSS 面）；「本次会话始终允许」→ 内存 Map 按会话放行。
- **历史分页**：`readTranscript(limit, before)` → `{events,total}`；加载行 `#hist-more` **必须挂 #chat 外**（renderTail 1:1 不变量）；跟手渐显：f=clamp((64−scrollTop)/64) 直驱行高/透明度（**勿加 CSS transition**）；`parseOlderTurns` 纯重放（**勿复用 applyEventToTurns**）；跨页 toolres 先进 `state.orphanToolRes` 暂存、prepend 后回填。
- **确认弹窗**：禁 window.confirm/alert——一律 `showConfirm({title,body,ok,danger,onOk,onCancel})`（底部 sheet 模态；danger=红钮+焦点落取消侧）。
- **费用面板**：**零价表设计**（官方无价格 API）：官方口径=cost-state 原值 / 倍率 / 自定义分模型单价；价格偏好存 localStorage 不进桥；**时间轴不渲染成本快照行**（$ 数字只经 header 入口/面板，数据走 sessions 帧）。**结算输出速率**：解析层按 assistant 行累加、按 `message.model` 分桶、随 cost-state `stats.rate` 下发（零新端点/帧）；**去重两律（勿回退）**：①同一条 API message 被 CLI 拆成多行（id 相同、每行重复整条 usage）——按 `message.id` 分组，out 只在组首计一次、间隔=基点→组末收口（`commitRateGroup`，组边界链式推进基点防重叠；无 id 按单行组，无 ts/非正间隔整组跳过）；②CLI 会把同 message 的后段 tool_use 写在 tool_result **之后**——已提交组的同 id 迟到片段整行跳过（`_rateSeen` 有界表 >2048 清零），否则 out 与工具时长双双重复。**展示（用户裁定）**：面板全宽速率卡——卡头总均值大数字+计时/总量（**分子走 cost-state outTok 与五格恒等，最近一轮不进速率；分母=解析层 Σms**），分模型相对速率横条、**最快模型数值珊瑚高亮**；单模型退化只有卡头。**实时速率不做**（裁定；真要做归宿=run-status 行）。**债会话认账不动**（裁定）：老会话账本有历史债（同模型多键并存、早年杀 run 少记/倒退）——**不修不改不特判**，面板数字即官方账口径。
- **子代理直播**：adapter 递归 watcher 里 `subagents` 路径段**路由进 tracker、绝不进会话体系**（`_ensureSession` 双保险）；归属/完成信号/boot 重放机制见 agents.js 文件头。前端硬规则：帧到达=**就地 patch DOM，不碰 renderTail**（未渲染才走 renderTail）；一切时长=startedAt..finishedAt（**完成态冻结，勿用 Date.now() 滴答**）；`#agent-sheet` 全宽 sheet 复用主视图节点渲染。
- **活动悬浮件**：`#act` 挂 `#detail-main` 子节点（**勿移出 detail-main**——否则文件树面板/抽屉打开时胶囊落进面板区域；非 #chat 子节点——renderTail 1:1）；**非模态**（无遮罩、不拦会话交互），胶囊/面板两态互斥。待办板=桥侧状态机（parsers-cc `applyBoard`：Task* 增量+TodoWrite 全量；**真实枚举无 cancelled，deleted=移出板**；**批次周期**：上一批全部 completed 后的新 TaskCreate=新周期、历史完成项清出板，部分完成时的新 create=同批补充不清；TodoWrite 覆写天然独立；转录内历史节点逐事件渲染不受板影响），快照走解析层 `tb` 字段随 messages + `tasks` 帧下发，前端禁 parse chip；**-p 无 Task*/TodoWrite 工具**——待办数据只来自 TUI/桌面会话转录。转录待办节点**静态渲染**（badge「待办」，TaskUpdate 一行无展开体，进行中=珊瑚无呼吸灯——活态动画专属运行中代理）。
- **产物预览**：锁会话 cwd 内（resolve+不区分大小写前缀校验）+ 扩展白名单 + ≤2MB；html **默认 text/plain**，仅 `render=1` 且 .html/.htm 才 text/html + `CSP: sandbox allow-scripts`；cwd 外不可预览（by design）。`.md/.csv/.tsv/.json/.diff/.patch` 与 `.svg` 有渲染态：统一 `md.js` 构建器（**先转义纪律**，机制细节在其文件头）；svg 桥仍回 text/plain，客户端 blob 重定型进 `<img>` 灯箱；diff=**行对模型**双布局同渲染（上下式+并排 grid，纯 CSS 切换）+分块加载（小 diff 零脚本）；git patch 散文行（From/index/diffstat/裸 `---`/签名 `-- `）走全宽行，**勿按 `-` 前缀误判为 del；flush 判定只认 `diff --git `/`-- `**。`#html-prev` 统一入口（同源链接/产物/附件文本），DOM 嵌在 #detail 内、**必须 `position:fixed; inset:0`**（e2e 有几何断言）；iframe 一律 `srcdoc` 注入 + `sandbox="allow-scripts"`（**勿加 same-origin**——直连 src 的导航会污染联合会话历史）；**每次 open 在已显形的容器内重建 iframe 节点**（display:none 里泡旧的节点合成层卡死，手机持续空白）；关闭只置 `srcdoc=""`；沙箱 opaque origin 下外链 module script 必被 CORS 拦——module 型 SPA 渲染态只剩静态壳，by design；异源链接不拦（新标签）。history 三裁定：pushState 用**唯一 (state,URL)**——`#hp/N` 与 `#s/N`（`state.detailSeq`）皆然，相邻同款条目 Chromium 静默遍历吃掉 back；返回钮/ESC **直接 closeHtmlPreview，勿 fire-and-forget back**，close 时把当前 htmlprev 条目 `replaceState` 原地转 detail 条目（僵尸条目压在 detail 下会吃首按）；`#back` 带 250ms 兜底（traversal 被吞则直接 closeDetail）。助手结论 miniMd 渲染后 `linkifyDom` 生成 `.flink`。
- **斜杠命令**：菜单=`GET /api/sessions/:id/commands`（内置白名单 `lib/commands.js`，收录标准=supportsNonInteractive + `-p` 冒烟实证；+自定义命令发现，项目覆盖用户；+技能发现 `~/.claude/skills` 与 `<cwd>/.claude/skills` 的 `<名>/SKILL.md`，行尾 kind 徽章）；**派发=普通消息**（`/名 参数` 直走消息链路，无多命令合并）。**命令块框架（勿逐命令打补丁）**四条硬规则（转录行序见 parsers-cc.js 注释）：①stdout 提取必须在 stripReminder **之前**（后者整块删空）；②`_cmdEnv` **武装必须在事件返回处**（中段武装自噬）；③展开体=武装后紧邻的下一条纯文本 user 行折叠，user 载体 stdout 与任何非 user 行**到达即解除武装**（防吞用户真消息）；④展开体检查必须在 stdout/caveat/hook 拦截**之后**。clear 的信封/stdout 落新会话文件、新 sid 走 runner adoption；旧文件仅追加记账行；派生会话**无 custom-title**（标题 fallback 显示 `/clear`）；未知命令=当纯文本发模型。**`clear` 已移出内置菜单**（与新建会话重复、mid-run 会话切换跟踪面大）——手输 `/clear` 仍会被 CLI 执行并重置进新转录文件，app 保持旧视图不跳转，by design 勿再修。
- 其余功能（导出 MD、改动文件汇总、**会话分支**、搜索/批量、队列面板）见对应 routes/views 文件头注释。**分支标题必须钉**：`titleFork` 经 `pinRename(newId, title, prev=源标题)`——fork 转录是父会话拷贝，CLI 每次 resume 会回显缓存的父标题覆掉 Fork- 前缀；显式 prev 让 fence 确定性命中 stale 分支（记录解析竞态下记录读不可靠）。

## 已实测确认的数据事实（勿再调研）

**环境**

- CLI 不在 PATH：第三方客户端内置 `%LOCALAPPDATA%\Claude-3p\claude-code\<版本>\<hash>\claude.exe`（runner 取 mtime 最新，config `claudePath` 可钉）。实测 2.1.308（Win）/ 2.1.197（Linux），行为强耦合：JSONL 格式 / resume 语义 / 旗标名 / `/context` 输出 / hooks 回调。
- 直接 spawn 报 "Not logged in"：`~/.claude/settings.json` 的 env 块**必须显式注入子进程**（密钥只进内存）。
- `--resume <id> -p` 追加写原 JSONL、不新建文件；`stream-json --verbose` 行序列：init（含 session_id）→ assistant → post_turn_summary → result。
- `/context` 在 `-p` 模式可用；statusline 方案勿用（仅交互会话触发、不热加载）。`claude://` deep link 被官方 Store 版接管（Phase 4 走 UIA）。Cowork 存储（`local-agent-mode-sessions/local_*.json`）字段齐全（Phase 3 可开工）。
- **Linux**：普通用户跑（root/sudo 拒跑 skip-permissions，runner 已前置拦截）；先写 settings.json 再起桥仍为佳（env 缺失已可自愈，但空窗期 run 报未登录）；递归 fs.watch 在 Node ≥20.13 可用；`*.sh` 已由 .gitattributes 钉 `eol=lf`。

**转录格式**

`~/.claude/projects/<工作区slug>/<sessionId>.jsonl`（追加式）；slug：`D:\foo\Bar` → `D--foo-Bar`。adapter 消费：

- `user`：**人机判定按内容**——含 tool_result 块即机器回合（origin 不可靠，tool_result 行 origin 为 null）；压缩续传（`isCompactSummary:true`）与技能注入（纯 text 数组 + 首段 "Base directory for this skill:"）折叠为标记；**勿按"origin 缺失"折叠**（手机 promptSource=sdk 的消息同样无 origin）；`<command-*>` 信封归一成 `/名 参数`。**cwd 采集=首见锚定后锁定**（CLI 会把模型 shell 的 cd 写进后续行，「最后胜出」会把 cd 进子目录的会话甩错项目组；锁定值经 `patch.cwdSet` 跨 drain 传递，boot 重放自愈错锚记录）。
- `assistant`：`message.content[]` = thinking/text/tool_use（**tool_use 的 `id` 是结果配对键**）；`message.model` 是显示模型名唯一来源；`message.usage` 是圆环唯一数据源（in/cacheRead/cacheCreate/out）。改动文件 ± 摘要在**解析层**算好随事件下发（`f:[{path,add,del}]`，Edit/Write/MultiEdit/NotebookEdit）——chip 文本 `v` 被 briefJson 截到 300 字符，**勿在前端 JSON.parse(v) 做汇总**；**汇总只收会话 cwd 锚内的文件**（Temp 等中间件不进；锚=锁定 cwdSet 大小写不敏感前缀，无锚不滤）。**公共前后缀行修剪（勿回退）**：`trimCommonLines` 剥离 old_string 里未改动的上下文行（editDelta 与 synthesizeFileDiff 共用 → 列表 ± 与详情 ± 恒等；空串=0 行）；synthesize 三禁：**①只收 EDIT_TOOLS 白名单**（Read/Grep 的 input 也带 file_path，混入错位）；**②ctx 行加前导空格**（unified 语义——markdown 列表行自带 `- ` 会被 diffRows 误判 del）；**③filediff 合成与汇总同锚**。CLI 合成哨兵行（text 精确等于「No response requested.」）=被杀 turn 的记账，**解析层已折叠**（长回复含该短语不折）。汇总行 ± 点击=`GET /api/sessions/:id/filediff`——重读 JSONL **原文**现场合成该文件全部编辑的 unified diff（Write/NotebookEdit 只出新增侧；不读盘故无 cwd 锁），前端走 diffDoc 双 tab。
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
6. 手机驱动的开发会话长在 bridge 进程树里：会话内脚本杀 bridge 切断的是当前 turn 的输出管道——CLI 子进程不死、转录为准、可被新桥按 `--resume` 接管；重启桥一律从 PC 侧做，例外=用户同意后走 detached 看护脚本自重启（缓冲→杀→等端口→startup vbs→HTTP 验版本）。

## 路线图

**已裁定不做**：锁屏/推送通知。下一步：Phase 3（Cowork 数据面）→ Phase 4（Cowork 控制面，UIA）。
