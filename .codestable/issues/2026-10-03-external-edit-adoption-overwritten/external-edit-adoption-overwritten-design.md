---
doc_type: design
issue: 2026-10-03-external-edit-adoption-overwritten
status: draft
created_at: 2026-10-03
revision: 4.1
related: [external-edit-adoption-overwritten-report.md, external-edit-adoption-overwritten-review-report.md, repro-write-ordering.mjs, ../2026-09-30-auxiliary-call-noise-and-memory-cap/over-cap-reply-persistence-fix-note.md]
tags: [memory, memory-journal, external-edit-adoption, lost-update, write-ordering, consolidation, design]
---

# 外部编辑采纳后被旧内容覆盖 修复设计（v4）

问题与证据见 `external-edit-adoption-overwritten-report.md`。三轮独立评审的逐条记录见
`external-edit-adoption-overwritten-review-report.md`：

| 轮 | 对象 | 裁决 | 抓到 |
| --- | --- | --- | --- |
| R1 | v1 | CHANGES-REQUESTED | 2 blocking（重跑被 pass 去重吞掉；发布窗口 TOCTOU）+ 8 important |
| R2 | v2.1 | CHANGES-REQUESTED | 0 blocking + 5 important（报告级语义、`basisKey` 口径、契约、流程表） |
| R3 | v3 | CHANGES-REQUESTED | 1 blocking（第 8 步漏 append）+ 1 important（seam 注入点）+ 12 nit |
| R4 | v4 | CHANGES-REQUESTED | **0 blocking** + 2 important（发布侧副作用未以 `written:true` 为门；§8 句表缺一格）+ 11 nit |

**v4.1 = R4 之后的修订**（含一处开 R5 前的自查修正，整体未评审，必须进 R5）：

- 按 R4-IM-1 把发布侧副作用门在 `written:true`——但**自查发现该指令字面执行会造成回归**：`lastWrite`
  与 CONTEXT.md 写入今天就与 `memoryChanged` 解耦（`report.ts:203-205` 的注释明确"context rewritten
  while memory kept"是合法组合），故 §9 改为**两类副作用分开**，只把"描述刚发布了一次 memory"的那些
  纳入门内；
- 按 R4-IM-2 给 §8 句表补"重跑产出 outcome 但 `memoryChanged === false`"一格；退出形态由三种改四种；
- 新增 `"superseded"` 必须早于 `report.ts:226` 的赋值与短路；
- 11 条 nit：行号（`pass.ts:151`、`store.ts:87-160`、读侧 `:138-142`、清空守卫 `:106`、`journal.ts:92-93`）、
  `kept` 是生效文本非文件字节、T2 断言改 `outcome2 === undefined`、命令回复文本要钉死、
  D2 fix note 两处同步 + 其 residual-1 要在 `v0.2.1` 落实、R-12b、R-17。

**v4 = R3 之后的修订**：第 8 步补 append（B-1）、钉死测试 seam 的调用点、逐条修 12 条 nit。
owner 2026-10-03 定调：**选 C，取最彻底形态**——判为陈旧 → **不发布** → **用采纳后的内容重跑一轮**，
日志说真话，丢弃的模型工作留档。

## 1. 目标

1. 扩展能观察到的任何时序下，外部编辑都不被"由更旧基线生成的回复"顶掉（残留窗口见 §12）。
2. 不白扔模型工作：判为陈旧时本轮工作由重跑替代。
3. 丢弃与采纳都可见：日志陈述**结果**；被丢弃的回复有本地留档。
4. 常态零变化：没有外部编辑时，行为与今天逐字节一致。

## 2. 不变式

- **INV-1 字节守恒**：凡检出"外部内容 ≠ fold 且 render 更新"（今天 `store.ts:61-71` 的采纳条件）
  **或**检出"发布窗口内文件被改写"（§6 第 8 步），该内容**必须 append 进 journal**。
- **INV-2 无陈旧发布**：`MEMORY.md` 由本 pass 写入的内容，其基线不早于发布时刻已知的最新内容。
- **INV-3 可观测**：每次陈旧检测产出一句与**实际 fold 一致**的结果日志；被丢弃的回复留档。

## 3. 硬约束

- 零新依赖；不改外部文件格式（仍是 `# Project Memory` + 四节 Markdown）。
- **读侧可观察行为不变**：`loadMemory` 的 `text`/`source`/`poisoned`/`damaged`/`unreadable` 逐字节不变
  （§5 的抽取是"把同一条规则挪进一个函数"，由既有测试 + 新用例双向钉住）。
- **重跑在锁外**：`shared/lock.ts:179` 的 `withMemoryLock` 带等待上限（`MEMORY_LOCK_WAIT_MS`）、
  **不可重入**（`open(…,"wx")` + 超时）。
