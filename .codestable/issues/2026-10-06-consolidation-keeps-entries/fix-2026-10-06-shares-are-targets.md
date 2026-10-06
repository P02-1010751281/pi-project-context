# 修复：段配额降为目标值，硬上限只剩文档上限

日期：2026-10-06
前置：`acceptance-2026-10-06-v0.4.4-not-met.md`（v0.4.4 的提示层修复不足，四次真实 pass 各丢 10–15 条）
改动：`memory/sections.ts`（渲染器）、`memory/schema.ts`（精确结构开销）、`prompt.ts`、`pass.ts`、`report.ts`
状态：已实现并收口第 1 轮评审（`CHANGES-REQUESTED` → 见 §5）

## 1. 决策

owner 定：**「总的不超配额就行；四段的数字本来就是预估」**。share 从「硬配额」降为「目标值」，唯一硬约束是
文档的 `maxMemoryChars`。

## 2. 机制

渲染前先分配（`allocationFor(targets, wanted, body)`）：

1. 每段先拿 `min(需求, 自己的目标)`——用不完的进池；
2. 池按各超额段的**超出量比例**分配（`floor(池 × 超额 / 总超额)`）；
3. 池覆盖全部超额时，比例分配**精确等于**各自超额 → 一条不丢；池不够（文档真的满）才丢条目。

**池的口径是文档自己的 body**：`cap − memoryStructureOverheadChars()`（header + 每段 `## H\n` + 段间空行 = 67），
**不是 `Σtargets`**。这一点是第 1 轮评审的 blocking 发现：`Σtargets`（31,922）比真实 body（31,933）小 11 字符
（`memorySchemaOverheadChars` 出于保守多留 9，加上 floor 余数），于是「文档还有 7 字符余量却丢 3 条」——
**正是本次要修的那类错误的翻版**，而且最先打在本仓自己提交的记忆上（那 3 条分别是 inject 指针条目、
skill-candidates 条目、attention.md 指针）。`text.length <= cap` 仍由构造保证。

## 3. 钉子与变异矩阵（`tests/sections-test.mjs`，单侧改动后还原）

| 变异 | 红点 |
| --- | --- |
| M0 未变异 | 0 断言红，套件 15/15 |
| M1 借用关掉（回到硬 share） | **6 红**：4 条借用断言 + `a document that fits the cap never drops (4 violations of 2000)` + `content that fits the cap but exceeds the target sum keeps every entry` |
| M2 `extra = min(over, pool)`（取自自己的超额，池不随领取递减） | **1 红**：`2000 random caps all fit`（worst margin 随机，−2634…−3232） |
| M2' 字面忽略池：`extra = over` | **4 红**（3 条确定性 + cap 属性，worst margin −10558） |
| M3 池用 `Σtargets` 而不是真实 body | **1 红**：`content that fits the cap but exceeds the target sum keeps every entry`（这条就是 B1 的钉子） |
| M4 每项上限用目标而非借用后额度 | **1 红**：`a borrowing section keeps a longer entry whole` |

两条属性断言（各 2,000 组随机）：内容装得进 cap 就**必须 0 丢弃**；任何输入**不得超过 cap**。
`tests/consolidation-test.mjs` 的 errors.log 读取改为 `errorLogText`（缺文件按「没有日志」判，不再 ENOENT 崩掉整个文件，
否则变异矩阵会以崩溃而不是断言红呈现）。

## 4. 端到端实测（真实 flash 辅助调用，现场输入）

| | 改前（v0.4.4） | 改后（v0.4.5） |
| --- | --- | --- |
| **渲染器**在提交版记忆上的丢弃 | 3–9 条（3 段超配额） | **0 条**（current 版：借 1,071/239/544，Project 让 1,850；canonical 67+31,926 = 31,993 ≤ 32,000） |
| 真实 pass 的**既有事实**净变化 | 每轮丢 7–15 条 | 样本：−1 / −3（我的两次，exact-match 口径）与 −4 / −17（评审的两次，含一次走 opaque 路径） |

**改后仍有的损失，归因要诚实**（第 1 轮评审 I2 推翻了初稿的归因）：

- **主因是模型自己的整篇重写**（合并、改写、删条目），不是渲染器：评审两次真实 pass 里，一次回复**不带 `- ` 条目**
  → `sectionsFromMarkdown` 判 undefined → 走 **fallback-opaque**，新分配器根本没执行，guard 记 "did not produce sections"；
  另一次走 sections、**渲染 0 丢弃**（分配器正常），但 guard 记 `memory regression: 39 …`、净条目 138 → 121。
  guard 的 exact-match 口径会把改写/合并算成删除（高估），但净条目 −17 说明模型确实在大删。
- **记忆贴上限是次要但真实的条件**：31,993 / 32,000（余 **7** 字符），模型每轮新增都会把回复推过上限，于是要么它自己删、
  要么重试压缩、要么渲染器补刀。彻底不丢要么抬 `maxMemoryChars`（每会话多约 1,000 tokens 的注入），要么人工裁剪一次。
- 已顺手减少一条 bypass：提示现在明说 `memory_markdown` 里每条要写成 `## <section>` 下的 `- ` 条目（写成普通行就会
  整篇 verbatim 存下、跳过所有分段账目）。

## 5. 第 1 轮评审的收口

| 编号 | 内容 | 处置 |
| --- | --- | --- |
| B1 | 池用了 `Σtargets`（31,922）而非真实 body（31,933），本仓记忆仍被丢 3 条 | 已修：新增 `memoryStructureOverheadChars()`（精确 67）并只用于渲染器；新增边界钉子（M3 可红） |
| I1 | 只有单项截断时也报「document reached its cap」，并指向不存在的 dropped 列表 | 已修：丢弃与截断分句，日志/提示/状态句按原因分流 |
| I2 | 「剩余 1–3 条」归因不成立（模型重写占主导 + opaque bypass） | 已改：见 §4；提示补 `- ` 条目形状要求 |
| N1 | 变异矩阵记录与实测不符（含 ENOENT 崩溃） | 已改：本文表格为复核后的数字；测试加 `errorLogText` |
| N2 | 旧策略残留文案（pass.ts、report.ts、测试 label、CONTEXT.md 验收句） | 已改 |
| N3 | 属性钉子跳过了 bug 区域（前提算术错） | 已改：前提改为「canonical 文档 ≤ cap」，并加边界 fixture |
| N4 | 借用数字口径不一致 | 已改：本文数字按渲染器口径（条目花费，不含 `## H\n`）复算 |
| N5 | `itemTruncated` 含「截断后又被丢」的条目 | 已改：句子写作「were cut to their section's per-item cap (a cut entry may also be dropped)」 |
| N6 | `MIN_SECTION_BUDGET_CHARS` 不可达、CONTEXT.md 边界 | 复核成立（生产路径 cap ≥ 4000），无需改 |

## 6. 剩余项（给 owner）

- 记忆贴着上限（余 7 字符）：抬 `maxMemoryChars`（`/memory max-memory <n>`）或人工裁剪一次，二选一，已记
  `.codestable/attention.md`。
- 模型每轮的自行删除/改写是主要损失源：这属于提示层与模型能力的边界（v0.4.4 已把「删」改成「压」），
  若要进一步收紧需独立议题。
- CONTEXT.md 仍按段裁剪（有 truncation marker + 日志）且是每轮重写的会话状态，不属于同一故障。
