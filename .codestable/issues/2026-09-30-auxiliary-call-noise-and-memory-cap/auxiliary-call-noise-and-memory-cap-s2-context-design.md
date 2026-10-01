# S2 — CONTEXT.md 固定 schema + 每节预算 + 截断标记

`status: implemented-pending-owner-review`
关联：S1/S3（MEMORY.md 固定 schema）见 `auxiliary-call-noise-and-memory-cap-s1-s3-design.md`。

## 问题

MEMORY.md 已有 `memory/schema.ts`（固定小节表 + 开销函数 + 每节预算）与 `memory/document.ts` 的整行裁剪 + 严格截断标记。CONTEXT.md 仍是：

- 小节在 `context-doc.ts` 里硬编码，没有一份可复用的“小节表”；
- 预算只有字段级 cap（`MAX_SUMMARY_CHARS`、`MAX_LIST_ITEM_CHARS`、`MAX_LIST_ENTRIES`），没有每节预算，prompt 也只描述 JSON 键而不给预算；
- 兜底是 `document.slice(0, MAX_CONTEXT_CHARS)`：整行中段被切开且**没有任何标记**，被裁掉的会话状态看起来像完整文档。

## 目标（与 MEMORY.md 同级）

1. **固定小节表**：`memory/context-schema.ts` 导出 `CONTEXT_SECTIONS`，含 heading / description / entry（`summary` | `key_points` | `open_tasks`）/ share（可带 `maxChars`）。
2. **每节预算**：`contextSectionBudgets(cap)` 先扣固定开销再按份额 floor，prompt 与渲染器共用同一张表、同一函数，杜绝“prompt 说一套、渲染剪另一套”。
3. **截断标记**：超预算的小节按整行裁剪（列表先按 `MAX_LIST_ITEM_CHARS` 截单项、按 `MAX_LIST_ENTRIES` 截条目，再丢尾项），`dropped` 以归一化但未 trim 的完整渲染为基准，统计真实损失（含单项 trim 与条目上限），并在文末追加严格标记 `_[context truncated: N characters dropped]_`；导出 `contextTruncationDropped` 供 report 告警（`isContextTruncated` 是其布尔包装，且只认文末最后一行）。

## 设计

固定小节（顺序即渲染顺序，share 之和为 1；`entry` 同时决定取哪个 `ContextUpdate` 字段与按散文/列表渲染）：

| 小节 | entry | share | 说明 |
|---|---|---|---|
| `Summary` | `summary`（prose） | 0.4（另受 `maxChars = MAX_SUMMARY_CHARS` 约束） | 本会话是什么、进展到哪 |
| `Key points` | `key_points`（list） | 0.35 | 值得带下去的事实 / 决策 / 结论 |
| `Open tasks` | `open_tasks`（list） | 0.25 | 未完成工作与约定的下一步 |

- 固定开销 `contextSchemaOverheadChars()` 覆盖：`# Project Context`、`Last updated: <ISO>`、三个 `## 标题` 及其空行、最坏情况的尾部 `<!-- latest-session-title: <160> -->`，以及**截断标记本身**的预留。份额作用在“cap − 开销”上，保证“逐节刚好填满 + 标记”也不超 `MAX_CONTEXT_CHARS`。
- Summary 保留 `MAX_SUMMARY_CHARS=6000` 的字段级上限（`min(份额预算, maxChars)`）：散文摘要天然比列表短，沿用既有上限避免把 CONTEXT.md 撑大；share 是上界。
- 列表先按 `MAX_LIST_ENTRIES=50` 截条目、单项按 `MAX_LIST_ITEM_CHARS=800` 截，再按本节预算丢尾项；`dropped` 以“归一化但未 trim 的完整渲染”为基准，因此单项 trim 与条目上限的损失都会进入标记。最小节预算 > 单项上限，故留下的一项不会单独溢出。
- 渲染器不再有不可达的 `slice` 兜底：构造上 doc ≤ cap；`dropped` 由三个小节求和，>0 才追加标记。
- 向后兼容：CONTEXT.md 仍由本扩展渲染、归档层只读注入；存储读取路径不变（没有“CONTEXT 解析器”，只有 `parse.ts` 的 JSON 对象 fail-closed，继续保留）。

## 明确出范围

- S4（记忆按节优先序丢）与符合度可见性。
- CONTEXT.md 的读取侧修复/迁移：没有历史 CONTEXT.md 解析器，本次不动。
- 把 CONTEXT.md 的 cap 做成可配置（仍固定 `MAX_CONTEXT_CHARS`）。

## 已知残留

- `title` 超过 `CONTEXT_TITLE_CHARS=160` 的截断是元数据裁剪，不计入 `dropped`/标记（一直如此，非本节预算）。

## 测试

新增 `tests/context-schema-test.mjs`：小节表 contract、开销常量、预算公式与缩放、`overhead + Σbudgets ≤ cap` 与 `最小节预算 > 单项上限`（不构造满预算渲染文档）、prompt 注入每节预算、超长 summary/单项/列表/entry cap/fallback 触发标记且损失计数精确、代理项不被切开、标记形状行不误判为真截断、匹配文档无标记、`isContextTruncated` 只认文末严格形状。既有 `sync-test`（50 条上限）、`registration-test`、`index-test`、`consolidation-test` 保持通过。
