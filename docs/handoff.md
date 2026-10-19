# handoff 预算与恢复

## 触发模型

handoff 有两种阈值模式：

- **自适应**（`handoffThresholdAuto=true`，默认，`/handoff threshold auto`）：auto = 模型的**质量拐点**
  （按保守拟合曲线 `knee(W)`：≤~400K 诚实窗口取自身边界，450K 起过渡，1M 级收敛到 157K，
  与窗口末点取小），**两项**：`min(knee(W), U − 4000)`；caps 只降不升。`handoffBudgetSummaryTokens`
  **不在触发线上**——它是手动设定的请求量，护栏决定触发点；被护栏压掉时 `/handoff status`
  点名它，不静默（见下）。
- **固定**（`handoffThresholdAuto=false`，`/handoff threshold 0.6`）：使用配置比例乘窗口，保留 4000-token 的 pi 安全边界；不套用自适应的计价档位 cap。

手动 `/handoff now` 不等待阈值；自动触发只在宿主允许的 TUI 模式中运行。

pi 的 `_checkCompaction` 在 post-run 循环里先于 `agent_settled` 运行，所以单轮涨幅跨过两条线时 pi 会先压缩，handoff 只能看到压缩后的分支。
现在 `session_before_compact` 在 handoff 已到阈值时取消这次自动 `threshold` / 无重试的 `overflow` compaction，让 settle 触发器在未压缩的分支上交接；
手动 `/compact` 不拦（用户显式选择）。带 `willRetry` 的 overflow recovery 仍交给 pi 先压缩并重试，避免把可恢复回合变成死回合；
handoff 失败会进入 failure backoff，下一次自动 compaction 照常进行；`nothing older ...` 的 skip 和被其他扩展取消的
handoff 也会进入冷却，不会每轮重复取消。

## 自适应预算公式

符号：

- `W`：当前模型 context window。
- `U`：可用于交接的窗口，预留 16384 token。
- `B`：system、工具 schema、注入 memory/context 等非 conversation token。
- `K`：`handoffBudgetRecentTokens`，最近内容原文保留预算。
- `S`：`handoffBudgetSummaryTokens`，用户手动设定的**触发请求量**（配置钳制 ≥ 8000）。它**不进入触发公式**：
  护栏决定触发点；`B + K + S` 高于护栏时，状态行点名这个请求没有被完整采纳。
  v0.4.1 起没有任何摘要调用读它，名字保留是因为它与 dsh 的配置面共享（改名/删旋钮需要单独决定）。
- `r`：`handoffThresholdRatio`，仅固定模式使用。

```text
U = W - 16384
B = max(0, usage.tokens - estimateTokens(current branch))
F = B + K + 8000
KNEE = round(W - (W - 157000) * sigmoid(ln(W / 450000) / 0.04))
T0 = min(KNEE, U - 4000)
```

如果 `U <= F`，不触发。否则依次应用上界：

```text
T1 = min(T0, firstTierEdge - 4000)  # 仅当该 tier 有意义时（tierEdge - 4000 >= F）
threshold = T1 >= F ? T1 : undefined
```

`F` 是**拒绝门，不是抬升**：`T1 < F` 时不触发，而不是把触发点抬到 `F`——抬高正是
`max(T0, B + K + S)` 会做的事，也正是质量护栏存在的理由所要禁止的（那会让声明 1M 的模型跑到
157K 拐点之外）。

其中 `8000` 是最小可丢弃前缀（`MIN_DROP_TOKENS`），`4000` 是 `TIER_EDGE_MARGIN`。
这些值是 token 预算，不是字符数；不同模型 tokenizer 会使 prefix 预算成为保守近似。

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
E-4000
\right),\qquad
\text{trigger iff } T\ge F
\]

`E` 是首个计价档位边界；没有有效档位时省略该项。

## 公式的实际含义

