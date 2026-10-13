# handoff 物理下限里的 baseline 是残差，不是测量：估计器偏差把 auto 交接整条关掉

**状态（2026-10-13）**：**已修复并经 8 轮独立审查通过**（第 8 轮冻结 `b9addeb`：VERDICT PASSED，0 blocking / 0 important / 3 nit；
3 条 nit 是证据文字，已作为 post-PASS 跟进落地，未改任何可执行行与断言）。实现分 6 轮：C+A（`3abd207`）、图像块 + 区间一致性（`acbf228`）、
按 pi 投影算 `chars`（`270b1b4`）、last-wins 编辑（`12c0f72`）、镜像 `convertToLlm` 的 `!!` 排除（`c31e40c`）、`!!` 首条仍需 marker（`b9addeb`）。
残余 ①②③④⑤⑥ 与两条已登记口径差异见 `design.md` §9–§13 与 `review-report.md` 的 R8 收尾。
2026-10-09 的原始归因结论（未改代码阶段）如下。
现场事实 + 初步量化在 `baseline-estimator-evidence.md`（增量比率法），
完整实验与归因在 `baseline-attribution-experiment.md`（漂移判据、真实比率、真实水位、owner 那条线的闭环）。
可复现探针：`probe-chars-per-token.py`、`probe-baseline-attribution.py`。是否修、怎么修要单独设计与审查（见「候选方向」）。

**归因结论（摘要）**：`chars/4` 的估计器在本仓会话上低估 20–45%（窗口级 r 中位 3.0–3.5，低端 2.2）；
因此报告的 baseline 在稳定段内会漂移（实测 +8.9k…+69.7k，而该段真实 B 必然恒定），
真实水位实测 ≈ **30–39k**（六段收敛，另有独立组成估算 ≈37–38k 佐证）；owner 那条线的 151k 反解出 r≈2.35，
落在实测低端 ⇒ `floor_true ≈ 63k < knee 157k` ⇒ 本该触发。

## 现场事实（owner 的 `/handoff status`，1M 窗口）

```text
Handoff ON · threshold auto (the model's quality knee of 157k is below the 179k floor a worthwhile handoff
needs at this window, so the handoff is skipped rather than run past the knee; a smaller baseline or keep
is the lever) · drop budget 64.0k · ~20.0k recent carried · mode send · guard wait · lang auto (en) ·
context 317k/1000k (32%)
```

反推：`floor = baseline + keep(20k) + MIN_DROP_TOKENS(8k) = 179k` ⇒ 扩展报出的 **baseline ≈ 151k**。
`knee(1M) = 157k < 179k` ⇒ 自适应阈值解析为 `undefined`（`threshold.ts` 的 `below-quality-knee` 拒绝分支）。

算术后果：要触发需 `baseline + keep ≤ 149k`。在 baseline≈151k 下**任何 keep 都救不回来**（keep=0 时还差 2k），
所以那句「a smaller baseline or keep is the lever」实际只有一个杆能用，而那个杆按下面证据**大半是估计器产物**。

## 机制：baseline 是差出来的，不是量出来的

- `extensions/project-context/handoff/threshold.ts` 的 `baselineTokens()`：
  `max(0, usage.tokens − Σ estimateTokens(branch messages))` —— 两项**来源不同**：前者是 provider 回报，后者是估计。
- pi 的 `getContextUsage().tokens` = `usageTokens`（最后一次请求的 provider 回报）`+ trailingTokens`（其后消息的 estimate），
  见装好的 dist `core/compaction/compaction.js` / `core/compaction/compaction.d.ts`（本机 release `1.1.0`）。
- pi 的 `estimateTokens` = **`ceil(chars / 4)`**（同一文件，system/user/assistant/tool 各分支都走这个常数）。
  装好的 dist 是唯一权威，本仓不复制它。

于是：`baseline_reported = baseline_true + (真实 token − 估计 token)`，覆盖 usage 那一段的全部消息。
**估计器的任何偏差都会原封不动落到 baseline 上**：CJK 重的分支被低估多少，baseline 就被抬高多少。

## 量化（本仓三份 CJK 重的会话，见证据文件）

在**没有 `context_edit`** 的相邻请求窗口里，用 `Δprompt` 对 `Δ字符` 求比率（增量里 system/工具/注入块相互抵消）：
实测 **chars/token ≈ 2.2–3.1**，而估计器假设 **4** ⇒ 估计偏低 22–45%。落到末次请求上：

| 会话 | clean c/t | prompt | chars/4 估计 | baseline_reported | baseline_true |
| --- | ---: | ---: | ---: | ---: | ---: |
| 06-17-56 | 3.12 | 160,146 | 101,082 | **59,064** | **30,665** |
| 00-48-37 | 2.21 | 181,256 | 109,993 | **71,263** | **−18,195** |
| 12-30-22 | 2.92 | 338,728 | 234,875 | **103,853** | **16,678** |

