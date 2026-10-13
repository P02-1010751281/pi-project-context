# 实验与归因：baseline 残差（2026-10-09）

复现：`python3 probe-chars-per-token.py <session-dir> [n]`（增量比率）+ `python3 probe-baseline-attribution.py <session-dir> [n]`
（漂移与真实水位）。两份都只读 pi 的会话 JSONL，不需要 provider 调用。

## 结论

| 归因要素 | 状态 | 证据 |
| --- | --- | --- |
| 机制（公式与来源） | **完成**（代码级） | `calculateContextTokens` / `estimateTokens` / `trailingTokens` 的组成见下 |
| 报告的 baseline 被估计器污染 | **完成**（现场直接测量） | 稳定段内 B_reported 漂移 +8.9k…+69.7k（真实 B 在该段必然恒定） |
| 真实 chars/token | **完成** | 窗口级 r：p10 2.2–2.8 / p50 3.0–3.5 / p90 3.7–3.8（估计器假设 4） |
| 真实 baseline 水位 | **完成**（两条独立方法相符） | 尾段干净段截距 ≈ 30–39k；按本仓提示组成独立估算 ≈ 37–38k |
| owner 那条线的量化闭环 | **完成** | 151k 反解 r≈2.35，落在实测低端（CJK 重）⇒ floor_true≈63k < knee 157k |
| 修复设计 | **未开工** | 候选方向见 brief.md |

## 机制（pi 侧代码级）

`dist/core/compaction/compaction.js`：`calculateContextTokens(u) = u.totalTokens || input+output+cacheRead+cacheWrite`；
`estimateContextTokens(messages)`：`usageTokens` 取最后一条 assistant usage（**含该次 output**），
`trailingTokens = Σ estimateTokens(其后消息)`，返回 `tokens = usageTokens + trailingTokens`；
`estimateTokens(message) = ceil(chars/4)`。于是扩展的

```text
B_rep(k) = pi.tokens - Σ estimateTokens(分支消息)
         = [prompt_k - chars_before_k/4] + [output_k - reply_chars_k/4]
```

尾部的估计项相消，**只有前缀与最后一条回复的估计误差留下来**（`output_k - reply_chars/4` 是后加的精确项，
此前只说了前缀部分，此处修正）。

## 实验 A：报告的 baseline 在稳定段内漂移（判据性实验）

判据：一个段内只要没有 `context_edit` / `model_change` / `thinking_level_change` / `session` / `compaction` 条目、
且提示不回退，非会话内容就不变 ⇒ **B_rep 必须恒定**。实测（同段内可比窗口，1.5≤r≤8）：

```text
session                         win  r_p10  r_p50  r_p90  drift_sum
2026-10-13T02-00-13-742Z_01a     20   2.78   3.49   3.77       8857
2026-10-09T06-17-56-756Z_01a     52   2.26   3.08   3.70      28171
2026-10-09T00-48-37-688Z_01a     77   2.22   2.99   3.66      38182
2026-10-08T12-30-22-066Z_01a    140   2.26   3.12   3.77      69705
2026-10-08T10-55-10-922Z_01a    131   2.56   3.32   3.81      51383
```

`drift_sum` 是这些窗口里 B_reported 的累计变化。五份会话全部非零，且量级随会话增长 ⇒
**报告的 baseline 里有一半以上不是 baseline，而是估计器误差的累积**。单段最干净的取样也带着漂移
（例如末段 15 点、R²≥0.99、B_true≈36.3k 的段，段内仍漂 +2.4k）。

## 实验 B：真实 chars/token

同一批窗口（增量里 system/工具/注入块相消）给出 r = Δ字符/Δprompt：中位 3.0–3.5，低端 2.2–2.8，高端 3.7–3.8。
估计器假设 4 ⇒ **低估 20–45%**，而估计覆盖 prompt 的 61–69% ⇒ 残差量级与 baseline 同阶。
含 `context_edit` 的窗口 r 掉到 0.0x（注入块变了而消息字符没变），故必须剔除 —— 这也是注入块确实在 prompt 里的旁证。

## 实验 C：真实 baseline 水位

对每个段做直线拟合（截距 = B_true，斜率 = 1/r），取 ≥5 点、R²≥0.99、r∈[1.5,8] 的段：

```text
tail（可用）:  15pt B=36304 r=3.51 | 13pt B=37607 r=3.38 | 63pt B=29570 r=2.89
              11pt B=36816 r=3.08 | 42pt B=38599 r=3.24 | 57pt B=39143 r=3.16
早段（伪影）:  7pt B=142819 | 17pt B=152330 | 21pt B=285428 | 32pt B=113325
其它伪影:      14pt B=5150 | 1pt 段若干（负值）
```

**可用的六段收敛在 29.6k–39.1k**。两条伪影各自有明确成因，别拿它们当数据：

