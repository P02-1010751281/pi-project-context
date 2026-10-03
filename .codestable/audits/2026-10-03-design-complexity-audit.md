---
doc_type: audit
subject: 设计复杂度（方案规模 vs 现场证据）
created_at: 2026-10-03
related: [../issues/2026-10-03-external-edit-adoption-overwritten/external-edit-adoption-overwritten-design.md, ../issues/2026-10-03-external-edit-adoption-overwritten/external-edit-adoption-overwritten-design-full-v5-archive.md]
tags: [process, design-review, complexity, evidence, retrospective]
---

# 设计复杂度审计：方案规模 vs 现场证据

**触发**：owner 2026-10-03 对 `.codestable/issues/2026-10-03-external-edit-adoption-overwritten/` 的设计
（415 行、5 轮独立评审）提出质疑——"会不会搞得太复杂了"。该修复的实际代码量约 30–40 行。
本文把同一把尺子量到**以往所有方案**上。

## 判据

1. **机制必须能追溯到现场事实**（`errors.log` / journal / 可复现 probe）。追不到 ⇒ 记残留或不做。
2. **评审轮次的去向**：若一轮的发现主要是"上一轮新增机制带来的问题"，那就是膨胀信号（本文的 R4/R5 正是）。
3. **规模比**：设计行数 ÷ 代码改动行数。作为警号而非硬门槛。

## 数据（实测，2026-10-03）

| issue / feature | 独立评审轮 | 设计体量 | 产物代码 | 现场证据 | 判断 |
| --- | --- | --- | --- | --- | --- |
| `2026-09-15-consolidated-memory-json-poison` | **12**（round 19–21 全在锁） | 44 行 + 报告 | `poison.ts` 158 + `lock.ts` 209 | 报告有稳定复现（UF 12:05 写坏文件） | ⚠️ **同类毛病最重** |
| `2026-10-01-structured-consolidation-output` | **19** | **421 行 / 71 KB** | `sections.ts` 385 + `record_memory` | 强（超 cap 中段丢失 = 本仓库 `errors.log:54` 实测） | ⚠️ 核心有据，strict 半边本机不可达 |
| `2026-09-30-auxiliary-call-noise-and-memory-cap` | 18 | 88 + 48 行 | `call-policy.ts` + 节流 | 强（owner 报警、六连发、402） | ✅ 有据 |
| **`2026-10-03-external-edit-adoption-overwritten`** | 5 | 415 行 → **已改 B 版** | 0（未实现） | 强（probe 退出码 0 + 142/35 条现场） | ⚠️ **本次，已收敛** |
| `2026-09-30-session-log-append-duplication` | 3 | — | `session-log.ts` 257 | 有据 | ✅ |
| `2026-09-19-handoff-adaptive-threshold-semantics` | 2 | 2 份（含数据报告） | `threshold.ts` 278 | **先做数据调研再定阈值** | ✅ **正例，可当模板** |
| `2026-09-19-consolidation-output-budget` | 3 | — | — | 有据 | ✅ |
| `2026-09-15-codex-project-context-port`（feature） | 0 | 234 行 | 全仓骨架 | 移植任务，逐面枚举 | ✅ 相称 |

## 三个具体发现

### 1. `consolidated-memory-json-poison`：跨主题硬化（最重的一个）

主体是"**旧 bug 把记忆写成裸 JSON**"的一次性读侧迁移（`poison.ts` 158 行可解释）。但
`review-round19/20/21` 全花在**锁协议的病理输入矩阵**：dangling symlink、FIFO、目录、inode 钉定、
claim 令牌化、备份同 mtime 的 tie-break。评审记录自己就抓到过 **"FIFO 用例是永真断言（catch 吞掉失败）"**——
一轮的产出是修一个什么都没断言的测试。

- 仓库里**找不到** FIFO / symlink / 目录形 lock 的**实际事故记录**；能找到的只有轮次记录。
- 更关键：这批硬化最可能的动因是"两个进程抢写"，而**本次审计证明兄弟仓库那个"两个 writer、间隔 69–450 ms"
  的现象其实是同一次调用里的两次 append**（一份 journal 里逐字节相同的回退记录已锁定结论）。
  也就是说，**并发冲突这条候选证据现在是空的**。
