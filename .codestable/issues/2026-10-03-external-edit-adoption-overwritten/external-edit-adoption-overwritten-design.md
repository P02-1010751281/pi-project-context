---
doc_type: design
issue: 2026-10-03-external-edit-adoption-overwritten
status: draft
created_at: 2026-10-03
revision: 3
related: [external-edit-adoption-overwritten-report.md, external-edit-adoption-overwritten-review-report.md, repro-write-ordering.mjs, ../2026-09-30-auxiliary-call-noise-and-memory-cap/over-cap-reply-persistence-fix-note.md]
tags: [memory, memory-journal, external-edit-adoption, lost-update, write-ordering, consolidation, design]
---

# 外部编辑采纳后被旧内容覆盖 修复设计（v3）

问题与证据见 `external-edit-adoption-overwritten-report.md`。两轮独立评审：
R1 对 v1 给 `CHANGES-REQUESTED`（2 blocking + 8 important），R2 对 v2.1 给 `CHANGES-REQUESTED`
（**无 blocking** + 5 important + 10 nit + 4 suggestion + 3 learning）。逐条记录见
`external-edit-adoption-overwritten-review-report.md`。

**修订轨迹**：v1 → R1 → v2（重跑入口 / 判据位置 / 发布窗口 / 副作用 / 上界 / 测试计划）→ v2.1
（自纠第 7 步恒触发缺陷）→ R2 → **v3（本文件）**。v3 按 R2 的 IM-1…IM-5 重排了流程表并定稿了
v2 遗留的开放项（§17）。

owner 2026-10-03 定调：**选 C，取最彻底形态**——判为陈旧 → **不发布** → **用采纳后的内容重跑一轮**，
日志说真话，丢弃的模型工作留档。

## 1. 目标

1. **扩展能观察到的任何时序下，外部编辑都不被"由更旧基线生成的回复"顶掉。** 残留的不可观察窗口见 §12。
2. **不白扔模型工作**：判为陈旧时本轮工作由重跑替代。
3. **丢弃与采纳都可见**：日志陈述**结果**；被丢弃的回复有本地留档。
4. **常态零变化**：没有外部编辑时，行为与今天逐字节一致。

## 2. 不变式

- **INV-1 字节守恒**：**凡检出"外部内容 ≠ fold 且 render 更新"**（今天 `store.ts:61-71` 的采纳条件），
  该内容必须 append 进 journal——**与是否判陈旧无关**（R2-IM-3）。
- **INV-2 无陈旧发布**：`MEMORY.md` 由本 pass 写入的内容，其基线不早于发布时刻已知的最新内容；
  检测到陈旧就不发布。
- **INV-3 可观测**：每次陈旧检测产出一句与**实际 fold**一致的结果日志；被丢弃的回复留档。

## 3. 硬约束

- 零新依赖（项目无 `package.json`）；不改外部文件格式（仍是 `# Project Memory` + 四节 Markdown）。
- **读侧可观察行为不变**：`loadMemory` 的返回（`text`/`source`/`poisoned`/`damaged`/`unreadable`）逐字节不变；
  §5 的抽取是"把同一条规则挪到一个函数里"，由既有测试 + 新用例双向钉住。
- **重跑在锁外**：`shared/lock.ts:179` 的 `withMemoryLock` 带等待上限（`MEMORY_LOCK_WAIT_MS`）、
  **不可重入**（`open(…,"wx")` + 超时），锁内重跑会自锁。
- **调用上界**（R1-I3 重写，R2 用 probe 复核为真实值）：单 `consolidateProjectState` attempt ≤ **3 次 `callAux`**
  （首调、解析/截断重试、condense；`pass.ts:197/221/248`），`callAux` 在 provider 拒绝 tools 时**再发一次**
  ⇒ ≤ **4 次 provider completion/attempt**；`consolidate()` ≤ **2 attempt** ⇒ ≤ **8 次**。写成具名常量并由测试断言
  （按 attempt/completion 计数，不按"模型调用"这种被内部重试污染的指标）。
- 向后兼容：`recordMemoryDocument` 的既有调用方（`shared/migrate.ts:127`、`tests/memory-ops-test.mjs`、
  `tests/consolidation-test.mjs`）不改也能工作；**不传 `basisKey` 时行为与今天逐字节一致**。
