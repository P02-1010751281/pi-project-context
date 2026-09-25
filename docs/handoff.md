# handoff 预算与恢复

## 触发模型

handoff 有两种阈值模式：

- **自适应**（`handoffAdaptive=true`，默认，`/auto-handoff auto`）：auto = 模型的**质量拐点**
  （按保守拟合曲线 `knee(W)`：≤~400K 诚实窗口取自身边界，450K 起过渡，1M 级收敛到 157K，
  与窗口末点取小），**两项**：`min(knee(W), U − 4000)`；caps 只降不升。`handoffTargetTokens`
  **不在触发线上**——它是手动设定的请求量，护栏决定触发点；被护栏压掉时 `/auto-handoff status`
  点名它，不静默（见下）。
- **固定**（`handoffAdaptive=false`，`/auto-handoff 0.6`）：使用配置比例乘窗口，保留 4000-token 的 pi 安全边界；不套用自适应的摘要模型 cap。

手动 `/auto-handoff now` 不等待阈值；自动触发只在宿主允许的 TUI 模式中运行。

## 自适应预算公式

符号：

- `W`：当前模型 context window。
- `U`：可用于交接的窗口，预留 16384 token。
- `B`：system、工具 schema、注入 memory/context 等非 conversation token。
- `K`：`handoffKeepTokens`，最近内容原文保留预算。
- `S`：`handoffTargetTokens`，用户手动设定的**目标摘要量**（配置钳制 ≥ 8000）。它**不进入触发公式**：
  护栏决定触发点；`B + K + S` 高于护栏时，状态行点名这个请求没有被完整采纳。
- `r`：`handoffThresholdRatio`，仅固定模式使用。
- `A`：摘要模型的 context window。

```text
U = W - 16384
B = max(0, usage.tokens - estimateTokens(current branch))
F = B + K + 8000
KNEE = round(W - (W - 157000) * sigmoid(ln(W / 450000) / 0.04))
T0 = min(KNEE, U - 4000)
```

如果 `U <= F`，不触发。否则依次应用上界：

```text
T1 = min(T0, B + K + max(8000, A - 32768))
T2 = min(T1, firstTierEdge - 4000)  # 仅当该 tier 有意义时（tierEdge - 4000 >= F）
threshold = T2 >= F ? T2 : undefined
```

`F` 是**拒绝门，不是抬升**：`T2 < F` 时不触发，而不是把触发点抬到 `F`——抬高正是
`max(T0, B + K + S)` 会做的事，也正是质量护栏存在的理由所要禁止的（那会让声明 1M 的模型跑到
157K 拐点之外）。

其中 `32768` 是 `SUMMARY_OUTPUT_RESERVE_TOKENS`，`8000` 是最小可摘要前缀，`4000` 是 `TIER_EDGE_MARGIN`。这些值是 token 预算，不是字符数；不同模型 tokenizer 会使 prefix 预算成为保守近似。

等价的 LaTeX 表达（GitHub 等支持 MathJax 的 Markdown 渲染器会渲染；不支持数学扩展的渲染器以文档前面的纯文本公式为准）：

\[
U = W - 16384,\qquad
F = B + K + 8000
\]

\[
\text{knee}(W) = W - (W-157000)\,\sigma\!\left(\frac{\ln(W/450000)}{0.04}\right),\qquad
T_0 = \min\!\left(U - 4000,\ \operatorname{round}(\text{knee}(W))\right)
\]

\[
T = \min\left(
T_0,
B+K+\max(8000,A-32768),
E-4000
\right),\qquad
\text{trigger iff } T\ge F
\]

`E` 是首个计价档位边界；没有有效档位时省略该项。若摘要模型没有显式配置，`A=W`。

## 公式的实际含义

- auto 是**质量拐点**，来自对 MRCR 8-needle 数据的**保守拟合**：`knee(W) = W − (W − 157K)·σ(ln(W/450K)/0.04)`（σ 为 logistic）。≤~400K 的诚实窗口基本取自身边界（272K → 252K、400K → 380K），450K 起开始过渡，1M 级收敛到 157K 平台（600K → 157K、768K → 157K、2M/10M → 157K）。
- 参数依据：`K=157K` 是实测拐点的人群中位数（46 个 ≥1M 模型：p25 127K / p50 157K / p75 190K）；`Wc=450K` 因为目前所有 500K+ 的声明实测都偏大——grok-4.5/4.6 声明 500K、家族实测 ~195K，DeepSeek-V4.1-Flash / GLM-5.3 / Qwen3.8 声明 1M、实测 130–170K（DeepSeek 官方 V4 报告 Figure 9：128K 0.92 → 256K 0.82 → 1M 0.59；linux.do 自测 V4.1-Flash：64–128K 79.2 → 128–256K 40.2）。**偏保守是刻意的**：GPT-5.6（~250K）、Gemini 3.7（~450K）、GPT-6（≥512K）会比自己拐点更早触发。
- 历史：v0.1.10 之前拟合过 `K=273K, Wc=650K`（锚 GPT-5.6 / OpenAI 首档），会让 500K/1M 声明跑到拐点外 2–3 倍（grok 480K、DeepSeek/GLM/Qwen 273K），已替换。
- 物理下限 `B + K + 8000` 是**拒绝门**：`T` 低于它就不触发（而不是被抬到它）。`S` 只是手动请求量，
  不参与这条线；当 `B + K + S` 高于护栏（质量拐点或窗口末点）时，`/auto-handoff status` 会显示
  `handoff target 64k is not applied in full: …` 并点名压住它的那条护栏与可用的杆杆。计价档位
  （`cost.tiers`，如 272K → 268K）与摘要模型窗口只能再压低；档位边界低于 `floor + 4000` 时返回
  undefined（不静默跨档）。
