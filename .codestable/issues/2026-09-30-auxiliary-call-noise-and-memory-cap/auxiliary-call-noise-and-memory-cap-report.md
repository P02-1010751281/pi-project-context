---
doc_type: issue-report
issue: 2026-09-30-auxiliary-call-noise-and-memory-cap
status: fixed
created_at: 2026-09-30
related: [auxiliary-call-noise-and-memory-cap-analysis.md, auxiliary-call-noise-and-memory-cap-fix-note.md]
tags: [memory, autolearn, alerts, errors-log, memory-cap, output-budget]
---

# 辅助调用报警与记忆上限 问题报告

## 1. 触发

owner 反馈：最近活跃的两个项目（UniField、Quantum_Matrix）**频频报警**。两个项目都跑在已安装的
`pi-project-context@v0.1.11` 上（PID 3225 cwd=UniField、PID 3278 cwd=Quantum_Matrix，11:22 启动）。

## 2. 症状与现场证据

- `errors.log` 里的三组高频记录：
  - `[memory]` / `[autolearn]` `Error: ... model call error: Connection error. / Request timed out.`
  - `memory exceeded maxMemoryChars (32000): the tail was dropped ...`
  - `adopted an externally edited MEMORY.md`（QM 141 次、UniField 28 次）
- autolearn 在 03:13–03:19 六连发：**每个 `agent_settled` 都重试一次失败的调用**。
- 会话模型是 `commandcode-c02-1010751281 / deepseek/deepseek-v4.1-flash`，两个项目的
  `provider`/`model` 都是空值，于是辅助调用回退到会话模型。
- 历史 cap 命中：UniField 2 次、QM 5 次；6 个归档带截断标记。
- 两个项目的 render 都贴顶：UniField 27604/36000、QM 11009/32000（曾经到 31827/32000）。

## 3. 影响

一条 provider 故障被放大成持续 toast 与不断增长的 `errors.log`；记忆在 cap 附近来回，
截断标记粘住后 resume 也救不回；`/project-context status` 既不显示占用比例，也没给出提 cap 的入口。