- **调用上界**：单 `consolidateProjectState` attempt ≤ **3 次 `callAux`**（首调、解析/截断重试、condense；
  `pass.ts:197/221/248`），`callAux` 在 provider 拒绝 tools 时再发一次 ⇒ ≤ **4 次 provider completion/attempt**；
  `consolidate()` ≤ **2 attempt** ⇒ ≤ **8 次**。写成具名常量并由测试断言（按 attempt/completion 计数）。
- 向后兼容：`recordMemoryDocument` 的既有调用方（`shared/migrate.ts:127`、`tests/memory-ops-test.mjs`、
  `tests/consolidation-test.mjs`）不改也能工作；**不传 `basisKey` 时行为与今天逐字节一致**。
- 落地前走 `.agents/skills/pi-project-context-sandboxed-independent-review/SKILL.md`，直到每轮
  `VERDICT: PASSED`；**PASSED 轮不覆盖其后的改动**（未评审的改动必须进下一轮）。

## 4. 现状（代码事实，行号已逐一复核）

| # | 事实 | 位置 |
| --- | --- | --- |
| F1 | 一次 `recordMemoryDocument` 调用里两次 append：先采纳、再写本次 pass 的 render | `store.ts:68` → `:77` → `:80` |
| F2 | 采纳日志在两次 append **之间**写出，措辞是完成态 | `store.ts:70` |
| F3 | `foldMemoryJournal` 取末条**非空** `replace`（空 text 被 `continue`） | `journal.ts:89-97`，跳过在 `:92-93` |
| F4 | 读取侧在同一条件下返回**外部编辑**；陈旧的是**模型调用期间**落地的编辑 | `store.ts:106-116` |
| F5 | 写入是否发生由 `memoryChanged` 门决定 ⇒ 生效条件反转 | `report.ts:132` |
| F6 | pass 层去重会吞掉重跑：`throttled`（`:149-150`）与 `force && cached && … < forceDedupeMs` 的返回（`:151`） | `pass.ts:149-151` |
| F7 | 空 journal 分支（条件在 `store.ts:50`，块体 `:51-55`）**不经过**采纳检测；采纳块在 `else`（`:56`）内 | `store.ts:50-71` |
| F8 | rotation 用**默认 32000** 折叠，与项目 cap 解耦 | `journal.ts:111` |
| F9 | `activeConsolidation` 模块级单飞、不按 projectRoot 键 | `pass.ts:135,137` |
| F10 | `modelBlocked` 的返回在 `pass.ts:154`；`force=true` 不查它 | `pass.ts:154` |
| F11 | `lastWrite` 清空只发生在每次 `consolidate()` 开头；无写入时现行是 `lastWrite.set({memoryKept:true,…})` | `report.ts:115`、`:204-216`、消费点 `:345` |
| F12 | 现场：QM 142 / UF 35 条 `adopted …`；顶掉记录与更早记录逐字节相同 | 报告 §2 |
| F13 | 已确定性复现（脚本退出码 0），`A → B → A` 即兄弟仓库形态 | `repro-write-ordering.mjs` |

## 5. 决策 1：单一判据 + 基线取"读取函数的精确返回值"

**判据只有一处实现**：把 `loadMemory`（`store.ts:87-160`）的主体抽成内部 `resolveMemory()`，
返回 `{ text, source, poisoned, damaged, unreadable }`；`loadMemory` 变成薄包装，写路径调用**同一个**
`resolveMemory()` 并只取 `.text`。

- **契约**：写路径取得的文本**逐字节等于** `loadMemory(projectRoot, limit).text`，**包含**
  `entries.length === 0` 时的 `MEMORY.md` 原样/`clipToLineBoundary`（**读侧**在 `store.ts:138-142`；
  写路径的空 journal 种子是另一处，在 `:50-55`）、
  `newestMemoryArchive` 回退（`:132`）、`.pi` legacy（`legacyPiDir` `:145`）与 OMP 回退（`legacyOmpDir` `:152`）。
  抽取必须覆盖这些分支——只实现 journal 分支会让 I2 的修复静默失效，且 T5 的弱判据照样绿（R2-IM-5）。
- **判断方式**：`stale = options.basisKey !== undefined && options.basisKey !== currentText`，两边都是
  `resolveMemory()` 的**原始返回字符串**，**不做任何规范化**：
  - `basisKey` 取自 pass 构造 prompt 前同一次 `loadMemory()` 的 `.text`（§11），**不是** `fitted.text`
    （`fitMemoryInput` 会把密集记忆裁短；用裁剪结果做基线会**永久自锁**：每次 pass 判陈旧、有界停止、
    永不发布——R2 用 29728→7585 字符 probe 实测）。
  - 无编辑时同一函数两次调用返回同一字符串，故不误报；无 journal 项目也不会因"raw vs 规范化键"
    产生一次性假陈旧。
