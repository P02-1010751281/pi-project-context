# 第 15 轮之后的修复（v0.4.9）

第 15 轮独立审查（冻结修订 `5f76996` / v0.4.8，`deepseek/deepseek-flash` + `high`）给出 CHANGES-REQUESTED。逐条处置在
`.codestable/issues/2026-10-06-handoff-shutdown-coupling/shutdown-flush-review-report.md` 的「第 15 轮处置」节；本文记本 issue 范围内的代码改动。

## 为什么（现场事实）

现场（Quantum_Matrix 2026-10-08）是「重推理 route + cap 装不下」：一次请求 32210 输出 token 里 20489 花在隐藏思考。
v0.4.8 让 cap 门把 reasoning 预留算进估算，但**取值取错了对象**：两个调用点读 `ctx.model.reasoning`（会话模型），
而调用其实走 `resolveAuxModel(ctx, config)` 解析出的辅助路由 ⇒ 只要用户把辅助路由指向重推理模型，门就静默漏报 —— 与现场同一失效模式（静默）。

## 改了什么

| 文件 | 改动 |
| --- | --- |
| `shared/llm.ts` | 抽出 `auxRouteFor(ctx, config)`（不告警的路由决策），`resolveAuxModel` 在其上加一次进程内去重的 dead-route 告警，新增 `peekAuxModel` 只返回模型 |
| `index.ts`、`memory/report.ts` | 两个 cap 门调用点改读 `peekAuxModel(ctx, config)?.reasoning`，注释写明「取调用真正用的路由」 |
| `shared/output-budget.ts` | `capCeilingWarning` 的可见句改 `plus a reserve of about N tokens`：预留是首次尝试的估算（现场实测 20489 ≫ 8192），不是界 |
| `autolearn/pass.ts` | 裸 `/autolearn`（强制 pass）在辅助调用前提示 `Autolearn: distilling this project's sessions…`，与 `/memory update` 的提示同源同因 |
| `tests/harness.mjs` | 默认 `modelRegistry` mock 补 `find`（真实 pi API 有它；此前只 mock 了 `hasConfiguredAuth`，状态读一旦查注册表就崩） |
| `tests/memory-ops-test.mjs` | M4b：`status` 与 set-time 两个入口各一条断言 + 正向对照（清空辅助路由后同一 cap 静默）+ N-4 措辞断言 |
| `tests/autolearn-test.mjs` | G2：断言 `complete` 被调用那一刻提示已在通知里 |

## 变异结果（每条守卫恰红 1 条目标断言）

| 变异 | 结果 |
| --- | --- |
| `index.ts` 调用点退回 `ctx.model?.reasoning` | 红 1：`status charges a configured reasoning aux route` |
| `report.ts` 调用点退回 | 红 1：`the set-time warning charges the same route` |
| 删 autolearn 前置提示 | 红 1：`the forced pass announces its wait before the call` |
| `reserve of about` 退回 `up to` | 红 1：`the warning calls the reserve an estimate, not a bound` |

## 登记的非目标

- **R-A（第 15 轮）**：结构测试接受面偏宽 —— 带一条 `- ` 条目 / 围栏 / 任意 `# 标题` 的散文仍能替换四节文档。这是第 14 轮 B1 指定的判据，文档如实写了接受面，更窄的判据没有现场事实支撑 ⇒ 非目标；重开条件＝出现「带 bullet 的会话回复替换了整篇记忆」的现场。
- **R-B（第 15 轮）**：重试对被**请求上限**封住的配置补不上差额（仍可在裁短后的正文上成功，只是 `clipped`）（现场需约 53.5k、上限 32768）⇒ 那类配置靠抬高上限或换辅助路由（本次已把该项目的 `maxOutputTokens` 提到 131072）。
