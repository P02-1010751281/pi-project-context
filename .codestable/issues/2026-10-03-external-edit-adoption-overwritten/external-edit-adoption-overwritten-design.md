---
doc_type: design
issue: 2026-10-03-external-edit-adoption-overwritten
status: draft
created_at: 2026-10-03
revision: 8 (B 版：最小修复面 + R6/R7 的修正)
related: [external-edit-adoption-overwritten-design-full-v5-archive.md, external-edit-adoption-overwritten-report.md, external-edit-adoption-overwritten-review-report.md, repro-write-ordering.mjs]
tags: [memory, memory-journal, external-edit-adoption, lost-update, write-ordering, minimal-design]
---

# 外部编辑采纳后被旧内容覆盖 修复设计（B 版，revision 8）

> **版本**：v1–v5 是"完整版"（415 行，含"判陈旧后重跑一轮"），5 轮评审后 owner 判定与 30–40 行的修复
> 不成比例 ⇒ 重写为 B 版（**取消重跑**）。R6（B 版）判 `CHANGES-REQUESTED`：1 blocking + 3 important；
> R7（revision 7）判 `CHANGES-REQUESTED`：**0 blocking** + 3 important + 7 nit。
> **两轮的发现全部是【修正已有机制】，无一条要求新机制。** 本 revision 8 折入 R7 的三条 important 与 7 条 nit。
> v5 全文存档于 `…-design-full-v5-archive.md`（**不要照它实施**）。

## 0. 最小修复面（对照）

| 层 | 改动 | 规模 |
| --- | --- | --- |
| `memory/pass.ts` | `ConsolidateOutcome.basisKey` 字段 + 构造点（`pass.ts:323`） | ~3 行 |
| `memory/store.ts` | 入口 `renderKey`、§2.2 判据、种子后置、§2.3 recheck、`nextRenderSupersedes`、返回值 | ~32 行 |
| `memory/report.ts` | 拒绝旗标、跳过发布侧、`keepReason:"stale"` + `contextWritten`、`wroteMemory`、`consolidateReply` 分支、overflow 后置 | ~28 行 |
| `tests/external-edit-test.mjs` | T1–T6 | 新文件 |
| `repro-write-ordering.mjs` | 传 `basisKey` + 谓词与退出码语义翻转 | ~6 行 |

**不做**：重跑、`memory-stale-*` 留档、`resolveMemory()` 抽取、测试 seam、锁改动、读侧改动。

## 1. 现场事实（机制必须对应到这几条，否则不做）

| # | 事实 | 来源 |
| --- | --- | --- |
| F1 | 一次 `recordMemoryDocument` 调用里两次 append（先采纳、再写本次 pass 的 render），后者决定生效内容 | `store.ts:68`/`:77`/`:80` |
| F2 | 顶掉采纳的那条记录与**更早一条逐字节相同** ⇒ 覆盖它的是"由**编辑前快照**生成的回复" | QM `[1]≡[3]≡[5]`、UF `[3]≡[5]` |
| F3 | 采纳日志在覆盖**之前**写出、措辞是完成态；现场 142 / 35 条，命令回复同族 | `store.ts:70`、`report.ts:408` |
| F4 | 已确定性复现，`A → B → A` 即兄弟仓库形态 | `repro-write-ordering.mjs` |

**结论**：唯一需要修的是"**用更旧基线算出的回复覆盖了更新的内容**"。

## 2. 方案

### 2.0 执行顺序（R6-IM-1：必须写死）

R6 用 probe 实测三种自然落点：字面"采纳块之后" ⇒ T4 红；字面"函数入口" ⇒ T2 的"编辑进 journal"红；
"整个 `if/else` 之后" ⇒ 种子把读侧 `clipToLineBoundary(raw.trim())` 归一化成 `normalizeMemoryDocument` 形态，
**无编辑也判陈旧**。唯一同时满足 T2/T3/T4 的是 v5 顺序：

```
① 入口读一次 MEMORY.md → renderRaw / renderKey（与采纳块同源）
② base.entries.length > 0  ⇒ 采纳块（原 store.ts:56-72）
③ §2.2 基线判据 —— 不通过就 return（不写、不种子）
④ base.entries.length === 0 ⇒ 种子（原 store.ts:50-55）
⑤ §2.3 发布前 recheck
⑥ appendMemoryOp(rendered) → rotate → ensureMemoryGitignore → writeAtomic
```

### 2.1 pass：把基线带出来

