---
doc_type: issue-fix
issue: 2026-10-19-context-refusal-publish
status: fixed
path: quick
fix_date: 2026-10-19
commit: 11bd38a
tags: [memory, context, refusal, lost-update]
---

# 被拒绝的 consolidation 回复不再发布 context 段

## 1. 结论：算 bug（lost update）

`errors.log` 2026-10-19T08:27:10.767Z 的拒发回复同时在同秒（`.770Z`）写出了 `CONTEXT.md`，把上一轮
（`b20c8cf`，07:23Z）手工收敛的 3 条 open tasks 覆盖回 9 条旧清单中已核实的已完成项。拒绝态"memory 不发布、
context 照写"是设计 §2.4 当时的刻意选择，但该回复与 memory 同出于更旧的快照，context 段并不比 memory 新：
它没有 basis 判据，于是构成一次对 `CONTEXT.md` 的 lost update。按仓库自己的不变量「nothing publish-side runs
on refusal」，context 写入也应被拒；本次把它纳入拒绝面。

## 2. 现场事实

- `errors.log` `2026-10-19T08:27:10.767Z`：`the memory changed while this pass's reply was being built; the reply was not published...`
- `MEMORY.md.memory-backup-2026-10-19T08-27-10-705Z-28911f0e` 与当时的 `MEMORY.md` 逐字节相同
  （md5 `2dbfebb...`），说明写路径在拒发前刚备份了未被改动的存储。
- `CONTEXT.md` mtime `2026-10-19T08:27:10.770Z`；与 `HEAD` 的 diff 正是"3 条收敛清单 → 9 条旧清单"。
- 之后的一次 pass（`CONTEXT.md` mtime 10:49Z 附近）重新渲染回收敛清单，说明下一次 pass 会从磁盘上的较新
  context 重建；本次修复让被拒的这一次不再覆盖它。

## 3. 机制

`memory/report.ts` 的 `consolidate()` 在 `memoryRefused === true` 时仍执行 `if (update) writeAtomic(contextFile ...)`。
`update` 来自同一个模型回复；`basisKey` 判据只覆盖 memory 侧。被拒回复的 context 段与 memory 一样，
是从更旧的 prompt 快照生成的，所以要么一起发布、要么一起丢弃；选后者（拒绝态不发布任何一侧）。

## 4. 改动

| 文件 | 改动 |
| --- | --- |
| `extensions/project-context/memory/report.ts` | 新增 `contextWritten = Boolean(update) && !memoryRefused`，作为 `lastWrite.contextWritten`、toast 与写入的唯一门；拒绝态写一条 `the refused reply's context section was not published; the previous CONTEXT.md stays effective` 诊断。 |
| `tests/consolidation-test.mjs` | 在既有 mid-call writer 夹具里同时替换 `CONTEXT.md`；断言文件保留竞写者的字节、且诊断落盘。 |
| `tests/external-edit-test.mjs` | 两个 T2 子用例（带/不带 context 段）都断言命令回复不声称 context 更新、`CONTEXT.md` 逐字节未动；带 context 段时另断言"跳过"诊断。 |
| `docs/architecture.md` | 「consolidation 的安全语义」新增一条：拒绝覆盖整条回复，含 context 段。 |
| `CHANGELOG.md` | v0.4.13 修复条目。 |
| `.codestable/issues/2026-10-03-external-edit-adoption-overwritten/external-edit-adoption-overwritten-design.md` | §2.4 的「拒绝态照写 CONTEXT.md」标为已取代，注明现场事实。 |

## 5. 验证

- `node tests/run-all.mjs`：15/15；`git diff --check` 干净。
- 变异：把 `contextWritten` 退回 `Boolean(update)`：
  - `tests/consolidation-test.mjs` 恰红 1 条（`a refused reply does not overwrite the newer CONTEXT.md`）；
  - `tests/external-edit-test.mjs` 恰红 4 条（两个子用例的 context claim / untouched / skip trace）。
- 正控：同一 fixture 的未竞写路径仍写 `CONTEXT.md`（既有 `CONTEXT.md has the new summary`、
  `the context section is written from the same reply` 用例全绿），证明红灯来自门而不是夹具。

## 6. 非目标 / 残留

- **不重跑** consolidation：被拒的回复丢弃，下一次 pass 从磁盘上的较新 context 重建。
- 拒绝态与写入之间的微窗口（无 CAS）保持既有语义，不新增机制。
- 被拒后 context 最多落后一轮；这是有意的代价，换取绝不覆盖更新的 `CONTEXT.md`。
- 拒绝仍是检测器（不阻止其他合法回复发布）；它只决定"这一条回复"两侧都不发布。
