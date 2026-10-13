# 独立审查报告 — issue `2026-10-09-handoff-baseline-residual`

审查对象：物理下限 baseline 的取样修复（`floor = baseline + keep + MIN_DROP_TOKENS`）。
流程按 `.agents/skills/pi-project-context-independent-review/SKILL.md`：冻结修订 → `/tmp` 逐字节沙箱 → 独立 `pi` 进程只读审查 → 零写入证明 → 抄本归档。

## 轮次表

| 轮 | 修订 | 判定模型 | verdict | blocking | important | 性质 |
|---|---|---|---|---|---|---|
| R1 | `466ebcd` | `deepseek/deepseek-flash`（thinking high） | CHANGES-REQUESTED | 0 | 2 | 新引入的 fail-open（单一 rate 套异质分支时 min 可读到 0）+「无 usage 记录逐字节等价」不成立（`plain` 漏掉非 message 条目） |
| R2 | 待冻结 | — | — | — | — | 修复轮后再开一轮 |

R1 抄本：`baseline-residual-review-round1-independent.txt`；提示词：`baseline-residual-review-round1-prompt.txt`。
沙箱：`/tmp/pc-baseline-review1`（`cp -a` 自 `466ebcd`），零写入证明：`git status --porcelain -uall` 与 `find … stat` 两次快照 diff 均为空
（仅 `.agents/memory` 按 skill 约定剪除），且被审五个文件的 md5 与活树逐一相同。审查员自己的实验在 `/tmp/rev1`（第二份副本）里跑。

## R1 的 finding 与处置

| # | 级别 | 一句话 | 处置 |
|---|---|---|---|
| 1 | important | 会话级单一 rate 套到异质分支：较"省 token"的早期样本被过度修正，`Math.max(0,…)` 把残差夹到 0，而 0 必赢 `min` ⇒ baseline=0、floor 过低、自动交接过早 | **已修**：过度修正（换算估计 ≥ 自身 prompt）的样本改用历史 chars/4 残差（会高读、不会低读），`min` 只由 rate 读得可信的样本推动 |
| 2 | important | 「无 usage 记录 ⇒ 逐字节走旧公式」不成立：`plain` 只累加 `type === "message"`，而旧公式对**全部**条目做 `sessionEntryToContextMessages`（compaction / branch_summary / custom_message 都是 prompt 内容） | **已修**：非 message 条目也计入 `plain`；`samples===0` 时 rate 必为 pi 的 4，换算退化为恒等 ⇒ 该路径现在与旧公式逐字节相同 |
| 3 | nit | 状态行在 `samples>0 && !calibrated` 时把兜底的 4.0 印成"测得的 rate" | **已修**：该支改为 `(chars/4, no usable delta, best of n)` |
| 4 | nit | 记录数字不符：design/commit 称「12 条用例」，实测 `git diff … \| grep -c '^+.*check('` = 15 | **已修**：design §8 改为实测口径（原始提交 15 条；本轮后该节 17 条 check） |
| 5 | suggestion | 同一状态行里 `~X recent carried`（config 预算）与回执 `carrying ~Y`（按 rate 估算）口径不同却都像测量句 | 登记为 R5（措辞轮，另开） |
| 6 | suggestion | 回执 `dropping ~X` 是"按本会话 rate 估算被丢集合"，不是真实切下的量（切点仍 pi 的 chars/4） | 登记为 R6（与 R1 同源，切点不动） |

两条 important 都在现场事实上有依据：`probe-true-baseline.md` 实测 `B_true = 17,766`（活树 30–39k），物理下限的 baseline 不可能是 0；
老的 `baselineTokens` 对**全部**条目求和是 `git show 3bafa26:…/threshold.ts` 里可核的既有行为。

## 登记残余（不在本轮修）

- **R1**：超带退化为 4 时本 issue 的偏差只是被 `min` 界定、未被消除（极密内容样本仍偏高）；文档措辞已从「min 是上界」改为「min 是最紧的*可信*样本」。
- **R2**：重放 predecessor 记录在"首个回合只有它"时就是 `min`（状态行首查会读到虚高的 fail-closed 值；自动触发发生在 `agent_settled`，影响面小）。
- **R3**：`context_edit` 的 `plain` 用的是编辑前原消息（既有口径，非本 diff 引入），新的 `min` 会主动挑中这类低残差样本。
- **R4**：多 provider / 模型切换只置 `split`，不同路由的样本仍一起进 `min`。
- **R5**：状态行 `carried` 与回执 `carrying` 的措辞口径（suggestion）。
- **R6**：切点仍是 pi 的 `findCutPoint`（chars/4），回执不披露"20k keep 在 CJK 下会超配"。
- **R7**：未在父提交上重现 `consolidation-test.mjs` 的 flake（需多轮高负载，预算不允许）；审查员只经 `waitUntil` 语义检查确认该修复不削弱断言。

## R1 的独立复现（审查员自造变异）

作者 8 条变异的红数被逐条复现且全符；审查员自造的 5 条里 3 条全绿（= 无覆盖的分支），正是本轮补测的来源：
`min`→最早 红 1、rate 固定上界 8 红 6、rate 固定下界 1 红 5、乘除写反 红 2、非 message 条目计入 `plain` 红 0、
去掉残差钳制 红 0、未校准后缀加标记 红 0。修复轮已为后三条各加一条会变红的契约（见下）。

## 修复轮（R1 之后）的验收

- 新增 3 条契约：异质分支的过度修正回退（自洽夹具真值 17,766）、compaction summary 属上下文而非 baseline（含"夹具真注册了该条目"的合取，防假绿）、未校准后缀不谎报 rate。
- 11 条单点变异全部变红（计法 `node tests/run-all.mjs` 的 `^FAIL ` 行）：取最后一条 2、`totalTokens` 1、rate 固定 4 7、去取值带 3、退 fallback 减法 9、
  回执忽略 rate 1、自己消息计入自己 2、去掉状态行后缀 1、**去掉过度修正守卫 1**、**非 message 条目不进估计 1**、**未校准分支谎报 4.0 1**。
- 全套 15 项测试连绿（多次），记录数字按实测口径订正。
- R1 的 PASS 不覆盖修复后的修订 ⇒ **修复轮必须自己再开一轮**（R2），冻结候选为修复提交。
