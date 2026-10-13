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
两轮审查与全部契约都在生产里不存在的分支形状上验证。**该发现排在 I-1 之前**；`baseline-includes-system-estimate.md` 的后续实测进一步定死：**C 是 A/B 两种选择都要的前置**（沙箱真值 17,753/11,008，
线上读 7,879/1,133；活树 6,515 vs 排除 system 后 36,227）；**D 不可行**（两沙箱 system 估算 9,881/9,882 而真值差 6,745 ⇒
pi 的估算看不到扩展注入的记忆块）；**A 必须配 C 且需要记录合格性规则**（A 单独含 system 时 probe 读 12,822，低 4,931；
活树首样本是 predecessor 重放，prompt 131,434 而本地分支 1 token）。A/B 的最终选择仍待 operator 定。**补充实测**（`probe-rate-spread`）：C 之后剩余的是**漂移**而非常数 —— 同一活树会话里
区间 rate 跨 0.17–19.90、C 后逐样本读数漂移 13.8k（真值应近常数），成因是 predecessor 重放、`context_edit`/compaction、
以及注入块被刷新；所以 A/B 的实质是「漂移要不要修」，且任何选项都要先有记录合格性规则。

## R3（本轮修复：C+A —— 尚未独立审查）

**改动**：`handoff/threshold.ts` 的 baseline 取样按 §9 换成 C+A；`tests/handoff-test.mjs` 的 8 条旧契约按新语义重写并新增 6 条；
`CHANGELOG.md`（v0.4.10 未发布段）、`docs/architecture.md`、`docs/handoff.md` 同步。

**验收证据**（本仓口径）：

- `node tests/run-all.mjs` ⇒ **All 15 tests passed**（handoff 末节 19 条 `check(`，本轮新增/改写 7 条 `^+.*check(` 行）。
- 变异矩阵（`^FAIL ` 行计数，每个变异只改一处，恢复校验通过）：system 重新计入估计（message 分支）**2**、上界退回 rate 缩放
  **7**、`min` 改 `max` **8**、去掉「记录不及其自身密度下界 ⇒ 不是测量」**1**、compaction 的 `systemMessage` 计入 **1**、
  后缀不写回执口径 **3**。无零命中变异。
- **真实会话验证**（同一 `/tmp/verify-ca.mjs`，只读）：probe 沙箱 17,763（真值 17,753，+10）、ctl 沙箱 11,018（真值 11,008，+10）、
  活树 handoff 会话 52,151（最空记录字符数带来的高读 ≈ +12k ⇒ 真值 ≈ 40k，与 probe 文档期望的活树 30–39k 同量级）。
  「C 已生效」的证据：把 system 消息清零后读数完全不变（旧实现会掉 9.9k–25.8k）。逐前缀扫：旧实现的 13.8k 漂移消失，
  序列非增（新记录只带来更大的上界）。
- I-1 回归钉：R2 审查员的两个夹具现读 20,266 / 20,916，均 ≥ 真值 17,766 与物理下限 11,021（旧实现 3,736 / 106）。

**登记残余**：§9 的三条 + 本报告原有的 RR-1..RR-4 中仍未闭合者（RR-2 状态行无法区分「赢家走了回退」已随守卫删除而消失；
RR-3「全样本被过度修正时退回 chars/4」同样消失；RR-1 即 I-1，本轮由构造消掉）。**下一轮 = 冻结本修订的独立审查。**

### R3 独立审查结果（冻结 `3abd207`，lane A，route `deepseek/deepseek-flash`）

判定：**CHANGES-REQUESTED — 0 blocking / 2 important / 4 nit**。抄本 `baseline-residual-review-round3-independent.txt`，
prompt `baseline-residual-review-round3-prompt.txt`。零写证明：`git status` 与文件 mtime/size 两份快照 diff 均为空
（全部实验在审查员自己的 `cp -a` 副本里跑，生产树 md5 = HEAD blob）。

**审查员独立复现并闭合的点**：

1. C 的前提成立：pi 1.2.0 的 `estimateTokens` system 分支 = `content + sections + toolsAdded`
   （`dist/core/compaction/compaction.js:201/206/207-211/213-214`）；自造夹具旧代码含 system 读 7,766、清零后 17,766，差 10,000 = atRate(system 估算)；
   两沙箱 system 估算 9,881 / 9,882 而真值差 6,745 ⇒「pi 的 system 估算看不到本扩展注入块」成立；旧公式低读 7,879 / 1,133 与
   `probe-variant-comparison.txt` 逐位吻合。
