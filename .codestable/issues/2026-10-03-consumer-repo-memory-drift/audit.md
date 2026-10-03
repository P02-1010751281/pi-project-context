---
doc_type: issue-audit
issue: 2026-10-03-consumer-repo-memory-drift
status: confirmed
path: quick
created_at: 2026-10-03
tags: [consumer-repos, memory-md, external-edit-adoption, drift]
---

# 消费仓库 MEMORY.md 漂移审计：Quantum_Matrix / UniField

触发：owner 要求处理「Quantum_Matrix 提高 `maxMemoryChars`、对账其 `MEMORY.md`/journal 分歧与备份，复查 UniField 设置」。

**本文件只做取证，不改任何仓库的记忆文件。** 结论以「需要 owner 选边」的形式给出，理由见末节。

## 1. 先纠正一条：cap 没超，量的是字符不是字节

我最初用 `wc -c`（字节）比对 cap，得出「UniField 42327 > 36000 超 cap」。**错的**——扩展的 cap 量的是**字符**（`memoryDocumentChars` → `text.length`），中文内容字节≈1.5–2× 字符。

| 仓库 | `wc -c`（字节） | 实际字符 | cap | 是否超 |
|---|---|---|---|---|
| Quantum_Matrix | 18525 | **11009** | 32000 | **否** |
| UniField | 42327 | **26931** | 36000 | **否** |

两份都远未触 cap，**因此不存在「因 cap 截尾丢内容」这件事**。`maxMemoryChars` 也无需上调（QM 已是默认 32000；且 QM 文件自述目标 ≤20k）。⇒ 原先记的「提高 Quantum_Matrix maxMemoryChars」这条**前提不成立**。

## 2. 两份记忆都走 opaque 路径，且都是人工维护的

两份都用中文自定义分节（QM 5 节、UniField 10 节），不是四节英文 schema。只读探针（加载本仓库 `memory/sections.ts` + `document.ts`）：

```
sectionsFromMarkdown(QM MEMORY.md)  → undefined ⇒ 走 opaque 路径
sectionsFromMarkdown(UniField …)    → undefined ⇒ 走 opaque 路径
isHeadingOnlyDocument                → false（有正文，不会被当骨架拒绝）
```

两个仓库的 `errors.log` **末行都是**：

```
[memory] adopted an externally edited MEMORY.md into the memory journal
```

⇒ 这两个 `MEMORY.md` 是 **owner 手工维护**的，扩展按「外部编辑采纳」路径接收它们。这和 QM 文件里那段自述一致（「本文件是**有损摘要**，插件每轮重写它 …恢复 = `git checkout HEAD -- .agents/memory/MEMORY.md`… 插件已多次丢/错内容」）。

## 3. 分歧的实测规模

| 仓库 | 工作树当前 | 富版本 | 缺的行 |
|---|---|---|---|
| Quantum_Matrix | **11009** 字符 | HEAD = **17998**；3 个备份也都是 17998 | **73 行** |
| UniField | **26931** 字符 | HEAD 只有 3806（陈旧四节渲染）；备份 `2026-10-01T08-48-46` = **34994** | **69 行** |

QM 的三个独立来源（HEAD + 09-30 的 3 个备份）**一致**指向 17998，所以「11009 是回退」这一点在 QM 有强证据。UniField 的 HEAD 是另一份陈旧渲染（3806），富版本只在备份里。

缺失内容的性质（各举例）：QM 丢的是实验口径与诚实附注（如「`64%/75%` 是 beam 臂数字」「8×8 档对照身份」）；UniField 丢的是 §37.x 的实验裁决与数值。

## 4. journal 时间线：两种解读，**本文件不选**

两个仓库的 `memory.jsonl` 都只有 5 条记录，且都呈同一形态——**一次采纳紧跟着一次旧版写入**，间隔 70–450 ms：

