---
doc_type: issue-fix
issue: 2026-10-19-context-refusal-publish
status: fixed
path: quick
fix_date: 2026-10-20
commit: fe6ca60
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
`update` 通常是同一个模型回复的 `context` 段，fresh 项目也可能是 `fallbackUpdate(ctx)` 生成的占位段；`basisKey`
判据只覆盖 memory 侧。被拒回复的 context 段与 memory 一样，是从更旧的 prompt 快照生成的，所以要么一起发布、
要么一起丢弃；选后者（拒绝态不发布任何一侧，包括占位段）。

## 4. 改动

| 文件 | 改动 |
| --- | --- |
| `extensions/project-context/memory/report.ts` | 新增 `contextWritten = Boolean(update) && !memoryRefused`，作为 context 写入与跳过诊断的门（toast 由 `memoryRefused` 决定）；拒绝态诊断按回复是否带 context / 不可用 / recovered 分支，只说“没有写 CONTEXT.md”，不声称不存在的旧文件、未写的占位符、或 pass 读到的旧快照仍在生效。shape 诊断移到写入之后，用 `wroteContext` 证明占位符已落地；拒绝态不再补缺失分支的 shape 行（不可用分支仍记录）。删除已不可达的 `LastWriteInfo.contextWritten` 与 `staleKeepSentence(true)` 分支；`/memory update` 的拒绝回执改为 warning。recovered 回复的发布线用 "no publishable context section"，不再说"没带 context 段"；没有写入时只说 "this pass wrote no CONTEXT.md"，写了占位符时就说占位符已写，不声称 pass 的快照仍在生效。 |
| `tests/consolidation-test.mjs` | 在既有 mid-call writer 夹具里同时替换 `CONTEXT.md`；断言文件保留竞写者的字节、诊断落盘、且日志不声称 pass 读到的旧快照仍在生效。新增三个 fresh 项目夹具（回复带 context / 不带 context / context 不可用）、两个 recovered 夹具（拒绝 / 发布）、一个 fresh absent 发布夹具和一个 CONTEXT.md 为目录的写失败夹具（断言没有占位符误报）。 |
| `memory/store.ts` | 拒发行去掉 `and the newer content stays effective`：只保留 `the reply was not published`（后续写入者仍可能换掉文件）。 |
| `tests/external-edit-test.mjs` | 两个 T2 子用例（带/不带 context 段）都断言命令回复不声称 context 更新、`CONTEXT.md` 逐字节未动、log 与回复都不含已退役短语；带 context 段时另断言"跳过"诊断。 |
| `docs/architecture.md` | 「consolidation 的安全语义」新增一条：拒绝覆盖整条回复，含 context 段。 |
| `CHANGELOG.md` | v0.4.13 修复条目。 |
| `.codestable/issues/2026-10-03-external-edit-adoption-overwritten/external-edit-adoption-overwritten-design.md` | §2.4 的「拒绝态照写 CONTEXT.md」标为已取代，注明现场事实。 |

## 5. 验证

- `node tests/run-all.mjs`：15/15；`git diff --check` 干净。
- 变异（按最终测试）：把 `contextWritten` 退回 `Boolean(update)`：
  - `tests/consolidation-test.mjs` 红 8 条：mid-call 的 `a refused reply does not overwrite the newer CONTEXT.md`、
    5 条 fresh 诊断/文件断言（带 context / 不带 context / context 不可用）、`a refused unusable context writes no CONTEXT.md`
    与 `a fresh recovered refusal says the reply could not be parsed`；
  - `tests/external-edit-test.mjs` 红 2 条：`CONTEXT.md was left untouched` 与 `the skipped context write is traced`
    （"不声称 context 更新"在变异下仍绿，因为 `staleKeepSentence` 已不再带 context 前缀；这是收窄后的守卫，不是门探针）。
  - 另六条定点变异：恢复旧的 shape 措辞（`no CONTEXT.md was written`）→ 恰红 `a refused unusable context does not claim a placeholder was written` 与 `a refused unusable context claims no previous file`；
    恢复旧的 I1 字面诊断（整条 skip ternary）→ 红 6 个 check / 5 个 fixture（mid-call、fresh carried、fresh absent、fresh unusable ×2、fresh recovered refusal）；去掉缺失分支的 `!memoryRefused` →
    consolidation 红 1 条（`a fresh recovered refusal says the reply could not be parsed`）+ external-edit 红 1 条
    （`reply carries no context section: no published-side missing-context line`）；把 parser 的 raw-string recovery
    退回无条件 → 红 `a nested memory_markdown fails closed` 与 `a non-string field with a nested string also fails closed`；在 recovered 提示后追加 "its object never closed" →
    红 `a cut-off reply says so in errors.log`（发布侧）与 `a fresh recovered refusal says the reply could not be parsed`（拒绝侧）；
    在跳过/形状诊断后追加 "left untouched" → 红 mid-call / fresh unusable 的负断言。
