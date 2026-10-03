---
doc_type: issue-fix
issue: 2026-09-30-auxiliary-call-noise-and-memory-cap
status: fixed
path: standard
fix_date: 2026-10-03
commit: 1f0672c
related: [auxiliary-call-noise-and-memory-cap-report.md, auxiliary-call-noise-and-memory-cap-analysis.md, auxiliary-call-noise-and-memory-cap-fix-note.md, release-v0.1.12-evidence.md]
tags: [memory, memory-cap, opaque-fallback, recoverability, unreleased]
---

# 超 cap 回复落盘 修复记录

这是发版后小债清单里那一条（本文全程写作「超 cap 回复落盘」，**不使用 D 编号**，原因见第 0 节）。
它修的是 `memory/report.ts` / `shared/gitignore.ts`，提交 `1f0672c`
`fix(memory): keep an over-cap reply locally before the cap clips it`。

## 0. 编号说明：此 D2 非彼 D2

仓库里同时存在多个「D2」，互相无关：

- **本文的条目**出自 `v0.2.0` 发版后的「**D（记录在案小债）**」清单（D2 = `1f0672c`，D3 = `1163255`
  `deferred`，D4 = `65b2699`）。该清单**只存在于会话与交接摘要里**，`.codestable` 中无文档——
  这正是本文要补的缺口。
- `2026-10-01-structured-consolidation-output/implementation-note.md:53` 的 D2 是**另一条**：
  `toolsAttempted` 在调用前置位，属那份 issue 自己的实施偏差序列。
- 各 issue 的 review transcript 中出现的 D2 又各有所指。

引用 D 编号时必须点名是哪份清单，否则会串味。

## 1. 问题

记忆写入的 cap 处理有三条路径，`memory/pass.ts` 的 `resolveReply`（`:76-104`）把它们分成三类：

| kind | 触发 | 超 cap 时怎么办 |
| --- | --- | --- |
| `structured` | 模型调用了 `record_memory` 工具 | 走 `renderMemoryDocument`：**按节丢整条条目**，用 `sectionDropped` 上报数量，且保证落在 cap 内 |
| `fallback-sections` | 文本被 Markdown extractor 接受（恰好四节） | 同上 |
| `fallback-opaque` | 其余全部（散文、未知标题、带前言） | `exceedsMemoryCap` → `clipToLineBoundaryBothEnds`：**留头 60%（`CLIP_HEAD_SHARE`）+ 尾 40%**，按整行收边，**中段永久丢失**，只留一条截断标记 |

于是 **opaque 是唯一会静默丢字节的路径**，而它丢掉的中间段通常正是耐久内容所在（`Invariants` /
`Pitfalls` 的腰部）。另两条路径的丢失都有计数可查，这一条没有。

`memory/pass.ts:239-240` 的注释本身就承认这一点：

> The opaque entry has no section counts, so it keeps the cap test — otherwise **the path most likely to
> overflow** would lose the loop entirely.

## 2. 现场证据：本仓库真实触发过一次

`.agents/memory/errors.log:54`：

```
2026-10-03T08:50:15.528Z [memory] memory exceeded maxMemoryChars (32000): both ends were kept and the
middle dropped on a line boundary; the reply needed about 32228 characters — raise it with
/project-context max-memory 32228 (or trim MEMORY.md)
```

即：某次真实 consolidation 走了 opaque 路径，回复需要 32228 字符、cap 是 32000，**超出 228 字符**，
中段就此永久丢失。修复前该仓库没有任何副本可回退（`memory-overflow-*.md` 不存在）。

这条日志同时说明该路径不是理论情形，而是**已实测命中**的回落分支——这正是它值得一条 fix note
的原因。

## 3. 修复内容（`1f0672c`）

`extensions/project-context/memory/report.ts`：

- 新增 `saveOverflowReply(projectRoot, text)`（`:56`）：把**未裁剪的原始回复**写到
  `.agents/memory/memory-overflow-<ISO 时间戳>.md`（时间戳里的 `:`、`.` 替换为 `-`），用
  `writeAtomic` 落盘，返回文件路径。
