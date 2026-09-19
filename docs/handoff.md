# handoff 预算与恢复

## 触发模型

handoff 有两种阈值模式：

- **自适应**（`handoffAdaptive=true`，默认）：窗口比例是下限，实际值还会考虑 baseline、保留量、摘要模型容量、计价档位和窗口余量。
- **固定**（`handoffAdaptive=false`）：使用配置比例乘窗口，保留 4000-token 的 pi 安全边界；不套用自适应的摘要模型 cap。

手动 `/auto-handoff now` 不等待阈值；自动触发只在宿主允许的 TUI 模式中运行。

## 自适应预算公式

符号：

- `W`：当前模型 context window。
- `U`：可用于交接的窗口，预留 16384 token。
- `B`：system、工具 schema、注入 memory/context 等非 conversation token。
- `K`：`handoffKeepTokens`，最近内容原文保留预算。
- `S`：`handoffTargetTokens`，旧前缀摘要目标。
- `r`：`handoffThresholdRatio`。
- `A`：摘要模型的 context window。

```text
U = W - 16384
B = max(0, usage.tokens - estimateTokens(current branch))
F = B + K + 8000
R = U - B - K
O = max(8000, min(S, floor(R / 2)))
share = round(r * W)
T0 = max(B + K + O, share)
```

如果 `U <= F`，不触发。否则依次应用上界：

```text
T1 = min(T0, B + K + max(8000, A - 32768))
T2 = min(T1, firstTierEdge - 4000)  # 仅当该 tier 有意义时
T3 = min(T2, U - 4000)
threshold = T3 >= F ? T3 : undefined
```

其中 `32768` 是 `SUMMARY_OUTPUT_RESERVE_TOKENS`，`8000` 是最小可摘要前缀，`4000` 是 `TIER_EDGE_MARGIN`。这些值是 token 预算，不是字符数；不同模型 tokenizer 会使 prefix 预算成为保守近似。

等价的 LaTeX 表达（GitHub 等支持 MathJax 的 Markdown 渲染器会渲染；不支持数学扩展的渲染器以文档前面的纯文本公式为准）：

\[
U = W - 16384,\qquad
F = B + K + 8000
\]

\[
O = \max\left(8000,\min\left(S,\left\lfloor\frac{U-B-K}{2}\right\rfloor\right)\right)
\]

\[
T_0 = \max\left(B+K+O,\operatorname{round}(rW)\right)
\]

\[
T = \min\left(
T_0,
B+K+\max(8000,A-32768),
E-4000,
U-4000
\right),\qquad
\text{trigger iff } T\ge F
\]

`E` 是首个计价档位边界；没有有效档位时省略该项。若摘要模型没有显式配置，`A=W`。

## 公式的实际含义

- 默认 `r=0.4` 的 1M 窗口，baseline 较小时通常在约 400k（40%）触发。
- `handoffTargetTokens` 不是大窗口的主旋钮；只有 baseline 足够重，或窗口较小，才会把 `T0` 推高。
- 辅助摘要模型可以比会话模型小；此时摘要输入 cap 可以把阈值压到 40% 以下，这是安全约束，不是 ratio 失效。
- 如果最终 cap 压低了阈值，`/auto-handoff status` 会显示：
  - `capped by the summarizer window`
  - `capped by the first pricing tier`
  - `capped by the usable window`
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

- provider/model 可用：调用 `pi.setModel()` 恢复，并恢复 thinking level。
- model 不可用或 `setModel` 失败：通知用户；可记录的异常写 `errors.log`；successor 沿用默认模型。
- `ctx.model` 缺失：不可能可靠推断 provider/model，只恢复 thinking，并写明确诊断；不伪造 fallback ID。
- 暂存 TTL 为 10 分钟；过期、损坏或 predecessor 不匹配会清理并沿用默认设置。

## 状态与验证

```text
/auto-handoff status
/auto-handoff auto 0.4
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