- 落地前走 `.agents/skills/pi-project-context-sandboxed-independent-review/SKILL.md`，直到每轮
  `VERDICT: PASSED`；**PASSED 轮不覆盖其后的改动**（反之，未评审的改动必须进下一轮）。

## 4. 现状（代码事实，行号已按 R1-A 与 R2-nit 复核）

| # | 事实 | 位置 |
| --- | --- | --- |
| F1 | 一次 `recordMemoryDocument` 调用里两次 append：先采纳、再写本次 pass 的 render | `store.ts:68` → `:77` → `:80` |
| F2 | 采纳日志在两次 append **之间**写出，措辞是完成态 | `store.ts:70` |
| F3 | `foldMemoryJournal` 取末条非空 `replace` | `journal.ts:91-97`（`:91-93` 跳过空 text） |
| F4 | 读取侧在同一条件下返回**外部编辑**；陈旧的是**模型调用期间**落地的编辑 | `store.ts:110-118` |
| F5 | 写入是否发生由 `memoryChanged` 门决定 ⇒ 生效条件反转 | `report.ts:132` |
| F6 | pass 层去重会吞掉重跑（`throttle` 与 `forceDedupeMs`） | `pass.ts:149-151` |
| F7 | 空 journal 分支**不经过**采纳检测（分支条件在 `store.ts:50`，块体 `:51-56`） | `store.ts:50-56` |
| F8 | rotation 用**默认 32000** 折叠，与项目 cap 解耦 | `journal.ts:111` |
| F9 | `activeConsolidation` 模块级单飞、**不按 projectRoot 键** | `pass.ts:135,137` |
| F10 | 现场：QM 142 / UF 35 条 `adopted …`；顶掉记录与更早记录逐字节相同 | 报告 §2 |
| F11 | 已确定性复现（脚本退出码 0），`A → B → A` 即兄弟仓库形态 | `repro-write-ordering.mjs` |

## 5. 决策 1：单一判据 + 基线必须取"读取函数的精确返回值"（R2-IM-4/IM-5）

**判据只有一处实现**。把 `loadMemory`（`store.ts:108-146`）的主体抽成内部 `resolveMemory()`，
返回 `{ text, source, poisoned, damaged, unreadable }`；`loadMemory` 变成薄包装，写路径调用**同一个**
`resolveMemory()` 并只取 `.text`。

- **契约（R2-IM-5）**：写路径取得的文本**逐字节等于** `loadMemory(projectRoot, limit).text`，
  **包含** `entries.length === 0` 的 `MEMORY.md` 原样/`clipToLineBoundary` 路径、`newestMemoryArchive`
  回退（`store.ts:119-135`）与 `.pi`/OMP legacy 路径（`:136-146`）。抽取必须覆盖这些分支，
  不能只实现 journal 分支——否则 I2 的修复会静默失效（R2 用 probe 演示了该失效，且 T5 的弱判据照样绿）。
- **判断方式**：`stale = options.basisKey !== undefined && options.basisKey !== currentText`，
  两边都是 `resolveMemory()` 的**原始返回字符串**，**不做任何规范化**（R2-IM-4 的修法）：
  - `basisKey` 由 pass 在构造 prompt 前取自同一次 `loadMemory()` 的 `.text`（§11），
    **不是** `fitted.text`（`fitMemoryInput` 会把密集记忆裁短，用裁剪结果做基线会**永久自锁**：
    每次 pass 都判陈旧、有界停止、永不发布——R2 用 29728→7585 字符的 probe 实测）。
  - 无 editor 改动时，同一函数在两次调用上返回同一字符串（fold 与 render 路径都确定），故不误报；
    无 journal 项目也不会因"raw vs 规范化键"产生一次性假陈旧（R2-IM-4）。
- **有效性**：`basisKey !== currentText` ⇒ 记忆在 pass 读取之后变了 ⇒ 回复基于更旧内容 ⇒ **陈旧**。
- 覆盖 **peer 先采纳**（R1-I1：peer 写入 Q 后 `currentText = Q ≠ basisKey = F`）与**空 journal 首写**
  （R1-I2：判据在函数入口，早于 `entries.length === 0` 分支）。
- **不猜意图**：区分不了 owner 编辑与旧版本 build 的退化写入，而两者正确动作相同——保更新的字节、
  以它为基线重跑；退化内容被重跑固化一轮的取舍**明确接受**（可观测：日志 + 留档），不引入意图判据。
- **误报守卫**：编辑早于 pass 读取 ⇒ `currentText === basisKey` ⇒ 不判陈旧。

