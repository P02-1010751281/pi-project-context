# 独立审查报告 — issue `2026-10-09-handoff-baseline-residual`

审查对象：物理下限 baseline 的取样修复（`floor = baseline + keep + MIN_DROP_TOKENS`）。
流程按 `.agents/skills/pi-project-context-independent-review/SKILL.md`：冻结修订 → `/tmp` 逐字节沙箱 → 独立 `pi` 进程只读审查 → 零写入证明 → 抄本归档。

## 轮次表

| 轮 | 修订 | 判定模型 | verdict | blocking | important | 性质 |
|---|---|---|---|---|---|---|
| R1 | `466ebcd` | `deepseek/deepseek-flash`（thinking high） | CHANGES-REQUESTED | 0 | 2 | 新引入的 fail-open（单一 rate 套异质分支时 min 可读到 0）+「无 usage 记录逐字节等价」不成立（`plain` 漏掉非 message 条目） |
| R2 | `d2e3e82` | `deepseek/deepseek-flash`（thinking high） | CHANGES-REQUESTED | 0 | 1 | 守卫只认 `scaled <= 0`，异质前缀在 `0 < scaled < 真值` 整段仍低读（20k ASCII 前缀 ⇒ 3,736；25.2k ⇒ 106 < 物理下限 11,021） |

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

## R2（冻结 `d2e3e82`）— 修复轮之后的复验

判定：CHANGES-REQUESTED，**0 blocking / 1 important（I-1）**。抄本 `baseline-residual-review-round2-independent.txt`。
审查员逐字节复现了两条 R1 修复的闭合（异质 60k 夹具 0 → 17,766；compaction 无 usage 59,000 → 57,000，且与 `3bafa26` 旧公式逐字节相同，
`branch_summary` / `custom_message` 同样吻合），并确认守卫对**同质**会话零影响（rate 2.5/3.5/4/1.2 四个夹具在"有守卫/去守卫"两种代码下读数一致）。

**I-1（important，同类 fail-open 未闭合）**：`threshold.ts` 的过度修正守卫只处理 `scaled <= 0`。当前缀比校准窗口**稀疏**（ASCII 前缀 + CJK 尾）而 `scaled`
落在 `(0, 真值)` 区间时，既不触发守卫、又低读：

| 夹具（真值 17,766） | 读数 |
|---|---|
| ASCII 60,000 字符 + CJK 尾 | 17,766（守卫触发，R1#1 闭合）|
| ASCII 20,000 字符 + CJK 尾 | **3,736** |
| ASCII 25,200 字符 + CJK 尾 | **106**（低于物理下限 11,021）|
| 同一分支去掉 CJK 尾 | 17,766 |

同一支分支加上尾巴反而塌掉 17.6k —— 正是本 issue 要修的「baseline 随分支漂移」的反向复现。`CHANGELOG:26` 的「会高读、不会低读」与
`design.md` 的「只高不低」只对 `scaled <= 0` 成立，**对 `0 < scaled < 真值` 不成立**（措辞已在 `design.md` §3 收窄为"只对可信样本成立"，
但 I-1 说明"可信"的判据本身不完整）。

根因（审查员的 learning，值得留档）：**单向守卫修不了双向误差** —— 把"过度修正"等同于"残差被夹到 0/转负"，漏掉了"过度修正但残差仍为正"的连续区间；
修一个符号缺陷前应先把出错量的**值域**画出来再定守卫形状。单个会话级 rate 只对与其同率的前缀有效。

**待 operator 决定（本报告停在这里，未取 PASS）**：
- **A. 重构成"锚点 + 精确增量"**（推荐）：两条 prompt 之差就是两者之间新增消息的**真实 token 数**（provider 自己数的，无估计），所以
  `T_i = T_anchor + ΣΔprompt`；只有锚点（首条记录之前的内容）需要估计，取 `chars/8`（取值带允许的最稀内容）作为**下界**，于是每个读数都
  ≥ 真值（可证：`须 r_anchor <= 8`），代价是 dense 锚点上最多高读 `chars*(1/r - 1/8)`，**以首条消息的字符数为界**（不再随分支增长）。
  这套去掉守卫、min 的角色也缩小，净代码量与现在相当或更少。
- **B. 接受现状 + 收窄措辞与残余**：把 I-1 登记为残余（现 R1–R7 未覆盖），明确写"baseline 可低读到物理下限之下，仅当前缀与校准段同率时不发生"，
  并把状态行改成能自证"这次读数是否可信"。**不推荐**：fail-open 方向（过早起跳）不该只靠文档兜。

**R2 的其它 finding（都便宜，等决定后一并处理）**：N-1 契约数仍差 1（实测 18，三处写 17）；N-2 状态行在"校准为真但赢家走了 chars/4 回退"时仍
谎报 rate（应记 `fellBack`）；N-3 compaction 契约的期望值用的是模块自己的输出，改成 `+= 2 * estimateTokens` 后**仍绿** ⇒ 需加绝对常数钉
（`|summaryOnly.estimated - 2_000| <= 2`）；S-1 `scaled === 0` 边界无覆盖；S-2 `RATE_PAIRS` 窗口无契约；S-3 `atRate` 取整方向无契约；
S-4 `run.ts` 每条 status 行重复走 4–5 次全量 walk（非本轮回归，登记即可）。

**R2 新登记的残余（RR）**：RR-1 I-1 本身（若选 B）；RR-2 状态行无法区分"赢家走了 chars/4 回退"；RR-3 全样本都被过度修正时退回 chars/4 的 min
（60k 夹具 17,766 vs 旧公式 42,897 ⇒ 不会复现原始缺陷，但属 fail-closed 侧，需点名）；RR-4 S-1..S-3 的覆盖缺口。

## R2 之后的结构性发现（operator 侧只读探针，非审查轮）

`probe-system-estimate-in-baseline.md`：线上 `baseline` 把 **pi 自己已算好的 system 估算**（`estimateTokens` 的 system 分支：
`content + Σsections + JSON(toolsAdded)`）减掉了 —— `plain` 里含 system 消息（`getBranch()` 无过滤，`sessionEntryToContextMessages`
对 message 条目返回该消息），所以 `baseline = prompt − atRate(plain)` 是「估算残差」而非「非对话开销 B_true」。

用生产 `measureContext` + 真实会话条目实测，对照（system 消息清零）之差**精确等于** `atRate(system 估算)`：

| 会话 | ① 线上 | ② 排除 system | ②−① | atRate(system) |
| --- | ---: | ---: | ---: | ---: |
| probe（01a1331c） | 7,879 | 17,760 | 9,881 | 9,881 |
| ctl（01a1331d） | 1,133 | 11,015 | 9,882 | 9,882 |
| 活树（01a13385） | 6,515 | 36,227 | 29,712 | 29,713 |

影响：`floor` 系统性偏低同量 ⇒ 每个会话都可能过早起跳（fail-open，比 I-1 更普遍）；测试夹具 0 个 system 条目 ⇒
两轮审查与全部契约都在生产里不存在的分支形状上验证。**该发现排在 I-1 之前**；候选修法 C（把 system 从 `plain` 排除）与
D（直接用 pi 的 system 估算）见该文件，A/B 的选择待此决定后一并给结论。
