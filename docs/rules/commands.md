# rules/commands — 斜杠命令/命令块解析

- 菜单=`GET /api/sessions/:id/commands`（内置白名单 `lib/commands.js`，收录标准=supportsNonInteractive + `-p` 冒烟实证；+自定义命令发现，项目覆盖用户；+技能发现 `~/.claude/skills` 与 `<cwd>/.claude/skills` 的 `<名>/SKILL.md`，行尾 kind 徽章）。
- **派发=普通消息**（`/名 参数` 直走消息链路，无多命令合并）；未知命令=当纯文本发模型。

## 命令块框架（勿逐命令打补丁）

四条硬规则（转录行序见 parsers-cc.js 注释）：

1. stdout 提取必须在 stripReminder **之前**（后者整块删空）。
2. `_cmdEnv` **武装必须在事件返回处**（中段武装自噬）。
3. 展开体=武装后紧邻的下一条纯文本 user 行折叠；user 载体 stdout 与任何非 user 行**到达即解除武装**（防吞用户真消息）。
4. 展开体检查必须在 stdout/caveat/hook 拦截**之后**。

## clear

- 信封/stdout 落新会话文件、新 sid 走 runner adoption；旧文件仅追加记账行；派生会话**无 custom-title**（标题 fallback 显示 `/clear`）。
- **`clear` 已移出内置菜单**（与新建会话重复、mid-run 会话切换跟踪面大）——手输 `/clear` 仍会被 CLI 执行并重置进新转录文件，app 保持旧视图不跳转，by design 勿再修。
