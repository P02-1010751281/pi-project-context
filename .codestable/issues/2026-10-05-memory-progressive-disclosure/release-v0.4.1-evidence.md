# v0.4.1 发布证据

日期：2026-10-05
范围：记忆/上下文注入改为渐进披露（节级指针）；交接删除整条摘要链，载荷改为最近原文 + 文件清单 + 会话日志指针 + 强指令。
涉及 issue：`.codestable/issues/2026-10-05-memory-progressive-disclosure/`（头条，本目录）、`.codestable/issues/2026-10-05-handoff-last-turn-not-replayed/`。
逐文件 why、用户可见变化与非目标见同目录 `v0.4.1-fix-note.md`。

## 提交与标签

| 项 | 值 |
| --- | --- |
| 行为提交 | `9821320` feat(memory) 混注；`e77ec20` refactor(handoff) 措辞合并；`2d1a87b` fix(memory) shutdown 解耦；`b4c9405` refactor(handoff) 删摘要链；`f19dc93` fix(handoff) 保住最后一轮（前置切片） |
| 评审修复提交 | `9abd971` fix(memory,handoff)（审1 后）；`a0bcdd1` fix(memory,handoff,docs)（审2 后） |
| 文档提交 | `4b96464` docs(records)；`98abe01` docs(architecture,handoff,configuration,changelog)；`7b6fc98` docs(changelog) 定版日期 |
| tag 对象 | `dca1f369e020c9f0bf42212e0310e8f6f8cb2715` |
| tag 指向（peeled） | `7b6fc98d82280dd918939cebc1cbb0bf65175632` |
| forgejo | `ls-remote --tags 'v0.4.1*'` → `dca1f369e020` + `7b6fc98d…^{} ` |
| github 镜像 | 同上（两行均含 peeled） |

tag 指向的 `7b6fc98` 相对审3 判定的 `a0bcdd1` 只多一个 CHANGELOG 标题定版（`未发布` → `2026-10-05`），无代码或文档内容差异。

## pin 与安装

| 项 | 值 |
| --- | --- |
| `~/.pi` pin 提交 | `8652b7b7d81a`（`agent/settings.json` + `README.md` 改 `@v0.4.1`，已推送 pi-config） |
| settings 备份 | `/tmp/settings.json.before-v0.4.1-20261005T154559Z` |
| 安装命令 | `pi update --extensions` |
| 安装副本 HEAD | `7b6fc98d82280dd918939cebc1cbb0bf65175632`，`describe --tags` = `v0.4.1`，脏文件 0 |
| 到位抽检 | 副本内 `turn prefix dropped during handoff`、`DOCUMENT_NOTE_RE`、`no recent carry-over`、`buildMemoryInjection` 均在；`generateSummaryWithUsage`/`SUMMARY_HEADINGS` 0 处 |
| 副本自测 | `node tests/run-all.mjs` → 15/15 |

**需要重启 pi 才生效**：运行中的会话仍加载 v0.4.0 的模块。

## 三审（独立审查轮，lane A，模型 `deepseek/deepseek-v4-pro`，/tmp 字节级沙箱 + 零写入证明）

| 轮 | 冻结点 | 判定 | blocking | important | 该轮实际抓到的东西 | transcript |
| --- | --- | --- | --- | --- | --- | --- |
| 审1 | `98abe01` | CHANGES-REQUESTED | 0 | 4 | 两处回执仍声称有摘要（`budget recent off`、`handoff thinking`）；CHANGELOG 修复段与自身变更段矛盾；词汇表未记 `drop budget`/`budget summary` 分叉；对抗轮发现注入指针是仓库相对路径而 read 按会话 cwd 解析 | `v0.4.1-review-round1-independent.txt`（12,870 B） |
| 审2 | `9abd971` | CHANGES-REQUESTED | 0 | 1 | `README.md` 两处仍写「带摘要的 handoff」（消费方第一眼文档与版本头条冲突）；6 条 nit（fence 未追踪、注记识别过宽、floor 含锚点、新收据无 pin、cwd 回退可能造游离目录、回执措辞） | `v0.4.1-review-round2-independent.txt`（8,762 B） |
| 审3 | `a0bcdd1` | **PASSED / RELEASE-OK: yes** | 0 | 0 | 逐条确认前两轮 18 条修复均为真修（无「只改表面」）；发布面逐字自洽；未发现发布后用户可见错误、错误承诺或数据丢失路径 | `v0.4.1-review-round3-independent.txt`（10,541 B） |

零写入证明：三轮沙箱（`/tmp/pc-v041-r1|r2|r3`）的 `git status --porcelain` 与文件 stat 基线 diff 均为空（仅 `.agents/memory` 为扩展自身启动写入，按 skill 剪除）；r1/r2 留档后已删除，r3 待本提交后删除。三轮的 prompt 同目录留档。

## 三校（机械核验）

### 校1 套件与单侧变异矩阵

- `node tests/run-all.mjs`：**15/15**（本仓与安装副本各跑一次）；`git diff --check` 干净。
- 变异矩阵 13 格（每条只改一处，预期打红具名断言）：**12 格具名红 + 1 格负向对照全绿**。