**Quantum_Matrix**
```
[0] 09:02:23.956 → 11009
[1] 09:03:07.058 → 17998   ← 富
[2] 09:03:07.127 → 11009   ← 69ms 后回退
[3] 09:29:25.473 → 17998   ← 富（owner 又编了一次）
[4] 09:29:25.553 → 11009   ← 80ms 后回退   ；同一毫秒 errors.log 记「adopted an externally edited MEMORY.md」
```

**UniField**
```
[0] 08:41:35.918 → 31883
[1] 08:44:17.862 → 32960
[2] 08:44:18.308 → 26931   ← 446ms 后回退
[3] 08:48:46.372 → 34994   ← 富（owner 又编了一次）
[4] 08:48:46.701 → 26931   ← 329ms 后回退   ；errors.log 记「adopted …」
```

工作树 `MEMORY.md` 的 mtime 精确等于 `[4]` 的时刻，且当前长度就是 `[4]` 的长度 ⇒ **`[4]` 是最终生效的那条**。

**两种解读都与证据相容，方向相反：**

| 解读 | 含义 | 谁是「真」版本 |
|---|---|---|
| **A（丢内容）** | pass 先写富版本 `[3]`，随后采纳逻辑把**更旧的**外部编辑 `[4]` 追加进来并生效 ⇒ owner 的手编被冲掉。 | 富版本（HEAD / 备份） |
| **B（正确采纳）** | owner 主动**收缩**成 `[4]`，pass 的 `[3]` 是陈旧写，采纳逻辑正确地用 owner 的版本压回。 | 当前工作树版本 |

区分 A / B 只需要 owner 一句话：**这两次编辑（09-30 09:29 / 10-01 08:48）是你有意收缩的，还是你扩写之后被吃掉的？** 我不替 owner 猜，因为猜错的代价正是 QM 文件里警告的那件事——再丢一次人工内容。

一个可支撑判断的旁证：QM 的富版本 `[1]`/`[3]` 与 `[2]`/`[4]` 的差异**不是随机**，而是稳定地「多出 `## 当前状态速查`、`## 方法清单` 等整节」；若是模型随机生成，不会两次都精确产生同一组节名。

## 5. 已做的无损清理

| 动作 | 结果 |
|---|---|
| 备份 QM/UniField 工作树 `MEMORY.md` 到 `/tmp/<Repo>-MEMORY.md.before-sync-<ts>` | 完成 |
| 删除陈旧 lock（**仅** 0 字节且早于今日，符合 skill §5） | QM 5 → **0**；UniField 本就 0 |
| 未改动任何 `MEMORY.md` / `MEMORY.md.memory-backup-*` / `memory.jsonl` | 遵守 skill「不替 owner 选边」 |

**未做**（需 owner 决定）：归档 `errors.log`（QM 104628 字节、UniField 53671 字节，两者末行都是采纳记录，不是 poison 证据）；恢复任一富版本；清理 5 个 `MEMORY.md.memory-backup-*`。

## 6. 交给 owner 的选择

对每个仓库，三选一（本文件不选）：

1. **恢复富版本**——QM：`git checkout HEAD -- .agents/memory/MEMORY.md`（该仓库自己写明的恢复方式，且 3 个来源一致）；UniField：以 `MEMORY.md.memory-backup-2026-10-01T08-48-46-062Z-6f6410ac`（34994）为准。恢复后 mtime 变新，下一次 pass 会把它**采纳进 journal** 而不再被旧版压回。
2. **保持现状**（若 A/B 里是 B）。
3. **逐行合并**——把缺失的 73 / 69 行并回当前渲染，不整体替换。

## 7. 一个与 owner 无关、但值得记的产品面发现

扩展的 consolidation 产出的 `MEMORY.md` 是固定四节英文 schema，而这两个消费仓库都用**中文自定义分节**。走 opaque 路径时文本被原样保留，所以自定义结构**能**存活——但它的存活依赖于「模型在回复里照抄了原结构」。一旦模型改回四节 schema，人工分节就没了。QM 文件里那句「插件每轮重写它」正是这个风险的记录。

这不构成本次的修复项（恢复内容优先），但如果要长期稳定支持消费仓库的自定义分节，需要的是设计层决定，不是补丁。