- 覆盖 **peer 先采纳**（R1-I1）与**空 journal 首写**（R1-I2，判据在函数入口，早于 `entries.length === 0` 分支）。
- **不猜意图**：区分不了 owner 编辑与旧版本 build 的退化写入，两者正确动作相同——保更新的字节、
  以它重跑；退化内容被重跑固化一轮的取舍**明确接受**（可观测），不引入意图判据。
- **误报守卫**：编辑早于 pass 读取 ⇒ `currentText === basisKey` ⇒ 不判陈旧。

## 6. 决策 2：流程——采纳块保留、陈旧只决定"发不发布"

```ts
export type MemoryWriteResult =
  | { written: true; adopted?: string }
  | { written: false; reason: "pass-reply-was-stale" | "external-edit-during-publish"; kept: string };
```

> 字段语义：`written:true` 的 `adopted` 只在**本调用确实采纳了外部编辑**时存在；
> `written:false` 的 `kept` 是"当前保持生效的内容"，**不代表本调用采纳过任何东西**
> （peer 先采纳时本调用根本没采纳）。report **不得**用 `kept` 反推"本次发生过采纳"（R3-N-6）。
> 另：`kept` 是**生效文本**（探针实测 `kept == fold == resolveMemory().text`），**不是文件字节**——
> `MEMORY.md` 上可能是带 CRLF/行尾空格/超 cap 的原文；日志与测试**不得**拿 `kept` 与文件字节比（R4-nit-9）。

| 步 | 动作 | 相对今天 |
| --- | --- | --- |
| 1 | 读 journal（`entries`/`damaged`/`unreadable`；unreadable 照旧抛）；读 `MEMORY.md` → `renderRaw`；`renderKey = renderRaw.trim() ? memoryComparisonKey(renderRaw, limit) : ""` | 新增 |
| 2 | **采纳块，仅当 `entries.length > 0`**（与 `store.ts:56` 的 `else` 同域）：`foldedView = foldMemoryJournal(entries, limit)`；若 `renderRaw` 非空、`external !== foldedView`、`render.mtime > journal.mtime` ⇒ `appendMemoryOp("replace", external)` + 中性日志（§8）；记 `adopted = external` | 今天的 `:61-71`，**只改日志措辞** |
| 3 | `currentText = (await resolveMemory()).text`；`stale = basisKey !== undefined && basisKey !== currentText` | 新增 |
| 3b | **测试 seam（仅测试传入）**：`await options.__testOnBeforePublish?.()`。位置**必须在第 3 步之后、第 5/6 步之前**，理由见下 | 新增 |
| 4 | 若 `stale` ⇒ 中性日志 + 返回 `{written:false, reason:"pass-reply-was-stale", kept:currentText}`，**不发布** | 新增 |
| 5 | `entries.length === 0` 的既有种子逻辑 | 原样 |
| 6 | `rendered = normalizeMemoryReply(...)`；`appendMemoryOp("replace", rendered)` | 原样 |
| 7 | `rotateMemoryJournalIfNeeded` / `ensureMemoryGitignore` | 原样 |
| 8 | **recheck（比 `MEMORY.md` 自己的字节）**：重读 → `nowRaw`；`nowKey = nowRaw.trim() ? memoryComparisonKey(nowRaw, limit) : ""`。触发条件：`basisKey !== undefined && nowKey !== "" && nowKey !== renderKey && nowKey !== memoryComparisonKey(rendered, limit)`。触发时**先 `appendMemoryOp("replace", nowKey)` 再返回** `{written:false, reason:"external-edit-during-publish", kept:nowKey}`，**不写 `MEMORY.md`** | 新增 |
| 9 | `writeAtomic(MEMORY.md, rendered)`；返回 `{written:true, adopted}` | 原样 + `adopted` |

四处要点：

- **第 8 步必须 append（R3-B1 的修法）**：只返回不落 journal 时，新字节的 mtime 早于第 6 步刚 sync 的
  journal ⇒ 重跑的 `loadMemory()` 会返回**attempt 1 被丢弃的回复**，编辑既不生效也不是基线，而日志说 "kept"。
  评审实测：补上这行后 `journal=A→A→C→E`、`attempt2 basisKey=E`、最终 `A→A→C→E→D`，三条断言全转绿。
  这正是 R1 的 B2 修复边界里明写过的动作（"把新 key 采纳进历史"），v2→v3 重排时丢失。
  **append 的是 `nowKey`（规范化键）而不是 `nowRaw`**：与第 2 步采纳块 append `external`（同样是规范化键）
  保持同一种落 journal 形式；`MEMORY.md` 上保持 `nowRaw` 不动（我们不重写它）。
