---
doc_type: design
issue: 2026-10-03-external-edit-adoption-overwritten
status: draft
created_at: 2026-10-03
revision: 2
related: [external-edit-adoption-overwritten-report.md, external-edit-adoption-overwritten-review-report.md, repro-write-ordering.mjs, ../2026-09-30-auxiliary-call-noise-and-memory-cap/over-cap-reply-persistence-fix-note.md]
tags: [memory, memory-journal, external-edit-adoption, lost-update, write-ordering, consolidation, design]
---

# 外部编辑采纳后被旧内容覆盖 修复设计（v2）

问题与证据见 `external-edit-adoption-overwritten-report.md`；v1 的独立评审（R1）两条 blocking 与八条
important 见 `external-edit-adoption-overwritten-review-report.md`。**v2 是 R1 之后的修订版**：
重跑入口、陈旧判据位置、发布窗口、副作用归属、调用上界与测试计划全部按评审结论改写。

owner 2026-10-03 定调：**选 C，取最彻底形态**——判为陈旧 → **不发布** → **用采纳后的内容重跑一轮**，
日志说真话，丢弃的模型工作留档。

## 1. 目标

1. **扩展能观察到的任何时序下，外部编辑都不被"由更旧基线生成的回复"顶掉。**
   措辞按 R1 收窄：残留的不可观察窗口见 §12，不声称"任何时序"。
2. **不白扔模型工作**：判为陈旧时本轮工作由重跑替代。
3. **丢弃与采纳都可见**：日志陈述**结果**；被丢弃的回复有本地留档。
4. **常态零变化**：没有外部编辑时，行为与今天逐字节一致。

## 2. 不变式（测试要钉的就是这三条）

- **INV-1 字节守恒**：扩展**观察到的**外部内容，要么成为 `MEMORY.md`、要么成为 journal 折叠结果、
  要么留在 journal 历史里；**任何检测到的外部内容都必须 append 进 journal**。
- **INV-2 无陈旧发布**：`MEMORY.md` 由本 pass 写入的内容，其基线不早于发布时刻已知的最新内容；
  **只要检测到陈旧就不发布**。
- **INV-3 可观测**：每次陈旧检测产出一句陈述**结果**的日志；被丢弃的回复留档。

## 3. 硬约束

- 零新依赖（项目无 `package.json`）。
- 不改外部文件格式（仍是 `# Project Memory` + 四节 Markdown）。
- **读侧可观察行为不变**：`loadMemory` / `foldMemoryJournal` / `normalizeMemoryDocument` 的语义逐字节不变
  （§5 的抽取是"把同一条规则挪到一个函数里"，不是改规则；由既有测试与新用例共同钉住）。
- **重跑在锁外**：`shared/lock.ts:179` 的 `withMemoryLock` 是带等待上限（`MEMORY_LOCK_WAIT_MS`）的
  文件锁，**不可重入**（`open(…,"wx")` + 超时），在锁内重跑会自锁到最后超时。
- **调用上界（按 R1-I3 重写）**：单次 `consolidateProjectState` 最多 **3 次 `callAux`**
  （首调、解析/截断重试、condense），而 `callAux` 在 provider 拒绝 tools 时会**再发一次**
  （`shared/llm.ts` 的 tools-回落）⇒ 单 attempt ≤ **4 次 provider completion**；
  `consolidate()` 最多 **2 个 attempt** ⇒ ≤ **8 次**。常态仍是 1 attempt。这条上界写成**具名常量**
  并由测试断言（按 attempt/version 计数，不按"模型调用次数"这种会被内部重试污染的指标）。
- 向后兼容：`recordMemoryDocument` 的既有调用方（`shared/migrate.ts:127`、`tests/memory-ops-test.mjs`、
  `tests/consolidation-test.mjs`）不改也能工作。
- 落地前走 `.agents/skills/pi-project-context-sandboxed-independent-review/SKILL.md`：多轮直到每轮
  `VERDICT: PASSED`，且 **PASSED 轮不覆盖其后的改动**。

