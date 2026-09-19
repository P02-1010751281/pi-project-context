---
doc_type: issue-report
issue: 2026-09-19-consolidation-output-budget
status: confirmed
path: quick
created_at: 2026-09-19
related: [consolidation-output-budget-analysis.md]
tags: [memory, consolidation, output-budget, reasoning, truncation, diagnostics]
---

# consolidation 偶发 "not a usable JSON object" 问题报告

触发：owner 追问 v0.1.8 的 warning `Project memory update failed: consolidation reply was not a usable JSON object`
「不是重试的问题吧？根因是什么？」；随后确认修复。

## 现象

- UI 偶发（并非每次）出现 `Project memory update failed: consolidation reply was not a usable JSON object`。
- `errors.log` 里有 `Error: consolidation reply was not a usable JSON object`，其后跟着最多 4000 字符的原始回复头。
- 同一台机器上的真实失败样本：
  - `/run/media/.../Projects/UniField/.agents/memory/errors.log` 2026-09-19T06:44:33.659Z（v0.1.8，重试路径 consolidate.ts:686）。
  - `/home/user/.pi/.agents/memory/errors.log` 06:02:19 / 06:11:47 / 06:23:48（v0.1.7，consolidate.ts:627）。
- v0.1.8 已加入「解析失败重试一次」，owner 质疑重试不是根因——这是对的。

## 范围

- 影响的 pass：consolidation 的模型调用（`completeText`）；autolearn 使用同一套预算与调用。
- 影响的项目：任何 memory 体量接近输出预算、且使用 reasoning 模型（或产出比输入更长）的项目。
- 不受影响：手工 `/memory-learn` 以外的行为、journal 折叠、写锁、外部编辑采纳逻辑。