`ConsolidateOutcome` 增 `basisKey: string` = 构造 prompt 前 `loadMemory()` 返回的 **`.text` 原值**
（`pass.ts:161` 的 `existing.text`；**不用** `fitted.text`——用裁剪结果当基线会永久自锁）。构造点只有 `pass.ts:323` 一处。

### 2.2 store：基线不一致就不发布

```ts
// ① 入口（R6-B-1：renderKey 必须与采纳块同源，且空文档必须归零）
const renderRaw = await readOptional(memoryFile(projectRoot));
const renderKey = renderRaw.trim() ? memoryComparisonKey(renderRaw, limit) : "";
...
// ③ 判据（R7-IM-B：两侧都过 memoryComparisonKey；空/纯空白不是"更新的记忆"）
const current = await loadMemory(projectRoot, limit);
if (options.basisKey !== undefined && current.text.trim()
    && memoryComparisonKey(current.text, limit) !== memoryComparisonKey(options.basisKey, limit)) {
    await logError(projectRoot, "memory",
        "the memory changed while this pass's reply was being built; the reply was not published and the newer content stays effective");
    return { written: false, kept: current.text };
}
```

- **为什么两侧要过 key（R7-IM-B）**：`loadMemory` 的返回形态随**读取来源**变化——journal 存在时返回 fold
  （`normalizeMemoryDocument` 形态、带尾换行），无 journal 时返回 `clipToLineBoundary(raw.trim())`
  （`store.ts:139-142`，**无**尾换行）。若 pass 读与 store 读之间 journal 被建立/删除（并发进程的首个 pass、
  手删 journal 后恢复），**同一份 `MEMORY.md` 字节**会被读成两种形态 ⇒ **假陈旧** + 一条断言"memory changed"
  的假日志（R7 `probe-sourceflip.mjs`）。两侧过 `memoryComparisonKey`（幂等，实测四 fixture 方向不变）后不再成立。
- **`loadMemory` 的渲染选择规则（R7 实测）**：journal 存在时，只有 **render 非空 + key ≠ fold +
  render mtime 严格大于 journal mtime** 才返回 render，否则返回 fold。
- **状态自洽的依据**：② 采纳块在判据**之前**跑，它把更新的字节 append 进 journal ⇒ ③ 读到的 `current`
  （fold，或 ② 之后的 render）**已经是最新**，所以 §2.2 拒绝时**不需要**再 append。
  （与 R3-B1 不同：那里 journal 还没拿到新字节。R7 实测确认此结论成立。）
- **mtime 回退**的编辑：`loadMemory` 返回 fold ⇒ §2.2 **看不见**它 ⇒ 正常发布并覆盖（§5 R-1）。注意这与
  下面那条不是同一情形。
- **① / ② 之间**落地的编辑：② 用旧 `renderRaw` 判定不采纳，③ 却读到它并判陈旧 ⇒ 拒绝、字节只在 `MEMORY.md`
  且**保持生效**，下一次写路径的 ② 先采纳、再基于它发布（R7 probe 实证）。**不为此加机制**（§5 R-11）。
- `current.text.trim()` 守卫：owner 清空 `MEMORY.md` 时**不拦**（回复胜出），保持既有语义（§5 R-3）。
- `basisKey === undefined` ⇒ 永不判陈旧 ⇒ `migrate.ts` 与既有测试行为逐字节不变。

### 2.3 store：发布前 recheck（R6-B-1：判据必须导出成有名字的纯函数）

```ts
/** True when what is on disk now is a different, non-empty document than what this pass will publish. */
export function nextRenderSupersedes(renderKey: string, nowKey: string, publishKey: string): boolean {
    return nowKey !== "" && nowKey !== renderKey && nowKey !== publishKey;
}
...
// ⑤ 在 appendMemoryOp(rendered) 之前
const nowRaw = await readOptional(memoryFile(projectRoot));
const nowKey = nowRaw.trim() ? memoryComparisonKey(nowRaw, limit) : "";
if (options.basisKey !== undefined && nextRenderSupersedes(renderKey, nowKey, memoryComparisonKey(rendered, limit))) {
    await appendMemoryOp(file, "replace", nowKey);      // 新字节进历史（R3-B1 的修法）
    await logError(projectRoot, "memory", "an external edit landed while this pass's memory write was being prepared; the reply was not published");   // R7-nit-7：与 §2.2 的拒绝在日志里可区分
    return { written: false, kept: (await loadMemory(projectRoot, limit)).text };
}
```