- **早段截距来自被重放的上一会话记录**（同日修正，先前的「携带大块的异质速率」说法作废）：交接把前任的
  保留片段**连同其 usage 记录**重放进新会话文件，而那条 usage 的 `prompt` 覆盖的是**前任的整支分支**，
  字符轴却只有保留片段 ⇒ 这些点构不成一条可解释的直线（142k/152k/285k/113k 全是这类）。
  **排除规则**：丢掉 handoff 提示消息（`handoff/language.ts` 的 `HANDOFF_PROMPT_*` 判据可识别）之前的
  全部 usage 记录，只用新会话自己的记录。按此规则本会话 33 条自有记录、7 条重放记录分得开，
  下面列出的六个尾段都落在自有记录里。
- **裁剪之后的段被字符基准偏移压低**：本探针的字符累计是文件级单调的，一旦某段之前发生过 `context_edit` 裁剪，
  被裁掉消息的字符仍留在累计里 ⇒ 截距被系统性压低（5,150 与若干负值）。**选择规则**：优先取
  该会话内没有任何 `context_edit` 之前的段（例如 `00-48-37` 那份 0 次编辑、63 点、B=29,570 是最干净的一次）。

独立交叉核对：按本仓系统提示的组成（工具 schema + 技能描述 + 注入的 memory/context 块 + base）估 ≈37–38k
⇒ 与实验 C 的尾段带相符。

## owner 那条线的闭环

`floor = 179k = B_rep + keep 20k + MIN_DROP 8k` ⇒ `B_rep = 151k`。用实测 `B_true ≈ 35k` 与
`B_rep = B_true + chars×(1/r − 1/4)`、`chars ≈ 664k`（由 `B_rep = prompt − chars/4`、`prompt = 317k` 反解）
反解 `r ≈ 2.35`，落在实测窗口比率的低端（p10 2.22–2.26）⇒ 与该会话以中文为主一致。
`floor_true = 35k + 20k + 8k = 63k < knee(1M)=157k` ⇒ **本该触发**；当前构建因为被污染的 B_rep 而拒绝。
固定模式共用同一条下限 ⇒ 同样受影响。

## 另一条候选机制：交接后紧接着的一次读数（新发现，未定）

上面量的是「整段估计偏低」这条**持续**偏差。检查交接产物时发现还有一条**瞬时**机制可能单独把读数顶高：
交接后、本会话自己的第一次请求之前，pi 的「最后一条 usage」是**重放记录**，其 `prompt` 覆盖前任整支分支，
而 `Σ estimateTokens(branch)` 只覆盖此刻分支里真实存在的保留片段 + 交接提示 ⇒
`B_ext = 大的前任 prompt − 小的保留片段估计` 会远大于真值（可能数十万），足以把 floor 顶过拐点、
让一次自动交接在交接刚结束就自我拒绝。

与主机制的区别是可测的：主机制随分支增长（持续、单调）；这条只在「重放记录仍是最后一条 usage」的窗口里出现，
本会话自己的第一次请求一落地就消失。**判别探针**：交接后立刻跑一次 `/handoff status`、再过一回合跑一次，
若 B 从数十万掉到几十千，就是这条；若两次都稳定在同一个大值，则是主机制（估计偏低）。
owner 那条 317k/151k 的线用自己的算术吻合主机制（见上节），所以**不主张**它来自本条；本条按未定记录，
修复设计需要同时覆盖两条（若它真的可达）。

## 局限与未定

- 扫描全部会话时必须先剔重放段：`hits` 里那些 `B_rep` 300k–670k 的候选就是重放记录（prompt 覆盖前任分支、
  字符轴只有保留片段）产生的伪影，不是任何真实读数。
- `r` 随内容构成在 2.2–3.8 间变化，所以上面对 owner 那条线的复算是量级闭环，不是精确复现：
  要精确复原必须拿到那条状态行所属会话的 JSONL（我手上的文件里没有 prompt=317k 且 B_rep=151k 的那一刻）。
- `B_true ≈ 30–39k` 是**本项目 + 本模型 + 本工具/技能集**的值；换路由、换模型、增删技能都会变，不可外推。
- 未做 provider 现场探针（一次最小请求即可直接量出 B_true，与实验 C 对照）。没做的原因：无头 pi 在本仓运行
  会在 settle 触发本扩展的渲染，可能改写 curated 记忆文件 —— 有副作用，需要独立的隔离方案（见
  `pi-project-context-headless-runs` 的沙箱说明）再动。
- 本探针的字符计数用 `json.dumps(content)` 长度近似 pi 的计数方式，差在个位数百分比，不改变量级。

## 与既有记录的关系

- `audits/2026-10-06-handoff-and-cache-field-run.md`（真机 RPC 现场跑：固定模式两种拒绝、真交接 + A 锚定、缓存两项 + 一个反直觉结果）
  是本 issue 之前唯一一份 handoff 现场实验记录，它把 baseline 当下限里的既有量；本文件补的正是那个量的来源与偏差。
- `audits/2026-10-05-context-cost-and-progressive-disclosure.md` 与 issue `2026-09-19-handoff-adaptive-threshold-semantics`
  处理下限的语义与文案（拒绝门不是抬升），同样未触及 baseline 的来源。
- `tests/handoff-test.mjs` 用合成 context 钉住 `baselineTokens` 的**公式**（含下限包含性边界）：公式没错，
  喂进去的估计有偏，所以单测抓不到 —— 只能靠本文件的会话级现场事实。
