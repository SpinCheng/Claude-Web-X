# rules/transcript-format — 转录 JSONL 格式与解析规则

范围：~/.claude/projects 转录行语义、人机判定、cwd 锚定、改动文件汇总/filediff。解析实现在 `bridge/parsers-cc.js`（纯函数、有单测）+ `adapter-cc.js`（机制见文件头）。

## 文件与行序列

`~/.claude/projects/<工作区slug>/<sessionId>.jsonl`（追加式）；slug：`D:\foo\Bar` → `D--foo-Bar`。`--resume <id> -p` 追加写原 JSONL、不新建文件；`stream-json --verbose` 行序列：init（含 session_id）→ assistant → post_turn_summary → result。

## 行语义

- `user`：**人机判定按内容**——含 tool_result 块即机器回合（origin 不可靠，tool_result 行 origin 为 null）；压缩续传（`isCompactSummary:true`）与技能注入（纯 text 数组 + 首段 "Base directory for this skill:"）折叠为标记；**勿按"origin 缺失"折叠**（手机 promptSource=sdk 的消息同样无 origin）；`<command-*>` 信封归一成 `/名 参数`。**cwd 采集=首见锚定后锁定**（CLI 会把模型 shell 的 cd 写进后续行，「最后胜出」会把 cd 进子目录的会话甩错项目组；锁定值经 `patch.cwdSet` 跨 drain 传递，boot 重放自愈错锚记录）。
- `assistant`：`message.content[]` = thinking/text/tool_use（**tool_use 的 `id` 是结果配对键**）；`message.model` 是显示模型名唯一来源；`message.usage` 是圆环唯一数据源（in/cacheRead/cacheCreate/out）。
- 图片占位符两代（`[Image: source]` 旧式 / 2.1.308 内嵌坐标版）的处理见 [attach-refs](attach-refs.md)；custom-title / write-fence 见 [titles](titles.md)；cost-state 行见 [cost-ctx](cost-ctx.md)；命令块行序四规则见 [commands](commands.md)。

## 改动文件汇总与 filediff

- ± 摘要在**解析层**算好随事件下发（`f:[{path,add,del}]`，Edit/Write/MultiEdit/NotebookEdit）——chip 文本 `v` 被 briefJson 截到 300 字符，**勿在前端 JSON.parse(v) 做汇总**；**汇总只收会话 cwd 锚内的文件**（Temp 等中间件不进；锚=锁定 cwdSet 前缀，大小写随 CI_PATHS——NTFS/APFS 折叠、Linux 严格，与预览守卫同语义；无锚不滤）。
- **公共前后缀行修剪（勿回退）**：`trimCommonLines` 剥离 old_string 里未改动的上下文行（editDelta 与 synthesizeFileDiff 共用 → 列表 ± 与详情 ± 恒等；空串=0 行）。
- synthesize 三禁：**①只收 EDIT_TOOLS 白名单**（Read/Grep 的 input 也带 file_path，混入错位）；**②ctx 行加前导空格**（unified 语义——markdown 列表行自带 `- ` 会被 diffRows 误判 del）；**③filediff 合成与汇总同锚**。
- CLI 合成哨兵行（text 精确等于「No response requested.」）=被杀 turn 的记账，**解析层已折叠**（长回复含该短语不折）。
- 汇总行 ± 点击=`GET /api/sessions/:id/filediff`——重读 JSONL **原文**现场合成该文件全部编辑的 unified diff（Write/NotebookEdit 只出新增侧；不读盘故无 cwd 锁），前端走 diffDoc 双 tab。