- 放在 `appendMemoryOp(rendered)` **之前** ⇒ 回复从不进 journal，v5 的"rendered 在历史里但非生效"随之消失。
- 三个入参都是 `memoryComparisonKey`（`poison.ts:156`，**已存在**、`store.ts:11` 已导入）规范化后的键；
  `kept` 一律取 `loadMemory().text`（与 §2.2 同口径），append 的是 `nowKey`（**不是**文件原始字节）。
- **`memoryComparisonKey` 的归一化边界（R7 实测）**：只吸收**文档级**首尾空白与尾换行；**内部** `\r` 与
  内部行尾空格**原样保留** ⇒ CRLF 或行尾空格编辑被视为不同 ⇒ 触发并 append（安全侧）。
- 空守卫 `nowKey !== ""`：窗口内清空/删文件 ⇒ 不拦（T6）；`publishKey` 排除项避免"窗口内写入的恰好是
  即将发布的回复"时谎报"已丢弃"（v5 N-10）。
- 放在 `writeAtomic`/rename 之前的窗口仍是残留（§5 R-6）。

### 2.4 report：拒绝态（R6-IM-2 + R7-IM-A）

```ts
// :169-173 锁回调改为带回写结果
const snapshot = await withMemoryLock(memoryFile(projectRoot), async () => {
    const kept = await backupMemoryBeforeWrite(memoryFile(projectRoot));
    const result = await recordMemoryDocument(projectRoot, memoryText, maxMemoryChars, { basisKey: outcome.basisKey });
    return { ...kept, written: result.written };
});
const memoryRefused = memoryChanged && !snapshot.written;
wroteMemory = snapshot.written;   // :176 —— 语义 = "本次 pass 是否落地了新的 MEMORY.md"，:275 的 claim 释放靠它
```

**应跳 / 不应跳（照 `report.ts` 行号；拒绝态 = `memoryRefused === true`）**

| 行 | 副作用 | 拒绝态 |
| --- | --- | --- |
| `:163-165` | `saveOverflowReply` | **跳**；并把调用移到**锁回调返回之后、`:179` 记账之前**（`:198`/`:254` 两处 `overflowPath` 插值都在其后，不能失去指针） |
| `:179-184` | `cappedSections` / `cappedMemory` / `neededChars` 赋值 | **跳**（保持初值 `false/false/0`），否则 `lastWrite` 带假 cap |
| `:185-188` | `replaced a stored JSON reply` 的 errors.log | **跳** |
| `:188-190` | section-budget errors.log + `memorySectionCapWarned` | **跳** |
| `:191-199` | cap errors.log + `memoryCapWarned` | **跳** |
| `:215` | `lastWrite` 的 `removed` 字段 | **跳**（拒绝态条目并未消失；`consolidateReply` 的 guard 会据此说谎） |
| `:228-230` | `consolidation shortened …` errors.log | **跳** |
| `:232-259` | 五个"发布成功"类 notify | **跳**；改为一条诚实 toast（非 silent 时，措辞与命令回复同规则） |
| `:260-270` | removal toast | **跳**（判定需提到拒绝旗标之后） |
| `:169-171` | `backupMemoryBeforeWrite` | **不跳**（写前备份 = 编辑的额外保底，且发生在判据之前） |
| `:135-151` | `contextShapeWarned` | **不跳**（描述 CONTEXT 回复形状，而 CONTEXT 照写 ⇒ 仍成立）。*注：v5 在重跑世界里选"拒绝态不消费"，本版选"留"；R7 判本版正确* |
| `:217-226` | CONTEXT.md 写入 + `contextCapWarned` | **不跳**（既有解耦语义：keep-adoption 也照写） |
| `:234-237` | `!memoryChanged` 的 keep 类 notify | **不跳**（今天就不在这扇门内，**绝不能被拖进来**，否则回归 R5-IM-1 保护的既有组合） |

**拒绝态的措辞（R7-IM-A：前缀必须由"context 是否真的写了"决定）**

`update === undefined`（回复没带可用 context，且既有 `CONTEXT.md` 非空）时 CONTEXT **没有写**，
但 `report` 仍是 `"updated"`；照 v7 的写法命令回复会输出 "Project context updated; …"，
与同一时刻 errors.log 的 "the previous CONTEXT.md is kept and stays stale"（`:141-151`）直接矛盾。

