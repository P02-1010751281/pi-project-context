# 证据：baseline 残差与估计器偏差（2026-10-09）

## 方法

pi 的会话 JSONL 每条 assistant 消息带 provider 回报的 usage（`input`/`cacheRead`/`cacheWrite`）。
对**相邻两次** usage 记录取增量：

```text
Δprompt = Δ(input + cacheRead + cacheWrite)      # 这一段请求多出来的 prompt token（provider 口径）
Δchars  = Δ(消息内容的 JSON 字符数)                # 同一段里新增的消息文本/工具结果字符数
ratio   = Δchars / Δprompt                        # 实测 chars per token
```

增量把非会话部分（system prompt、工具 schema、注入的 memory/context）**抵消掉**，所以 ratio 是会话内容的真实比率。
含 `context_edit` 的窗口**必须剔除**：注入块变了但没有新增消息字符，ratio 会掉到 0.0x（见下表 dirty 列，
它同时也是「注入块确实在 prompt 里」的旁证）。

复现：`python3 probe-chars-per-token.py <session-dir> [n]`（本目录）。字符数用 `json.dumps(content)` 长度近似
pi 的计数方式（文本字符 + 工具 JSON），相差在个位数百分比内，不影响量级结论。

## 原始输出（本仓最近三份会话，2026-10-09 运行）

```text
session                                      clean c/t dirty c/t   prompt    est/4   B_rep  B_true   est%
2026-10-09T06-17-56-756Z_01a11f4f-a914-766        3.12      0.03   160146   101082   59064   30665    63%
2026-10-09T00-48-37-688Z_01a11e22-2938-766        2.21       nan   181256   109993   71263  -18195    61%
2026-10-08T12-30-22-066Z_01a11b7e-4372-766        2.92      0.02   338728   234875  103853   16678    69%

clean c/t = median chars per token on windows without context_edit (pi assumes 4)
B_rep = prompt - chars/4 (what baselineTokens reports) · B_true = prompt - chars/clean_c/t
```

窗口数：52（含 `context_edit` 2）、79（0）、143（含 3）。第一份是仍在写入的会话，重跑时末次记录会前移，
所以它的数字每次略有不同；结论不依赖单次取值。

## 换算到 owner 的那条状态行

`floor = 179k = baseline_reported + keep 20k + MIN_DROP 8k` ⇒ `baseline_reported = 151k`。
`baseline_reported = prompt − chars/4` 且 `prompt = 317k` ⇒ `chars/4 ≈ 166k` ⇒ 分支字符 ≈ **664k**。
用上表比率换算分支真实 token：`664k / 3.12 ≈ 213k` 到 `664k / 2.21 ≈ 300k` ⇒
`baseline_true = 317k − (213k…300k) ≈ 17k…104k` ⇒ `floor_true = baseline_true + 28k ≈ 45k…132k`。
`knee(1M) = 157k` ⇒ **floor_true < knee ⇒ 本该触发**；当前构建因为 reported baseline 而拒绝。

## 误差棒（必须一起读）

- Δ 窗口量的是**增量脚本构成**（工具输出偏 ASCII），套到整支分支上是近似；因此可以被主张的是
  「`4 chars/token` 在本仓这类会话上不成立，且偏差足以把下限推过拐点」，而不是某个精确的 baseline_true。
- 00-48-37 那份换算得到**负的** baseline（−18k），物理上不可能 ⇒ 方法的误差棒与 baseline_true 同量级。
  该会话的 ratio 最低（2.21），说明它的分支以 CJK/短串为主，估计偏低最严重。
- `est%`（估计占 prompt 的比例）在 61–69% ⇒ **三分之二的 prompt 由估计器描述**，provider 口径只覆盖剩下的部分；
  这就是为什么残差能大到盖过真实 baseline。
- 用 `chars` 而不是 pi 精确的字符计数方式会带来个位数百分比的差异，不足以改变上面的判定（第一个会话的
  clean c/t 在两次运行间从 3.00 变到 3.12，也是同一量级的抖动）。

## 与本仓既有记录的关系

- `audits/2026-10-05-context-cost-and-progressive-disclosure.md` 与 issue `2026-09-19-handoff-adaptive-threshold-semantics`
  讨论的是**下限的语义与文案**（拒绝门不是抬升）；它们把 baseline 当已知量，没有涉及它的来源。
  本文件新增的是：baseline 是两条不同来源相减的**残差**，估计器偏差整体落在它上面。
- `tests/handoff-test.mjs` 用合成 context 钉住 `baselineTokens` 的**公式**（含下限包含性边界）——公式本身没错；
  错的是喂进去的估计，所以这类缺陷单测抓不到，只能靠会话级现场事实（本文件的方法）。