2. A 的可证方向成立：R2 两个 I-1 夹具读 20,266 / 20,916（≥ 真值 17,766 与物理下限 11,021）；同质 CJK 读 41,100 = 40,000 + 4,000×(1/2.5 − 1/8) 取整；
   同一会话两个 leaf 读同值（非增）；`prompt <= chars/8` 的记录不进 min 且读数不为负。
3. 取整方向不翻转上界（`ceil(Σceil(len/4)/2) ≤ Σceil(len/8) ≤ T` ⇒ 保守高读），只在**取值带被打破**时翻转 —— 即 I-1。
4. 六个已发布变异逐位复现：2 / 7 / 8 / 1 / 1 / 3 条 `^FAIL`；另有 9 个自造变异（见 N-3）。
5. dense 锚点量级复现：纯 CJK 10 万字符 ⇒ baseline 105,266（1M 窗口 knee 仍先绑定，`drop 31,734`）；15 万字符 ⇒ floor 177,016 > 157k ⇒ 拒绝。
6. 前缀序列自证：probe / ctl 17,763 / 11,018 精确复现；活树 record 0–3 读 131,433、record 4 起恒 52,151（非增，13.8k 漂移消失）。

**待修（R4）**：

- **I-1（important，fail-open）图像块打破 `chars/8 ≤ T`**：pi 对每张图固定计 `ESTIMATED_IMAGE_CHARS = 4800`
  （`compaction.js:182/193-195`），而带要求每张图 ≥600 token 才不低读；小图（截图缩略图 / low-detail 85 token 级）远低于此 ⇒ 上界落到真值之下并赢 min。
  审查员夹具：B = 17,766 + 图 100 token ⇒ 读 **17,264**（低 502），每张更小的图再多低约 500。修法：把 image block 从 `chars` 的密度下界里单列
  （图内真实 token 落进 baseline，方向 fail-closed），并把「>8 chars/token 的长空白/重复串」写进同一残余。
- **I-2（important，fail-open，低读侧未登记）`prompt <= chars/8` 不是记录合格性**：实现只走当前 leaf 的分支，把**当前**前缀字符数记给每条历史记录；
  某条记录计费后分支前插了 replay（或 `context_edit` 改长）时，其 `chars` 含它没被计费的字符 ⇒ 上界落真值之下并赢 min。
  审查员夹具（B = 17,766、本地记录 prompt = 18,766）：replay 50k ⇒ **12,016**、100k ⇒ **5,766**、140k ⇒ **766**。
  这正是 design `§5.3` 早已写明的要求（「截至 r」要用 r 自己当 leafId 重建，不能用当前叶子截断）而两轮实现都没做 ⇒ R4 按 §5.3 修（并留意 S-4 的性能面）。
- **N-1**：`CHANGELOG.md` / `docs/handoff.md` / `threshold.ts` 注释的「永不低读」与自登记残余②（注入块会话内增长）矛盾 ——
  审查员夹具读 18,866 vs **当前**真值 24,511（低 5,645）⇒ 收窄文案（或把残余②写进 CHANGELOG 的残余清单）。
- **N-2**：残余③的「首回合」表述不准（实测活树到 record 3 才出现更小 bound）；`below-quality-knee` 的拒绝句仍输出 "a smaller baseline … is the lever"，
  而同文件注释刚说不该把 baseline 当杆 ⇒ 未登记的文案面。
- **N-3**：CHANGELOG 的契约数（末节实为 **26** 条 `check(`；diff 新增 7 条 ✓）与「每条断言都有单点变异」的措辞需订正（审查员 9 个自造变异覆盖 24/26；
  未覆盖的是「fallback tracks usage.tokens exactly」与伞形断言「no scenario above reached a model」）。
- **N-4**：陈旧注释 `threshold.ts:114`（"tightest sampled residual"）、`:244`、`tests/handoff-test.mjs:1493`。

## R4（本轮修复：I-1 + I-2 + 4 条 nit —— 待独立审查）

**改动**：`handoff/threshold.ts`（`withoutImages`/`textEstimate` 单一文本基准、区间一致性规则、`ContextSample`/`ContextMeasure`
注释与 doc block、`below-quality-knee` 拒绝句）、`tests/handoff-test.mjs`（图像契约、区间契约、`absurd` 夹具样本数、陈旧注释）、
`CHANGELOG.md`、`docs/handoff.md`、design §10。

**逐条处置**：

- **I-1 修**：图像不计入 `chars`/`estimated`（图 token 落进 baseline，fail-closed）。契约
  `an image block is not charged to the density floor` 钉 `baseline === 17,866`（审查员夹具读 17,264）+ 与无图控制组的 `estimated` 相等。
