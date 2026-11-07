# rules/list-history — 会话列表/归档/历史分页

- **列表交互**：行是真 `<button>`，内嵌交互元素必须用 span（嵌 button 会被 fragment 解析器提出去打碎布局）；右键有选区守卫；**列表行长按不选文本**（`.srow/.pgroup-head` user-select:none，输入框除外）。
- **归档**：纯视图过滤零文件操作（`bridge/data/archived.json`；mergedSessions 带 `archived` 标记）；主列表滤归档、**搜索照常覆盖**（中性「已归档」徽章）；归档页=独立 `.page` 复用 renderRow；**活跃反归档**：转录新 append 或手机发消息自动解除+toast；running 会话 ⋯ 不显示归档项；删除 drop 归档标记。
- **历史分页**：`readTranscript(limit, before)` → `{events,total}`；加载行 `#hist-more` **必须挂 #chat 外**（renderTail 1:1 不变量）；跟手渐显：f=clamp((64−scrollTop)/64) 直驱行高/透明度（**勿加 CSS transition**）；`parseOlderTurns` 纯重放（**勿复用 applyEventToTurns**）；跨页 toolres 先进 `state.orphanToolRes` 暂存、prepend 后回填。
