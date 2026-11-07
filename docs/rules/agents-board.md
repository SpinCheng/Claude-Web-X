# rules/agents-board — 子代理直播/活动悬浮件/待办板

## 子代理直播

- adapter 递归 watcher 里 `subagents` 路径段**路由进 tracker、绝不进会话体系**（`_ensureSession` 双保险）；归属/完成信号/boot 重放机制见 agents.js 文件头。
- 前端硬规则：帧到达=**就地 patch DOM，不碰 renderTail**（未渲染才走 renderTail）；一切时长=startedAt..finishedAt（**完成态冻结，勿用 Date.now() 滴答**）；`#agent-sheet` 全宽 sheet 复用主视图节点渲染。

## 活动悬浮件

- `#act` 挂 `#detail-main` 子节点（**勿移出 detail-main**——否则文件树面板/抽屉打开时胶囊落进面板区域；非 #chat 子节点——renderTail 1:1）；**非模态**（无遮罩、不拦会话交互），胶囊/面板两态互斥。
- 待办板=桥侧状态机（parsers-cc `applyBoard`：Task* 增量+TodoWrite 全量；**真实枚举无 cancelled，deleted=移出板**；**批次周期**：上一批全部 completed 后的新 TaskCreate=新周期、历史完成项清出板，部分完成时的新 create=同批补充不清；TodoWrite 覆写天然独立；转录内历史节点逐事件渲染不受板影响）。
- 快照走解析层 `tb` 字段随 messages + `tasks` 帧下发，前端禁 parse chip；**-p 无 Task*/TodoWrite 工具**——待办数据只来自 TUI/桌面会话转录。
- 转录待办节点**静态渲染**（badge「待办」，TaskUpdate 一行无展开体，进行中=珊瑚无呼吸灯——活态动画专属运行中代理）。
