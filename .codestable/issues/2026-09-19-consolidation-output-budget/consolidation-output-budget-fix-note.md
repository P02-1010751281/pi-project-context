---
doc_type: issue-fix
issue: 2026-09-19-consolidation-output-budget
status: confirmed
path: standard
fix_date: 2026-09-19
related: [consolidation-output-budget-analysis.md]
tags: [memory, consolidation, output-budget, reasoning, truncation, diagnostics]
---

# 修复记录：reasoning 预留 + finish reason 处理 + 截断重试

## 1. 改动

### `extensions/project-context/llm.ts`

- 新增 `CompleteWithMeta`（`completeWithMeta`）：返回 `{ text, stopReason, errorMessage, reasoningTokens }`。
  - `stopReason === "error" | "aborted"` 时抛出 `model call <reason>: <errorMessage>`，不再返回空字符串；
  - `usage.reasoning` 作为 `reasoningTokens` 暴露（它是 `output` 的子集）。
- `completeText` 保留原签名，内部走 `completeWithMeta`（autolearn 等调用方自动获得 provider 错误抛掷语义）。

### `extensions/project-context/consolidate.ts`

- 新增 `reasoningReserveTokens(contentTokens, model)`：`reasoning: true` 时按正文 token 的
  `35%` 预留，范围 `[1024, 8192]`；非 reasoning 模型为 0。
- `fitMemoryInput` 新增：`reasoningReserve`、可选 `extraHeadroomTokens`，`reserve` 取
  `min(scaffold + reasoning + headroom, maxTokens − MIN_CLIP_CHARS, max(1024, floor(maxTokens/2)))`。
  非 reasoning 且未被 cap 时的预算与旧实现逐值一致（既有矩阵断言不改）。
- `consolidateProjectState`：
  - 新增 `call(input, promptOverride?)` 统一调用与失败退避；
  - 解析失败时若 `stopReason === "length"`：按 `+4096` token 重新 fit（模型/配置上限封住时只发送更少正文），
    重试提示改为「被输出上限截断，请压缩」；
  - 两次都截断时抛出 `consolidation reply was cut off by the model output limit (N tokens requested)…`；
  - 其他解析失败仍走原有一次重试与 fail-closed 文案；
  - `clipped` 以**最后一次实际发送**的输入为准（截断重试可能发送更少内容）。

### `extensions/project-context/autolearn.ts`

- 技能输出预算同样加上 `reasoningReserveTokens(MAX_SKILL_BODY_CHARS, auxModel)`。

## 2. 测试

`tests/consolidation-test.mjs` 新增：

- 截断重试：第一次 `stopReason: length` + 截断 JSON，第二次成功 → 断言仅 2 次调用、第二次 `maxTokens` 更大、
  重试 prompt 含 `cut off by the output limit` / `condense`、memory 正常写入、无失败日志。
- 持续截断：两次都 `length` → 断言 2 次调用、errors.log 点名 `cut off by the model output limit`、MEMORY.md 原样。
- provider 错误：`stopReason: error` + `errorMessage: "402: Insufficient Balance"` → 断言不解析、不重试（1 次调用）、
  MEMORY.md 原样、errors.log 含 provider 原文、**不**出现误导性的 `carried no context section`。
- reasoning 预留：`reasoning: true` 的 `maxTokens` 大于非 reasoning；正文完整不裁剪；模型上限封住时正文地板仍在；
  reserve 边界 `[1024, 8192]`；非 reasoning 为 0。
- 完整到达上限：`stopReason: "length"` 但 JSON 完整 → 直接接受、不重试。
- 非终态响应：`pending`/`deferred`/`toolUse` + 空文本 → 失败且不重试，errors.log 含 `model call <reason> without text`。
- 预算矩阵扩到 `reasoning: false|true` 两轮（5 档 cap × 8 种密度 × 2 = 80 组），期望 reserve 由常量独立计算（不调用被测 helper）。
- `a truncated retry can clip more than the first attempt`：首轮未裁剪、重试裁剪时 `clipped` 跟随实际发送。

## 3. 验证

- `node tests/run-all.mjs`：**9/9 通过**（consolidation 断言数增加）。
- 真实场景复验（同一 memory、同一模型、真实 session fork，只读沙箱）：
  - 修复前：`maxTokens=13198 / output=13198 / reasoning=4133 / stopReason=length / PARSE FAIL`；
  - 修复后：`maxTokens=17459 / output=13693 / reasoning=2419 / stopReason=stop`，MEMORY.md、CONTEXT.md 正常写出，无 errors.log。
- 独立复审（lane A，3 轮，见 `consolidation-output-budget-review.md`）：
  - round 1 无 blocking；I-1/I-2/I-3 处置；
  - round 2 新增 I-4（非终态空文本）与 I-2 文案，同轮修复；
  - round 3 无 blocking/important/minor，I-4/I-2 关闭；
  - 变异矩阵：reserve 恒 0 → 10 红；去 length 分支 → 2 红；忽略 retry prompt → 1 红；provider error 不抛 → 2 红。
- 证据：`consolidation-output-budget-repro.txt`。

## 4. 残余与后续

- 若模型在 reasoning 后仍写出超过 `maxOutputTokens` 的内容，第二次重试会 fail closed 并点名输出上限：这是可见的失败，
  不会写坏 memory；彻底解决需要 provider 原生 structured output 或拆成 memory/context 独立调用（本轮不做）。
- reasoning 预留按 `model.reasoning` 元数据判断，元数据缺失的模型仍按非 reasoning 处理（保守不裁剪正文），
  其截断由重试路径兜底。

## 5. 发布（v0.1.9）

- 修复 commit：`0af9ec6`；annotated tag `v0.1.9`（tag 对象 `87eaf39`）指向该 commit。
- `master` 与 tag 已双推 Forgejo + GitHub mirror。
- 安装 pin：`~/.pi/agent/settings.json` 与 `~/.pi/README.md` 更新为 `@v0.1.9`，pi-config commit `da0f869` 已推送。
- `pi update --extensions` 后安装副本 HEAD = `0af9ec6`（与 tag 一致，工作树干净），已含 `reasoningReserveTokens`。
- settings 加载的真机探针：`/tmp/pi-project-context-v019-probe-voVpBB`，模型 `openai-codex/gpt-5.6-luna`（reasoning: true），
  `memory-learn` / `auto-handoff` 命令可用；`/memory-learn` 写出 `MEMORY.md`（5447 bytes）、`CONTEXT.md`（885 bytes）、
  `memory.jsonl`（40861 bytes）与两份 backup，**无 errors.log**（即未发生裁剪、未发生截断）。
  注：该模型自行把 29.5KB 的 CJK 记忆压缩到 5.4KB，属模型编辑选择而非 clipped（否则会有 “shortened” 日志）。
