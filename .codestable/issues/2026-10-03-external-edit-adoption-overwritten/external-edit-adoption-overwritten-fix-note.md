---
doc_type: issue-fix
issue: 2026-10-03-external-edit-adoption-overwritten
status: fixed
path: standard
fix_date: 2026-10-03
commit: 00bf797
related: [external-edit-adoption-overwritten-report.md, external-edit-adoption-overwritten-design.md, external-edit-adoption-overwritten-design-full-v5-archive.md, external-edit-adoption-overwritten-review-report.md, repro-write-ordering.mjs, ../2026-09-30-auxiliary-call-noise-and-memory-cap/over-cap-reply-persistence-fix-note.md]
tags: [memory, memory-journal, external-edit-adoption, lost-update, write-ordering, unreleased]
---

# 外部编辑采纳后被旧内容覆盖 修复记录

修 `extensions/project-context/memory/{pass,store,report}.ts` + 测试，提交 `00bf797`
`fix(memory): keep an external edit that lands while a reply is being built`。
实施依据是设计 **revision 9**（8 轮独立设计评审，见 `…-review-report.md`）。

## 1. 改了什么

| 文件 | 改动 |
| --- | --- |
| `memory/pass.ts` | `ConsolidateOutcome.basisKey` 字段（`+4` 行）+ 构造点 1 处：把**构造 prompt 前读到的** `loadMemory().text` 原值带进写路径 |
| `memory/store.ts` | 入口读 `renderRaw`/`renderKey`、§2.2 基线判据、无 journal 的种子后置、§2.3 发布前 recheck、导出 `nextRenderSupersedes`、返回 `MemoryWriteResult`（`±71` 行） |
| `memory/report.ts` | 拒绝旗标 `memoryRefused`、拒绝态跳过发布侧副作用、`keepReason:"stale"` + `contextWritten`、`wroteMemory = snapshot.written`、overflow 副本后置、`consolidateReply` 的 stale 句子（`±117` 行） |
| `tests/external-edit-test.mjs` | 新增 T1–T6，**47 条断言**（199 行） |
| `tests/consolidation-test.mjs` | mid-call-writer 那条 check 拆开（见 §4） |
| `.codestable/…/repro-write-ordering.mjs` | 从"复现"翻成"回归线"：第二次调用带 `basisKey`，退出码语义倒转 |

合计 6 文件 `+362/−68`。

## 2. 机制（四条）

1. **基线指纹**：pass 把 `loadMemory().text` 的**原值**（不是 `fitMemoryInput` 裁剪后的 `fitted.text`）作为
   `basisKey` 交给写路径。
2. **不发布陈旧回复**：`recordMemoryDocument` 在采纳块之后读一次当前有效内容，两侧都过
   `memoryComparisonKey` 比较（读侧有 journal 时返回 fold、无 journal 时返回 raw clip，同一份字节会有
   两种形态），不一致且非空 ⇒ **不发布**，返回 `{written:false, kept}`。采纳块已把更新的字节 append 进
   journal，状态自洽；本轮模型工作丢弃，下一轮 pass 自然重做（**不重跑**，这是 v5 复杂度的根源）。
3. **发布前 recheck**：`appendMemoryOp(rendered)` 之前再读一次 `MEMORY.md`，由导出的纯函数
   `nextRenderSupersedes(renderKey, nowKey, publishKey)` 判定；触发时**先把新字节 append 进 journal**再返回
   （R3-B1 的教训：检出必须落 journal）。
4. **拒绝态不说谎**：`memoryRefused` 时跳过 overflow 副本、cap/section-cap/poison/`shortened` 四类日志、
   五个"发布成功"类 toast、removal toast 与 `lastWrite` 的 `removed`；命令回复与 toast 共用
   `staleKeepSentence()`，前缀只在 `CONTEXT.md` **确实写了**时出现（`contextWritten`）。
   不传 `basisKey` 的调用（`migrate.ts`、既有测试）行为逐字节不变。

## 3. 实测验证（本仓库，2026-10-03）

- `node tests/run-all.mjs` → **All 15 tests passed**（14 既有 + 新增）。
- `node .codestable/…/repro-write-ordering.mjs` → **退出码 0**：两条场景 journal 都是 `A → B`、
  `MEMORY.md` 生效 = `B`、`loadMemory()` = `B`、`errors.log` 明说 `the reply was not published`。
- 新增文件 47 条断言全绿，其中 T2 走**真实 report/pass 全链路**（`/memory update` + 伪造 `complete` 在
  调用期间改写 `MEMORY.md`），两个子例（回复带/不带 context）分别验证：编辑字节不动、回复从不进 journal、
  编辑进 journal、日志有"未发布"且**没有**任何"已写"声明、命令回复前缀与实际写入一致、未被写的
  `CONTEXT.md` 字节不变。
