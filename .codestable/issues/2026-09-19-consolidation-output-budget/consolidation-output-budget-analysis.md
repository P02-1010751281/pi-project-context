---
doc_type: issue-analysis
issue: 2026-09-19-consolidation-output-budget
status: confirmed
root_cause_type: token-budget
created_at: 2026-09-19
related: [consolidation-output-budget-report.md, consolidation-output-budget-repro.txt]
tags: [memory, consolidation, output-budget, reasoning, truncation, diagnostics]
---

# 根因分析：输出预算漏算 reasoning token + 忽略 finish reason

## 1. 结论

主根因有两个，都在**输出预算与 finish reason 的处理**，不在模型「偶发不听话」，也不在重试次数：

1. **`fitMemoryInput` 只按要复述的正文（memory + context + 1024 JSON 余量）算 `max_tokens`，没有给 reasoning 模型的隐藏思考留量。**
   这些模型把思考 token 计入 `output`（pi-ai `Usage.reasoning` 文档明确「subset of output」），于是思考吃掉一部分上限后，JSON 在字符串中途被截断。
2. **`completeText` 丢弃了响应的 `stopReason`/`errorMessage`。**
   - `stopReason: "length"`（被上限截断）与「模型返回了畸形 JSON」被混成同一句 `not a usable JSON object`；
   - `stopReason: "error"`（provider 报错、content 为空）会被 `extractText` 变成空字符串，再被 `parseConsolidated("")` 当成「纯 Markdown 记忆」，既不失败也不写日志，只可能留下一条误导性的 `carried no context section`。

v0.1.8 的重试之所以救不了：它沿用同一个 `maxTokens` 重发同样的请求，截断原因不变，第二次大概率再撞上限（真实 UniField 失败正是重试后仍失败）；偶然成功只是第二次思考量变少。

## 2. 证据

### 2.1 真实失败记录（errors.log）

`UniField` 06:44:33Z（v0.1.8，重试后仍失败）：

```
Error: consolidation reply was not a usable JSON object
--- raw reply ---
{
"memory_markdown": "# Project Memory\n\n## 项目定位与架构\n\nUniField 是频域..."
[...reply omitted after 4000 of 14008 chars...]
    at .../consolidate.ts:686:13   ← v0.1.8 的最终 throw（重试后）
```

`~/.pi` 06:02/06:11/06:23（v0.1.7，无重试），栈顶 `consolidate.ts:627`。三条回复分别 12954 / 4738 / 7779 字符。

### 2.2 复现（同一 memory、同一模型、真实会话 fork）

用 UniField 的真实 memory（17.9k 字符）与真实 session 重放到只读沙箱，模型 `commandcode/inclusionai/ling-3.0-flash-sante:free`：

修复前（HEAD 代码）：

```
reply 1: maxTokens=13198 output=13198 reasoning=4133 stopReason=length → PARSE FAIL（尾部 "- 支持 `--check" 截断）
reply 2: maxTokens=13427 output=13427 reasoning=2111 stopReason=length → PARSE FAIL
```

其中 `output == maxTokens` 正好等于请求上限，`reasoning` 是 `output` 的子集——截断点就是 cap。

修复后（本 issue 改动）：

```
reply 1: maxTokens=17459 output=13693 reasoning=2419 stopReason=stop → 正常写出 MEMORY.md / CONTEXT.md，无 errors.log
```

`17459 ≈ 13198 + reasoning 预留（约 4.2k）`，第一次调用即完整返回，不再依赖重试。

### 2.3 provider 报错被吞（复现）

同一沙箱环境把 commandcode 打到 `400 insufficient credits`、deepseek 打到 `402 Insufficient Balance` 时：

- `completeText` 返回空字符串 → `parseConsolidated("")` 走「纯 Markdown」分支 → 返回 `{ memory: "" }`；
- 最终报告 `unchanged`，`errors.log` 只留下 `the consolidation reply carried no context section`，**真实余额/额度错误完全不可见**。

## 3. 触发条件与放大因素

- reasoning 模型（`reasoning: true`）：`deepseek/deepseek-flash`、`commandcode/deepseek/deepseek-v4.1-flash`、`inclusionai/ling-3.0-flash-sante` 的元数据均为 true。
- 正文较大：UniField memory 17.9k 字符（CJK 混合，`needed≈13198`）；`~/.pi` memory 12.9k 字符（ASCII 多，`needed≈6857 < 8192`，上限停在 configured 8192，reasoning 2–3k 就能挤爆）。
- 模型输出会**膨胀**：成功样本里 17.9k 字符的输入被重写成 19–20k 字符的 JSON 文本，1024 的余量不够覆盖。
- 对话越长越容易触发（回复包含更多当次 context），这就是「偶发」的来源。

## 4. 为什么既有防线没拦住

- `REPLY_OUTPUT_MARGIN_TOKENS = 1024` 只够 JSON 键名与括号，不足以覆盖 reasoning。
- `adaptiveOutputTokens` 以模型 `maxTokens`（本机元数据 384000）为上限，使得「请求更多」始终可行；上限本身不是瓶颈。
- `parseConsolidated` 的恢复路径只处理「字符串未闭合」等形态；被截断的 JSON 无法恢复。
- 重试不改变预算，因此对截断型失败无效。