- **第 8 步比"文件自己的字节"而不是比有效内容**（v2.1 自纠，R2/R3 均复核）：第 6 步 append `rendered`
  之后 fold **就是 `rendered`**，而 `MEMORY.md` 的 mtime 必然早于刚写完的 journal ⇒ 比有效内容会
  **恒触发**，正常路径永不发布。
- **空内容不触发（R2-IM-1）**：窗口内 `MEMORY.md` 被清空时 `nowKey === ""`；若照旧触发，
  `appendMemoryOp("replace","")` 对 fold 是 **no-op**（`journal.ts:92-93`）⇒ 生效的是被声称"未发布"的回复，
  日志与 fold 相反。故空内容按 R-1 的既有语义**继续发布**。
- **第 8 步的窗口内改写"恰好等于即将写入的内容"时不触发**（R3-N-10 定稿：**纳入**该条件）：发布等于
  没有变化，触发只会白跑一次重跑。CRLF-only / 行尾空格的重写仍会触发（`memoryComparisonKey` 只归一化
  文档级尾空白）——安全侧，明示不收紧（R-14）。

**窗口划分（R3-B1 后修正）**：

- **第 3 步 → 第 6 步**之间的编辑：由第 8 步按字节**检出**，且第 8 步的 append 使其进入 journal 并成为
  重跑基线 ⇒ 生效丢失被关闭（这是 v3 缺的那一半）。
- **第 8 步读取 → rename**：唯一残留字节窗口（Node 无 CAS），压到 μm–ms 级；其中的编辑会丢字节
  （只存在于被 rename 覆盖的文件里）。明示不假装关闭（R-2）。
- 第 8 步触发时第 6 步的 `rendered` 留在 journal 历史但非生效（R-10）。

## 7. 决策 3：重跑走 pass 层新入口，并断言 version 递增（R1-B1）

`consolidateProjectState` 选项加 `rerun?: boolean`（参数行 `pass.ts:132`）：

- `rerun: true` **跳过** `throttled` 返回与 `force && cached && Date.now()-cached.at < forceDedupeMs`
  返回（`pass.ts:149-151`）⇒ 若产出 outcome 则 `nextVersion += 1`（`pass.ts:319`）。
- **不**跳过失败停放：`modelBlocked` 时 `pass.ts:154` 返回 `cached?.outcome`（第 1 次成功后 `lastOutcome`
  必有值），且 `force=true` 本就不查它（F10）——"路由故障时不重跑"的兜底是**version 断言**，不是该分支。
- `activeConsolidation`（`pass.ts:135`）在第一次调用的 `.finally` 里已清空，不阻塞重跑；它是模块级、
  不按 projectRoot 键（F9）——重跑不加剧（同为普通调用，概率不变），既有问题见 R-4。
- 调用方（`report.ts`）拿到 `outcome2` 后**必须断言** `outcome2.version !== outcome1.version`；
  不满足则**不得**进入写路径（按"重跑未发生"处理）。

## 8. 决策 4：日志归属拆分

`store.ts` 只输出**中性事实**（不知道调用方是否重跑、也不知道之后是否发布成功）：

- 采纳块：`the memory on disk was newer than the journal; it was adopted into the journal history`
- 陈旧：`this pass's reply was older than the memory read just now; it was not published`
- 发布窗口：`the memory file changed during the publish window; the newer content was adopted and this pass's reply was not published`

`report.ts` 在**循环结束后**输出**结果句**，含"成功"字样者必须在发布成功之后：

| 条件 | 结果句 |
| --- | --- |
| **最终发布 attempt** 的 `adopted` 存在 | `adopted an externally edited MEMORY.md into the memory journal; this pass's reply replaced it in the same write` |
| 最终发布 attempt 无 `adopted` | 沿用今天的 `Project memory updated: …`（**不得**出现 adopted 字样） |
| 检出陈旧（两种 reason 共用同一有界循环）→ 重跑**发布成功** | `the memory changed while the reply was being built or published: the reply was discarded, the newer content was kept, and the pass was re-run` |
| 检出陈旧 → 重跑**未发生/未产出 outcome** | `…the newer content was kept; the re-run did not happen` |
| 检出陈旧 → 重跑产出了回复但**也被判陈旧** | `…the newer content was kept; the re-run's reply was also discarded`（**仅当该次在第 8 步被判陈旧**时，其回复才按 R-10 留在历史里；若它在第 4 步就判陈旧，回复从未 append） |
| 检出陈旧 → 重跑**产出 outcome 但 `memoryChanged === false`**（heading-only / opaque < 40 字符，`report.ts:131-133`） | `…the newer content was kept; the re-run's reply carried nothing usable and was discarded`（R4-IM-2 补的格；它同样走 `"superseded"`，且**不**执行任何发布侧副作用） |

**选择句子用循环状态，不是 `adopted` 的存在性**：重跑成功时 attempt 2 自己也可能有 `adopted`，
只有"最终发布 attempt 的 `adopted`"才允许出现采纳句（R2-IM-2 的注意项 + R3-N-7 区分后两种退出）。