- 落盘时机在**任何裁剪发生之前**（`:163`）：
  ```ts
  if (!sectioned && exceedsMemoryCap(memoryText, maxMemoryChars)) {
      overflowPath = await saveOverflowReply(projectRoot, memoryText);
  }
  ```
  其中 `sectioned = outcome.kind !== "fallback-opaque"`（`:131`）——即**只有 opaque 条目需要副本**，
  另两条由 renderer 按条丢并报计数。
- **best-effort**：写副本失败只记一行 `errors.log`（`…could not be kept locally: …`），不抛出、
  不阻断受限写入本身。
- 诊断指向：cap 的 `errors.log` 行（`:198`）与非静默 toast（`:254`）都在末尾追加
  `the unclipped reply is kept at <path>`，只有在副本确实落盘时才出现。

`extensions/project-context/shared/gitignore.ts`：`MEMORY_GITIGNORE_LINES` 增加
`"memory-overflow-*.md"`，与 `*.memory-backup-*`、`errors.log` 同级——**副本是本地诊断物，不随
仓库提交**。

`tests/consolidation-test.mjs`（`:930-934`）新增 5 条断言：副本存在且只有一个、副本内容等于
**完整回复**（且长于裁剪后的 render）、`.gitignore` 含该模式、`errors.log` 点名该文件；另有一条
既有断言扩为同时校验三种被忽略模式、且 `gitignore` 只追加一次。

## 4. 边界与设计约束

- **只覆盖 opaque，这是刻意的**：另两条由 `renderMemoryDocument` 按整条丢并报 `sectionDropped`，
  无损字节裁剪可言；给它们也写副本只会增加无谓 IO。
- **写副本在前、写受限文档在后**：若受限写入随后失败，磁盘上会留下一个没有对应 `MEMORY.md` 的
  副本。方向安全（多一份东西，不少一份），不额外处理。
- **副本不参与读取**：`loadMemory` / `foldMemoryJournal` 完全不看 `memory-overflow-*.md`，它不进
  journal、不进 fold、不影响任何记忆决策，纯粹是可回退的物证。
- **不改变记忆正文的正确性**：受影响的只有"丢了能不能找回"，因此严重度**低**。这也是它可以选择
  不发版、随下个功能版走的原因。

## 5. 残留（未覆盖项）

1. **没有独立评审轮**。`1f0672c` 只有 `tests/consolidation-test.mjs` 的单元断言，没有按
   `.agents/skills/pi-project-context-sandboxed-independent-review/SKILL.md` 跑过 审/校 沙箱轮。
   若切 `v0.2.1` 把它发出去，**应先补一轮**。
2. **副本无轮转/保留策略**：每次 opaque 超 cap 都新增一个文件，没有任何代码清理它，
   `.gitignore` 只保证它不被提交。与 `D3`（session-log 体积/保留策略）同族，本 fix 不试图解决。
3. **重试仍不迁移到分节路径**：超 cap 的压缩重试（`memory/pass.ts:246`）发出的 prompt 明确要求
   `Return exactly one complete JSON object with string memory_markdown and object context`，即
   **要求 opaque 形状**、且不带工具，因此重试结果仍可能落回 opaque。把重试目标改为
   `record_memory` / 恰好四节 Markdown，是**未做的独立改动**，不在本 fix 范围内。
4. **首次回复仍可能被裁剪**：本 fix 保住的是字节，不改变「首次 opaque 超 cap 会丢中段」这个事实。

## 6. 发布状态

| 位置 | 是否含本修复 |
| --- | --- |
| `master`（`067cdff`） | **有** |
| `v0.2.0` tag（`a870dc3`） | 无 |
| 已安装克隆 `~/.pi/agent/git/…/pi-project-context` | 无（实测其 `memory/report.ts` 无 `saveOverflowReply`） |
| `~/.pi/agent/settings.json:30` 的 pin | 仍是 `@v0.2.0` |

`git log --oneline v0.2.0..master` 中**只有 `1f0672c` 改了会随包安装的代码**
（`extensions/`），其余是 `docs/`、`tests/`、`.codestable/`、`.agents/`。因此本修复**存在于仓库、
不在任何已发布版本**——要生效必须切 `v0.2.1` 并抬 pin，切换后需重启 pi。
