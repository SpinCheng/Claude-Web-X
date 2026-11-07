# rules/attach-refs — 附件/图片占位符/@ 远程引用

范围：附件上传管线、CLI 图片占位符、@ 引用选中/代附/回显折叠。数据面机制见 `bridge/lib/fileindex.js` 文件头。

## 附件与图片

- 图片走 `--input-format stream-json` stdin 图片块（**stdin 写完必须保持打开**，立即 close 挂死 CLI）；文本类 ≤24KB 内联进 prompt；输入框 Ctrl+V 粘贴文件=走附件管线（截图/资源管理器复制直传）。
- CLI 图片占位符两代都在解析层处理：`[Image: source]` 旧式独立行=折叠；2.1.308 `[Image: original WxH, displayed at WxH. Multiply coordinates…]` **纯标记独立行**=tool_result 图片的合成回显（模型自己 Read 图片也产生）折叠，**内嵌式（人类消息）逐字原样显示——用户裁定：我的输入是文本，绝不剥离/改写/占位符化**。
- 乐观孪生去重走标记不敏感比较（`sameUserText`，折叠时采纳转录原文保持重放一致）。正则锚定完整机器格式防引文误伤。

## @ 远程引用

- 数据面=`GET /api/sessions/:id/files` + 发送代附（词边界扫 @token→cwd 守卫→文本 ≤24KB 内联/图片 ≤2MB stdin/其余降级纯路径，上限 4、原文逐字不动），细节在 lib/fileindex.js 文件头；白名单 `bridge/data/file-index-include` **逐行 `--exclude=` 直传——`--exclude-from` 否定压不过 .gitignore，勿回退**。
- 前端：**选中=固定 dock 标签**（`#at-chips`，/ 命令 chip 同款：✕ 删除、发送即消费、失败路径恢复；发送时前置组合 `/名 @ref 正文`）；**呈现=行卡 `.at-ref`**（icon+文件名亮/路径灰双行；dock 标签/气泡引用同构，卡点=预览；手输 @path 同套卡、不经标签照常代附；文件树 insertRef 同一标签语义）；ftFileIcon 从 filetree.js 导出共享（函数级循环，求值期零交叉；测试桩需 dataset）；**无命中=收起菜单不出空态列表**（用户裁定，/ 菜单同款——文本照常原文发送）。
- **回显折叠**：runner 代附内联块标签 `[引用 @path]`（上传附件=`[附件 name]`）——解析层以**首个 `\n\n[引用 @`/`\n\n[附件 ` 词法切分**：标记前文本=气泡（乐观孪生因此仍精确匹配）、其后=机器附录折叠成 `k:'attref'` 标记行（sysline「已随消息附上 N 份」）；正文撞完整机器格式≈主动伪造，勿加武装/解除机制。