## 4. 现状（代码事实，行号已按 R1 的 A 节复核）

| # | 事实 | 位置 |
| --- | --- | --- |
| F1 | 一次 `recordMemoryDocument` 调用里两次 append：先采纳、再写本次 pass 的 render | `store.ts:68` → `:77` → `:80` |
| F2 | 采纳日志在两次 append **之间**写出，措辞是完成态 | `store.ts:70` |
| F3 | `foldMemoryJournal` 取末条 `replace` | `journal.ts:91-97` |
| F4 | 读取侧在同一条件下返回**外部编辑**；陈旧的是**模型调用期间**落地的编辑 | `store.ts:114`、`:110-118` |
| F5 | 写入是否发生由 `memoryChanged` 门决定 ⇒ 生效条件反转 | `report.ts:132` |
| F6 | pass 层去重会把重跑吞掉（`throttle` 与 `forceDedupeMs`） | `pass.ts:149-151` |
| F7 | 空 journal 分支**不经过**采纳检测 | `store.ts:51-56` |
| F8 | rotation 用**默认 32000** 折叠，与项目 cap 解耦 | `journal.ts:111` |
| F9 | `activeConsolidation` 是模块级单飞、**不按 projectRoot 键** | `pass.ts:135,137` |
| F10 | 现场：QM 142 条 / UF 35 条 `adopted …`；顶掉记录与更早记录逐字节相同 | 报告 §2 |
| F11 | 已确定性复现（脚本退出码 0），`A → B → A` 即兄弟仓库形态 | `repro-write-ordering.mjs` |

## 5. 决策 1：单一判据函数 + 对「有效内容」无条件比较

**判据只有一处实现**。把 `loadMemory`（`store.ts:110-118`）现有的"render 更新且与 fold 不同则取
render，否则取 fold"这条规则抽成：

```ts
/** The content this project's memory reads right now — one rule, used by both read and write. */
async function effectiveMemoryKey(projectRoot: string, limit: number, entries: readonly MemoryJournalEntry[]): Promise<string>
```

`loadMemory` 改为调用它（可观察行为不变），写路径也调用它。这样"什么算当前内容"不会两处漂移
（R1-I1 的根因之一就是判据只写在采纳分支里）。

**比较方式（R1-I1 的修法）**：不再只在"检出 external"的分支里比较，而是

```
current = await effectiveMemoryKey(...)
stale   = options.basisKey !== undefined && options.basisKey !== current
```

- `basisKey` 来自 pass 构造 prompt 时读到的记忆（§7），**是本次回复的基线**。
- 有效性：`current ≠ basisKey` ⇒ 记忆在 pass 读取之后变了 ⇒ 回复基于更旧的内容 ⇒ **陈旧**。
- **空 journal 分支同样被覆盖**（R1-I2）：判据在函数入口，早于 `entries.length === 0` 的分支。
- **peer 先采纳也覆盖**（R1-I1）：peer 已写入 Q 时 `current = fold = Q ≠ basisKey = F` ⇒ 判陈旧 ✓。
- **不猜意图**：区分不了 owner 编辑与旧版本 build 的退化写入，而两者的正确动作相同——保更新的字节、
  以它为基线重跑。取舍（退化内容被重跑固化一轮）**明确接受**，可观测（日志 + 留档），不引入意图判据。
- **误报守卫**：编辑早于 pass 读取时 `current === basisKey` ⇒ 不判陈旧 ✓。

**显式 `undefined` 守卫（R1-I7）**：`basisKey` 省略时必须**永不**判陈旧。写成
`options.basisKey !== undefined &&` 是**接口级**要求，不是实现纪律；由 legacy 回归用例钉住
（不传 `basisKey` 且**确实发生**采纳时，行为必须与今天一致）。

## 6. 决策 2：陈旧时不发布；发布前 recheck 把窗口压到「recheck → rename」

`recordMemoryDocument` 的返回类型加宽（原 `Promise<void>`）：

```ts
export type MemoryWriteResult =
  | { written: true }
  | { written: false; reason: "pass-reply-was-stale" | "external-edit-during-publish"; adopted: string };
```