## 6. 决策 2：流程重排——采纳块保留，陈旧只决定"发不发布"（R2-IM-1/IM-3）

v2 的流程表把"采纳 append"写进了 stale 分支，导致"编辑早于读取"时外部字节**不再单独进历史**，
INV-1 与 T12 的 legacy 承诺同时破（R2-IM-3）。v3 把两件事**分开**：**采纳块照旧无条件执行**，
陈旧判定只决定是否发布。

`recordMemoryDocument` 返回类型（R2-IM-2：必须能区分"这次有没有采纳"，否则 report 的常态结果句
无法产出、无条件输出就是谎报）：

```ts
export type MemoryWriteResult =
  | { written: true; adopted?: string }
  | { written: false; reason: "pass-reply-was-stale" | "external-edit-during-publish"; adopted: string };
```

| 步 | 动作 | 相对今天 |
| --- | --- | --- |
| 1 | 读 journal（`entries`/`damaged`/`unreadable`；unreadable 照旧抛）；读 `MEMORY.md` → `renderRaw`，`renderKey = renderRaw.trim() ? memoryComparisonKey(renderRaw, limit) : ""` | 新增 |
| 2 | **采纳块（保留今天的语义，逐行等价）**：`foldedView = foldMemoryJournal(entries, limit)`；若 `renderRaw` 非空且 `external !== foldedView` 且 `render.mtime > journal.mtime` ⇒ `appendMemoryOp("replace", external)`，并记一条**中性**日志（§8） | 今天的 `:61-71`，仅日志措辞改 |
| 3 | `currentText = (await resolveMemory()).text`；`stale = basisKey !== undefined && basisKey !== currentText` | 新增 |
| 4 | 若 `stale` ⇒ 中性日志 + 返回 `{written:false, reason:"pass-reply-was-stale", adopted:currentText}`，**不发布** | 新增 |
| 5 | `entries.length === 0` 的既有种子逻辑（此刻等价于旧行为） | 原样 |
| 6 | `rendered = normalizeMemoryReply(...)`；`appendMemoryOp("replace", rendered)` | 原样 |
| 7 | `rotateMemoryJournalIfNeeded` / `ensureMemoryGitignore` | 原样 |
| 8 | **recheck（比 `MEMORY.md` 自己的字节）**：重读 → `nowRaw`、`nowKey = nowRaw.trim() ? memoryComparisonKey(nowRaw, limit) : ""`。触发条件 `basisKey !== undefined && nowKey !== "" && nowKey !== renderKey`（**空内容不触发**，见下）⇒ 返回 `{written:false, reason:"external-edit-during-publish", adopted:nowRaw}`，**不写 `MEMORY.md`** | 新增 |
| 9 | `writeAtomic(MEMORY.md, rendered)`；返回 `{written:true, adopted: 第 2 步是否发生过 ? <external> : undefined}` | 原样 + `adopted` |

三处要点：

- **第 8 步为什么比"文件自己的字节"而不是比有效内容**（v2.1 自纠，R2 复核为正确）：第 6 步 append
  `rendered` 之后 fold **就是 `rendered`**，而 `MEMORY.md` 的 mtime 必然早于刚写完的 journal
  ⇒ 比有效内容会**恒触发**，正常路径永不发布。
- **空内容不触发（R2-IM-1）**：窗口内 `MEMORY.md` 被清空时 `nowKey === ""`；若照旧触发并
  `appendMemoryOp("replace","")`，那是 `foldMemoryJournal` 的 **no-op**（`journal.ts:91-93` 跳过空 text），
  于是第 6 步的 `rendered` 仍是生效 fold，函数却声称"未发布"⇒ **日志与实际 fold 相反**（INV-2/INV-3 双破）。
  v3 明确：**空 `MEMORY.md` 不是"更新的记忆"**，按 R-1 的既有语义继续发布（回复胜出）。
- **窗口内写入的正是即将写入的内容**时不触发（`nowKey === memoryComparisonKey(rendered, limit)` 时
  发布等于没变化）——归入"不触发"的可选精确化（R2-N-10）；**CRLF-only / 行尾空格**的重写仍会触发
  （`memoryComparisonKey` 只归一化文档级尾空白），这是**安全侧**行为，明示为已知语义，不额外放宽。