- **I-2 部分修 + 登记**：区间一致性规则修掉了重放/编辑形状（审查员夹具现读首样本的 **18,266**，不再是 **12,016**；新契约
  `a record whose text outgrew its prompt is not a measurement`）。4b 夹具的算术**保持**（该文件内部自洽：`prompt_4 = 60,000` 相对其前缀
  只支持 `B ≤ 9,499`，只有跨记录对照才能证伪），其注释改写为诚实表述；「陈旧锚点」登记为残余⑤，真实交接形状（前任记录在前、
  本地记录在后）由新规则捕获。`absurd` 夹具的 `samples` 由 4 改为 **1**（区间规则丢弃三条 40 chars/token 的记录，首条仍是上界）。
- **N-1 修**：`CHANGELOG`/`docs/handoff.md`/`threshold.ts` 三处「永不低读」收窄为「相对设定它的那条记录时刻」，并点名残余②。
- **N-2 修**：残余③表述改为「直到出现更小 bound 的记录（活树实测 record 0–3）」；`below-quality-knee` 拒绝句改为「keep 是杆、
  baseline 是测量值」。
- **N-3 修**：CHANGELOG 的契约数（末节 **28** 条 `check(`）与变异覆盖措辞按本轮实测改写。
- **N-4 修**：`threshold.ts` 两处注释 + `tests/handoff-test.mjs:1493` 的 `chars/8`。

**验收**（本仓口径）：`node tests/run-all.mjs` ⇒ All 15 tests passed。

变异矩阵（`^FAIL ` 行数，每个变异只改一处，跑后 MD5 恢复校验）：system 重新计入 **2**、上界退回 rate 缩放 **7**、`min`→`max` **8**、
去掉自身密度下界判定 **1**、compaction `systemMessage` 计入 **1**、后缀不写回执口径 **1**、**图像字符重新计入 1（新）**、
**去掉区间一致性规则 2（新）**。

现场复验（同一只读探针，三个真实会话）：probe 沙箱 **17,763**（真值 17,753）、ctl 沙箱 **11,018**（真值 11,008）、
活树 `01a13385` **52,151**（35 样本、rate 3.22；前缀 `131,433 ×4 → 52,151` 非增）。三条会话「system 消息清零后读数不变（差 0）」
⇒ C 仍生效；R4 未移动任何现场读数（这三条会话无图像块）。

## R5（本轮修复：R4 的 2 important + 4 nit —— 待独立审查）

**改动**：`handoff/threshold.ts`（`editedMessages`/`messageTokens`：按 pi 投影就地改写 `context_edit` 目标、compaction 只计最新；
区间规则边界注释与残余⑤措辞；rate 过滤去掉不可达的上半）、`tests/harness.mjs`（`contextEditEntry`）、`tests/handoff-test.mjs`
（4c 算术订正、4d 残余⑤形状、4e context_edit、`absurd` 改钉 band 下半）、`CHANGELOG.md`、`docs/architecture.md`、design §9③/§10/§11。

**逐条处置**：

- **R4-I-2 修**：镜像 pi 投影（`context_edit` 就地改写、compaction index>0 记 0）⇒ 审查员夹具现读 **17,767**（真值 17,766；旧读 5,268）。
  新契约 `a context edit shrinks the prefix the record was billed for`；变异「忽略 context_edit」红 1。
- **R4-I-1 部分修 + 登记**：审查员夹具（更大前任 prompt + 重放 + 陈旧本地记录）由新契约 4d 钉为残余⑤形状
  （`samples === 2`、`baseline < 17,766`），且 design §10 里「真实交接里前任记录就在前面 ⇒ 会被捕获」这句错误表述删除；
  「prompt 缩小时不检查」在代码、CHANGELOG、design 三处写成**有意**的 fail-open 取舍（理由：丢掉本地记录会把 baseline 钉死在前任 131k 上）。
- **N-1 修**：删除不可达的 `rate > RATE_MAX`（证明：接受样本已过区间规则 ⇒ `rate ≤ RATE_MAX`），`absurd` 夹具改钉下半
  （4 条样本全在、无 pair 可校准）⇒ `!calibrated` 不再是 `rate === 4` 的同义反复。
- **N-2 修**：4c 注释算术改为 `4,000 + 4 + 50,000 = 54,004`、`ceil(/8) = 6,751`、`18,766 − 6,751 = 12,015`。
- **N-3 修**：design §9 残余③ 改为「直到出现更小 bound 的记录之前（活树 record 0–3 读 131,433、record 4 起 52,151）」。
- **N-4 修**：`docs/architecture.md` 的 `threshold.ts` 摘要同步「chars 只计文本、按 pi 投影含 context_edit」。