流程（v2）：

| 步 | 动作 |
| --- | --- |
| 1 | 读 journal（`entries` / `damaged` / `unreadable`；unreadable 照旧抛） |
| 2 | `current = effectiveMemoryKey(...)` |
| 3 | 若 `basisKey !== undefined && basisKey !== current` → **陈旧**：若 `current` 非空且不是当前 fold，则 `appendMemoryOp("replace", current)`（**INV-1**：外部字节进历史）；发中性日志（§8）；返回 `{written:false, reason:"pass-reply-was-stale", adopted:current}`。**不做后续任何事** |
| 4 | `entries.length === 0` 的既有种子逻辑（此时已通过第 3 步，等价于旧行为） |
| 5 | `rendered = normalizeMemoryReply(...)`；`appendMemoryOp("replace", rendered)` |
| 6 | `rotateMemoryJournalIfNeeded` / `ensureMemoryGitignore` |
| 7 | **recheck**：重新读 journal 并算 `after = effectiveMemoryKey(...)`；若 `after !== current` → 发布窗口内落了编辑：`appendMemoryOp("replace", after)`（INV-1）+ 中性日志 + 返回 `{written:false, reason:"external-edit-during-publish", adopted:after}`，**不写 `MEMORY.md`** |
| 8 | `writeAtomic(MEMORY.md, rendered)`；返回 `{written:true}` |

**为什么 recheck 放在 append(rendered) 之后**：这样第 7 步到 rename 的窗口是**唯一**残留窗口，
被压到"再读一次 → rename"（本机 μm–ms 级）；放在之前则 append + fsync + rotation + gitignore
全落在窗口里（R1-B2 的现场量级 69–450 ms 正来自这类序列）。

**代价与残留（R1-B2 的答复）**：Node 没有 CAS，窗口**不可能完全关闭**；窗口内落地的编辑会**丢字节**
（不只是丢生效），因为它的字节只存在于被 rename 覆盖掉的那个文件里。设计把窗口缩到最小并在 §12
明示，而不是假装关闭。第 7 步若触发，`rendered` 那条记录仍在 journal 历史里，但 fold 已被
`after` 覆盖 ⇒ 生效内容是新编辑，状态自洽。

## 7. 决策 3：重跑必须走 pass 层的新入口，并断言 version 递增（R1-B1）

`consolidateProjectState` 的选项加 `rerun?: boolean`（`pass.ts:133`）：

- `rerun: true` 时**跳过** `throttled` 返回与 `force && cached && Date.now()-cached.at < forceDedupeMs`
  返回（`pass.ts:149-151`）⇒ 一定跑一次真实 pass、`nextVersion += 1`（`pass.ts:319`）。
- **不**跳过失败停放（`modelBlocked`）：路由刚故障时重跑只会放大调用量；此时返回 `undefined`，
  调用方保留采纳内容（见 §9 的第 3 种退出）。
- `activeConsolidation`（`pass.ts:135`）不会阻塞重跑：第一次调用已经完成并在 `.finally` 里清空。
  但它是**模块级、不按 projectRoot 键**（F9）——两项目并发时可能互串（既有问题，见 §12）。
- 调用方（`report.ts`）拿到 `outcome2` 后**必须断言** `outcome2.version !== outcome1.version`；
  不满足则**不得**进入写路径，按"重跑未发生"处理（保留采纳内容 + 日志），否则就是 R1-B1 的
  陈旧回放。

## 8. 决策 4：日志归属拆分（R1-I4）

`store.ts` **说不出**最终结果：它不知道调用方会不会重跑，也不知道自己之后是否写入成功（第 8 步可能抛）。
所以：

- `store.ts` 只输出**中性事实**，两条：
  - `the memory changed while this pass's reply was being built; the reply was not published and the newer content stays effective`
  - `an external edit landed during the publish window; the newer content was adopted and this pass's reply was not published`
