---
doc_type: design
issue: 2026-10-03-external-edit-adoption-overwritten
status: draft
created_at: 2026-10-03
revision: 6 (B 版：最小修复面)
related: [external-edit-adoption-overwritten-design-full-v5-archive.md, external-edit-adoption-overwritten-report.md, external-edit-adoption-overwritten-review-report.md, repro-write-ordering.mjs]
tags: [memory, memory-journal, external-edit-adoption, lost-update, write-ordering, minimal-design]
---

# 外部编辑采纳后被旧内容覆盖 修复设计（B 版）

> **版本说明**：v1–v5 是"完整版"，经 5 轮独立评审（记录见 `…-review-report.md`）。owner 2026-10-03 指出
> **方案与修复规模不成比例**——根因是我每次用"新增机制"回应评审发现，表面积越滚越大。
> 本文按"**现场证据实际需要什么**"重写；v5 全文存档于 `…-design-full-v5-archive.md`，其价值在
> "把复杂度逼出来的那些分支都想过了"，**不在篇幅，不要照它实施**。

## 1. 现场事实（机制必须对应到这几条，否则不做）

| # | 事实 | 来源 |
| --- | --- | --- |
| F1 | 一次 `recordMemoryDocument` 调用里两次 append（先采纳、再写本次 pass 的 render），后者决定生效内容 | `store.ts:68`/`:77`/`:80` |
| F2 | 顶掉采纳的那条记录与**更早一条逐字节相同** ⇒ 覆盖它的是"由**编辑前快照**生成的回复" | QM `[1]≡[3]≡[5]`、UF `[3]≡[5]` |
| F3 | 采纳日志在覆盖**之前**写出、措辞是完成态；现场 142 / 35 条 | `store.ts:70` |
| F4 | 已确定性复现，`A → B → A` 即兄弟仓库形态 | `repro-write-ordering.mjs` 退出码 0 |

**结论**：唯一需要修的是"**用更旧基线算出的回复覆盖了更新的内容**"。
其余候选机制（重跑、并发/锁、留档、三态门控）**现场都没有对应事实**。

## 2. 方案（约 30–40 行代码）

### 2.1 pass：把基线带出来

`ConsolidateOutcome` 增加 `basisKey: string`，取值是构造 prompt 前 `loadMemory()` 返回的 **`.text` 原值**
（`pass.ts:161` 的 `existing.text`）。**不用** `fitted.text`——`fitMemoryInput` 会把密集记忆裁短，
用裁剪结果当基线会导致"每次 pass 都判陈旧"的永久自锁。

### 2.2 store：基线不一致就不发布

在既有采纳块（`store.ts:61-71`）**之后**加：

```ts
const current = await loadMemory(projectRoot, limit);
if (options.basisKey !== undefined && options.basisKey !== current.text) {
    await logError(projectRoot, "memory",
        "the memory changed while this pass's reply was being built; the reply was not published and the newer content stays effective");
    return { written: false, kept: current.text };
}
```

- **直接调 `loadMemory`**（不抽新函数）：它本身就是"当前有效内容"这条规则的唯一实现，两侧天然可比，
  读侧**零改动**，也不需要契约说明。
- 采纳块已经把更新的内容 append 进 journal（`MEMORY.md` 未被覆盖）⇒ **状态自洽，无需任何搬运**。
- `options.basisKey === undefined` ⇒ 永不判陈旧 ⇒ `migrate.ts` 与既有测试行为逐字节不变。

### 2.3 store：发布前 recheck（唯一保留的额外机制，约 4 行）

在 `appendMemoryOp(rendered)`（`store.ts:77`）**之前**重读一次 `MEMORY.md` 的 key：

```ts
if (options.basisKey !== undefined && memoryComparisonKey(await readOptional(memoryFile(projectRoot)) ?? "", limit) !== renderKey) {
    await appendMemoryOp(file, "replace", <重读内容>);   // 新字节进历史（INV-1）
    return { written: false, kept: <重读内容> };
}
```

理由：这是 R1 认定 blocking 的字节丢失窗口（"读取之后、发布之前"）。放在 append **之前** ⇒ 回复从不进 journal，
连带 v5 的 R-10（"rendered 在历史里但非生效"）也消失。**不引入测试专用 seam**：判定抽成小纯函数做单测，
接线由评审覆盖（记为残留 R-2）。

