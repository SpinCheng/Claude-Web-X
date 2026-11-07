# rules/preview — 产物预览/#html-prev/渲染态构建器

范围：产物预览管线、全屏预览页、md/csv/json/diff/svg 渲染态、history 语义。机制细节在 `public/js/md.js` 与 `overlays.js` 文件头。

## 预览管线

- 锁会话 cwd 内（resolve+不区分大小写前缀校验）+ 扩展白名单 + ≤2MB；html **默认 text/plain**，仅 `render=1` 且 .html/.htm 才 text/html + `CSP: sandbox allow-scripts`；cwd 外不可预览（by design）。
- 预览失败的 toast 按 HTTP 状态分类文案（403 目录外/404 不存在/413 过大/415 类型）。

## 渲染态

- `.md/.csv/.tsv/.json/.diff/.patch` 与 `.svg` 有渲染态：统一 `md.js` 构建器（**先转义纪律**，机制细节在其文件头）；svg 桥仍回 text/plain，客户端 blob 重定型进 `<img>` 灯箱；diff=**行对模型**双布局同渲染（上下式+并排 grid，纯 CSS 切换）+分块加载（小 diff 零脚本）。
- git patch 散文行（From/index/diffstat/裸 `---`/签名 `-- `）走全宽行，**勿按 `-` 前缀误判为 del；flush 判定只认 `diff --git `/`-- `**。

## #html-prev

- 全屏预览页统一入口（同源链接/产物/附件文本），DOM 嵌在 #detail 内、**必须 `position:fixed; inset:0`**（e2e 有几何断言）；iframe 一律 `srcdoc` 注入 + `sandbox="allow-scripts"`（**勿加 same-origin**——直连 src 的导航会污染联合会话历史）；**每次 open 在已显形的容器内重建 iframe 节点**（display:none 里泡旧的节点合成层卡死，手机持续空白）；关闭只置 `srcdoc=""`。
- 沙箱 opaque origin 下外链 module script 必被 CORS 拦——module 型 SPA 渲染态只剩静态壳，by design；异源链接不拦（新标签）。

## history 三裁定

- pushState 用**唯一 (state,URL)**——`#hp/N` 与 `#s/N`（`state.detailSeq`）皆然，相邻同款条目 Chromium 静默遍历吃掉 back。
- 返回钮/ESC **直接 closeHtmlPreview，勿 fire-and-forget back**；close 时把当前 htmlprev 条目 `replaceState` 原地转 detail 条目（僵尸条目压在 detail 下会吃首按）。
- `#back` 带 250ms 兜底（traversal 被吞则直接 closeDetail）。

助手结论 miniMd 渲染后 `linkifyDom` 生成 `.flink`。