- `handoffThresholdRatio` 只服务固定模式（`/auto-handoff 0.6`）；`/auto-handoff auto` 不接受比例参数。
- 辅助摘要模型可以比会话模型小；此时摘要输入 cap 可以把阈值压低到 auto 目标以下，这是安全约束。
- `/auto-handoff status` 在能解析阈值时显示 **guardrail 之后的预计摘要输入量**（`tokens − baseline − keep`；`auto 157k (16%) · summarize 125k`，Codex 272K 窗口 → `auto 252k (93%)`）；没有可用 usage 时回退为配置值（`target 64.0k`）。实际切点只会更短：若整段窗口装在一轮里，handoff 会跳过并提示 `nothing older than the recent window to summarize`。
- 如果最终 cap 压低了阈值，状态行会显示 `capped by the summarizer window` 或
  `capped by the first pricing tier`；窗口末点是 auto 的两个项之一，不再作为「事后 cap」出现。
- 如果门槛拒绝，状态行点名真正的原因：`window too small`、`pricing tier`、
  `the model's quality knee of … is below the … floor`、或窗口最后 4000 token 留下的量不足——
  不再统一渲染成「窗口没空间」。
- tokenizer 差异和完整 reserve 预留会让结果偏保守；本项目不引入第二套 tokenizer 或分块摘要。

## 交接内容与 replay

successor 接收：

1. 旧会话较早部分的模型摘要；
2. 最近 `handoffKeepTokens` 范围内的可重放原文；
3. `HANDOFF.md` 中的摘要和旧 session log 指针。

为保证不同 provider 都能接受 replay block：

- 旧 handoff continuation prompt 替换为 `[handoff prompt omitted]`，不会把上一代交接提示当作新指令重复执行。
- keep cut 若落在一个 turn 中，开头插入 `[turn prefix summarized during handoff]`，保证 user-first 形状。
- 没有对应 assistant tool call 的 orphan `toolResult` 不重放，而是并入摘要输入。
- keep budget 是上限，不会为了填满预算回补更旧 prompt；空预算场景是设计上的静默 no-op。

## 语言

`handoffLanguage`：

- `en`：英文 scaffold 与 continuation。
- `zh`：中文 scaffold 与 continuation。
- `auto`：从最近用户消息判断中/英；摘要正文也使用该语言。

## successor 模型与 thinking 恢复

交接前在 `.agents/memory/handoff-session-settings.json` 暂存：

```json
{
  "previousSessionFile": "...",
  "model": { "provider": "...", "id": "..." },
  "thinkingLevel": "...",
  "at": 0
}
```

successor `session_start` 只接受 `reason=new` 且 `previousSessionFile` 精确匹配的暂存，成功后立即消费删除。这样普通 `/new`、resume、fork 不会误吃设置。

暂存文件**每个项目只有一个**，所以两个同时在飞的 handoff 会互相覆盖对方的暂存。因此一个指向**别的前驱**的暂存不会当场被删（2 分钟内它可能正是另一次 handoff 的 successor 要用的），只有超过该宽限期才当成「staging 与 switch 之间崩溃」的残留清掉；被跳过的那次恢复会写 `errors.log` 并提示用户模型/thinking 没有恢复。

- provider/model 可用：调用 `pi.setModel()` 恢复，并恢复 thinking level。
- model 不可用或 `setModel` 失败：通知用户；可记录的异常写 `errors.log`；successor 沿用默认模型。
- `ctx.model` 缺失：不可能可靠推断 provider/model，只恢复 thinking，并写明确诊断；不伪造 fallback ID。
- 暂存 TTL 为 10 分钟；过期、损坏或 predecessor 不匹配会清理并沿用默认设置。

## 状态与验证

```text
/auto-handoff status
/auto-handoff auto
/auto-handoff target 64k
/auto-handoff keep 20k
/auto-handoff lang auto|zh|en
/auto-handoff now
```

验证阈值边界：

```bash
node tests/run-all.mjs
```

真实交接验证必须检查 successor session JSONL 中的 `model_change`、`.agents/memory/HANDOFF.md`、`memory.jsonl` 的 `replace`、memory backup、`CONTEXT.md` 和 `errors.log`；详见 `docs/README.md` 与 headless RPC skill。
