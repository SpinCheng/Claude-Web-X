# rules/cost-ctx — 费用面板/结算速率/上下文口径

## 转录行事实

- `cost-state`：聚合全部模型、**不覆盖** model 标签；相邻快照折叠保末值。

## 费用面板

- **零价表设计**（官方无价格 API）：官方口径=cost-state 原值 / 倍率 / 自定义分模型单价；价格偏好存 localStorage 不进桥；**时间轴不渲染成本快照行**（$ 数字只经 header 入口/面板，数据走 sessions 帧）。
- **结算输出速率**：解析层按 assistant 行累加、按 `message.model` 分桶、随 cost-state `stats.rate` 下发（零新端点/帧）；**去重两律（勿回退）**：①同一条 API message 被 CLI 拆成多行（id 相同、每行重复整条 usage）——按 `message.id` 分组，out 只在组首计一次、间隔=基点→组末收口（`commitRateGroup`，组边界链式推进基点防重叠；无 id 按单行组，无 ts/非正间隔整组跳过）；②CLI 会把同 message 的后段 tool_use 写在 tool_result **之后**——已提交组的同 id 迟到片段整行跳过（`_rateSeen` 有界表 >2048 清零），否则 out 与工具时长双双重复。
- **展示（用户裁定）**：面板全宽速率卡——卡头总均值大数字+计时/总量（**分子走 cost-state outTok 与五格恒等，最近一轮不进速率；分母=解析层 Σms**），分模型相对速率横条、**最快模型数值珊瑚高亮**；单模型退化只有卡头。
- **实时速率不做**（裁定；真要做归宿=run-status 行）。
- **债会话认账不动**（裁定）：老会话账本有历史债（同模型多键并存、早年杀 run 少记/倒退）——**不修不改不特判**，面板数字即官方账口径。

## 上下文口径

- 圆环/明细 = `(in + cacheRead + cacheCreate) / 窗口`（与 CLI 一致）；窗口：探针实测优先，fallback 按 model id 含 `[1M]` 推 1M、否则 200k；明细分类表驱动 `CTX_CATS`；模型目录读 settings.json env 的 `ANTHROPIC_DEFAULT_*`。
