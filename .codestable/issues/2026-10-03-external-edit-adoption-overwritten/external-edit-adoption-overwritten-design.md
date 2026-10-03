---
doc_type: design
issue: 2026-10-03-external-edit-adoption-overwritten
status: draft
created_at: 2026-10-03
related: [external-edit-adoption-overwritten-report.md, repro-write-ordering.mjs, ../2026-09-30-auxiliary-call-noise-and-memory-cap/over-cap-reply-persistence-fix-note.md]
tags: [memory, memory-journal, external-edit-adoption, lost-update, write-ordering, consolidation, design]
---

# 外部编辑采纳后被旧内容覆盖 修复设计

问题与证据见 `external-edit-adoption-overwritten-report.md`；本文件只写**怎么修**。
owner 2026-10-03 定调：**选 C，且取最彻底形态**——不是"跳过旧回复"，而是"判为陈旧 → 不写 →
**用采纳后的内容重跑一轮 consolidation**"，并让日志说真话、丢弃的模型工作留档。

## 1. 目标

1. **外部编辑在任何时序下都不被顶掉**：手改、`git checkout` 恢复、旧版本 build 写入，都不再被
   "由更旧快照生成的回复"覆盖。
2. **不白扔模型工作**：判为陈旧时，本轮 consolidation 的结果应被重跑替代，而不是直接丢弃。
3. **丢弃与采纳都可见**：日志陈述**结果**而不是意图；被丢弃的回复有本地留档。
4. **常态零变化**：没有外部编辑时，写入路径的行为与现在逐字节一致。

## 2. 硬约束

- 零新依赖（项目无 `package.json`），只用 Node 标准库与已暴露的 pi-ai 能力。
- 不改外部文件格式：产物仍是 `# Project Memory` + 四节 Markdown。
- **读侧不动**：`loadMemory` 的「render 更新且与 fold 不同」规则、`foldMemoryJournal`、
  `normalizeMemoryDocument` 语义不变。
- **单次 pass 的模型调用有界**：≤ 2 次（首次 + 最多 1 次重跑），不得出现"每轮都重跑"的活锁。
- **重跑必须在锁外**：`shared/lock.ts:179` 的 `withMemoryLock` 是带等待上限（`MEMORY_LOCK_WAIT_MS`）
  的文件锁，**不可重入**——在锁内重跑会等自己持有的锁直到超时。
- 向后兼容：`recordMemoryDocument` 的既有调用方（`shared/migrate.ts:127`、`tests/memory-ops-test.mjs`、
  `tests/consolidation-test.mjs`）不改也能工作。
- 落地前走 `.agents/skills/pi-project-context-sandboxed-independent-review/SKILL.md` 的沙箱只读
  独立评审（审/校 对，多轮直到每轮 `VERDICT: PASSED`）。

## 3. 现状（代码事实，均已核实）

| # | 事实 | 位置 |
| --- | --- | --- |
| F1 | 一次 `recordMemoryDocument` 调用里**两次 append**：先采纳、再写本次 pass 的 render | `store.ts:68` → `:77` → `:80` |
| F2 | 采纳日志在两次 append **之间**写出，措辞是完成态 | `store.ts:70` |
| F3 | `foldMemoryJournal` 取末条 `replace`，故 `:77` 那条决定生效内容 | `journal.ts:89` |
| F4 | 读取侧在同样条件下返回**外部编辑**，所以 prompt 不陈旧；陈旧的是**模型调用期间**落地的编辑 | `store.ts:114` |
| F5 | 写入是否发生由 `memoryChanged` 门决定 ⇒ 生效条件反转（pass 成功则顶掉，失败则保留） | `report.ts:132` |
| F6 | 现场：QM 142 条 / UF 35 条 `adopted …`；顶掉记录与更早记录**逐字节相同** | 报告第 2 节 |
| F7 | 已确定性复现（脚本退出码 0），`A → B → A` 即兄弟仓库形态 | `repro-write-ordering.mjs` |

## 4. 决策 1：判据用「本次 prompt 的基线内容」，不猜意图

