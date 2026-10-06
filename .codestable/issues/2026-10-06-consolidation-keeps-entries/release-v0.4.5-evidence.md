# v0.4.5 发布证据

日期：2026-10-06
范围：issue `consolidation-keeps-entries` 的**策略修复**——段配额降为目标值，硬约束只剩文档上限；渲染器的池
按文档真实 body 计量。

## 提交与标签

| 项 | 值 |
| --- | --- |
| 策略修复（第一版） | `e2184af`（借用分配器；第 1 轮评审判 CHANGES-REQUESTED） |
| 池口径修正 + 全轮收口 | `59a53a4`（`memoryStructureOverheadChars()`；报告措辞分流；提示补条目形状；矩阵/记录更正） |
| 会话快照 | `14aac0c`（CONTEXT.md，与评审冻结树逐字节一致） |
| tag 对象 / peeled / 双远端 | 见「发布后补记」 |

## 独立评审（lane A，`deepseek/deepseek-flash`，/tmp 冻结沙箱，只读）

| 轮 | 冻结点 | 判定 | 抓到的东西 |
| --- | --- | --- | --- |
| R1 | `ae857ab` | **CHANGES-REQUESTED / RELEASE-OK: no** | B1：池用 `Σtargets`（31,922）而非真实 body（31,933），本仓提交的记忆仍被丢 3 条（文档余 7 字符）；I1：仅单项截断也报「到达文档上限」并指向不存在的 dropped 列表；I2：「剩余 1–3 条」归因不成立（模型整篇重写占主导；不带 `- ` 条目的回复走 opaque 绕过分配器）；N1–N6 |
| R2 | `59a53a4` 树（提交结构见上表，`git diff` 为 0） | **CHANGES-REQUESTED / RELEASE-OK: no** | I1：命令回复（`/memory update` → `consolidateReply`）仍把「仅单项截断」报成「到达文档上限」并指向不存在的 dropped 列表（自动 toast 与 errors.log 已分流，命令路径漏了）；nit：边界注释算术、M2 变异写法歧义、数字口径未统一、CONTEXT 状态过期。B1 修复经其独立复核通过（`memoryStructureOverheadChars` 与渲染器实际结构逐一致；M3 恰丢那 3 条） |
| R3 | 本轮收口后的 REV | 见「评审 R3」 | — |

评审的独立复核（R1）本身很有价值：50,000 组随机输入上分配器语义与自写参考实现一致；两次真实 pass 分别
−4 与 −17 条，其中一次证明 opaque 路径能让分配器整段不执行。

## 机制与证据

- 借用分配器：每段先取 `min(需求, 目标)`，余量入池，超额段按超额比例借用；池覆盖超额时**精确等于**超额 → 0 丢弃。
- 池 = `cap − memoryStructureOverheadChars()`（= 67：header + 每段 `## H\n` + 段间分隔）；`Σtargets` 比它小 11
  （schema 保守多留 9 + floor 余数），这正是 B1 的来源，已在技能 5b 与 attention 里记成教训。
- 提交版记忆（138 条 / 31,993）：canonical 67 + 31,926 = 31,993 ≤ 32,000，`droppedItems=0`；借用 1,071/239/544，
  Project 让 1,850。
- 变异矩阵（复核后）：M0 0 红；M1 借用关掉 6 红；M2 `min(over, pool)` 1 红（上限属性）；字面 `extra = over` 5 红；M3 池回 `Σtargets` 1 红（边界钉子）；
  M4 每项上限回目标 1 红。四格都红在 `sections-test.mjs`，无崩溃。
- 端到端（真实 flash，现场输入）：渲染器 0 丢弃；既有事实净变化 −1/−3（本次两次）与 −4/−17（评审两次）。
  **归因**：剩余损失**主因是模型自身整篇重写/合并/删除**（一次 39 条 exact-match、净 −17），其次是记忆贴上限
  （余 7 字符）与 opaque 回退路径（提示已补 `- ` 条目形状要求）。

## 记名残留

- **待 owner 定**：抬 `maxMemoryChars`（`/memory max-memory <n>`，每会话多约 1,000 tokens 注入）或人工裁剪一次记忆。
- 模型每轮自行删除/改写属提示层与模型能力边界，若要进一步收紧需独立议题。
- CONTEXT.md 仍按段裁剪（有 truncation marker + 日志），是每轮重写的会话状态，不属同一故障。

## 发布后补记

见紧随其后的 `docs(records)` 提交（tag 对象、peeled、pin 提交、安装副本 HEAD/describe、到位抽检、副本地测）。
