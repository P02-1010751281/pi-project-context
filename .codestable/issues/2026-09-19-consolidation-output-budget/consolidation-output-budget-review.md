---
doc_type: issue-review
issue: 2026-09-19-consolidation-output-budget
status: confirmed
path: quick
created_at: 2026-09-19
rounds: 3
related: [consolidation-output-budget-report.md, consolidation-output-budget-fix-note.md, consolidation-output-budget-review-round1-independent.txt, consolidation-output-budget-review-round2-independent.txt, consolidation-output-budget-review-round3-independent.txt]
tags: [memory, consolidation, output-budget, reasoning, truncation, diagnostics]
---

# consolidation 输出预算修复 Review

## 审查方式

- lane A 独立 `pi` 进程，只读沙箱副本（rsync 自工作树，含 `.git` 与未提交改动；`.agents/memory/session-logs`、`skill-candidates` 除外）：
  - round 1：`/tmp/pc-output-budget-review`，`commandcode/inclusionai/ling-3.0-flash-sante:free`；
  - round 2：`/tmp/pc-output-budget-review2`（free 配额当日用尽，改用 `openai-codex/gpt-5.6-luna`）；
  - round 3：`/tmp/pc-output-budget-review3`，同 round 2 模型；
  - 统一 `--no-session -ne -ns -np --tools read,bash --thinking off`，round 2/3 显式 `-e` 加载 custom-providers（否则 `-ne` 下 provider 未注册）。
- 零写入校验：复审期间仓库工作树未被修改；复审自行构造的探针均在 `/tmp`。
- 转录：`consolidation-output-budget-review-round{1,2,3}-independent.txt`；prompt 入库（round1 在 issue 目录，round2/3 为 `-review-round{2,3}-prompt.txt`）。

## 轮次记录

| 轮次 | 结论 | 发现 | 处置 |
|---|---|---|---|
| 1 | **无 blocking** | important ×3：I-1 `clipped` 改末次口径可能漏报；I-2 capped 模型重试预算不变；I-3 reasoning 预算矩阵缺失。minor ×5：M-1 类型断言、M-2 autolearn 字符当 token、M-3 空 errorMessage、M-4 契约变更未声明、M-5 完整 JSON + `length` 无测试 | I-1 用 168 组网格证明「首轮 clipped 且重试未 clipped」不可达，且新口径覆盖反向 6 例（旧口径漏报），加探针；I-2 改文档；I-3 矩阵改由常量独立计算并扩到 2 模式（5 cap × 8 密度 × 2 = 80 组）；M-5 加测试；M-1/M-4 加模块契约注释；M-2/M-3 接受 |
| 2 | **无 blocking** | important ×1：I-4 非终态 stop reason（`pending`/`deferred`/`toolUse`）+ 空文本被当成合法空 memory；I-2 文案「重试预算不变」不准确 | I-4 修：`completeWithMeta` 对三者 + 空文本抛 `model call <reason> without text`，加测试；I-2 文案改为「请求上限可能不变，重试可能保持或减少正文预算」 |
| 3 | **无 blocking / important / minor** | I-4、I-2 均关闭；无新 finding | — |

## 变异矩阵（作者侧复跑，详见各轮转录）

| 变异 | 转红断言 |
|---|---|
| `reasoningReserveTokens` 恒 0 | 10 条（reasoning 专项 + 预算矩阵越界项 + retry clip 方向题） |
| `truncated` 恒 `false`（去掉 length 分支） | 2 条 |
| 忽略 retry prompt override | 1 条 |
| provider error 不抛 | 2 条 |
| 非终态 + 空文本不抛 | 2 条（round 2 复核） |

round 2 复核确认：I-1 关闭（`usedInput.clipped` 跟随实际发送 prompt）、I-3 关闭（期望公式独立于被测 helper，80 组不变式全过）、M-1/M-4/M-5 关闭。

## 关于「空文本清空 MEMORY.md」的核验

round 2 的 I-4 表述为「可能覆盖现有记忆」。实际写入路径还有 `memoryText.length >= 40` 门槛（`consolidate.ts`），空文本不会写盘；
但 I-4 指出的语义问题成立：非终态响应被当成「无事发生」会掩盖失败，故按修复处理。round 3 复核确认 `stop` + 空文本仍保持旧语义（报告 unchanged、不写盘）。