```ts
// lastWrite（:204-216）：note R7-nit-4 —— 只在拒绝或未发布时写 keepReason
memoryKept: !memoryChanged || memoryRefused,
contextWritten: Boolean(update),                       // update 为真 ⇒ :217-226 必然写
...(memoryRefused ? { keepReason: "stale" } : !memoryChanged ? { keepReason: outcome.semanticEmpty ? "empty" : "short" } : {}),
...(memoryRefused ? {} : outcome.removed ? { removed: outcome.removed } : {}),
```

`consolidateReply`（`:399-415`）的 `info.memoryKept` 分支：

| `keepReason` | 文本 |
| --- | --- |
| `"stale"` | `${info.contextWritten ? "Project context updated; " : ""}project memory kept the newer MEMORY.md you edited (this pass's reply was built from an older memory and was discarded).${guard}` |
| `"empty"` / `"short"` | **保持今天逐字不变**（`Project context updated; project memory was kept unchanged (${why}).${clippedNote}${guard}`） |

`report` 变量（`:227`）不动（CONTEXT 真的写了时 `updated`/`clipped` 仍成立；没写时由 `contextWritten` 负责纠正前缀）。

### 2.5 明确不做

| 不做 | 为什么 |
| --- | --- |
| **不重跑** consolidation | 复杂度之母（逼出 `rerun` 入口、version 断言、四种退出、三态门控）。本轮工作丢弃，**下一轮 pass 自然重做**；R6 确认 R1-B1 这条 blocking 随之**消失** |
| **不写 `memory-stale-*.md`** | 被丢弃的不是数据、是没用上的回复；D2 的 overflow 副本成立是因为内容**真的被裁掉了** |
| 不抽 `resolveMemory()` | `loadMemory` 已是唯一实现（R6 判此选择优于 v5 的契约式抽取） |
| 不加测试 seam、不动锁、不动读侧 | 无现场证据 |
| 不为 ①/② 竞态在 §2.2 补 append | 属**新增机制**，无 F1–F4 现场事实；R7 实测该竞态自愈（§5 R-11） |

## 3. 接口改动

```ts
// memory/pass.ts
export type ConsolidateOutcome = { /* 既有字段 */ basisKey: string };

// memory/store.ts
export async function recordMemoryDocument(
  projectRoot: string, text: string, limit?: number,
  options?: { preserveMarker?: boolean; basisKey?: string },
): Promise<{ written: true } | { written: false; kept: string }>;

// memory/store.ts（导出以支持 T6 单测）
export function nextRenderSupersedes(renderKey: string, nowKey: string, publishKey: string): boolean;

// memory/report.ts:24-29
keepReason?: "empty" | "short" | "stale";
contextWritten?: boolean;
```

## 4. 测试（6 条）

| # | 场景 | 判据 |
| --- | --- | --- |
| T1 | 无外部编辑（四个 fixture：普通 journal / `preserveMarker` / legacy 无 journal / 全新项目） | 与今天 op/text 序列 + `MEMORY.md` 字节**逐字节一致**（实现后"今天"不可再取 ⇒ 落成显式期望序列/字节）；`tests/run-all.mjs` 14 文件全绿。**加入 R7 的"来源翻转"变体**：journal 建立/删除前后各读一次 `loadMemory`，断言回复不丢、日志不撒谎（IM-B 的回归线） |
| T2 | **模型调用期间编辑**（核心） | 编辑保住且进 journal；回复**未成为** render；`errors.log` 恰两行 memory 记录（`adopted …`、未发布），**无** cap/section-cap/poison/`shortened`/removal 行——**夹具不得删除任何 Invariants/Pitfalls 条目**（`pass.ts:300-317` 的 `memory regression: …` 在 pass 层写出，report 层拦不住）；`lastWrite` 无 `capped/sectionsCapped/removed`；命令回复 = 丢弃句。**加两例锁 IM-A**：回复带 context / 不带 context 且既有 `CONTEXT.md` 非空，分别断言前缀 |
| T3 | 编辑早于 pass 读取（`basisKey === current`） | 正常发布，不误报 |
| T4 | 无 journal + 调用期编辑 | 编辑保住（**按 §2.0 顺序：判据在种子之前**，journal 可为空）；另加"无 journal + 无编辑"legacy 回归 = 与今天一致 |
| T5 | 不传 `basisKey`（`migrate.ts` / legacy） | 逐字节同今天 |
| T6 | `nextRenderSupersedes` 单测（**必须导出才可测**） | `(A,A)=false`、`(A,"")=false`、`("","")=false`、`("",E)=true`、`(A,E)=true`、`(A,publishKey)=false`。**CRLF/行尾空格按 R7 实测方向钉死**：内部 `\r` ⇒ `true`、内部行尾空格 ⇒ `true`、末行尾空白/首尾空行/首尾空格 ⇒ `false`。另测拒绝后抛错 → 缓存 outcome 重放 → 仍拒发、不重复 append |