### 2.4 report：拒绝时不发"关于一次发布的"日志

`if (memoryChanged)` 块内若返回 `written: false` ⇒ 跳过该块的**发布侧**部分：
overflow 留档、cap / section-cap / 存过 poison 三类 `errors.log`、`:228-230` 的 `shortened` 行、
removal 告警、以及声称已更新的 notify；`lastWrite` 置为"保留"态；命令回复说明
"本轮回复已丢弃，保留你写入的内容，下一轮会重新整理"。

**不做三态门控表**：`memoryChanged === false` 的路径根本不进这个块，R5 的三态争论随之消失。

### 2.5 明确不做

| 不做 | 为什么 |
| --- | --- |
| **不重跑** consolidation | 复杂度之母（它才逼出 `rerun` 入口、version 断言、四种退出、三态门控）。本轮工作丢弃，**下一轮 pass（每次 settle / shutdown）自然重做** |
| **不写 `memory-stale-*.md`** | 被丢弃的不是数据、是没用上的回复；D2 的 overflow 副本成立是因为内容**真的被裁掉了** |
| 不抽 `resolveMemory()` | `loadMemory` 已是唯一实现 |
| 不加测试 seam、不动锁、不动读侧 | 无现场证据 |

## 3. 接口改动

```ts
// memory/pass.ts
export type ConsolidateOutcome = { /* 既有字段 */ basisKey: string };

// memory/store.ts
export async function recordMemoryDocument(
  projectRoot: string, text: string, limit?: number,
  options?: { preserveMarker?: boolean; basisKey?: string },
): Promise<{ written: true } | { written: false; kept: string }>;

// memory/report.ts:171 —— 必须传，漏传即静默退回今天的行为
recordMemoryDocument(projectRoot, memoryText, maxMemoryChars, { basisKey: outcome.basisKey })
```

## 4. 测试（6 条）

| # | 场景 | 判据 |
| --- | --- | --- |
| T1 | 无外部编辑（常态） | 与今天逐字节一致；既有 `tests/run-all.mjs` 14 文件全绿 |
| T2 | **模型调用期间编辑**（核心场景） | 编辑保住且进 journal；本次回复**未成为** render；`errors.log` 有为"未发布"的那一句；**没有** cap/removal/"已更新" 类发布侧日志 |
| T3 | 编辑早于 pass 读取（`basisKey === current`） | 正常发布，不误报 |
| T4 | 无 journal 项目（首次 consolidation 窗口） | 编辑保住（判据在函数入口，早于空 journal 分支） |
| T5 | 不传 `basisKey`（`migrate.ts` / legacy） | 行为与今天逐字节一致 |
| T6 | recheck 判定（纯函数单测） | 窗口内清空 ⇒ 不拦（空内容不是"更新的记忆"）；CRLF/行尾空格重写 ⇒ 拦 |

另：`repro-write-ordering.mjs` 的期望改为"外部编辑生效"，退出码 0 作为回归线。

## 5. 残留（全部明示，**不再加机制**）

| # | 项 |
| --- | --- |
| R-1 | mtime **回退**的编辑（`cp -p`/`rsync --times`）不被采纳检测看到（今天也如此） |
| R-2 | recheck 的**接线**没有集成测试（只测判定函数）；由评审覆盖 |
| R-3 | owner 清空 `MEMORY.md` 时回复胜出（既有语义，未变） |
| R-4 | 被丢弃的回复没有副本（靠下一轮重做） |
| R-5 | **未升级的 peer 进程**仍会顶掉编辑：全部进程升级后才对所有交错成立 |
| R-6 | 发布窗口内（recheck 之后 → rename）落地的编辑仍丢字节；Node 无 CAS，窗口为 μm–ms 级 |

## 6. 评审与发版

一轮**设计**评审（针对本文）→ 实现 → 一轮**代码**评审 → 与 D2 一起切 `v0.2.1`。

**给评审的纪律（本次审计的结论之一）**：若发现要求**新增机制**（而不是修正本文已有机制），
先问"§1 有对应现场事实吗"；没有就写进 §2.5 非目标，而不是加进来。