pass 在构造 prompt 前已经读到了记忆（`pass.ts:160` 的 `const existing = await loadMemory(...)`）。
**那正是本次回复赖以生成的内容**。把它的规范化键带出来：

- `ConsolidateOutcome`（`pass.ts:35-52`）新增 `basisKey: string` = `memoryComparisonKey(existing.text, config.maxMemoryChars)`；
  在 `pass.ts:323` 构造 outcome 时填入。
- `recordMemoryDocument` 的采纳分支里已有 `external = memoryComparisonKey(renderRaw, limit)`（`store.ts:63`）。
  **`external !== basisKey` ⇒ 采纳进来的字节比本次回复的基线更新 ⇒ 回复必定陈旧。**

**为什么不猜"是谁写的"**：现有信息（内容不同 + render mtime 更新）**区分不了** owner 的有意编辑与旧版本
build 的退化写入。而这个设计不需要区分，因为两者的正确动作**恰好相同**：

- 对 owner 的编辑：当前行为直接毁掉它 → 必须保。
- 对旧版本 build 的退化写入：该内容无论如何都会成为记忆的当前内容（下一个 pass 读的就是它），
  当前行为（用基线快照的回复顶掉它）并不比"以它为基线重跑"更好——重跑至多把这份内容重新
  consolidate 一次。**取舍**：若外部内容本身是坏版本，重跑会把它固化一轮；这一取舍被明确接受，
  并由日志与留档使其可见，而不是引入一个猜不准的意图判据。

**误报守卫**：若编辑在 pass 读取**之前**就已存在，则 `basisKey === external` ⇒ **不判陈旧**，
走原行为（写入本次 render）。这正是"外部编辑本来就该被 consolidat"的正常情形。

## 5. 决策 2：陈旧时**不写**，保留采纳字节，由调用方在锁外重跑一轮

`recordMemoryDocument` 返回值加宽（原为 `Promise<void>`）：

```ts
export type MemoryWriteResult =
  | { written: true }
  | { written: false; reason: "adopted-newer-external-edit"; adopted: string; discardedReply?: string };
```

陈旧分支的行为：

1. 采纳 append（`store.ts:68`）**照旧执行**——外部字节进历史，这是采纳的意义所在；
2. **跳过** `:77` 的 `appendMemoryOp(rendered)` 与 `:80` 的 `writeAtomic(MEMORY.md, rendered)`；
3. 返回 `{ written: false, reason: "adopted-newer-external-edit", adopted: external }`。

**自洽性（关键）**：采纳 append 之后，journal 的 mtime 比 `MEMORY.md` 新，于是 `loadMemory`
的外链条件（`render.mtime > journal.mtime`）**不再成立**，下一次读取取 fold＝**采纳的内容**。
也就是这次 append 自己就把 fold 更新成了最新真相，**重跑无需任何额外搬运**。

调用方（`report.ts` 的 `consolidate()`）在**锁外**包一层有界循环：

```
attempt 1: outcome1 = consolidateProjectState(force)
           write1 = withMemoryLock(backup + recordMemoryDocument(..., { basisKey: outcome1.basisKey }))
           write1.written === true  → 结束（常态路径，零变化）
           write1.written === false → 记一条明确日志 + 留档被丢弃回复 → 进入 attempt 2
attempt 2: outcome2 = consolidateProjectState(force)      // 新 pass，基线已是采纳内容
           write2 = withMemoryLock(backup + recordMemoryDocument(..., { basisKey: outcome2.basisKey }))
           write2.written === false → **停止**（不再重跑），保留采纳内容，日志说明"重跑仍遇并发外部编辑"
```

**为什么重跑而不是只跳过（原 A 方案）**：只跳过会让本轮模型调用白花；边跑边编辑的场景里
"编辑一次就丢一轮 consolidation" 会累积。重跑把编辑与本轮工作**都**保住。

**为什么上限 1 次**：`callAux` 已有失败退避与路由冷却，重跑本身也要花钱；上限保证收敛。

