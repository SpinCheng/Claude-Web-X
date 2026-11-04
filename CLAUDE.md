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
- **@ 远程引用（v192）**：数据面=`GET /api/sessions/:id/files`（git ls-files 全索引一次下发、客户端过滤 v109 先例；非 git 退 readdir 首层；白名单 `bridge/data/file-index-include` **逐行 `--exclude=` 直传——实测 `--exclude-from` 否定压不过 .gitignore，勿回退**）；发送代附=message 路由词边界扫 @token（prose 标点截断，前端 atDetect 是同语义镜像）→cwd 守卫→文本 ≤24KB 内联/图片 ≤2MB stdin/其余降级纯路径，上限 4、原文逐字不动（细节在 lib/fileindex.js 文件头）；前端 @ 气泡=cmd-menu 直系方案 A（目录直插 `@dir/`，不做 chip）。
- **项目文件树（v194）**：手机=右缘遮挡抽屉 82vw+轻 scrim 挂 `#detail`（cwd=会话项目，切会话 resetFileTree 跟随重建；**不动 history**、收起即销毁；PC 右栏面板归条目 13，行单元 filetree.js `ftRowEl` 届时复用）。数据面=`GET /api/sessions/:id/tree`：readdir 磁盘真相 + git **仅标注层**——tracked=纯 index（`trackedFileList`，**勿用 --others 混合索引**）、unt=porcelain `??` 折叠目录按前缀判定、ign=`check-ignore --stdin` 批查；「git 视角不筛 git」：unt/ign 角标行文字降灰但照常可开/预览/插入。点文件=previewArtifact 管线全复用；⋯/右键（span role=button）=预览/插入 @（`composer.insertRef` 借力）/复制路径/复制文件名（row-actions 气泡壳复用）；护栏：单层 >500 截断、深度上限 12、目录计数=索引推得不触盘。
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
- **费用面板**：**零价表设计**（官方无价格 API）：官方口径=cost-state 原值 / 倍率 / 自定义分模型单价；价格偏好存 localStorage 不进桥。**时间轴不渲染成本快照行**（v145 裁定——"$x · in/out tok" 提醒已除；$ 数字只经 header 入口/面板，数据走 sessions 帧）。**结算输出速率（v191，roadmap 05 定稿）**：解析层按 assistant 行累加 Σout/Σ间隔（间隔=本行 ts−上一非 assistant 行 ts，链式基点防重叠计时；无 ts/非正间隔跳过），按 `message.model` 分桶、随 cost-state `stats.rate` 下发（零新端点/帧）；费用面板 muted 一行总均值 + 分模型行尾 tok/s；**实时速率不做**（弹窗瞬态，裁定；真要做归宿=run-status 行）。
- **子代理直播**：adapter 递归 watcher 里 `subagents` 路径段**路由进 tracker、绝不进会话体系**（`_ensureSession` 双保险）；归属/完成信号/boot 重放机制见 agents.js 文件头。前端硬规则：帧到达=**就地 patch DOM，不碰 renderTail**（未渲染才走 renderTail）；一切时长=startedAt..finishedAt（**完成态冻结，勿用 Date.now() 滴答**）；`#agent-sheet` 全宽 sheet（v122 起非锚定气泡）复用主视图节点渲染。
- **活动悬浮件（v154）**：`#act` 挂 `#detail`（**非 #chat 子节点**——renderTail 1:1）；**非模态**（无遮罩、不拦会话交互），胶囊/面板两态互斥。待办板=桥侧状态机（parsers-cc `applyBoard`：Task* 增量+TodoWrite 全量；**真实枚举无 cancelled，deleted=移出板**），快照照 v145 `f:[]` 先例走解析层 `tb` 字段随 messages + `tasks` 帧下发，前端禁 parse chip；**-p 无 Task*/TodoWrite 工具**——待办数据只来自 TUI/桌面会话转录。转录待办节点**静态渲染**（badge「待办」，TaskUpdate 一行无展开体，进行中=珊瑚无呼吸灯——活态动画专属运行中代理）。
- **产物预览**：锁会话 cwd 内（resolve+不区分大小写前缀校验）+ 扩展白名单 + ≤2MB；html **默认 text/plain**，仅 `render=1` 且 .html/.htm 才 text/html + `CSP: sandbox allow-scripts`；cwd 外不可预览（by design）。`.md`（v139）与 `.csv/.tsv/.json/.diff/.patch`（v142）产物/附件有渲染态：统一 `md.js` 构建器（共享 `docShell` 外壳、先转义纪律）注入 srcdoc——md=剥 frontmatter（护栏：无闭合栅栏或无 `key:` 行不吞）+miniMd，**唯一加 allow-popups**；csv=RFC4180（引号字段/内嵌换行/CRLF/BOM）+首行表头+500 行截断；json=美化+四色 token（解析失败退化为带提示的原样）；diff/patch=**行对模型**（v143：hunk 内 ctx 双指针配对、del/add run 按序两两配、长侧单边溢出）双布局同渲染——默认上下式 + 并排 grid，**纯 CSS checkbox 切换**；±统计；v144 **分块加载**：首块 2000 行、其余以 JSON 载荷（预构建 [上下,并排] HTML 对、`<` 转 `<` 防拆宿主 script 标签）+ 自有内联脚本按块追加（模型内容在建载荷时已 ESC，脚本不碰原文），硬上限 10000 行、超出指路源码 tab——**小 diff 仍零脚本**；git patch 散文行（From/index/diffstat/裸 `---`/签名 `-- `）走全宽行，**勿按 `-` 前缀误判为 del；hunk 内代码行可能撞 meta 前缀，flush 判定只认 `diff --git `/`-- `**；`.svg`（v142）白名单放行但**桥仍回 text/plain**，客户端 blob 重定型进 `<img>` 灯箱（图片上下文不执行 svg 脚本，「桥不下发 markup」裁定不破）；html 维持 allow-scripts，openHtmlPreview 每次 open 重设 sandbox。全屏预览页 `#html-prev` 统一入口（同源链接/产物文件/附件文本），DOM 嵌在 #detail 内、**必须 `position:fixed; inset:0`**（static 会被 flex 裁成半屏且 z-index 无效；e2e 有几何断言）。iframe 一律 `srcdoc` 注入文本 + `sandbox="allow-scripts"`（**勿加 same-origin**；blob/直连 src 的导航会污染联合会话历史）；**每次 open 在已显形的 `#html-prev` 内重建 iframe 节点**（旧节点自 boot 起泡在 display:none 容器里、合成层状态卡死，手机上持续空白，切 tab 的 display 翻转才救活；仅"先显形再赋 srcdoc"不够，v140 真机实测失败→v141 改重建节点）；沙箱 opaque origin 下外链 **module script 必被 CORS 拦**（module 获取走 cors 模式、无 ACAO 头）——module 型 SPA（含本 app 的 index.html：壳全 hidden、无 JS 即空白）渲染态只剩静态壳，by design，server 端 CSP 沙箱同样 opaque 无出路；关闭只置 `srcdoc=""`、勿再动 src；异源链接不拦（新标签）。history 三裁定：pushState 用**唯一 (state,URL)**——`#hp/N`（预览）与 `#s/N`（detail，`state.detailSeq` 计数）皆然，相邻同款条目 Chromium 静默遍历、吃掉 back；返回钮/ESC **直接 closeHtmlPreview，勿 fire-and-forget back**，且 close 时把当前 htmlprev 条目 `replaceState` 原地转成 detail 条目（僵尸 `#hp` 条目压在 detail 下会吃首按）；手势 back 走 popstate 尽力而为。`#back` 处理器带兜底：back() 后 250ms 仍停在同一条目（traversal 被吞）则直接 closeDetail——app 按钮不依赖 traversal 语义。助手结论 miniMd 渲染后用 `linkifyDom`（DOM 走查、跳过 a/code/pre）生成 `.flink`。
- **斜杠命令**：菜单=`GET /api/sessions/:id/commands`（内置白名单 `lib/commands.js`，收录标准=supportsNonInteractive + `-p` 冒烟实证；+ 自定义命令发现，项目覆盖用户；+ 技能发现 `~/.claude/skills` 与 `<cwd>/.claude/skills` 的 `<名>/SKILL.md`，行尾 kind 徽章区分 技能/命令）；**派发=普通消息**（composer 组 `/名 参数` 直走消息链路，无多命令合并）。**命令块框架（勿逐命令打补丁）**四条硬规则（转录行序见 parsers-cc.js 注释）：①stdout 提取必须在 stripReminder **之前**（后者整块删空）；②`_cmdEnv` **武装必须在事件返回处**（中段武装自噬——信封行折叠自己）；③展开体=武装后紧邻的下一条纯文本 user 行折叠，user 载体 stdout 与任何非 user 行**到达即解除武装**（防吞用户真消息）；④展开体检查必须在 stdout/caveat/hook 拦截**之后**。clear 的信封/stdout 落新会话文件、新 sid 走 runner adoption；旧文件仅追加 queue-operation/cost-state 记账行（对话内容不动）；派生会话转录**无 custom-title**（列表标题走 fallback，显示为 `/clear`）；未知命令=当纯文本发模型。**`clear` 已移出内置菜单**（v151 裁定：与新建会话功能重复、流内会话切换跟踪 bug 面大，runner 不再跟随 mid-run session 切换、前端无跳转逻辑）——手输 `/clear` 仍会被 CLI 执行并重置进新转录文件，app 保持旧视图不跳转（新会话仅出现在列表，标题 fallback），by design 勿再修。
- 其余功能（导出 MD、改动文件汇总、会话分支、搜索/批量、队列面板）见对应 routes/views 文件头注释。