**为什么 recheck 放在第 6 步之后**：第 8 步到 rename 是唯一残留窗口，压到"再读一次 → rename"（μm–ms 级）；
放在之前则 append + fsync + rotation + gitignore 全落在窗口内（现场 69–450 ms 正来自这类序列，R1-B2）。

**残留**：Node 无 CAS，窗口不可能完全关闭；窗口内落地的编辑会**丢字节**（其字节只存在于被 rename
覆盖的那个文件里）。设计把窗口缩到最小并明示（§12 R-2），不做假承诺。第 8 步触发时 `rendered`
留在 journal 历史但非生效（§12 R-10）。

## 7. 决策 3：重跑走 pass 层新入口，并断言 version 递增（R1-B1）

`consolidateProjectState` 选项加 `rerun?: boolean`（参数行 `pass.ts:132`）：

- `rerun: true` **跳过** `throttled` 返回与 `force && cached && Date.now()-cached.at < forceDedupeMs`
  返回（`pass.ts:149-151`）⇒ 若产出 outcome 则 `nextVersion += 1`（`pass.ts:319`）（R2-N-4 的措辞修正：
  并发 join、`resolveAuxModel` 缺失或抛错时都不会产出新 version，由调用方的断言兜住）。
- **不**跳过失败停放：`modelBlocked` 时 `pass.ts:146-147` 返回 `cached?.outcome`（第 1 次成功后
  `lastOutcome` 必有值），且 `force=true` 本就不查 `modelBlocked`（R2-N-3）——所以"路由故障时不重跑"
  的兜底是 **version 断言**，不是该分支的行为描述。
- `activeConsolidation`（`pass.ts:135`）在第一次调用的 `.finally` 里已清空，不阻塞重跑；
  但它是模块级、不按 projectRoot 键（F9）——重跑**不加剧**（同样是普通调用），既有问题见 §12 R-4。
- 调用方（`report.ts`）拿到 `outcome2` 后**必须断言** `outcome2.version !== outcome1.version`；
  不满足则**不得**进入写路径（按"重跑未发生"处理：保留采纳内容 + 日志）。

## 8. 决策 4：日志归属拆分（R1-I4，R2-IM-2 补 `adopted` 字段）

- `store.ts` 只输出**中性事实**（不知道调用方是否重跑、也不知道自己之后是否发布成功）：**三条**
  - 采纳块：`the memory on disk was newer than the journal; it was adopted into the journal history`
  - 陈旧：`this pass's reply was older than the memory read just now; it was not published`
  - 发布窗口：`the memory file changed during the publish window; this pass's reply was not published`
- `report.ts` 在**循环结束后**输出**结果句**；含"成功"字样者必须在发布成功之后，且**采纳句只在
  `adopted` 存在时输出**（R2-IM-2）：
  - 有采纳 + 发布：`adopted an externally edited MEMORY.md into the memory journal; this pass's reply replaced it in the same write`
  - 无采纳 + 发布：沿用今天的 `Project memory updated: …`（**不得**出现 adopted 字样）
  - 陈旧（两种原因共用同一有界循环）→ 重跑后发布：`the memory changed while the reply was being built or published: the reply was discarded, the newer content was kept, and the pass was re-run`
  - 陈旧 → 重跑未产出/未发生（有界停止）：`…the newer content was kept; the re-run did not produce a newer reply`
  - 第二次仍陈旧：沿用上一条（"有界停止"分支），不新增措辞

## 9. 决策 5：副作用只在最终 attempt 执行（R1-I5）

v1 曾称"attempt 1 的 side effect 只有采纳 append + 写前备份"，与现状不符。v3 规则：**只有最终 attempt
执行** `saveOverflowReply`、CONTEXT.md 写入、`lastWrite.set`、四个一次性警告集合
（`contextShapeWarned`/`memoryCapWarned`/`memorySectionCapWarned`/`memoryRemovalWarned`）与 notify；
且"后置"读作**在该次写入之前/之时按既有位置执行**（overflow 留档仍必须在该次写之前，R2-IM-5 的边界说明）。

attempt 1 允许的副作用只有：采纳 append（INV-1 要求）、写前备份 `backupMemoryBeforeWrite`
（先于检测执行、无法避免，且是外部编辑的额外保底）、被丢弃回复的留档（§10，与 overflow 留档去重：
**被丢弃走 `memory-stale-*`，被裁剪走 `memory-overflow-*`，同一份回复只留一种**）。