**验收**：`node tests/run-all.mjs` ⇒ All 15 tests passed（末节 30 条 `check(`）。
变异矩阵（9 条，每个只改一处、跑后 MD5 恢复校验）：system 重新计入 **3**、上界退回 rate 缩放 **8**、`min`→`max` **9**、
去掉自身密度下界判定 **1**、后缀**把未校准的 4.0 印成测得 rate** **1**、图像字符重新计入 **1**、去掉区间一致性规则 **1**、
忽略 `context_edit` **1**、去掉 rate 带下半 **3**（后缀那条的精确补丁很重要：按「永远印 fallback」红 2、按「删掉整段 `receipt at`」红 3）。
现场三条会话读数不变：probe **17,763**（真值 17,753）、ctl **11,018**（真值 11,008）、活树 `01a13385` **52,151**
（35 样本、rate 3.22、前缀 `131,433×4 → 52,151` 非增、system 清零差 0）。活树那 8 条 `context_edit` 的**目标 content 全为空**
（`replacement: null` 的 omit），所以对 `chars` 零影响；它们的 `split` 效应在 R4→R5 之间没有变化，两版现场读数才逐位相同 ——
把这 8 条从文件里删掉会少 8 个 `split` 豁免点，活树读数会变成 **161,788 / 2 样本**（第 5 轮审查员实测），所以「无影响」只对 `chars` 成立。

## R6（本轮修复：R5 的 1 important + 5 nit —— 待独立审查）

**改动**：`handoff/threshold.ts`（`seen` 保存 `raw`，每条 edit 从原始消息重算；注释）、`tests/handoff-test.mjs`（新契约 4f、4d 注释改口径）、
`CHANGELOG.md`、`docs/architecture.md`（无）、design §10/§11、本报告。

**逐条处置**：

- **R5-I-1 修**：同一目标多次编辑按 pi 的 last-wins 语义重算（`editedMessages(target.raw, …)`）⇒ 审查员的「null 删除 → 恢复」夹具
  现与 `buildSessionProjection` 一致（其忠实值 28,875/2,251 那一类）；新契约 `the last edit of a target wins, applied to the raw messages`
  钉 `baseline === 19,500`、`estimated === 1,001`（链式变异读 20,000 / 1）✓，变异 M10 红 1。
- **NIT 2 修**：design §11 的 compaction 可达性说法改写 —— 旧 compaction 可因新 compaction 的 `firstKeptEntryId` 落在它之后而保留在
  index>0（审查员夹具 `[c_new, m1, c_old, m2, a1]` ⇒ c_old 在 index 2，我们的镜像正确）；原「线性分支只会返回最新那条」删除。
- **NIT 3 修**：`CHANGELOG` 里被推翻的「那正是 `min` 本就会跳过的情形 / 只有在它前面还有可参照样本时才被捕获」措辞删除，
  改为**有意**的 fail-open 取舍 + 指向残余⑤。
- **NIT 4 修**：4d 注释与 design §10/§11 改为「**文件级**形状」（pi 的写者只向 leaf 追加 ⇒ 路径祖先不可能晚于记录计费，
  该时序现场不可复现；真实可达的低读只有 `SPLIT_TURN_MARKER` 注入这类量级更小的情形）。
- **NIT 5 修**：R5 的「8 条 `context_edit` 无影响」补成「对 `chars` 无影响；`split` 效应 R4→R5 未变，故两版读数逐位相同」，
  并记下删掉它们会让活树读 **161,788 / 2 样本**。
- **NIT 6 修**：变异矩阵恢复精确补丁定义（后缀：measured-rate 1 / always-fallback 2 / 删整段 3）。

**验收**：`node tests/run-all.mjs` ⇒ All 15 tests passed（末节 **31** 条 `check(`）。
变异矩阵（10 条，每个只改一处、跑后 MD5 恢复校验）：system 重新计入 **3**、上界退回 rate 缩放 **9**、`min`→`max` **9**、
去掉自身密度下界判定 **1**、后缀把未校准的 4.0 印成测得 rate **1**、图像字符重新计入 **1**、去掉区间一致性 **1**、
忽略 `context_edit` **1**、去掉 rate 带下半 **3**、编辑链式应用 **1**。
现场三条会话读数不变：probe **17,763**、ctl **11,018**、活树 `01a13385` **52,151**（35 样本、前缀 `131,433×4 → 52,151` 非增、system 清零差 0）。
