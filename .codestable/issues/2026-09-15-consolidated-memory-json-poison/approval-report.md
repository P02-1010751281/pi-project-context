---
doc_type: approval-report
unit: .codestable/issues/2026-09-15-consolidated-memory-json-poison
status: approved
reason: fix-completion
approvals:
  issue-report-confirmation: approved
  issue-fix-plan: approved
  code-review-local-only: superseded
  memory-heal-mode: approved
  fix-completion: approved
created_at: 2026-09-15
---

# Approval Report

## Decision History

- 2026-09-15 — owner 批准 report，并给出附加指令「帮我检查修复两个项目的」：
  - `issue-report-confirmation: approved`；report 转 confirmed；授权两个项目 `MEMORY.md` 的备份后数据修复
- 2026-09-15 — owner 选择 **A + C**（读取端自愈 + 失败诊断 + 输出预算匹配）：
  - `issue-fix-plan: approved`；analysis 转 confirmed
- 2026-09-15 — fix 实现与验证完成（3 文件、8/8 测试、Quantum_Matrix 14:58 实测自愈）
- 2026-09-15 — owner 批准 `code-review-local-only`（本机审查降级）：
  - 随后 owner 撤回：「降级？你可以开一个pi来review吧？」→ 降级记为 `superseded`，
    改用独立 pi CLI 进程执行环节 A（独立上下文、只读、运行前后核验）
- 2026-09-15 — 独立审查 round 1..5（均以独立 pi 进程 + 沙箱副本执行，记录见 issue 目录）：
  - round 1：IMP-1..5（预算不可收敛 / silent 剪裁无痕 / 自愈过宽 / 召回缺口 / 缺压缩指令）
  - round 2：B-1（自愈误判）/ I-1（headless 无痕）/ I-2（tiny cap 退化）/ I-3（召回）
  - round 3：B-1 未真正关闭（对象后未校验）/ I-2b / T-1；I-1 确认修复
  - round 4：B-1R（对象前未校验）/ I-2bR context 饥饿 / I-S2 stale heal 竞态 / T-1R
  - round 5：**B-1R5（单行前缀 + 嵌套键 + 二次级联三个向量）仍属 blocking**；
    I-S2R（CAS 非原子）；T-1R 部分；预算 64 组矩阵与真实备份回放通过
  - 五轮共性：blocking 全部来自「读取端启发式写回」这一设计本身，逐轮加固仍可构造新的
    破坏性误判向量；TOCTOU 在无锁/无原子交换下无法关闭
- 2026-09-15 — 按流程停在 owner 决策 `memory-heal-mode`（见下）
- 2026-09-15 — **owner 选择 1 = B**（读取端只解码、不写盘；污染文件由正常 consolidation
  写入路径在覆盖前备份修复）→ `memory-heal-mode: approved`；已按 B 实施并验证：
  8/8 测试、三份真实备份解码正确（15055/14385/14525）且读路径零写入；待 round 6 独立复审确认后
  进入 fix 完成确认。
- 2026-09-15 — B 实施后的独立复审 round 6..11（均独立 pi CLI + 只读沙箱，核验零写入）：
  - round 6（blocked）：B-1 截断解码丢末行；B-2 写路径备份用陈旧快照；I-1..4（clip 无备份、
    冒号引入行误判、并发重复写、召回缺口）→ 全部修复
  - round 7：IMP-1 备份对不可读目标 fail-open；IMP-2 修剪按名排序可删新备份 → 修复
  - round 8：IMP-1 混合语种预算越界；IMP-2 修剪 `startsWith` 过宽（可删用户文件、目录中止）→ 修复
  - round 9：预算收敛循环可清零/不变量超 4%；`written.delete` 过宽回放陈旧 outcome → 修复
  - round 10：保底分支把 token 配额当字符上限（浪费 43–44.5%）→ 修复
  - round 11：**PASSED**（无 blocking / 无 important）；唯一 nit（浮点残差）已用精确修剪修复，
    60k 随机网格 0.001 容差下 0 越界 / 0 清零 / 0 地板破坏 / 0 浪费超标