- `report.ts` 在**循环结束后**输出**结果句**，且含"成功"字样的行必须在发布成功之后：
  - 常态：`adopted an externally edited MEMORY.md into the memory journal; this pass's reply replaced it in the same write`
  - 陈旧 → 重跑成功：`an external edit landed while the reply was being built: the reply was discarded, the edit was kept, and the pass was re-run`
  - 陈旧 → 重跑未发生/未产出：`…the adopted memory was kept; the re-run did not produce a newer reply`

**为什么不用"保留原行 + 加一条"**：只有一处知道结果，两条并存正是 142/35 条误导日志的成因（F2）。

## 9. 决策 5：副作用全部后置到最终 attempt（R1-I5）

v1 声称"attempt 1 的 side effect 只有采纳 append + 写前备份"，与现状不符：attempt 1 还会
`saveOverflowReply`（`report.ts:164`）、写 CONTEXT.md（`:219`）、`lastWrite.set`（`:204`）、
消耗四个一次性警告集合（`:138/:145/:189/:194`）、发 notify（`:237-259`）。

v2 规则：**只有最终 attempt 驱动所有副作用**——`saveOverflowReply`、CONTEXT.md 写入、`lastWrite`、
一次性警告集合、notify。attempt 1 的副作用限定为：

- 采纳 append（journal 历史，INV-1 要求）；
- 写前备份 `backupMemoryBeforeWrite`（它先于检测执行，无法避免，且是外部编辑的一份额外保底）；
- 被丢弃回复的留档（§10）——与 `saveOverflowReply` 去重：**同一份回复只留一种档**
  （被丢弃走 `memory-stale-*`，被裁剪走 `memory-overflow-*`，不会两份都写）。

`consolidate()` 的退出形态因此有三种：**发布成功** / **保留采纳内容（重跑未发生或未产出）** /
**失败**（既有失败路径不变）。三者在 `errors.log` 与 toast 上各不相同（§8）。

## 10. 决策 6：被丢弃的回复留档

与 `saveOverflowReply`（D2，`report.ts:56`）对称：写 `.agents/memory/memory-stale-<ISO>.md`，
时间戳照抄 `replace(/[:.]/g,"-")`，`writeAtomic`、best-effort（失败只记日志、不阻断主流程），
`shared/gitignore.ts` 的 `MEMORY_GITIGNORE_LINES` 增加 `memory-stale-*.md`，日志点名该文件。
`writeAtomic` 的 `*.tmp` 残片由既有 `cleanStaleTemps`（1 h）回收，不额外处理。

## 11. 接口改动

```ts
// memory/store.ts
export type MemoryWriteResult =
  | { written: true }
  | { written: false; reason: "pass-reply-was-stale" | "external-edit-during-publish"; adopted: string };

export async function recordMemoryDocument(
  projectRoot: string, text: string, limit?: number,
  options?: { preserveMarker?: boolean; basisKey?: string },
): Promise<MemoryWriteResult>;
```

```ts
// memory/pass.ts
export type ConsolidateOutcome = { /* 既有字段 */ basisKey: string };   // :35-52，构造于 :323
export async function consolidateProjectState(pi, ctx, options?: { force?: boolean; rerun?: boolean });
```

- `consolidateProjectState` 的调用点在 `report.ts:120`（+ 新增的重跑调用）。
- `ConsolidateReport` 若需新值（如 `"superseded"`）一并扩展，供命令输出与 toast 使用。
- `shared/project-state.ts:9` 的 re-export 需要多导出一个类型。

## 12. 风险与残留

