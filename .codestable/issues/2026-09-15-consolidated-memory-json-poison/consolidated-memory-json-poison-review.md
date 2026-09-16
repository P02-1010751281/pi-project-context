---
doc_type: issue-review
issue: 2026-09-15-consolidated-memory-json-poison
status: passed
reviewer: subagent
reviewed: 2026-09-15
round: 24
lane_a_state: completed
lane_a_ref: "独立 pi CLI 进程（ephemeral session、只读沙箱副本），round 1..24 完整记录：consolidated-memory-json-poison-review-round{1..24}-independent.txt"
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
| 12 | changes-requested | I-1 陈旧锁夺取无所有权判别（原持有者 finally 可能删掉新持有者的锁）；I-2 `clipText` 在补偿代理对时返回 `limit+1`，精确修剪空转（60k 网格 254 越界 @0.001） | 修复：锁内容唯一 token + 释放比对；`tailStart` 补偿 head 保证 `length ≤ limit`；新增 emoji/引号 fixture 与锁回归 |
| 13 | changes-requested | IMP-R13-1 夺取侧仍可互删新锁（400 轮 ×3 写者重叠 3 次）；N-R13-1 `lastWrite` 陈旧回执；N-R13-2 畸形代理对 | 修复：`<lock>.steal` 单胜者夺取 + 释放串行；每轮清理 `lastWrite`；畸形孤儿低代理跳过；压测 400 轮 0 重叠 0 泄漏 |
| 14 | changes-requested | IMP-R14-1 `releaseLock` 抢不到 claim 仍删锁（删到夺取者新锁）；IMP-R14-2 stale 分支忙等旁路 5s deadline（CPU 空转 6.6s/6s） | 修复：release 无 claim 即返回；deadline 前置 + 全路径退避；`tryLock` 先 close 再 rm；建锁即写 gitignore |
| 15 | **PASSED** | 无 blocking / 无 important；nit：`<lock>.steal` 为目录时协议永久冻结；无跨进程回归；文档滞后 | 已修 nit：claim 非普通文件移开自愈、`lockMtimeMs` 区分缺失/不可读、3 子进程跨进程回归、`*.broken-*` 忽略；round 16 确认 |
| 16 | **PASSED** | 无 blocking / 无 important；nit：锁路径为目录时同类冻结、跨进程用例无 timeout/泄漏断言、`.broken-*` 无回收、根 `.gitignore` 过宽 | 已修 nit：`tryLock` 非普通文件自愈、spawn timeout + 残留断言 + `fileURLToPath`、`cleanStaleTemps` 回收 `.broken-*`、根规则收窄到 `.agents/**`；round 17 确认 |
| 17 | **PASSED** | 无 blocking / 无 important；nit：`.broken-*` 回收对非文件来源无效（且新增删除面）；`run-all.mjs` 无 timeout | 已修 nit：只删「空目录且超龄」的 broken 产物（含用户数据/非目录一律保留）、`run-all` 加 60s timeout；8/8 通过，闭合 |
| 18 | **PASSED** | 无 blocking / 无 important；residual：legacy `.pi`/OMP 不可读此前静默；`migrateProjectState` OMP 导入同类静默 | 已修：`readMemorySource` 覆盖 `.pi`/OMP 回退（unreadable 上报），OMP 迁移不可读时记 `errors.log`；8/8 通过 |
| 19 | changes-requested | IMP：dangling symlink 在 lock/claim 路径不再自愈（`stat` 跟随链接误判 ENOENT，5s 永久超时）；nit：steal 未钉 inode、常量耦合 | 修复：EEXIST 分类改 `lstat`、非 regular 一律移开；steal 用 inode+bytes+claim 三重复查；`MAX=max(KEPT,20)`；补 symlink/FIFO/上限断言 |
| 20 | changes-requested | IMP：FIFO 用例是永真断言（catch 吞掉失败）；nit：claim 回收未钉 inode、`tryLock` 清理用 `stat` | 修复：mkfifo 探测与断言分离、claim 回收 inode 钉定、清理统一 `lstat`、备份同 mtime 按名 tie-break |
| 21 | **PASSED** | 无 blocking / 无 important；nit：`acquireClaim` 清理仍用 `stat`、FIFO 缺失为带标注 OK、stat 失败跳过无覆盖 | 已修 nit：清理统一 `lstat`、新增同 mtime 确定性断言；残余为 node:fs 无内核原子（flock）的 check→unlink 悬挂窗，注释已如实声明 |
| 22 | changes-requested | IMP：外部编辑 mtime 判别器恒真（自家渲染被反复 adoption、journal 重复记录）；IMP：半行尾部吞掉下一条 append；nit：轮换 rename→重写窗口会让 journal 路径消失 | 修复：内容同口径归一 + 双条件判别；append 前补换行；轮换改「临时文件 → 归档 → 替换 + 回滚」；归档加后缀并补年轻保护测试 |
| 23 | changes-requested | BLOCKING：内容相等分支因「折叠带尾换行 vs 渲染 trim」成为死代码，round-22 修复未生效（normalization 口径分叉） | 修复：抽出 `memoryComparisonKey` 单点收口，读/写共用；新增「内容相同 + mtime 新 ⇒ 不采信、条目线性」负例 |
| 24 | **PASSED** | 无 blocking / 无 important；nit：轮换临时名不被 gitignore/清理覆盖、README 树注释陈旧 | 已修：临时名改 `.tmp`（gitignore + `cleanStaleTemps` 覆盖）、`/memory` 对无可用记录 journal 给出重建提示、adoption 记 `errors.log`、文档同步 |

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
- round 12：owner 要求「残差都修复掉」；解码召回、跨进程锁、备份保龄、gitignore/脱敏、
  token 率/代理对、maxOutputTokens、读错误展示、去重等批次已实现（fix-note §6 round-12），待独立复审。
- round 12/13 的 findings 均已修复（锁单胜者夺取、clipText 长度契约、lastWrite 清理、畸形代理对），round 14 复审确认中。
- round 14/15：release claim 门控、deadline 退避、claim 异常自愈、跨进程回归均已落实；round 16 复审确认中。
- round 16 判 **PASSED**；其 nit（锁路径非文件自愈、测试 timeout/残留断言、`.broken-*` 回收、根 .gitignore 收窄）已修，round 17 复审确认中。
- round 17 判 **PASSED**（无 blocking/important）；最后两个 nit 已以本地测试收口，review gate 关闭。
- round 18 判 **PASSED**（legacy 未读来源可见性补全）；OMP 迁移同类静默已同步收口，最终闭合。
- round 19/20/21：锁协议病理矩阵（symlink/FIFO/目录/inode/claim 令牌）与备份硬上限加固完成；round 21 PASSED，review gate 关闭。
- round 22/23/24：记忆 journal 化（append-only 权威 + 派生渲染，与会话存档同构）；round 24 PASSED，review gate 再次关闭。

## 4. Focused Closure（无则写 none）

- round 11 为完整独立复审（PASSED）；其后仅按 round-11 nit 做「精确修剪」小改（非 material：不改变分配设计，只消除浮点残差；60k 随机网格 + 仓库矩阵验证）。