## 已实测确认的数据事实（勿再调研）

**环境**

- CLI 不在 PATH：第三方客户端内置 `%LOCALAPPDATA%\Claude-3p\claude-code\<版本>\<hash>\claude.exe`（runner 取 mtime 最新，config `claudePath` 可钉）。实测 2.1.308（Win）/ 2.1.197（Linux），行为强耦合：JSONL 格式 / resume 语义 / 旗标名 / `/context` 输出 / hooks 回调。
- 直接 spawn 报 "Not logged in"：`~/.claude/settings.json` 的 env 块**必须显式注入子进程**（密钥只进内存）。
- `--resume <id> -p` 追加写原 JSONL、不新建文件；`stream-json --verbose` 行序列：init（含 session_id）→ assistant → post_turn_summary → result。
- `/context` 在 `-p` 模式可用；statusline 方案勿用（仅交互会话触发、不热加载）。`claude://` deep link 被官方 Store 版接管（Phase 4 走 UIA）。Cowork 存储（`local-agent-mode-sessions/local_*.json`）字段齐全（Phase 3 可开工）。
- **Linux**：普通用户跑（root/sudo 拒跑 skip-permissions，runner 已前置拦截）；先写 settings.json 再起桥仍为佳（env 缺失已可自愈，但空窗期 run 报未登录）；递归 fs.watch 在 Node ≥20.13 可用；`*.sh` 已由 .gitattributes 钉 `eol=lf`。