## 9. 决策 5：副作用只在最终 attempt 执行

**两类副作用必须分开，不能一律门在 `written:true`（v4.1 自查修正）**：

1. **只在 `written:true` 时执行**（它们描述的是"刚刚发布了一次 memory"）：`saveOverflowReply`、
   `cappedMemory`/`cappedSections`/`neededChars` 的计算、cap / section-cap / 存过 poison 三类 `errors.log`
   （`report.ts:185-197`）、memory-update 分支的 notify（`:232-259`）、`memoryRemovalWarned` 消费（`:264-265`）、
   以及 `contextShapeWarned` 消费（`:138`/`:145`——它描述的是**回复**的 context 形状，回复被丢弃时不该烧掉）。
   任何 `written:false` 的 attempt——**包括作为"最终 attempt"的那一次**（§8 的 row 5 / row 6）——只允许：
   第 8 步的 append、写前备份、`memory-stale` 留档、中性日志，以及 keep-adoption 的那一次 warning toast。
2. **与 memory 发布解耦、保持现行行为**：`update` 存在时写 CONTEXT.md（`:217-226`）与 `lastWrite`（`:204-216`）。
   `report.ts:203-205` 的注释明确"context rewritten while memory kept"是**合法组合**，命令的回复措辞依赖
   `lastWrite`——**不得**把这两者纳入 `written:true` 门（那会造成回归）。

不这样做就会写出"memory exceeded maxMemoryChars…middle dropped"或"no longer carries N entries"这类
**关于一次并未发生的发布**的 errors.log/notify，并把一次性集合烧掉、让真正的下一次事件不再告警。
attempt 1 允许的副作用只有：采纳 append（INV-1）、写前备份 `backupMemoryBeforeWrite`
（先于检测执行、无法避免，且是外部编辑的额外保底）、被丢弃回复的留档（§10）。

**overflow 留档改到"发布成功之后"（R3-N-8 定稿）**：今天 `saveOverflowReply` 在写路径之前
（`report.ts:159-165`）。若最终 attempt 在 step 8 被判陈旧，先前的顺序会同时留下 `memory-overflow-*`
与 `memory-stale-*`，违反"同一份回复只留一种"。更准确的语义是：**只有被裁过的文档真的发布，才需要那份
可恢复副本**。因此 v4 把该调用移到 `written === true` 之后立即执行（仍然是 best-effort、失败只记日志）。
对 D2 的影响：其 fix note 有**两处**要同步改——§3 的"落盘时机在任何裁剪之前"改为"在发布成功之后立即落盘"，
以及 §4 的"写副本在前、写受限文档在后"这条边界**不再成立**（顺序反了）；
另 D2 fix note §5 residual-1（发版前补一轮独立评审）必须在 `v0.2.1` 计划里落实。
D2 尚未发版，无兼容问题；失去的只是"发布成功但与写副本之间进程死掉"这一窄窗口（诊断便利，非正确性）。

`consolidate()` 的退出形态四种：**发布成功** / **保留采纳内容且重跑未发生或未产出 outcome** /
**保留采纳内容且重跑产出但未发布**（row 5 / row 6） / **失败**（既有失败路径不变）。

- `ConsolidateReport` 新增 `"superseded"`，用于"检出陈旧但最终保留新内容"的两种退出。
- **`"superseded"` 的赋值必须早于 `report.ts:226`** 的 `memoryChanged || update ? … : "unchanged"`，
  并在 `:232` 的 notify 与 `:345` 的 `consolidateReply` 里短路：keep-adoption 时 `memoryChanged || update`
  可能为真，否则命令会说 "updated" 或 "already up to date"，而事实是本轮回复被丢弃、你的编辑被保住。
- **keep-adoption 退出必须 `lastWrite.delete(projectRoot)`**：今天无写入时是
  `lastWrite.set({memoryKept:true, …})`（`report.ts:204-216`）——那是"记忆内容没变"的语义，
  与"你的编辑被保住、本轮回复被丢弃"不同，且 `/memory update` 的回复由 `consolidateReply(report, …)`
  在 `:345` 统一产出。**`"superseded"` 必须在 `memoryKept` 分支之前短路**（R3-N-4）。
- **toast 门控（R3-N-9）**：keep-adoption 时发一次 warning toast，但必须由 `!silent` 门控——
  `session_shutdown` 与 `/memory update` 都是 `silent=true`。命令路径改走
  `consolidateReply("superseded")` 的文案。成功发布不新增 toast。

## 10. 决策 6：被丢弃的回复留档