`consolidate()` 的退出形态三种：**发布成功** / **保留采纳内容（重跑未发生或未产出）** /
**失败**（既有失败路径不变）。`ConsolidateReport` 新增 `"superseded"` 供后两种中的第一种使用
（§17.1 定稿）。

## 10. 决策 6：被丢弃的回复留档

与 `saveOverflowReply`（D2，`report.ts:56`）对称：写 `.agents/memory/memory-stale-<ISO>.md`，
时间戳照抄 `replace(/[:.]/g,"-")`；`writeAtomic`、best-effort（失败只记日志、不阻断主流程）；
`shared/gitignore.ts` 的 `MEMORY_GITIGNORE_LINES` 增加 `memory-stale-*.md`；日志点名该文件。
`*.tmp` 残片由既有 `cleanStaleTemps`（1 h）回收；**不做**年龄保留策略（§17.4）。

## 11. 接口改动

```ts
// memory/store.ts
export type MemoryWriteResult =
  | { written: true; adopted?: string }
  | { written: false; reason: "pass-reply-was-stale" | "external-edit-during-publish"; adopted: string };

export async function recordMemoryDocument(
  projectRoot: string, text: string, limit?: number,
  options?: { preserveMarker?: boolean; basisKey?: string; __testOnBeforePublish?: () => Promise<void> },
): Promise<MemoryWriteResult>;
```

```ts
// memory/pass.ts
export type ConsolidateOutcome = { /* 既有字段 */ basisKey: string };   // :35-52，构造于 :323
export async function consolidateProjectState(pi, ctx, options?: { force?: boolean; rerun?: boolean });
```

- `basisKey` 的取值（R2-IM-4 定稿）：pass 里 `const existing = await loadMemory(projectRoot, config.maxMemoryChars)`
  （`pass.ts:161`）之后的 **`existing.text` 本身**，不规范化、不用 `fitted.text`。
- `__testOnBeforePublish`：**仅为测试存在**的 seam（§17.3 定稿），生产代码不传；它是验证 INV-2
  这条**时间窗性质**的唯一手段（纯函数单测测不到接线）。
- `ConsolidateReport` 新增 `"superseded"`；命令输出与之同步。
- `shared/project-state.ts:9` 的 re-export 需多导出 `MemoryWriteResult`。

## 12. 风险与残留

| # | 项 | 处置 |
| --- | --- | --- |
| R-1 | **不可观察窗口**：mtime **回退**的编辑（`cp -p`/`rsync --times`）不被采纳检测看到；owner **清空** `MEMORY.md` 时（`store.ts:63` 的 `renderRaw.trim()` 守卫）回复胜出 | 明示为已接受语义；目标 1 的措辞据此收窄 |
| R-2 | 发布窗口（第 8 步 → rename）内落地的编辑丢字节（Node 无 CAS） | 窗口压到最小并明示 |
| R-3 | cap>32000 时 rotation 用默认 32000 折叠（F8）⇒ fold 可能落后 render | 既有问题，本设计不修；**T13 断言只在"未触发 rotation 的小 fixture"下成立**（R2-N-5），否则改断言 `resolveMemory().text` 与重跑结果一致 |
| R-4 | `activeConsolidation` 模块级、不按 projectRoot 键（F9） | 既有；重跑不加剧（同为普通调用，R2 指出"不加剧"未被证明，此处明示为**概率不变**） |
| R-5 | **未升级的 peer 进程仍会顶掉编辑** | 明示：全部进程升级后才对所有交错成立 |
| R-6 | 重跑放大调用量 | 上限 2 attempt（§3）；version 断言兜底；日志可计数 |
| R-7 | session_shutdown 同步 pass 最坏 8 次 completion ⇒ 退出变慢 | 接受并记录；仅在实际检出陈旧时发生 |
| R-8 | 退化外部写入被重跑固化一轮 | 决策 1 的取舍，可观测 |
| R-9 | 基线口径不一致导致误判 | 两侧同为 `resolveMemory()` 的原始返回（§5）；T3 覆盖 clip 与无 journal 两个 fixture |
| R-10 | 第 8 步触发时 `rendered` 留在历史但非生效 | 有意（历史保留）；测试断言"未成为 render"，不是"不在 journal" |
| R-11 | `written.set` 的 claim 语义（R1-I8） | 最终 attempt 的 version 一经确定，仍在任何 `await` **之前**同步 claim；**stale-stop（非异常、未发布）时也保持 claim**（防缓存 outcome 被回放，R2-N-9）；失败时按既有 `wroteMemory` 模式释放 |
| R-12 | 陈旧分支跳过 `rotateMemoryJournalIfNeeded`/`ensureMemoryGitignore`（第 4 步在第 7 步之前 return） | 明示（R1 已列，v2 漏记）：journal 可暂超 512 KB，无损坏，属可接受延迟 |
| R-13 | `memory-stale-*` / `memory-overflow-*` 只增不减 | 本设计不引入保留策略（与 D3 同族）；见 §17.4 |
| R-14 | 窗口内 CRLF-only / 行尾空格重写会被判陈旧 | `memoryComparisonKey` 只归一化文档级尾空白；安全侧，明示不收紧 |
| R-15 | 窗口内把 `MEMORY.md` **清空**时按 R-1 语义发布（回复胜出） | R2-IM-1 的定稿结论：空内容不是"更新的记忆"；日志必须与实际 fold 一致 |