- auto 是**质量拐点**，来自对 MRCR 8-needle 数据的**保守拟合**：`knee(W) = W − (W − 157K)·σ(ln(W/450K)/0.04)`（σ 为 logistic）。≤~400K 的诚实窗口基本取自身边界（272K → 252K、
  400K → 380K），450K 起开始过渡，1M 级收敛到 157K 平台（600K → 157K、768K → 157K、2M/10M → 157K）。
- 参数依据：`K=157K` 是实测拐点的人群中位数（46 个 ≥1M 模型：p25 127K / p50 157K / p75 190K）；`Wc=450K` 因为目前所有 500K+ 的声明实测都偏大——grok-4.5/4.6 声明 500K、
  家族实测 ~195K，DeepSeek-V4.1-Flash / GLM-5.3 / Qwen3.8 声明 1M、实测 130–170K（DeepSeek 官方 V4 报告 Figure 9：128K 0.92 → 256K 0.82 → 1M 0.59；
  linux.do 自测 V4.1-Flash：64–128K 79.2 → 128–256K 40.2）。**偏保守是刻意的**：GPT-5.6（~250K）、Gemini 3.7（~450K）、GPT-6（≥512K）
  会比自己拐点更早触发。
- 历史：v0.1.10 之前拟合过 `K=273K, Wc=650K`（锚 GPT-5.6 / OpenAI 首档），会让 500K/1M 声明跑到拐点外 2–3 倍（grok 480K、DeepSeek/GLM/Qwen 273K），已替换。
- 物理下限 `B + K + 8000` 是**拒绝门**：`T` 低于它就不触发（而不是被抬到它）。`B` 是测出来的：对分支上每条 usage 记录取
  `prompt − chars/8`（`chars` 是该记录之前的**文本**字符数：system 消息与图像块都不计 —— pi 已为 system 算过 sections 与工具 schema，
  而它对每张图固定计 4,800 字符，那是对 provider 成本的估计、不是文本，小图会把上界推到真值之下），再取这些**上界**的最小值。
  取值由最空的那条记录定下、不随分支增长；它相对的是**设定它的那条记录时刻**的真值：增长可按「新增文本 ≤2 token/字符」判定时
  （`prompt_r − prompt_p > 2 × (chars_r − chars_p) + allowance`）就从该记录重锚（该假设比 band 本身（≤1 token/字符）宽松，
  故是启发式而非证明），更小的增量则读低其量（残余②）。`allowance` 是 provider 计费而分支文本没有承载的内容：上一条回复的
  `max(0, output − estimate(message))`（未落盘的隐藏推理）加上一条记录以来图像块按 pi 自身预算折算的 token（每张 1,200）。
  没有它，中转站推理路由和截图重的会话会逐轮重锚，每次重锚把整段文本的高读重新计入，baseline 一路抬到拐点或窗口之上、
  自动交接静默关闭（v0.4.11）。预算内的小图因此不再重锚，其真实成本也不进 baseline —— floor 低读该成本（fail-open，按图有界）；
  超出预算的图仍重锚，整张图的成本（连同重新计入的文本高读）进 baseline（fail-closed）。**最新 compaction 之前计费的记录不作样本**
  —— 镜像 pi 的 `assistantIsFromBeforeCompaction`，`firstKeptEntryId` 保留的那条 prompt 属压缩前分支、`chars` 属压缩后投影（残余⑥），
  代价是刚 compaction、尚无新记录的窗口退回无样本公式，
  代价是最空记录自身字符数带来的高读。区间一致性：一条记录只有在 prompt 的增长（且 prompt 未缩小）覆盖得住自己的文本增长时才算样本
  （`chars_r − chars_p ≤ (prompt_r − prompt_p) × 8`，即 `prompt_r − prompt_p ≥ (chars_r − chars_p)/8`），否则它的字符包含它的 prompt
  从未持有过的内容（重放插入、分支被编辑）⇒ 丢弃而不是夹取。`S` 只是手动请求量，
  不参与这条线；当 `B + K + S` 高于护栏（质量拐点或窗口末点）时，`/handoff status` 会显示
  `handoff budget summary 64k is not applied in full: …` 并点名压住它的那条护栏与可用的杆杆。计价档位
  （`cost.tiers`，如 272K → 268K）能再压低；档位边界低于 `floor + 4000` 时返回
  undefined（不静默跨档）。
