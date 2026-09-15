---
doc_type: issue-review
issue: 2026-09-15-consolidated-memory-json-poison
status: passed
reviewer: subagent
reviewed: 2026-09-15
round: 11
lane_a_state: completed
lane_a_ref: "独立 pi CLI 进程（ephemeral session、只读沙箱副本），round 1..11 完整记录：consolidated-memory-json-poison-review-round{1..11}-independent.txt"
lane_a_reason: "独立上下文 reviewer，分别在 /tmp/pi-context-revN 沙箱副本中审查；沙箱与真实仓库均核验无写入"
lane_b_state: unavailable
lane_b_ref: ""
lane_b_reason: "ocr CLI 未安装（which ocr 为空）"
---

# 2026-09-15-consolidated-memory-json-poison 代码审查报告（round 1..8）

## 1. Scope And Inputs

- 来源：issue（无 design/checklist）；实现证据：fix-note §6（owner 决策 B + review-fix 增量）
- Diff basis: `git diff`（未提交）：`consolidate.ts`、`project-state.ts`、`tests/consolidation-test.mjs`
- Review mode: full re-review（round 6/7/8 均为完整复审）
- 独立核验手段：8/8 测试、差分 fuzz（20 万/5 万/3000 例）、预算矩阵独立复算、变异组、
  真实备份回放、写路径确定性交错、fail-closed（EACCES/EISDIR）、时钟回拨与修剪身份探针

## 2. Verdicts By Round

| Round | 结论 | 关键发现 | 处置 |
|---|---|---|---|
| 1–5 | changes-requested → blocked | 读路径启发式写回的破坏性误判（B-1R5）、读侧 TOCTOU（I-S2R） | 停 owner 决策 → 选 B（解码只读 + 写时备份） |
| 6 | blocked | B-1 截断解码丢末行；B-2 写路径备份用陈旧快照；I-1 clip 无备份；I-2 冒号引入行误判；I-3 并发重复写 | 全部修复：不裁剪末行；写时无条件备份；clip 同备份；前缀白名单收紧；claim 提前 |
| 7 | changes-requested | IMP-1 备份对不可读目标 fail-open；IMP-2 修剪按名排序可删新备份 | 修复：仅 ENOENT 视为无文件（其余抛出 → failed）；mtime + 身份排除修剪 |
| 8 | changes-requested | IMP-1 混合语种预算越界（CJK memory + ASCII context）；IMP-2 修剪 `startsWith` 过宽（可删用户文件、目录中止） | 修复：按各 artifact 本地 token 率分配并收敛；精确生成名 + isFile + 单项容错 |
| 9 | changes-requested | IMP-1 round-8 预算收敛循环可把 memory 清零、不变量最多超 4%；IMP-2 失败路径 `written.delete` 过宽回放陈旧 outcome | 修复：地板+按需分配+实际文本迭代+字符保底（20k 网格 0 越界/0 清零）；仅本次 claim 过才释放；修剪全名锚定 |
| 10 | changes-requested | IMP-R10-1 保底分支把 token 配额当字符上限，触发时浪费 43–44.5% 并破坏 400 字符地板；N-R10-1 部分写失败释放 claim | 修复：token 比例缩放 + 字符数绝对上限 + 阻尼增长回填；仅未写成功 MEMORY.md 时释放 claim；skew 测试改真实 utimes（60k 网格 0 越界/0 清零/0 地板/0 浪费超标） |
| 11 | **PASSED** | 无 blocking / 无 important；nit：0.4 token 浮点残差与测试容差不一致（已用精确修剪修复，60k 网格 0.001 容差 0 越界） | 无 blocking；残差按记录接受 |

## 3. 当前状态（round 11 复审后）

- blocking：无（连续三无破坏性数据丢失主路径）。
- round 6/7/8 的全部 blocking/important 已修复并锁定测试：真实备份末行保真、
  写时备份、clip 备份、并发去重、fail-closed 端到端、修剪身份/时钟回拨、混合语种预算上界。
- 未闭环（记录为 residual）：`/memory` 对不可读文件显示「无记忆」（展示误导）；
  `.memory-backup-*` 未纳入 gitignore；写→prune→rename 微窗口；解码召回缺口
  （`context` 先行/无 header 值/`.pi`/OMP 来源）；token 率未计 JSON 转义与非 CJK 低编码文字；
  `clipText` 可能切开 surrogate pair；`cleanMemory`/`normalizeHealedMemory` 逻辑重复；
  `migrateProjectState` 的极窄竞态不走备份。
- round 10：CHANGES-REQUESTED（无 blocking），IMP-R10-1/N-R10-1 已修复（见 fix-note §6），本地 60k 随机网格 0 失败。
- round 11：**PASSED**（无 blocking/important；唯一 nit 已用精确修剪修复并本地验证）。review gate 关闭，待 owner 确认后提交。

## 4. Focused Closure（无则写 none）

- round 11 为完整独立复审（PASSED）；其后仅按 round-11 nit 做「精确修剪」小改（非 material：不改变分配设计，只消除浮点残差；60k 随机网格 + 仓库矩阵验证）。
