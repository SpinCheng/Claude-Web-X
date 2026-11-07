# rules/filetree — 项目文件树/文件索引

范围：文件树 UI（手机抽屉/PC 面板）与数据面。机制细节在 `public/js/views/filetree.js` 与 `bridge/lib/fileindex.js` 文件头。

- 手机=右缘遮挡抽屉 82vw+轻 scrim 挂 `#detail`（cwd=会话项目，切会话跟随重建；**不动 history**、收起即销毁；右缘拖拽收起见 filetree.js，宽屏面板形态不参与）；PC=第三栏（`body.wide` 下转 static 列、scrim 隐；localStorage `cr_ft_panel` 记开关、**只由用户显式开关写入**）。
- 数据面=`GET /api/sessions/:id/tree`，细节在 lib/fileindex.js：readdir 磁盘真相 + git **仅标注层**（tracked=纯 index，**勿用 --others 混合索引**；「git 视角不筛 git」；全状态着色 del 红/mod 琥珀/add·unt 绿/ign 置灰，目录聚合取后代最强态；**幽灵行**=磁盘上已不存在的删除项，del 行禁预览/插入）；状态与索引缓存同源 3s TTL（`clearIndexCache` 双清）。
- 点文件=previewArtifact 管线全复用；⋯/右键（span role=button）=预览/插入 @/复制路径/复制文件名（**复制走 clipboard 竞速 1.2s+execCommand 兜底**——LAN HTTP 无 clipboard API；row-actions 气泡壳复用）。
- 护栏：单层 >500 截断、深度上限 12、目录计数=索引推得不触盘。