- `handoffThresholdRatio` 只服务固定模式（`/handoff threshold 0.6`），且受同一条物理下限约束；`/handoff threshold auto` 不接受比例参数。
  固定比例模式**走同一条物理下限**（v0.4.3 起）：比例给出的阈值低于 `baseline + keep + MIN_DROP` 时**自动触发**会
  被拒绝（手动 `/handoff now` 不查阈值，见上），因为一次只丢几千 token 的交接只是换会话、省不下上下文。这条下限是
  **拒绝门**，不会把比例抬到下限；固定模式下阈值仍完全由比例与窗口决定（`handoffThresholdRatio` 只在这里生效）。
- `/handoff status` 在能解析阈值时显示 **guardrail 之后的预计丢弃量**（`tokens − baseline − keep`；`auto 157k (16%) · drop 125k`，
  Codex 272K 窗口 → `auto 252k (93%)`）；没有可用 usage 时回退为配置值（`drop budget 64.0k`）。
  实际切点只会更短：若整段窗口装在一轮里，handoff 会跳过并提示 `nothing older than the recent window to drop`。
- 如果最终 cap 压低了阈值，状态行会显示 `capped by the first pricing tier`；窗口末点是 auto 的两个项之一，不再作为「事后 cap」出现。
- 如果门槛拒绝，状态行点名真正的原因：`window too small`、`pricing tier`、
  `the model's quality knee of … is below the … floor`、或窗口最后 4000 token 留下的量不足——
  不再统一渲染成「窗口没空间」。固定比例模式同样点名：`fixed 10% (the …-token threshold is below the …-token
  floor …)`，或比例在该窗口取不到正值时的 `fixed 50% (this ratio resolves to no positive threshold …)`。
- tokenizer 差异和完整 reserve 预留会让结果偏保守；本项目不引入第二套 tokenizer 或分块摘要。

## 交接内容与 replay

交接**不调用任何模型**（v0.4.1 起）：successor 收到的是机械载荷，没有任何生成物。successor 接收：

1. 最近 `handoffBudgetRecentTokens` 范围内的可重放原文（被切回合的起始 user 消息也锚定在内）；
   若设置了 `handoffBudgetToolResultTokens`（默认 0 = off），每个被携带 toolResult 的文本超过该 token 上限时，
   文本块替换为 `[tool result trimmed during handoff: N characters; full output in the previous session log]`，
   `toolCallId` 和非文本块（如图片）保留，完整输出仍在旧会话日志里；cap 省的是 carried 正文，不保证总成本下降：
   successor 若需要该正文，必须回读文件或 session log，回读可能比原来直接携带更贵；
2. 旧会话里出现过的文件清单（`<read-files>` / `<modified-files>`，含扩展工具的嵌套调用）；
3. 上一会话加载过的技能与模式：从用户 `/skill:` 加载的技能块（含 standalone `.md`）、`read` 过 `SKILL.md` 的工具调用（含工具结果上记录的嵌套 `read`）、compaction 的 `readFiles`、以及上一份交接提示的
   `<read-files>` 收集（去重；`/skill:` 最优先，其次真实 `read`，两者内部按最近出现排序；提示/压缩的文件清单最后，
   按块内倒序只填剩余名额；最多 8 个），每个条目带技能名与文件路径（目录形式为 `SKILL.md`，单独文件为其 `.md`），并附一条「若某个设定了持续生效的模式，先重新读取它的技能文件并继续遵循」的指令（v0.4.11）。这样即使技能说明随被丢弃的前缀一起离开上下文，
   像 grilling 这样的模式在常见的一次交接里也不会消失（8 个上限与 successor 内部的 compaction 仍可能丢，
   见 `.codestable/issues/2026-10-18-handoff-active-skills/fix-note.md`）；