- 结论：这部分是 **fail-safe 方向**（自愈奇怪路径，不会静默毁数据），拆掉不划算，但应当**冻结**：
  不再往上加病理矩阵，真遇到再修。`lock.ts` 209 行、`pi-project-context-write-lock-hardening` skill 保留。

### 2. `structured-consolidation-output`：核心有据，但一半机制在本机不可达

核心（分节渲染 + 整条丢弃 + 计数）对应的是真实损失（本仓库 `errors.log:54`：32228 vs 32000，中段永久丢失）⇒ 值得。
但 **strict JSON-schema 那一半在此机器上跑不到**：可达路由全是 `openai-completions` 且
`compat.supportsStrictMode=false`（设计自己也写了"诚实的限界（I8）"）。它是"为将来/别的 provider 准备"的机制，
外加一份 `pi-project-context-structured-tool-output-strict-mode` skill。

它还留下了 opaque 回退，衍生出 D1/M/N 一族悬案——**其中 D1 的前提是自相矛盾的**
（"被 extractor 拒收的回复里仍有可识别的四节"），N 则是给一个**无现场证据**的情形加机制。

处置建议：strict 清单**冻结**（记录已有），D1 标 `wontfix`，N 不做，M（重试改带节目标）保留为可选小改动。

### 3. 本次（`external-edit-adoption-overwritten`）：重跑是复杂度之母

v1→v5 的膨胀路径可精确归因：**"判陈旧后重跑一轮"这一个决定**，逼出了 `rerun` 入口、version 断言、
四种退出、三态副作用门控、副作用×主体表——也就是 R4/R5 大部分发现。删掉重跑，这些面**全部不存在**。
已改为 B 版（30–40 行、6 条测试、5 条残留）。

## 防复发规则（建议写进 `.codestable/attention.md`）

1. **每个机制必须在设计里标出对应的现场事实编号**；标不出 ⇒ 进"非目标/残留"，不进方案。
2. **评审发现若要求"新增机制"**（而非修正已有机制），评审与作者都要先问"哪条现场事实"；无则只记残留。
3. **设计行数 > 代码改动行数 ×3** 时，先写一段"最小修复面"并对照，再开始评审轮。
4. **一个 issue 只做一个主题**：不并入跨主题硬化（`poison × 锁` 是反例）。
5. **轮次预算**：若某轮的发现主要来自上一轮新增的机制，停止加机制，改为降级方案。

## 未查完（诚实声明）

- `handoff/run.ts`（**538 行，全仓最大模块**）的机制——`language auto/zh/en`、replay 过滤、staged settings、
  切点选择——**未逐条核对**是否有现场依据。建议单独审计一次（判据同上）。
- `shared/config.ts` 302 行、`handoff/prompt.ts` 199 行的可配置项与提示层未审计。

## 待 owner 拍板的状态变更（本文只建议，不改 status）

| 项 | 现状 | 建议 | 依据 |
| --- | --- | --- | --- |
| **D1**（opaque 路径按节丢整条） | "未做" | **`wontfix`** | 前提自相矛盾（被 extractor 拒收的回复"仍有可识别四节"本就少见），且只改善同一条罕见回落路径 |
| **N**（任意块粒度丢弃） | 未立项 | **不做** | 无现场证据；它唯一服务的路径（opaque 超 cap）在本仓只出现过 1 次 |
| **M**（重试改带节目标） | 未做 | **可选小改动**（~10 行） | 有据（`pass.ts:246` 的重试明确要求 opaque 形状），但不阻塞任何事 |
| strict 清单与 `…-structured-tool-output-strict-mode` skill | 已交付 | **冻结**，不再扩写 | 本机不可达，等真有 strict 路由再说 |
| 锁病理矩阵 | 已硬化 | **冻结**，不再加 | 无事故记录；本次审计还抽掉了它的并发动因 |
