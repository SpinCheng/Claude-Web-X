# rules/wide-layout — PC 双栏/断点/composer 锚定

范围：≥1024px 宽屏布局与 history 语义。断点单点在 `public/app.js`（matchMedia → `body.wide`）。

- ≥1024px 断点由 app.js `matchMedia` 单点驱动 `body.wide`（**CSS 只认类名，勿写重复媒体查询**）；`#detail-main` 包裹右栏主列（窄屏 display:contents 零影响）。
- history：**宽屏切会话 replaceState 不 pushState**、#back 宽屏隐藏；宽屏空态=`updateDetailEmpty`（**provisional 不算空态**）。
- 内容列 860px 居中、气泡绝对上限 620/700；跨断点 resize **必恢复左栏常驻**；**composer 窄屏=视口级 fixed（chat 用 paddingBottom 补偿），宽屏必须转锚 detail-main（absolute bottom）**；focus-visible 只挂 button/[role=button]（**勿挂 input/textarea**）；Ctrl/Cmd+Enter 恒发送。
- 拖宽手柄 `.rg`（#rg-list 260-600 / #rg-ft 180-480，负 margin 叠栏；**手柄 z-index 10 必须压过 ft-drawer z9**；localStorage cr_list_w/cr_ft_w，窄屏必须清内联宽）。
- wide 主滚动器 `scrollbar-width:none`；文件树 ign 无文字标签只置灰（unt 保留琥珀角标）；树图标=文件树语系（文件夹开合双态+按类型 5 族字形，`ftFileIcon` 单色）。