4. `HANDOFF.md` 与续接提示里的旧 session log 指针，以及一条「缺的细节必须先查该日志、不确定不得凭印象作答」的强指令；
5. 一条收尾指令：successor 先用一两句话复述上一轮用户的要求、当前进度，以及仍在生效的技能或模式，再从上次中断处继续（v0.4.11）；
   若该技能的说明已被丢弃，先重新读取它的技能文件。旧版以「从上次中断处继续 / Continue the task from where it left off」结尾的
   prompt 仍被识别，重放时照旧替换为 omission marker。

较早的部分不再以摘要散文进入 successor，而是留在旧会话日志里按需取回：日志是原文，不会像摘要那样二次压缩。

为保证不同 provider 都能接受 replay block：

- 旧 handoff continuation prompt 替换为 `[handoff prompt omitted]`，不会把上一代交接提示当作新指令重复执行。
- keep cut 若落在一个 turn 中，开头插入 `[turn prefix dropped during handoff]`，保证 user-first 形状。
- 没有对应 assistant tool call 的 orphan `toolResult` 不重放，也不会进入任何载荷；它的内容只留在旧会话日志里。
- keep budget 是上限，不会为了填满预算回补更旧 prompt；空预算场景是设计上的静默 no-op。
- toolResult 的文本 cap 是**可选的第二层上限**，默认 off；它只裁文本块，不改变 call/result 配对，也不删除图片或 `nestedCalls`。
  裁掉的正文不再进入 successor，完整内容通过旧 session log 恢复；因此开启后 continuation 会说明「过大的工具输出已裁剪」。

## 前缀缓存

handoff 换 session，successor 的首个请求必然失去 predecessor 的 conversation prefix：`cacheRead` 只能命中最前面的
静态块（system、工具 schema、注入的 memory/context），旧对话前缀不会跨 session 命中。因此一次 handoff 的固定损失是
**一次 conversation-prefix miss**，不是 system 块的丢失；successor 的总 token 仍可能更低。保持静态块在交接时逐字节
稳定是唯一能保住的部分，尤其不要在 handoff 同刻改 memory render。

把旧开头（`keepHead`）放回 replay 前面能把首轮 `cacheRead` 抬到 predecessor 的某个 turn 边界，但 successor 的
total 随之变大，且只对后续轮次有折扣收益；当前实现没有这个 head，也不把它作为默认。机制测量、对照与边界见
`.codestable/audits/2026-10-18-handoff-prefix-cache-field-run.md`。

## 语言

`handoffLang`：

- `en`：英文 scaffold 与 continuation。
- `zh`：中文 scaffold 与 continuation。
- `auto`：从最近用户消息判断中/英；续接文档（scaffolding）也使用该语言。

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

暂存文件**每个项目只有一个**，所以两个同时在飞的 handoff 会互相覆盖对方的暂存。因此一个指向**别的前驱**的暂存不会当场被删（2 分钟内它可能正是另一次 handoff 的 successor 要用的），只有超过该宽限期才当成「staging 与 switch 之间崩溃」的残留清掉；
被跳过的那次恢复会写 `errors.log` 并提示用户模型/thinking 没有恢复。

- provider/model 可用：调用 `pi.setModel()` 恢复，并恢复 thinking level。
- model 不可用或 `setModel` 失败：通知用户；可记录的异常写 `errors.log`；successor 沿用默认模型。
- `ctx.model` 缺失：不可能可靠推断 provider/model，只恢复 thinking，并写明确诊断；不伪造 fallback ID。
- 暂存 TTL 为 10 分钟；过期、损坏或 predecessor 不匹配会清理并沿用默认设置。

## 状态与验证

```text
/handoff status
/handoff threshold auto
/handoff budget summary 64k
/handoff budget recent 20k
/handoff budget toolresult 2k
/handoff lang auto|zh|en
/handoff now
```

验证阈值边界：

```bash
node tests/run-all.mjs
```

真实交接验证必须检查 successor session JSONL 中的 `model_change`、`.agents/memory/HANDOFF.md`、`memory.jsonl` 的 `replace`、memory backup、
`CONTEXT.md` 和 `errors.log`；详见 `docs/README.md` 与 headless RPC skill。