- 2026-09-15 — **owner 确认 fix-completion**（回答「1 + A B C」）：
  - `fix-completion: approved`；A 按建议**不在本次修改仓库文件**（`.memory-backup-*`/`errors.log`
    的忽略与脱敏留作后续独立 feature）；B 保留三份 `.poison-backup-*`；C Quantum_Matrix 记忆保持现状。
  - 授权限定范围 commit（3 个代码文件 + 本 issue 文档），不 push。

## Resolved Checkpoints

**Checkpoint: memory-heal-mode** — 读取端自愈的写入策略需要 owner 决策（blocking 未清）：

> **Owner answer: 1 = B（读取端只解码、不写盘；写入方备份后覆盖）。已按 B 实施，见 fix-note §6。**

- 审查报告：`consolidated-memory-json-poison-review.md`（`status: blocked`，round 5）；
  五份独立记录：`consolidated-memory-json-poison-review-round{1..5}-independent.txt`
- 背景：`loadMemory` 是注入/整理/autolearn/命令的共享读路径；「读时判定 + 原地覆盖 + 备份」
  的实现连续四轮被独立 reviewer 构造出新的健康记忆误判（每轮修复只关闭一个等价类），
  且 stale-heal 的 TOCTOU 无法在不加锁的前提下关闭。

**选项**

1. **B（推荐）：读取端只解码、不写盘**
   - `loadMemory` 检测到结构性污染时只在内存中解码返回，注入/整理/autolearn/`/memory`
     都得到干净 Markdown；**不再写回、不再备份**。
   - 污染文件由正常 consolidation 写入路径修复：检测到存储文件是污染的 pass 在覆盖前
     先写 `.poison-backup-<stamp>`，并保留 warning/日志。
   - 从构造上消除：破坏性误判（B-1 系列）、TOCTOU（I-S2）、备份命名冲突、自愈静默等。
   - 代价：磁盘文件在下次成功整理（或显式 `/memory-learn`）前保持污染（但注入已干净）；
     read-only 路径不再自动留备份。
2. **A：继续加固原地自愈**
   - 单行前缀白名单（只允许真正 wrapper）、depth-1 键校验、二次级联防抖；
   - I-S2R 接受残余 TOCTOU 或引入锁文件；需再走一轮完整独立复审。
3. **C：接受风险**
   - 把 B-1R5 / I-S2R 记为已记录残余风险继续（不推荐：仍有破坏性数据丢失面）。

## Why Now

fix-note 与五轮独立审查均已完成；blocking 未清时按协议不能进入 fix 完成确认与提交，
而剩余两条路径（继续加固 / 改设计）是产品取舍，需要 owner 决策。

## Context

- 代码状态：3 文件未提交改动（+427/−52），8/8 测试通过；预算分配、通知矩阵、
  headless 留痕、解码器与真实备份回放均已验证；阻塞点只在「读路径写回」的误判面与并发窗口。
- 两个项目的存量数据已修复（Quantum_Matrix 14:58 自愈 + 备份；UniField 14:46 手工解码修复），
  旧进程已退出；继续加固/改设计不影响这两份已修复数据。

## Risks And Tradeoffs

- B：磁盘污染滞留窗口（无自动备份）依靠正常整理修复；需同步改测试、fix-note 与 README 交底。
- A：预计还需 1–2 轮独立复审，且无法证明启发式无误判（只能收窄）。
- C：保留静默破坏共享记忆文件的可能。

## Non-Automatic Actions

- 不 commit / 不推送；不删除任何备份；不修改两个项目的其他数据。

## After You Answer

- 选 B：按新设计实施（decode-only + 写入端备份），更新分析/fix-note/测试，再走完整独立复审。
- 选 A：实施 round-5 建议的加固 + 并发取舍，再走完整独立复审。
- 选 C：把两项写入 residual risk 与 fix-note，进入 fix 完成确认。