把这些比率套到 owner 那条线上（prompt 317k、baseline_reported 151k ⇒ 分支估计 166k token ⇒ 分支字符≈664k）：
`baseline_true` 落在 **约 17k–96k**，`floor` 就在 **约 45k–124k ≤ knee 157k** ⇒ **本该触发**。当前构建不触发。
其中一个会话的换算给出**负的** baseline（物理上不可能）——**同日已修正**：负值来自「用增量中位比率套整支分支」
（增量比整段平均更密，扣多了），改用段级回归后同一会话给出 `B_true = 29,570`、`r = 2.89`，不再是负值；
水位以 `baseline-attribution-experiment.md` 为准，本文件的增量比率只用于定「偏差存在且量级足够」。

## 为什么这不是「配错旋钮」

同一个估计器偏差同时抬高**两种模式**的下限（固定模式走同一条 `baselineTokens` 下限），并且让「缩小 baseline」这条建议
指向一个大部分不存在的量。用户可见的句子承诺了代码做不到的事 —— 正是本仓审查里反复抓到的那一类。
另有一条与 pi 的关系（不属本仓）：pi 自身压缩用的 `trailingTokens` 也用同一个 `chars/4` 估计器。

## 已闭合：真 baseline 的直接测量（2026-10-13，`probe-true-baseline.md`）

隔离探针（沙箱 cwd + 只加载被测扩展 + core 路由）由 provider 直接回报了真值：

- 本仓激活状态下首条请求 **17,766 tokens**，其中 **6,745** 是注入块、**11,021** 是 system + 核心工具 + 技能
  （去掉注入文件即得）；消息 chars≈0 时 `B_ext` 与 `B_true` **相等** ⇒ 估计误差随 chars 增长，不是常量偏移。
- 活树会话回归截距 30–39k 比 17.8k 多出的 12–21k 是本机**其他扩展**的工具/schema 贡献（真人会话的真实开销）。
- 对注入块的估计（chars/4）反而**高估约 3.1k**（39.3k 字符 ⇒ 6,745 token，≈5.8 字符/token）⇒ 高估只来自消息部分。

## 候选方向（未定，需设计与审查）

1. **标量校准**：用相邻 usage 记录推出本会话的 chars→token 因子（`Δprompt/Δchar`，剔除含 `context_edit` 的窗口），
   `baseline = prompt − 分支字符 × 因子`。不引入第二套 tokenizer，只用 provider 回报当基准。
2. **估计路径按脚本加权**：CJK 字符与 ASCII 分别计权（仍是启发式，不换 tokenizer）。注意 `estimateTokens` 是 pi 的，
   本仓只能绕它做补偿，不能改它。
3. **诚实降级**：当**仅凭 reported baseline** 就把下限顶到拐点之上时，不要断言「baseline 是杆」——点名这是测量不可用，
   或退回固定比例模式的判定，宁可说「测不出来」也不给一条假的行动建议。
4. **可见性**：`/handoff status` 显示 baseline 及其来源（残差 vs 校准），让这条拒绝可自证。

**反目标**：不引入第二套 tokenizer；不为它搭缓存层（见 `audits/2026-10-06-handoff-and-cache-field-run.md`）；
不改 pi 的估计器；不在没有新设计的情况下顺手改阈值公式。

## 验证（按成本排序）

1. **零成本原地探针**：同一会话里隔一段再跑 `/handoff status`。非会话内容不变 ⇒ **baseline 应当基本不动**；
   若它随分支增长，本 issue 成立（也是最便宜的确认）。
2. **跨脚本对照**：ASCII 为主（英文/代码）与 CJK 为主的两趟会话，在相近分支大小下比 baseline。
3. **脚本复现**：`probe-chars-per-token.py <session-dir> [n]`，输出 clean/dirty 窗口比率与 B_reported/B_true。
4. **修好之后的钉法**：把「从 usage 增量推导校准因子」做成纯函数单测（**不要**去钉 pi 的估计器）。

**什么能证伪本 issue**：若 baseline 在分支增长时保持恒定，且 ASCII/CJK 会话在相近分支下报出同一个 baseline，
那么它就是真实非会话开销，这条拒绝成立，杆确实只有 baseline/keep —— 那时该查的是技能描述与工具 schema 的水位。
**现状（2026-10-13）**：第一支已被漂移数据否掉（`B_rep` 在稳定段内漂移 +8.9k…+69.7k，累计 +58k…+128k），
而探针同时确认非会话开销**确实存在**（17.8k 隔离 / 30–39k 带本机其他扩展）⇒ 设计必须**分开处理**这两部分，
只调一个标量会把真实开销也抹掉。