| 变异 | 预期打红（具名断言） | 实测 |
| --- | --- | --- |
| m1 keep 与 pointers 重叠 | the memory split keeps nothing it also points at | 红（2 条，含 totality） |
| m2 去掉 read-first 强指令 | the read-first instruction follows the pointers | 红 |
| m3 去掉查日志指引行 | zh detail lookup merges index and how-to | 红（2 条） |
| m4 `carryNothing` 撒谎 | zh no-carry line says nothing was carried | 红 |
| m5 交接文档恢复摘要小节 | document carries the file list and no summary | 红（2 条） |
| m6 失败文案重新承诺自动压缩 | the failure toast does not promise pi's compaction | 红 |
| m8 丢文档前言 | the document preamble stays inline | 红 |
| m9 丢文档级注记 | a document-level note stays inline next to the pointers | 红 |
| m10 指针回到相对路径 | the pointer path resolves against the project root… | 红 |
| m11 去掉 fence 追踪 | a heading-shaped line inside a fence does not split the document | 红 |
| m12 `budget recent off` 回执改回 summary only | the off receipt does not claim a summary carries the rest | 红 |
| m13a/b thinking 回执（两个分支各一格） | the thinking receipt does not claim a summary call (…) | 红（各 1 条） |
| **m7（负向对照）删掉 shutdown 守卫** | （预期无红） | **全绿** —— 印证该守卫在测试面上不可达，按「有现场依据的防御」记录（errors.log 2026-09-22 栈穿过 `emitSessionShutdownEvent`） |

### 校2 声明—代码一致性

- 用户可见串在代码中存在且文档已同步：`dropping ~X`、`drop N`/`drop budget N`、`nothing older than the recent window to drop`、`turn prefix dropped during handoff`、拒绝句 handoff 化、失败句去 auto-compaction。英文收据串在中文文档里是义译（不是缺口）；`no recent carry-over` 与 `stored for the dsh profile` 属回执层专用串。
- 已删摘要链符号全仓 0 残留：`generateSummaryWithUsage`、`SUMMARY_OUTPUT_RESERVE_TOKENS`、`summaryFocus`、`localizeSummaryHeadings`、`summary.ts`；`handoff/` 内无任何 `complete(` 调用（`session-settings.ts` 只做 successor 的模型解析与切回）。
- 保留旧名者均已记录：`MIN_SUMMARIZE_TOKENS`（语义已成为「最小可丢弃前缀」）、`handoffBudgetSummaryTokens`、`/handoff budget summary`、`handoffThinking`（pi 侧只剩写路径）。
- `docs/*.md` 正文无 >160 字符行（表格行例外）；`docs/architecture.md` 的 handoff 模块表已无 `summary.ts` 且标 `(无 LLM)`。

### 校3 发版机械核验

- 发布前：tag 不存在；CHANGELOG 有 v0.4.1 段；代码区无未提交改动；pin = `@v0.4.0`；安装副本 = v0.4.0。
- 发布后：tag 双远端一致（含 peeled）；pin 提交 `8652b7b7d81a`；安装副本 HEAD = peeled、`describe=v0.4.1`、脏 0；副本自测 15/15。
- 真实安装态探针（`/tmp/pc-release-probe`，默认设置、未加 `-ne/-e`）：`pi -p "只回复两个字：收到"` → exit 0、回复「收到」；生成 `.agents/memory/{MEMORY.md 589 B, CONTEXT.md 853 B, memory.jsonl 661 B, .gitignore}` 与 `session-logs/<id>/{session.jsonl 95,029 B, session.md 124,678 B}` + `INDEX.md`。
- 用**安装副本的代码**渲染该探针产物：MEMORY 常驻 `## Invariants`/`## Pitfalls`，`## Project`/`## Index` 变指针且路径为绝对路径；CONTEXT 常驻 `## Key points`/`## Open tasks`，`## Summary` 变指针 —— 发布态行为与设计一致。

## 实测（快照，随 consolidation 重渲染浮动）

| 项 | 值 |
| --- | --- |
| 本仓当前渲染的注入节省 | MEMORY 29,434 → 21,266；CONTEXT 8,407 → 7,427；合计 −9,148 字符/轮 |
| 小文档的固定成本 | 探针的 589/853 字节文档注入后为 740/975 —— 指针块有固定开销，节省只在文档大于数百字节时成立 |

## 残留（发布后）

1. **A+B 与无模型载荷的首次生产暴露**：吸附/锚定路径只被 mock 与真实 SDK 的合成条目 pin 过，从未经历一次真实交接。失败形态安全（`Handoff: failed — Staying in this session`，内容留在会话日志）。
2. **审3 的 5 条 nit 未修**（发布候选冻结在审3 判定通过的那一版，按 stop rule 不把未评审的改动塞进 tag）：
   `memory/report.ts` 的存在性检查用 `.agents` 而非 `.agents/memory`；`shared/inject.ts` 的 preamble 扫描无 fence 追踪（仅自由结构 legacy 文档可能触发）、fence 关闭条件未比较长度（CommonMark 边缘）；`.codestable/reference/vocabulary-conventions.md` 的示例键写成 `handoffSummaryTokens`；审计文档 `status: draft` 却被 CHANGELOG 引作证据。
3. **两条边界行为故意未 pin**：floor 的锚点减法、cwd 回退的存在性检查（需要真实边界场景才可观测）。
4. **旋钮命名分叉**待 owner 决定（`/handoff budget summary`、`handoffThinking`、`MIN_SUMMARIZE_TOKENS`）。
5. **`branch_summary` 锚点退化**：pi 的 `isTurnStartMessage` 也认 `branchSummary`/`compactionSummary`，此时锚点条目不可重放 → successor 只拿到占位标记与半回合尾巴，起始问题靠日志指针恢复。
6. `.agents/memory/*` 的渲染抖动按仓规未提交；一次**刻意的** render refresh 需要同时做 stale-fact 复审，本轮未做。

## 发布后探针（计划）

- 真实 TUI 交接一次：确认吸附/锚定路径的载荷形状，并顺手观测 floor 锚点减法与 cwd 回退两条边界。
- 真实会话 JSONL 里出现对 `.agents/memory/*` 的 `read` 工具执行 —— 渐进披露服从度的现场证据。
