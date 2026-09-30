---
doc_type: issue-analysis
issue: 2026-09-30-session-log-append-duplication
status: fixed
path: standard
created_at: 2026-09-30
related: [session-log-append-duplication-fix-note.md]
tags: [session-log, archive, session.jsonl, append-cursor, data-integrity]
---

# 会话归档 session.jsonl 重复条目 分析

## 1. 触发

owner 要求“恢复上下文，检查 session-log 是否有缺漏”。对 `.agents/memory/session-logs/` 与
`~/.pi/agent/sessions/--run-media-user-<...>-Projects-pi-project-context--/` 做了逐会话完整性比对。

## 2. 症状与证据

- 12 个归档 `session.jsonl` 含**相邻重复条目**，而对应 harness 源文件没有任何重复：

  | 会话 | 归档行数 | 重复 id 数 |
  | --- | --- | --- |
  | `01a0a41a-…` | 224 | 1 (`d3970cd3` @221/222) |
  | `01a0a53e-…` | 297 | 2 |
  | `01a0b8d4-…` | 376 | 4 |
  | `01a0f19c-…`（上一轮施工会话） | 229 | 9 |
  | `01a0f1c3-…`（上上一轮施工会话） | 483 | 7 |

  重复条目类型以 `context_edit`（扩展在 settle/consolidation 后写入）和 `message` 为主，即**刚被
  写入 harness 的最后一两条**，符合“追加窗口重叠”的特征。
- 另发现 `INDEX.md` 有 2 条指向已不存在目录的悬空行（`01a0a89f-…`、`01a0f261-…`），
  以及 4 个只有 header/model/thinking 三条的“探针”会话存根。这些是历史数据，与本次代码缺陷无关。

## 3. 根因

`extensions/project-context/archive/session-log.ts` 的增量追加游标：

1. 先 `stat(source)` 得到 `sourceStat.size`；
2. 守卫通过后 `readRange(source, cursor.sourceSize)`，而 `readRange` **内部再 `stat` 一次**并按
   当时的大小读取；
3. 追加完成后却把游标置为**第 1 步的 `sourceStat.size`**。

若 harness 在第 1、2 步之间追加了内容（`context_edit`/message 正是这样并发落盘的），第 2 步会读到
超过第 1 步大小的字节，但游标只前进到第 1 步的大小。下一次刷新从该陈旧偏移再读一次，
就把已经追加过的区间**重复追加**。重建路径同样用后来的 `stat` 设置游标，存在对称的漏读风险。

## 4. 影响

`session.jsonl` 是会话归档的权威副本，handoff 回放 / autolearn 回溯都按它导航。重复条目会让这些
读取方看到重复事件，破坏“原始日志=harness 文件”的契约；长期累积也会放大归档体积。