**转录格式**

`~/.claude/projects/<工作区slug>/<sessionId>.jsonl`（追加式）；slug：`D:\foo\Bar` → `D--foo-Bar`。adapter 消费：

- `user`：**人机判定按内容**——含 tool_result 块即机器回合（origin 不可靠，tool_result 行 origin 为 null）；压缩续传（`isCompactSummary:true`）与技能注入（纯 text 数组 + 首段 "Base directory for this skill:"）折叠为标记；**勿按"origin 缺失"折叠**（手机 promptSource=sdk 的消息同样无 origin）；`<command-*>` 信封归一成 `/名 参数`。
- `assistant`：`message.content[]` = thinking/text/tool_use（**tool_use 的 `id` 是结果配对键**）；`message.model` 是显示模型名唯一来源；`message.usage` 是圆环唯一数据源（in/cacheRead/cacheCreate/out）。改动文件 ± 摘要在**解析层**算好随事件下发（`f:[{path,add,del}]`，Edit/Write/MultiEdit/NotebookEdit；v145）——chip 文本 `v` 被 briefJson 截到 300 字符，**勿在前端 JSON.parse(v) 做汇总**（截断串必炸，v145 前超限输入的文件全被静默丢出汇总）。CLI 合成哨兵行（text 精确等于「No response requested.」）= 被杀 turn 的记账（kill 路径/resume 补记），**解析层已折叠**（v158；长回复含该短语不折）。汇总行 ± 点击=`GET /api/sessions/:id/filediff`（v146）——adapter 重读 JSONL **原文**现场合成该文件全部编辑的 unified diff（Write/NotebookEdit 只出新增侧；不读盘故无 cwd 锁；hunk 头数字仅供渲染），前端走 diffDoc 双 tab。
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