- T1/T5：四个 fixture（普通 journal / `preserveMarker` / legacy 无 journal / 全新项目）下，
  带 `basisKey` 与不带 `basisKey` 的两次写入在 **journal 记录与 `MEMORY.md` 字节上完全相同**。

## 4. 既有测试的账面同步（R8-IM-1）

`tests/consolidation-test.mjs` 的 `a mid-call writer is backed up` 原来要求日志含
`replaced a stored JSON reply`——而该场景（模型调用期间写入裸 JSON 的 `arrived`）**正是本修复的拒绝路径**，
拒绝态下 `MEMORY.md` 仍是裸 JSON，"已替换成 Markdown"会是谎报。现在该 check 保留"备份数量 1 + 备份字节
=== `arrived`"，并把"编辑字节仍留在 `MEMORY.md`"与 `adopted …` / `reply was not published` 两条日志
一并断言；poison 修复日志仍由上面"并发 pass 只重写一次"的 check 覆盖（那里没有编辑撞车）。

## 5. 残留（设计 §5 的 R-1…R-15 全部成立，不再加机制）

其中与本次实现直接相关的：

- **R-1**：mtime 回退**或同刻**的外部编辑仍看不见（`memoryComparisonKey` 形态的采纳检测本身如此）。
- **R-6**：recheck 之后 → rename 之间的编辑仍可能丢字节（Node 无 CAS，窗口 μm–ms 级）。
- **R-11**：入口读与采纳 `stat` 之间落地的编辑：不采纳、判据检出后拒绝、字节留在 `MEMORY.md` 且保持生效，
  下一次写路径先采纳再发布（自愈，未为其加机制）。
- **R-13**：overflow 副本后置后，"发布成功但副本缺失"的崩溃窗。
- **R-14**：手删 journal 且存在 rotation 归档时，`loadMemory` 优先取归档 ⇒ 调用期编辑既不被判断看见、
  也不被 recheck 看见（既有读侧优先级）。**T4 的承诺应读作"无 journal 且无归档"**。
- **R-15**：**既有**谎言——`update === undefined` 且未拒绝时命令回复仍说 "…and context updated." 而
  `CONTEXT.md` 未写。本修复只在拒绝态消费 `contextWritten`，不引入也不扩大它。

### 5.1 一处措辞校准（实测校正设计 R-3）

设计 R-3 原文是"owner 清空 `MEMORY.md` 时回复胜出"。实测：

| 清空后的文件 | 行为 |
| --- | --- |
| 零字节 / 纯空白 | **回复胜出**（两个判据都有 `trim()` 空守卫） |
| 只剩 `# Project Memory\n` | **拒发**，该文件保留 —— `memoryComparisonKey` 对它是非空键，因此被当作一次真实编辑 |

也就是说"清空"只有在前一种意义上"不拦"；后一种（把内容删空、留下头）**尊重 owner 的编辑**。两种行为都已
在 `tests/external-edit-test.mjs` 的 `cleared memory` 两条里钉死，设计 R-3 已按此改写。这是**行为选择**，
留给代码评审轮判定（若认为头文件也该让回复胜出，那是一个新的判据，需要现场事实）。

## 6. 发布状态（未发版）

- `00bf797` 在 `master`；tag 仍只到 `v0.2.0`，`~/.pi/agent/settings.json` 的 pin 仍 `@v0.2.0`，
  已安装克隆**没有**本修复。
- 计划与 D2（`1f0672c`）一起切 `v0.2.1`；D2 的 fix note 已按本提交同步两处落盘时机语义
  （§4 的"写副本在前"与 §3 的"任何裁剪发生之前"）。
- 发版报告须写明 `pi update --extensions` 后**需要重启**。

## 7. 评审状态：独立代码评审轮**未跑**（被 provider 周限阻塞）

- 设计侧 8 轮已完成（R6 1 blocking / R7 0 / R8 0，三轮发现全是【修正已有机制】）。
- **代码评审轮**已就位：prompt 存为 `external-edit-adoption-overwritten-code-review-round1-prompt.txt`，
  沙箱配方与零写入证明照 `.agents/skills/pi-project-context-sandboxed-independent-review/SKILL.md`
  （沙箱 `/tmp/pi-context-rev36`、353 文件基线、`status`/`files` diff 均为空）。
- 2026-10-03T14:12Z 两次启动都在 **`429 You've reached your weekly usage limit`** 上失败
  （transcript 0 字节 = provider 失败，按协议**不算一轮**；复位时间 **2026-10-08T08:37:39Z**）。
  该路由是这台机器上唯一可用的评审路由，因此本轮在复位前无法完成。
- 在评审通过前，本修复应当视为**已实现、已验证、未独立评审**：发版（`v0.2.1`）建议等这一轮。