## 13. 测试计划

新增 `tests/external-edit-test.mjs`（R2 逐条判过可行性）：

| # | 场景 | 通过判据 |
| --- | --- | --- |
| T1 | **重跑验收线**：fake `modelRegistry.complete` 第 1 次调用期间改 `MEMORY.md` 为 B；force（`session_shutdown`）与非 force（`agent_settled`，需把 `consolidateTurns` 配小或让间隔已过，否则被 `pass.ts:149-150` 节流）两条路径 | 第 2 次真实 pass 发生（completion 计数增加）；最终 `MEMORY.md` = 第 2 次回复；第 1 次回复未成为 render；B 在 journal 历史；`memory-stale-*.md` 存在 |
| T2 | 重跑不得写缓存回复 | 构造法写明（seam 或让 `rerun` 时 `resolveAuxModel` 缺失）；断言 `version` 相同则**不调用**写路径，B 仍生效 |
| T3 | 误报守卫，**两个 fixture**：(a) 无 journal 项目、(b) prompt 被 `fitMemoryInput` clip 的项目（密集记忆，输出上限压到 8192 量级） | 都不判陈旧、发生发布（覆盖 R2-IM-4 的自锁陷阱与 R-9） |
| T4 | peer 先采纳（I1）：fake 首次调用里直接调 `recordMemoryDocument(root, Q)` 模拟 peer，随后本写路径 | 判陈旧；本次回复未写；Q 仍是 fold；B 未退回纯历史 |
| T5 | 空 journal 首写（I2），判据收紧 | 断言"**B 进 journal** **且**重跑回复被发布"；只断言"B 仍生效"不算通过（R2-N-6） |
| T6 | TOCTOU（B2）：用 `__testOnBeforePublish` 在检测后、发布前改 `MEMORY.md`（含**窗口内清空**变体） | 非空：走陈旧分支、新字节进 journal、日志与最终 fold 一致；**清空：按 R-15 发布**，日志不得声称"未发布"（R2-IM-1） |
| T7 | 重跑期间再次编辑 | 有界停止；保留采纳内容；`ConsolidateReport === "superseded"`；结果句与实际 fold 一致 |
| T8 | 锁：pass 阶段不持锁、两个写窗口各持锁一次 | fake 阻塞期间轮询 `MEMORY.md.lock` 不存在；总耗时 < `MEMORY_LOCK_WAIT_MS` |
| T9 | 记账 | keep-adoption 退出的 `lastWrite`/命令回复语义按 §17.1 定稿断言；并发两次 `consolidate()` 不重复写同一 version |
| T10 | 调用上界 | 用 R2 给出的配方（tools 抛非 provider 错 → 回落返回坏 JSON → retry 有效 → condense 触发）实测 completion 数 = 具名常量 |
| T11 | D2 交互 | opaque 超 cap + attempt 1 陈旧：`memory-overflow-*` 与 `memory-stale-*` 的数量/内容正确、gitignore 覆盖两者、留档失败不阻断、日志点名实际文件 |
| T12 | 兼容 / I7 | `run-all` 全绿；migrate 输出 md5 不变；**不传 `basisKey` 且确实发生采纳**时 journal 含采纳记录（IM-3 的检测线），行为与今天逐字节一致 |
| T13 | INV 断言 | 小 fixture（不触发 rotation）下 `memoryComparisonKey(MEMORY.md) === foldMemoryJournal(entries)`，分「陈旧后」「重跑成功后」两段；CRLF 变体两边都保留 `\r`；rotation 场景改断言 `resolveMemory().text` |
| T14 | 复现脚本重写 | **主用例驱动 report/pass 全链路**（`session_shutdown` + fake model）验证重跑；显式传 `basisKey` 的 store 级变体只作"编辑保住"的补充；脚本头部 exit-code 注释与判定一并改（现在 0 = 复现 bug） |

