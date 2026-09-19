---
doc_type: issue-report
issue: 2026-09-19-handoff-adaptive-threshold-semantics
status: confirmed
path: quick
created_at: 2026-09-19
related: [handoff-adaptive-threshold-semantics-analysis.md]
tags: [handoff, adaptive-threshold, budget, diagnostics]
---

# handoff 自适应阈值 auto 项的语义问题报告

触发：owner 复核 v0.1.9 的 `/auto-handoff status`，指出自适应公式的 auto 项
`baseline + keep + min(handoffTargetTokens, conversationRoom/2)`「明显不对」：
auto 应由窗口推导，而不是被绝对值 64k 封顶。

## 现象与证据

- v0.1.8/v0.1.9 的 1M 窗口默认值（keep 20k、target 64k、ratio 0.4、baseline ≈12k）：
  `T0 = max(baseline + keep + min(64k, room/2), 0.4 × window) = max(96k, 400k) = 400k`，
  bound 为 `share`。
- 也就是说，大窗口上 auto 项恒等于 64k，阈值实际由**配置的 ratio** 决定；
  「ratio 是下限」只是文字描述，auto 项没有参与决策。
- 该 `min(S, …)` 形态继承自 pre-v0.1.8 的 target-driven 公式（当时的意图是「不要摘要超过 S」），
  v0.1.8 只把 ratio 改成 floor，没有改 auto 项本身。
- v0.1.8 之前 1M 窗口表现为 64k（6.4%）；v0.1.8 之后表现为 400k（40%，share 主导）。
  两种情况下 auto 项都固定在 64k。

## 范围

- 影响：自适应模式（`handoffAdaptive=true`，默认）的 `targetOlder` 计算、对应状态行文案、
  公式文档与 review skill。
- 不影响：固定模式（`handoffAdaptive=false`）、caps（`summarizer` / `tier` / `usable`）、
  `baseline` / `keep` / 最小 floor、触发与退避逻辑、replay 与摘要调用路径。

## 期望

- auto 是**模型的质量拐点**，按保守拟合曲线：`knee(W) = W − (W − 157K)·σ(ln(W/450K)/0.04)`
  （K 取实测拐点人群中位 p50；Wc=450K 因为 500K+ 的声明实测都虚高），再与窗口末点取小。
- 诚实窗口（≤~400K）取自身边界，450K–1M 过渡，≥1M 饱和 157K；物理下限只在重 baseline 或 W ≲ 116K 时生效。
- `/auto-handoff auto` 不接受参数；`handoffThresholdRatio` 只服务固定模式。
- 公式保持简单（min/max + 既有 caps），caps 只降不升；状态行显示实际摘要量。
