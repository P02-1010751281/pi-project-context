---
doc_type: issue-report
issue: 2026-09-15-consolidated-memory-json-poison
status: confirmed
issue_path: standard
severity: P1
summary: 自动整理报 "consolidation reply was not a usable JSON object"，且 UniField/Quantum_Matrix 的 MEMORY.md 内容变成了原始 JSON 回复而不是 Markdown
tags: [memory, consolidation, json, legacy-process, self-heal]
---

# consolidation 回复不可解析 + MEMORY.md 被原始 JSON 污染 Issue Report

## 1. 问题现象

用户在项目会话中收到通知：

```text
Warning: Project memory update failed: consolidation reply was not a usable JSON object
```

随后检查项目记忆文件，发现至少两个项目（UniField、Quantum_Matrix）的
`<project>/.agents/memory/MEMORY.md` 文件正文不是项目记忆 Markdown，而是一段
被截断的原始 JSON 回复：

```text
# Project Memory

{
  "memory_markdown": "# Project Memory\n\n## 项目定位...
```

文件在字符串中途结束，没有闭合的 `"` 和 `}`；UniField 为 24027 字节 /
15249 字符，Quantum_Matrix 为 24296 字节 / 14717 字符。该内容会被注入后续会话的
system prompt（Project Memory 段），也会被作为 `<existing-memory>` 反馈给下一次整理。

UniField 的 `errors.log` 记录了失败时间点：

```text
2026-09-15T04:08:28.656Z [memory] Error: consolidation reply was not a usable JSON object
```

## 2. 复现步骤

1. 在 UniField 或 Quantum_Matrix 中正常运行 pi 会话，触发自动整理
   （默认 6 个用户轮次或距上次整理 5 分钟，`agent_settled` 时执行）。
2. 整理调用辅助模型，模型回复被截断/无法解析。
3. 观察到：会话弹出上述 warning；`errors.log` 追加同条错误；
   `MEMORY.md` 保持/变成原始 JSON 内容；此后每次整理仍可能重复失败。

复现频率：稳定可触发；UniField 在 2026-09-15 12:05（本地）写坏文件、12:08（本地）
报错；Quantum_Matrix 在 2026-09-15 14:35（本地）文件被再次写坏。

## 3. 期望 vs 实际

**期望行为**：整理成功后 `MEMORY.md` 应是稳定的 Markdown 项目记忆；模型回复不可解析时，整理失败并保留旧 Markdown 记忆，绝不把原始 JSON 写入或注入。

**实际行为**：`MEMORY.md` 被写入原始 JSON（历史代码路径）或长期停留在该状态；
新代码虽然不再写入坏内容，但每次整理都失败并弹 warning，坏内容继续注入。

## 4. 环境信息

- 涉及模块 / 功能：project-context 扩展的 memory/consolidation 与 injection。
- 相关文件 / 函数：`extensions/project-context/consolidate.ts:354`（报错点）、
  `extensions/project-context/project-state.ts:347`（`loadMemory`，无自愈）。
- 运行环境：pi + 已安装的 pi-project-context v0.1.2（git 包）；
  另有两个 2026-09-12 启动、至今仍存活的 pi 进程：
  PID 370858（cwd=Quantum_Matrix，pts/0）、PID 378387（cwd=UniField，pts/2）。
- 其他上下文：未受影响的 pi-project-context 本项目无 MEMORY.md 与 errors.log；
  用户消息中粘贴的 warning 与 UniField 12:08 的日志一致。

## 5. 严重程度

**P1** — 项目记忆是本扩展的核心功能，两个活跃项目的记忆已被污染并持续注入；
有绕过方法（手工清理/重启旧会话），但数据损坏在扩大。

## 备注

调查中观察到的客观事实（供阶段 2 使用，不在此下根因结论）：

- 安装包在 2026-09-15 12:04:45 才更新到 ad81a11（含 b9c8618 修复）；两个旧 pi 进程
  启动于 2026-09-12，早于该修复。
- b9c8618 已让新代码在无法解析时抛错、不再写坏 `MEMORY.md`，但没有处理存量已污染文件。
- 两个坏文件的 `memory_markdown` JSON 字符串都未闭合（被截断），
  因此按名字恢复字段的 `jsonStringField` 也拿不到完整值。
- `project-context.json` 中 `maxTokens` 为 8192；坏文件里的记忆接近
  `MAX_MEMORY_CHARS`(24000) 规模的中文文本。