| # | 项 | 处置 |
| --- | --- | --- |
| R-1 | **不可观察窗口**：mtime **回退**的编辑（`cp -p` / `rsync --times`）根本不被采纳检测看到；owner **清空** `MEMORY.md` 时（`store.ts:63` 的 `renderRaw.trim()` 守卫）回复会顶掉"清空"动作 | **明确列为已知残留**；目标 1 的措辞按 R1 收窄为"扩展能观察到的时序"。字节保底只有 `report.ts:170` 的写前备份 |
| R-2 | 发布窗口（第 7 步 → rename）内落地的编辑会丢字节（Node 无 CAS） | 窗口压到最小并明示；不做假承诺 |
| R-3 | cap>32000 时 rotation 用默认 32000 折叠（F8，`journal.ts:111`）⇒ journal fold 可能落后 render，`loadMemory` 回退到 render | **既有问题**，本文档不修；但 §2 的 INV-1 措辞与测试断言用 `memoryComparisonKey(MEMORY.md) === fold` 而不是原始字节相等（R1-I6/T5） |
| R-4 | `activeConsolidation` 模块级、不按 projectRoot 键（F9） | 既有问题；重跑不加剧（重跑在锁外、且单飞已释放），记录待办 |
| R-5 | **未升级的 peer 进程仍会顶掉编辑**：本修法要在每个运行中的进程里生效；一个旧版本 peer 依然会 adopt-then-supersede | 明示：全部进程升级后才对所有交错成立 |
| R-6 | 重跑放大调用量 | 上限 2 attempt（§3）；`modelBlocked` 停放对重跑同样生效；日志可计数 |
| R-7 | session_shutdown 的同步 pass 在重跑下最坏 8 次 provider completion ⇒ 退出变慢 | 接受并记录；重跑只在真的检测到陈旧时发生 |
| R-8 | 退化外部写入被重跑固化一轮 | 决策 1 的取舍，可观测 |
| R-9 | 基线口径不一致导致误判 | 两侧都用 `config.maxMemoryChars` 与同一个 `effectiveMemoryKey` |
| R-10 | 第 7 步触发时 `rendered` 留在历史里但非生效 | 有意的（历史保留）；测试断言的是"未成为 render"，不是"不在 journal"（R1-I6/T2） |
| R-11 | `written.set` 的 claim 语义（R1-I8） | 最终 attempt 的 version 一经确定，仍在任何 `await` **之前**同步 claim；失败时按既有 `wroteMemory` 模式释放。并发 `consolidate()` 不得重复写同一 version |

## 13. 测试计划（按 R1 的 Test And QA Focus 重列）

新增 `tests/external-edit-test.mjs`：

| # | 场景 | 通过判据 |
| --- | --- | --- |
| T1 | **重跑真的发生（B1 验收线）**：默认配置下 fake model 第 1 次调用期间改 `MEMORY.md` 为 B；分别走 `session_shutdown`（force）与 `agent_settled`（非 force） | 发生第 2 次真实 pass（`version` 递增、模型调用数增加）；最终 `MEMORY.md` = 第 2 次回复；第 1 次回复未成为 render；B 仍在 journal 历史；`memory-stale-*.md` 存在 |
| T2 | attempt 2 不得写缓存回复 | 若 attempt 2 返回 `version === outcome1.version`，**不得**调用写路径；B 仍生效 |
| T3 | 误报守卫：编辑早于 pass 读取（`basisKey === current`） | 正常写入；不判陈旧；无重跑 |
| T4 | peer 先采纳（I1）：pass 读到 F，peer 采纳 B 并写 Q，随后我们的写路径 | 判陈旧；我们的回复未写；Q / B 未被退回纯历史 |
| T5 | 空 journal 首写（I2）：删 journal、只留 `MEMORY.md=A`；调用期间写 B | B 仍生效（或至少进 journal 且 `MEMORY.md` 不回退）；B 不得只存在于历史 |
| T6 | TOCTOU（B2）：用仅在测试传入的 seam 在"检测完成后"改 `MEMORY.md` | 走陈旧分支；B 的 key 进 journal；`lastWrite`/`errors.log` 不得声称本次回复已覆盖 |
| T7 | 重跑期间再次编辑 | 有界停止；保留采纳内容；恰好 1 条结果句；无第三次 attempt |
| T8 | 锁（锁外重跑、不自锁） | pass 阶段不持锁；两个写窗口各持锁一次；总耗时 < `MEMORY_LOCK_WAIT_MS` |
| T9 | 记账 | 陈旧停止后 `/memory update` 的回复不得说"already up to date"；`lastWrite` 指向最终 attempt 的备份；并发两次 `consolidate()` 不重复写同一 version |
| T10 | 调用上界（I3） | 首调截断 + retry 坏 JSON + condense 触发时的 provider completion 数 ≤ 具名常量；记录 session_shutdown 的数量 |
| T11 | D2 交互 | opaque 超 cap 且 attempt 1 陈旧：`memory-overflow-*` 与 `memory-stale-*` 的数量/内容正确、gitignore 覆盖两者、留档失败不阻断、日志点名实际文件 |
| T12 | 向后兼容 / I7 | `node tests/run-all.mjs` 全绿；`migrate.ts` 路径不传 `basisKey` 时输出与基线逐字节一致；**不传 `basisKey` 且确实发生采纳**时仍按旧行为（防止"全判陈旧"） |
| T13 | INV 断言（T5 修正版） | `memoryComparisonKey(MEMORY.md) === foldMemoryJournal(entries)`（**规范化**相等），分「陈旧分支后」「重跑成功后」两段断言；用无尾换行 / CRLF 的 B 各测一遍 |
| T14 | 复现脚本转绿（T8 修正版） | `repro-write-ordering.mjs` 改为驱动 report 级流程（或显式传 `basisKey`）后断言最终 `MEMORY.md` 含外部编辑、退出码 0；另留一个 legacy 直调用例断言"采纳被顶掉"的旧行为不变 |