**记账纪律**：`written` / `lastWrite` / `notify` 只对**最终被采纳的尝试**执行；attempt 1 的
side effect 限定为「采纳 append + 写前备份」（两者都是幂等意义上的无害物）。`report.ts:125` 的
`written.set(projectRoot, outcome.version)` 与 `claimed` 的语义要按最终尝试设置，否则 dedupe 会误判。

## 6. 决策 3：日志陈述结果，不陈述意图

现状（F2）：`adopted an externally edited MEMORY.md into the memory journal` 在覆盖**之前**写出、
完成态措辞，142/35 条，读起来像"编辑已生效"。

**改法（采用 (i)）**：把该行的发出时机移到**决策之后**，措辞含结果：

- 常态（回复已写入）：`adopted an externally edited MEMORY.md into the memory journal; this pass's
  reply replaced it in the same write`
- 陈旧（回复被丢）：`adopted an externally edited MEMORY.md that this pass's reply was older than;
  the reply was discarded and the pass re-run against the adopted memory`
- 重跑仍陈旧：`…; an external edit landed again during the re-run: the adopted memory was kept and
  this pass's reply discarded`

**为什么不用"保留原行 + 新增一条"**：只有一处知道结果，两条并存的现状正是误导的来源。

## 7. 决策 4：被丢弃的回复留档（与 D2 对称）

`saveOverflowReply` 保的是"**被裁剪**的回复"（`1f0672c`）；这里保"**被丢弃**的回复"。
同一模式：写 `.agents/memory/memory-stale-<ISO>.md`（`writeAtomic`、best-effort、失败只记日志、
不阻断主流程），`shared/gitignore.ts` 的 `MEMORY_GITIGNORE_LINES` 增加 `memory-stale-*.md`，
日志点名该文件。

对称性论证：两条路径都遵守同一条纪律——**模型的产出不因流程决策而静默消失**。

## 8. 接口改动

```ts
// extensions/project-context/memory/store.ts
export async function recordMemoryDocument(
  projectRoot: string,
  text: string,
  limit: number = MAX_MEMORY_CHARS,
  options: { preserveMarker?: boolean; basisKey?: string } = {},
): Promise<MemoryWriteResult>;
```

```ts
// extensions/project-context/memory/pass.ts
export type ConsolidateOutcome = { /* 既有字段 */ basisKey: string; };
```

- `report.ts` 的 `consolidate()`：有界循环 + 两种新报告字符串；`ConsolidateReport` 类型若需扩展新值
  （如 `"superseded"`）一并更新。
- `shared/project-state.ts:9` 的 re-export 无需改（只多导出一个类型）。

## 9. 向后兼容

- `basisKey` **省略**（`migrate.ts` 的 legacy 导入、既有测试）⇒ 永不判陈旧 ⇒ 行为与今天完全一致。
- 返回值从 `void` 加宽为联合类型：忽略返回值的调用方不受影响。

## 10. 风险

| 风险 | 说明 | 处置 |
| --- | --- | --- |
| 重跑放大调用量 | 每次"模型调用期间发生外部编辑"多 1 次调用（历史量级 142/35 次） | 上限 1 次；日志可计数；`callAux` 的失败退避/冷却仍生效 |
| 基线比较口径不一致导致误判 | `basisKey` 与 `external` 若用不同 `limit` 规范化，可能假陈旧 | 两侧都用 `config.maxMemoryChars`（同一个值，`pass.ts` 与 `report.ts` 都从 `getConfig` 取） |
| 退化外部写入被重跑固化 | 见决策 1 的取舍 | 明确接受 + 日志/留档可见；不引入意图判据 |
| 重跑期间再次编辑 | 第二次仍判陈旧 | 有界停止，保留采纳内容，明确日志 |
| 备份重复 | 两次尝试各有一次写前备份 ⇒ 多一份 `memory-backup-*` | 接受（备份本就多份）；备选：只在真正写入前备份，但那会改变"写前备份"的既有语义 |
| 锁内重跑自锁 | `withMemoryLock` 不可重入 | 循环写在 `withMemoryLock` **之外**（硬约束） |
| 与 dedupe 冲突 | `written`/`version` 的记账若按 attempt 1 设置，重跑的 pass 会被 dedupe 吞掉 | 记账按最终尝试设置（决策 2 记账纪律） |