`repro-write-ordering.mjs`（R6-IM-3 + R7-IM-C）：

```js
// 第二次调用必须显式传基线，否则 undefined 守卫会让判据永不触发、回归线恒假红
await recordMemoryDocument(root, passReply, undefined, { basisKey: A });
...
const fixed = fresh.bEffective && fresh.adopted && stale.bEffective && stale.adopted;
console.log(`判定：${fixed ? "编辑已守住（已采纳且生效）" : "未守住——编辑仍被顶掉"}`);
process.exit(fixed ? 0 : 1);   // 0 = 回归线通过（修复生效）
```

头部注释里的"退出码 0 = 复现"必须同步改为"退出码 0 = 编辑守住"。**未实施本设计时该脚本应退出 1。**

## 5. 残留（全部明示，**不再加机制**）

| # | 项 |
| --- | --- |
| R-1 | **mtime 回退或同刻**的编辑（`cp -p`/`rsync --times`/粗粒度 mtime 相等）不被采纳检测看到（今天也如此；§2.2 也看不见 ⇒ 发布并覆盖） |
| R-2 | recheck 的**接线**没有集成测试（只测导出的判定函数）；由代码评审覆盖 |
| R-3 | owner **清空** `MEMORY.md` 时回复胜出（既有语义；两个判据的空守卫正是为此） |
| R-4 | 被丢弃的回复没有副本（靠下一轮重做） |
| R-5 | **未升级的 peer 进程**仍会顶掉编辑：全部进程升级后才对所有交错成立 |
| R-6 | recheck 之后 → rename 之间的编辑仍丢字节；Node 无 CAS，窗口 μm–ms 级 |
| R-7 | 拒绝分支跳过 `rotateMemoryJournalIfNeeded` / `ensureMemoryGitignore` ⇒ journal 可暂超 512 KB（无损坏） |
| R-8 | pass 读 → report 写之间 `maxMemoryChars` 被改（`getConfig` 缓存，仅同进程 `updateConfig`）⇒ 一次假陈旧 |
| R-9 | cap > 32000 时 rotation 用默认 32000 折叠（`journal.ts:111`），下一次写路径可能把自己的 render 当"外部编辑"采纳并打 `adopted …`（既有） |
| R-10 | 第 ⑥ 步中途进程被杀时窗口编辑只在 `MEMORY.md` 且因 journal mtime 更新而不再被采纳（v5 R-18） |
| R-11 | **① / ② 之间**落地的编辑：② 不采纳它、§2.2 检出后拒绝、字节只在 `MEMORY.md`（保持生效，下一次写路径采纳）。自愈，不补 append |
| R-12 | `activeConsolidation` 是**模块级**、不按 `projectRoot`（`pass.ts:61/135/338`）：跨项目 join 会让 B 拿到 A 的 outcome。`basisKey` 判据缩小了爆炸半径（内容不同即拒发），但**内容恰好相同的两个项目**（如两个全新项目 `basisKey=""`）仍会串写。非本设计要修 |
| R-13 | overflow 副本后置后的崩溃窗：`writeAtomic` 成功 → `saveOverflowReply` 之前进程被杀 ⇒ 发布成功但副本缺失（D2 原文"孤儿副本"方向反转；best-effort 语义下接受） |

## 6. 评审与发版

一轮**设计**评审（针对本 revision 8，R8）→ 实现 → 一轮**代码**评审 → 与 D2 一起切 `v0.2.1`。

- **D2 的 fix note 要同步两处**（R7-nit-5）：`over-cap-reply-persistence-fix-note.md:72`（"落盘时机在任何裁剪发生之前"）
  与 `:97`（"写副本在前、写受限文档在后"）——后置到"发布成功之后"后两条都失效，需改写并在 §5 记入"崩溃窗"。
- 发版报告须写明：`pi update --extensions` 后**需要重启**，pin 而非 tag 决定加载。
- **给评审的纪律**：要求**新增机制**（而非修正已有机制）的发现，先问"§1 有对应现场事实吗"；没有就写进 §2.5 非目标。