## 14. 评审计划

沙箱只读独立评审（`pi -p --no-session --no-project-context --no-skills --no-prompt-templates
--tools read,bash --model commandcode/deepseek/deepseek-v4.1-flash-fast`），每轮记录候选定版 md5；
零写入证明 = 前后 `git status --porcelain -uall` + `find … stat` 快照（`-prune` 掉 `.agents/memory`）；
**空 transcript / 0 字节 = provider 失败，必须重跑，不算一轮**；**PASSED 轮不覆盖其后的改动**。
轮次与残留记入 `external-edit-adoption-overwritten-review-report.md`。

## 15. 非目标

- **M / N**（opaque 回复迁移到分节路径）：另立设计（见 `over-cap-reply-persistence-fix-note.md` §5.3）。
- **D1**（opaque 路径按节丢整条）被 N 覆盖；**S4**（分节路径按优先序丢）被冻结设计列为非目标
  （`structured-consolidation-output-design.md:401`）。
- 可配置 CONTEXT cap、CONTEXT.md 读侧迁移、归档 vault/加密/上传、autolearn 节流与准入、handoff 摘要路径。
- **意图判据**（owner 编辑 vs 旧版本退化写入）：显式不引入（决策 1）。
- R-1 / R-3 / R-4 三个既有残留：本文档记录但不修。

## 16. 决策记录

- **owner 2026-10-03**：选 **C** 且要求取**最彻底形态** ⇒ 判陈旧 → 不发布 → 锁外重跑一轮；
  日志结果化；被丢弃回复留档。
- **R1 评审 2026-10-03**：`CHANGES-REQUESTED`（2 blocking + 8 important）。v2 按 R1 结论改写：
  重跑入口（B1）、发布前 recheck（B2）、有效内容无条件比较与空 journal 覆盖（I1/I2）、
  上界重写（I3）、日志归属拆分（I4）、副作用后置（I5）、测试计划重列（I6）、显式 `undefined` 守卫（I7）、
  claim 同步（I8）。
- **owner 2026-10-03**：发版次序为 设计 → 修 + 测试 + 独立评审 → 与 D2 一起切 `v0.2.1`。

## 17. 仍开放

1. `ConsolidateReport` 是否需要新值区分"陈旧重跑成功 / 保留采纳内容"，还是仅靠 `errors.log` + toast。
2. 重跑的 toast 策略：静默（只记日志）还是提示一次。
3. T6 的测试 seam（`recordMemoryDocument` 的 `beforePublish` 钩子）是否可接受为测试专用 API，
   还是改为把"检测 → 发布"的 recheck 抽成纯函数做单测。
4. 留档文件（`memory-stale-*` / `memory-overflow-*`）的保留策略（与 D3 同族）。