- 正控：同一 fixture 的未竞写路径仍写 `CONTEXT.md`（既有 `CONTEXT.md has the new summary`、
  `the context section is written from the same reply` 用例全绿），证明红灯来自门而不是夹具。

## 6. 非目标 / 残留

- **不重跑** consolidation：被拒的回复丢弃，下一次 pass 从磁盘上的较新 context 重建。
- 拒绝态与写入之间的微窗口（无 CAS）保持既有语义，不新增机制。
- 被拒后 context 最多落后一轮；这是有意的代价，换取绝不覆盖更新的 `CONTEXT.md`。
- **R1（上下文-only lost update）**：本修复用 memory 的 `basisKey` 拒发作为"回复快照已旧"的代理；如果 `CONTEXT.md`
  在模型调用期间被改而 `MEMORY.md` 未变（或回复 semantic-empty/short），`memoryRefused` 为 false，仍会用回复的旧
  context 覆盖新文件。要关掉这一类需要独立的 context basis key（新机制，且与 keep-adoption 的既有测试冲突），
  本轮不做，登记为残留。独立审查（deepseek/deepseek-flash，2026-10-19）亦以 R1 命名此项。
- **R2**：`written` claim 在拒绝时也已置位，紧随其后的 `/memory update` 在 `forceDedupeMs` 内返回 "deduped"；
  这是既有去重行为，不是本修复引入的。（独立审查 R2）
- **R3**：并发 pass 可能在拒绝 pass 与命令读取 `lastWrite` 之间删除它，命令回复退化为 "updated"；既有设计残留。
- **R4**：context 写入不在 memory 锁内、无 CAS；本修复缩小了现场窗口，但没有新增 context CAS。
- **N-H（接受）**：shape 诊断移到 memory 写入之后，若 memory 写抛错，pass 直接进 catch，shape 诊断不再补发；
  失败本身有 errors.log，且 once 标记未消费，后续 pass 可再报。按"不新增机制"接受。
- **R5（已修）**：recovered 回复的 fresh 拒绝/发布诊断曾把"不可解析"说成"没带 context 段"；现按 `recovered` 分支，
  并给 fresh 发布补了"a placeholder context was written"的告知；拒绝态不再补缺失分支的 shape 行（避免同一回复两条互相
  矛盾的记录），recovered 拒绝句改为"could not be parsed / no publishable context section"。不可用分支的 shape warning 在拒绝态仍保留。
- **R6（已修）**：拒绝/形状诊断曾声称 "the previous CONTEXT.md stays effective / is kept and stays stale"，而竞写可能已
  换掉磁盘上的文件；没有写入时只说 "this pass wrote no CONTEXT.md"，写了占位符时就说占位符已写，不再引用 pass 的旧快照。
- **R8（已修）**：`parseConsolidated` 在 JSON 已解析但 `memory_markdown` 不是顶层字符串时仍走 raw-string recovery，
  会把 valid JSON 回复报成"不可解析"并丢掉可用的 context；现在只在 `parsed === undefined` 时 recovery，并加两条
  fail-closed 单测（nested / non-string）。
- **R9（已修）**："the file on disk was left untouched" 在竞写下不成立（另一个写入者可能已换掉文件）；改说
  "this pass wrote no CONTEXT.md"。
- **R7（已修）**：recovered 回复的发布线曾把"对象未闭合"说成"没带 context 段"；现改为 "no publishable context
  section"，refused/published 两侧都钉住；拒绝态不再补缺失分支的 shape 行。
- 拒绝仍是检测器（不阻止其他合法回复发布）；它只决定"这一条回复"两侧都不发布。
