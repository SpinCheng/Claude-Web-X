# rules/titles — 标题/改名/write-fence/分支标题

- 列表标题截取自首条 user 文本（记录带 `titleFallback` 标记）。真标题=转录 `custom-title` 行：手动改名与 titlegen 自动标题**共用 `appendTitle`+`pinRename` 写入路径**（行尾无 `\n` 先补；不 bump lastActive；钉防 Desktop 回写）。
- 打开中的详情页标题实时更新走双路：sessions 帧 → renderMeta（主）+ append `k:'title'` 事件直写 `d-title`（兜底，append 帧只达订阅者）。
- 自动标题：手机新建会话首跑结束由 `titlegen.js` 一次性 `-p` 生成（机制见其文件头；cfg `titleGen`=false 关）。
- **write-fence**：改名钉只被**活流**（emitAppends=true 的 drain）解除；boot 重放/readTranscript 无权解钉或夺标题。判定实现在 parsers-cc.js `fenceTitle`。
- **分支标题必须钉**：`titleFork` 经 `pinRename(newId, title, prev=源标题)`——fork 转录是父会话拷贝，CLI 每次 resume 会回显缓存的父标题覆掉 Fork- 前缀；显式 prev 让 fence 确定性命中 stale 分支（记录解析竞态下记录读不可靠）。