与 `saveOverflowReply` 对称：写 `.agents/memory/memory-stale-<ISO>.md`，时间戳照抄
`replace(/[:.]/g,"-")`；`writeAtomic`、best-effort；`shared/gitignore.ts` 的 `MEMORY_GITIGNORE_LINES`
增加 `memory-stale-*.md`；日志点名该文件。`*.tmp` 残片由既有 `cleanStaleTemps`（1 h）回收；
不做年龄保留策略（§17.4）。**去重规则**：同一份回复只留一种档——被丢弃走 stale，被裁剪走 overflow，
而 overflow 现在只在发布成功后写（§9），因此不存在两份并存。

## 11. 接口改动（含调用点闭环，R3-N-11）

```ts
// memory/store.ts
export type MemoryWriteResult =
  | { written: true; adopted?: string }
  | { written: false; reason: "pass-reply-was-stale" | "external-edit-during-publish"; kept: string };

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

**实施清单（缺一即静默退回 legacy 行为）**：

1. `pass.ts:161` 之后：`basisKey` = `existing.text`（**原值**，不规范化、不用 `fitted.text`），填入
   `:323` 的 outcome。
2. `report.ts:171` 的调用**必须改成**：
   `recordMemoryDocument(projectRoot, memoryText, maxMemoryChars, { basisKey: outcome.basisKey })`。
   （今天只有三个实参；漏传 = 永不判陈旧，T1/T4/T5 会红。）
3. `shared/project-state.ts:9` 的 re-export 多导出 `MemoryWriteResult`。
4. `ConsolidateReport` 增加 `"superseded"`；`consolidateReply` 与 toast 分支同步。
5. `__testOnBeforePublish` **仅测试传入**（双下划线标明身份），生产路径不传。

## 12. 风险与残留

| # | 项 | 处置 |
| --- | --- | --- |
| R-1 | **不可观察窗口**：mtime 回退的编辑（`cp -p`/`rsync --times`）不被采纳检测看到；owner **清空** `MEMORY.md` 时（**写侧**守卫 `store.ts:63`，**读侧**返回 fold 的守卫 `store.ts:106`）回复胜出 | 明示为已接受语义；目标 1 据此收窄 |
| R-2 | **第 8 步读取 → rename** 窗口内落地的编辑丢字节（Node 无 CAS） | 窗口压到最小并明示（第 3→6 步窗口已由第 8 步的 append 关闭） |
| R-3 | cap>32000 时 rotation 用默认 32000 折叠（F8）⇒ fold 可能落后 render | 既有问题；**T13 只在未触发 rotation 的小 fixture 下断言**，否则改断言 `resolveMemory().text` |
| R-4 | `activeConsolidation` 模块级、不按 projectRoot 键（F9） | 既有；重跑不加剧（概率不变），记录待办 |
| R-5 | **未升级的 peer 进程仍会顶掉编辑** | 明示：全部进程升级后才对所有交错成立 |
| R-6 | 重跑放大调用量 | 上限 2 attempt（§3）；version 断言兜底；日志可计数 |
| R-7 | session_shutdown 同步 pass 最坏 8 次 completion ⇒ 退出变慢 | 接受并记录 |
| R-8 | 退化外部写入被重跑固化一轮 | 决策 1 的取舍，可观测 |
| R-9 | 基线口径不一致导致误判 | 两侧同为 `resolveMemory()` 原始返回；T3 覆盖 clip 与无 journal 两个 fixture |
| R-10 | 第 8 步触发时 `rendered` 留在历史但非生效 | 有意；测试断言"未成为 render"，不是"不在 journal" |
| R-11 | `written.set` 的 claim 语义 | 最终 attempt 的 version 一经确定，仍在任何 `await` 之前同步 claim；**stale-stop（非异常、未发布）时保持 claim**（防缓存 outcome 被回放）；失败时按既有 `wroteMemory` 模式释放 |
| R-12 | 第 4 步早退跳过 `rotateMemoryJournalIfNeeded`/`ensureMemoryGitignore`（第 7 步之前 return） | 明示：journal 可暂超 512 KB，无损坏，属可接受延迟 |
| R-12b | 第 8 步的 append 发生在第 7 步 rotation **之后** ⇒ 可能把 journal 重新推过 512 KB 而当次不再旋转（下个 pass 才收敛） | 与 R-12 同族；明示为可接受延迟 |
| R-17 | pass 读到 report 写之间 **cap 被改**（`maxMemoryChars`）⇒ 一次假陈旧 | 有界重跑一次即自愈（R4-nit-8）；非阻塞，记录 |
| R-13 | `memory-stale-*` / `memory-overflow-*` 只增不减 | 本设计不引入保留策略（与 D3 同族），§17.4 |
| R-14 | 窗口内 CRLF-only / 行尾空格重写会被判陈旧 | `memoryComparisonKey` 只归一化文档级尾空白；安全侧，明示不收紧 |
| R-15 | 窗口内把 `MEMORY.md` **清空**时按 R-1 语义发布（回复胜出） | 定稿：空内容不是"更新的记忆"；日志必须与实际 fold 一致 |
| R-16 | 第 8 步触发后 `MEMORY.md` 保留编辑、journal 末条是该编辑、且 `rendered` 在历史中 | 三者自洽（fold == `MEMORY.md` 语义上相等，因其内容已 append）；由 T6/T13 断言 |

## 13. 测试计划

新增 `tests/external-edit-test.mjs`：

| # | 场景 | 通过判据 |
| --- | --- | --- |
| T1 | **重跑验收线**：fake `modelRegistry.complete` 第 1 次调用期间改 `MEMORY.md` 为 B；force（`session_shutdown`）与非 force（`agent_settled`，需把 `consolidateTurns` 配小或让间隔已过，否则被 `pass.ts:149` 节流） | 第 2 次真实 pass 发生（completion 计数增加）；最终 `MEMORY.md` = 第 2 次回复；第 1 次回复未成为 render；B 在 journal 历史；`memory-stale-*.md` 存在 |
| T2 | 重跑不得写缓存回复 | **唯一构造法**（R3-N-5 + R4-nit-5）：让 `rerun` 那次的 `resolveAuxModel` 返回 undefined（在 fake 首调里改 `ctx`）⇒ `consolidateProjectState` 返回 **`undefined`**；断言 `outcome2 === undefined` 时**不调用**写路径，B 仍生效 |
| T3 | 误报守卫，两个 fixture：(a) 无 journal 项目、(b) prompt 被 `fitMemoryInput` clip（密集记忆，输出上限 8192 量级） | 都不判陈旧、发生发布 |
| T4 | peer 先采纳：fake 首次调用里直接调 `recordMemoryDocument(root, Q)` 模拟 peer，随后本写路径 | 判陈旧；本次回复未写；Q 仍是 fold；B 未退回纯历史 |
| T5 | 空 journal 首写，判据收紧 | 断言"**B 进 journal** **且**重跑回复被发布"；只断言"B 仍生效"不算通过 |
| T6 | TOCTOU：用 `__testOnBeforePublish`（位置 = 第 3 步之后、第 5/6 步之前）注入编辑，含**窗口内清空**变体 | 非空：走陈旧分支、**该字节 append 进 journal**、**重跑 `basisKey` 含该字节**（R3-B1 的验收线）、日志与最终 fold 一致；清空：按 R-15 发布，日志不得声称"未发布" |
| T7 | 重跑期间再次编辑 | 有界停止；保留采纳内容；`ConsolidateReport === "superseded"`；结果句为"re-run's reply was also discarded"；无第三次 attempt |
| T8 | 锁：pass 阶段不持锁、两个写窗口各持锁一次 | fake 阻塞期间轮询 `MEMORY.md.lock` 不存在；总耗时 < `MEMORY_LOCK_WAIT_MS` |
| T9 | 记账与副作用门 | keep-adoption 时 `lastWrite` 被 `delete`（不是 `memoryKept`）；`consolidateReply("superseded")` 在 `memoryKept` 分支之前短路；并发两次 `consolidate()` 不重复写同一 version；**keep-adoption 退出后 `memoryCapWarned`/`memoryRemovalWarned`/`contextShapeWarned` 未被消费、errors.log 无 cap/removal 行、CONTEXT.md 未变**（R4-IM-1 的验收线） |
| T10 | 调用上界 | 用 R2 的配方（tools 抛非 provider 错 → 回落坏 JSON → retry 有效 → condense）实测 completion 数 = 具名常量 |
| T11 | D2 交互与去重 | 最终 attempt 陈旧时**只有** `memory-stale-*`（无 overflow 孤儿）；发布成功且超 cap 时**只有** `memory-overflow-*`；gitignore 覆盖两者；留档失败不阻断；日志点名实际文件 |
| T12 | 兼容 / I7 | `run-all` 全绿；migrate 输出 md5 不变；**不传 `basisKey` 且确实发生采纳**时 journal 含采纳记录，行为与今天逐字节一致 |
| T13 | INV 断言 | 小 fixture（不触发 rotation）下 `memoryComparisonKey(MEMORY.md) === foldMemoryJournal(entries)`，分「陈旧后」「重跑成功后」两段；CRLF 变体两边都保留 `\r`；rotation 场景改断言 `resolveMemory().text` |
| T14 | 复现脚本重写 | 主用例驱动 report/pass 全链路（`session_shutdown` + fake model）验证重跑；显式传 `basisKey` 的 store 级变体只作"编辑保住"补充；脚本头部 exit-code 注释与判定一并改（现在 0 = 复现 bug） |

## 14. 评审计划

沙箱只读独立评审，每轮记录候选定版 md5；零写入证明 = 前后 `git status --porcelain -uall` +
`find … stat` 快照（`-prune` 掉 `.agents/memory`）；**0 字节 transcript = provider 失败，必须重跑**；
**PASSED 轮不覆盖其后的改动**。轮次与残留记入 `external-edit-adoption-overwritten-review-report.md`。

## 15. 非目标

- **M / N**（opaque 回复迁移到分节路径）：另立设计。
- **D1**（opaque 按节丢整条）被 N 覆盖；**S4** 为冻结设计的非目标（`structured-consolidation-output-design.md:401`）。
- 可配置 CONTEXT cap、CONTEXT.md 读侧迁移、归档 vault/加密/上传、autolearn 节流与准入、handoff 摘要路径。
- **意图判据**：显式不引入。
- R-1/R-3/R-4/R-13/R-14：记录但不修。

## 16. 决策记录

- **owner 2026-10-03**：选 **C** 且取**最彻底形态**；发版次序 设计 → 修 + 测试 + 独立评审 → 与 D2 一起切 `v0.2.1`。
- **R1**（v1）`CHANGES-REQUESTED`（2 blocking + 8 important）→ v2。
- **自纠**（v2.1，未评审）：第 7 步比有效内容会恒触发 → 改比 `MEMORY.md` 自身字节。
- **R2**（v2.1）`CHANGES-REQUESTED`（0 blocking + 5 important）→ v3。
- **R3**（v3）`CHANGES-REQUESTED`（1 blocking + 1 important + 12 nit）→ **v4**：
  - B-1：第 8 步**先 append 再返回**（重跑基线 = 编辑），且 append 的是 `nowKey`（与第 2 步采纳块同一形式）；
  - IMPORTANT-1：seam 调用点钉在**第 3 步之后、第 5/6 步之前**；
  - N-1 第 2 步限定 `entries.length > 0`；N-2/N-3/N-12 行号修正；N-4 `lastWrite.delete` + `"superseded"` 短路；
    N-5 T2 构造法钉死；N-6 `kept` 取代 `adopted` 的误用；N-7 两种退出分开措辞；N-8 overflow 移到发布成功后；
    N-9 toast `!silent` 门控；N-10 纳入 `nowKey === key(rendered)` 不触发；N-11 §11 实施清单闭环。
- **R4**（v4）`CHANGES-REQUESTED`（**0 blocking** + 2 important + 11 nit）→ **v4.1**：
  - IM-1：发布侧副作用（overflow/CONTEXT/`lastWrite`/四个一次性集合/notify）**只在 `written:true` 时执行**，
    `written:false` 的"最终 attempt"（row 5/6）不得写"关于一次并未发生的发布"的日志、不得烧掉一次性集合；
  - IM-2：§8 句表补"重跑产出 outcome 但 `memoryChanged === false`"一格；退出形态改四种；
  - nit：`pass.ts:151` / `store.ts:87-160` / 读侧 `:138-142` / 清空守卫 `:106` / T2 断言 `outcome2 === undefined` /
    `kept` 不是文件字节 / 命令回复文本要钉死 / D2 fix note 两处同步 / R-12b / R-17。
- **自纠 2026-10-03（v4.1，未评审）**：R4-IM-1 的指令字面执行会破坏"CONTEXT 被重写而 memory 保留"这一
  **既有合法组合**（`report.ts:203-205`）。§9 改为两类副作用分开：只把"描述刚发布了一次 memory"的副作用
  门在 `written:true`；CONTEXT 写入（`:217-226`）与 `lastWrite`（`:204-216`）保持解耦。另补 `"superseded"`
  的赋值必须早于 `:226` 并短路 `:232`/`:345`。

## 17. 定稿的开放项

1. **`ConsolidateReport` / keep-adoption 语义**：新增 `"superseded"`；**`lastWrite.delete`**；命令回复由
   `consolidateReply("superseded")` 产出且必须在 `memoryKept` 分支之前短路（§9，R3-N-4）。
   **命令回复文本要钉死**（R4-nit-6）：`lastWrite.delete` 之后 `consolidateReply` 拿不到 `info`，只能给通用文案；
   若要区分 row 4（重跑未发生）与 row 5/6（重跑产出但未发布），必须把 loop 状态单独传给文案函数，
   或接受通用文案并在结果句里区分——**二选一，实施时定并写进本项**。
2. **toast**：成功发布不新增；keep-adoption 发一次 warning toast，由 `!silent` 门控（§9，R3-N-9）。
3. **测试 seam**：`__testOnBeforePublish`，位置 = **第 3 步之后、第 5/6 步之前**（§6 第 3b 步，R3-IMPORTANT-1）。
   理由：要验证的是 INV-2 的**时间窗性质**与 R-15 的接线，纯函数单测测不到接线。
4. **留档保留策略**：**不做**（R-13）：删除证据比磁盘增长更糟，保留策略与 D3 同族，应在 D3 一并定。