## 14. 评审计划

沙箱只读独立评审（`pi -p --no-session --no-project-context --no-skills --no-prompt-templates
--tools read,bash --model commandcode/deepseek/deepseek-v4.1-flash-fast`），每轮记录候选定版 md5；
零写入证明 = 前后 `git status --porcelain -uall` + `find … stat` 快照（`-prune` 掉 `.agents/memory`）；
**0 字节 transcript = provider 失败，必须重跑**；**PASSED 轮不覆盖其后的改动**。
轮次、残留与零写入证明记入 `external-edit-adoption-overwritten-review-report.md`。

## 15. 非目标

- **M / N**（opaque 回复迁移到分节路径）：另立设计（`over-cap-reply-persistence-fix-note.md` §5.3）。
- **D1**（opaque 按节丢整条）被 N 覆盖；**S4**（分节按优先序丢）为冻结设计的非目标
  （`structured-consolidation-output-design.md:401`）。
- 可配置 CONTEXT cap、CONTEXT.md 读侧迁移、归档 vault/加密/上传、autolearn 节流与准入、handoff 摘要路径。
- **意图判据**（owner 编辑 vs 旧版本退化写入）：显式不引入。
- R-1/R-3/R-4/R-13/R-14 五个残留：记录但不修。

## 16. 决策记录

- **owner 2026-10-03**：选 **C** 且取**最彻底形态**；发版次序 设计 → 修 + 测试 + 独立评审 →
  与 D2 一起切 `v0.2.1`。
- **R1（2026-10-03）** `CHANGES-REQUESTED`（2 blocking + 8 important）→ v2。
- **自纠（v2.1，未评审）**：第 7 步比有效内容会恒触发 → 改比 `MEMORY.md` 自身字节。
- **R2（2026-10-03）** `CHANGES-REQUESTED`（0 blocking + 5 important）→ **v3**：
  - IM-1 空内容不触发（R-15）+ 陈旧两原因共用同一有界循环 + 补结果句；
  - IM-2 `written:true` 带 `adopted`，采纳句只在有采纳时输出；
  - IM-3 采纳块保留为独立步骤（INV-1 与 T12 的 legacy 承诺）；
  - IM-4 `basisKey` = `loadMemory().text` 原值，不规范化、不用 `fitted.text`；
  - IM-5 `resolveMemory()` 契约含空 journal/archive/legacy 回退。
- **定稿的开放项（v3 §17）**：`"superseded"` + keep-adoption 语义；无新增 toast；测试 seam；
  不做留档保留策略。

## 17. 定稿的开放项（v2「仍开放」的裁决）

1. **`ConsolidateReport` / keep-adoption 语义**：新增 `"superseded"`，用于"检出陈旧但最终保留了新内容"
   的两种退出（重跑未发生、重跑未产出）。`/memory update` 的回复必须**不得**说
   "already up to date / nothing rewritten"：它要说"检测到外部编辑，本轮回复已丢弃，保留你写入的内容
   （并已重跑 / 重跑未产出）"。`lastWrite` 指向最终 attempt 的写前备份；**没有最终写入时 `lastWrite` 清空**
   （`report.ts:207-215` 的现有语义）。
2. **toast 策略**：成功发布不新增 toast（沿用今天的 `Project memory updated`）；keep-adoption 退出**发一次**
   warning toast（owner 必须知道他的编辑被保住、本轮回复被丢弃）。理由：这条路径罕见且 owner 需要知情。
3. **测试 seam**：采用 `__testOnBeforePublish`（仅测试传入，双下划线命名标明身份）。理由：要验证的是
   INV-2 这条**时间窗性质**与 IM-1 的"窗口内清空"接线，纯函数单测测不到接线；抽纯函数反而会引入
   "测了函数、没测调用点"的假绿。
4. **留档保留策略**：**本设计不做**（R-13）。删除证据比磁盘增长更糟，且保留策略与 D3（session-log
   体积/保留策略）同族，应在 D3 一并定。
