---
doc_type: issue-report
issue: 2026-09-17-handoff-session-continuity
status: open
path: quick
created_at: 2026-09-17
related: [handoff-session-continuity-analysis.md]
tags: [handoff, session, settings, ui]
---

# handoff 后会话设置丢失与会话树过深 问题报告

owner 现场反馈（2026-09-17）：handoff 到新会话后，(1) 模型/思考等级退回默认值，而不是延续上一会话的设置；
(2) pi 的会话树层级异常地深。

## 现象与数据

### 1. 设置未延续（实证）

本仓会话链全部是 `think=max`（即进程/配置默认），看不出差异；**UniField 的链上直接可见**：

| 会话 | 创建时间 (UTC) | parent | entries | 最后 model | 最后 thinking |
|---|---|---|---|---|---|
| `01a0ae58` | 09-17T07:50 | 01a0ae3e | 238 | deepseek/deepseek-flash | high |
| `01a0aeb1` | 09-17T09:27 | 01a0ae58 | 220 | deepseek/deepseek-flash | **high** |
| `01a0aed0` | 09-17T10:02 | 01a0aeb1 | 161 | deepseek/deepseek-flash | **max** ← 退回默认 |

即：`think=high` 的会话经 handoff 后，新会话变回 `max`（`PI_REASONING_LEVEL=max`）。模型同理：只要上一会话用的是非默认模型，
新会话会回到 `defaultProvider`/`defaultModel`，除非回放里的 assistant 消息恰好再次带上它（那也只在**恢复**该会话文件时才生效，
当前活会话不会据此改写）。

### 2. 会话树过深

`dist/modes/interactive/components/session-selector.js:164` 明确按 `parentSessionPath` 构造会话树；
而每次 handoff 都以 `parentSession = ctx.sessionManager.getSessionFile()` 新建会话（`handoff.ts` 的 `newSession` 调用），
于是**每次 handoff 都给树加一层**：

- 本仓链：`01a0887 → 01a0895 → 01a08a7 → 01a08ab → 01a0a953 → 01a0a998 → 01a0aa0b → …`
- UniField 链：`01a0aa0f → 01a0aaa8 → 01a0ad53 → 01a0ae3e → 01a0ae58 → 01a0aeb1 → 01a0aed0 → …`（一天内 7 层）

（`/tree` 的**会话内**树不受影响：当前会话 entries=127、单根、maxDepth=127、无分叉，是正常线性链。）

## 影响

- 长流程（自动 handoff 频繁触发）后，用户必须重新 `/model`、重新选思考等级；设置越"非默认"越明显。
- 会话选择器里同一工作流被套成 N 层，越用越深、越难找。

## 复现

- 设置：在任一会话 `/model` 换非默认模型或调 think 等级 → 触发 `/auto-handoff now` → 新会话 `pi` 状态回默认。
- 树深：连续 handoff N 次后打开会话选择器，或看会话文件头部的 `parentSession` 链（`~/.pi/agent/sessions/<cwd-slug>/*.jsonl` 第一行）。