## 11. 测试计划

新增 `tests/external-edit-test.mjs`（若与既有文件耦合过多则并入 `tests/consolidation-test.mjs`）：

| # | 场景 | 断言 |
| --- | --- | --- |
| T1 | 无外部编辑（常态） | 回复写入；`written === true`；无重跑（模型调用 1 次）；日志为原措辞 + 结果 |
| T2 | 模型调用期间外部编辑，回复陈旧 | `MEMORY.md` 保持**外部内容**；journal **不含**该回复；发生 1 次重跑；最终 render = 重跑结果 |
| T3 | 编辑早于 pass 读取（`basisKey === external`） | 正常写入；**不**判陈旧；无重跑（误报守卫） |
| T4 | 重跑期间再次编辑 | 恰好 2 次调用后停止；保留采纳内容；1 条明确日志；无第三次调用 |
| T5 | 陈旧分支后的状态自洽 | journal fold == `MEMORY.md`，且都等于采纳内容 |
| T6 | 留档（决策 4） | `memory-stale-*.md` 存在、内容 = 被丢弃回复、gitignore 含该模式、日志点名 |
| T7 | `migrate.ts` 路径 | 不带 `basisKey` ⇒ 行为与今天逐字节一致 |
| T8 | 复现脚本转绿 | `repro-write-ordering.mjs` 的期望改为"外部编辑生效"，退出码 0 |

另有既有 14 个测试文件必须全绿（`node tests/run-all.mjs`）。

## 12. 评审计划

- 沙箱只读独立评审（`pi -p --no-session --no-project-context --no-skills --no-prompt-templates
  --tools read,bash --model commandcode/deepseek/deepseek-v4.1-flash-fast`），审/校 对；
  每轮记录候选定版 md5；零写入证明 = 前后 `git status --porcelain -uall` + `find … stat` 快照
  （`-prune` 掉 `.agents/`，因 `--no-project-context` 仍会在 cwd 建该目录）；
  **空 transcript / 0 字节 = provider 失败，必须重跑，不算一轮**。
- 「一个 PASSED 轮不覆盖其后的改动」：任何 post-PASSED 的改动都要再开一轮。
- 记录归档为 `external-edit-adoption-overwritten-review-report.md`（轮次表 + 残留清单 + 零写入证明）。

## 13. 非目标

- **M / N**（把 opaque 回复迁移到分节路径：重试改目标 / 任意块粒度丢弃）：另立设计，见
  `over-cap-reply-persistence-fix-note.md` 第 5 节第 3 条。
- **D1**（opaque 路径按节丢整条）与 **S4**（分节路径按优先级丢）：前者被 N 覆盖，后者被冻结设计
  列为非目标（`structured-consolidation-output-design.md:401`）。
- 可配置 CONTEXT cap、CONTEXT.md 读侧迁移、归档 vault/加密/上传、autolearn 节流与准入、
  handoff 摘要路径。
- **意图判据**（区分 owner 编辑 vs 旧版本退化写入）：本设计显式不引入（决策 1）。

## 14. 决策记录

- **owner 2026-10-03**：选 **C**（把 pass 的基线带进写入路径，判陈旧后处理），并要求**取最彻底形态**
  ⇒ 采用「判陈旧 → 不写 → 锁外重跑一轮」而非「只跳过」；决策 3 采用 (i) 结果化日志；决策 4 做留档。
  （若 owner 反悔其中任一子项，按"一个 PASSED 轮不覆盖其后改动"重开评审轮。）
- **owner 2026-10-03**：发版次序为 设计 → 修 + 测试 + 独立评审 → 与 D2 一起切 `v0.2.1`。

## 15. 仍开放

1. `ConsolidateReport` 是否需要新值来区分"陈旧重跑成功/有界放弃"，还是仅靠 `errors.log` 与 toast。
2. 重跑的 toast 策略：静默（只记日志）还是提示一次（owner 可见"你的编辑被完整采纳，本轮已重跑"）。
3. 留档文件是否需要保留策略（与 D2 的 `memory-overflow-*.md`、D3 的 session-log 保留策略同族问题）。
