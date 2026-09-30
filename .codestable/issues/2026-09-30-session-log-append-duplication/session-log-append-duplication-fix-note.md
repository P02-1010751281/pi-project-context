---
doc_type: issue-fix
issue: 2026-09-30-session-log-append-duplication
status: fixed
path: standard
fix_date: 2026-09-30
related: [session-log-append-duplication-analysis.md]
tags: [session-log, archive, session.jsonl, append-cursor, data-integrity]
---

# 会话归档 session.jsonl 重复条目 修复记录

## 1. 修复

`extensions/project-context/archive/session-log.ts`：

- **以归档自身大小作为追加偏移。** `RawCursor` 去掉 `sourceSize`，只保留 `source`/`sourceIno`/`dest`。
  追加时从 `cursor.dest.size`（即 archive 的实际字节数，`sameStamp` 已保证就是我们写的那份）读取，
  读完再从 `stampOf(rawPath)` 刷新游标。归档大小永远等于已写字节，不可能像独立 `stat` 那样
  “跑到已复制内容之前/之后”，因此重叠追加不可能发生。
- **重建路径不再植入合成字节。** 源文件末尾没有换行时按原样复制，不再补 `\n`；下一个追加从精确
  字节偏移接上，避免合成的换行让游标与归档错位。
- 守卫从 `cursor.sourceSize <= sourceStat.size` 改为 `cursor.dest.size <= sourceStat.size`；
  读取到空尾（文件在守卫与读取之间收缩）时不追加，等下一次守卫失败走重建。

## 2. 测试

`tests/sync-test.mjs` 新增 “session.jsonl does not duplicate under a concurrent writer”：

- 4000 行初始源 + 一个持续 `appendFile` 的并发写入者（`setImmediate` 让出），期间反复调用
  `writeSessionArtifacts`，最后再刷新一次；
- 断言 `archive === source`，且归档内没有任何重复 id。
- **非空洞**：把 `session-log.ts` 还原到修复前（`git checkout --` 后运行），该用例稳定地
  `FAIL archive matches the source after concurrent appends` +
  `FAIL no entry is duplicated by the append cursor`（2 项失败）；恢复修复后 12/12 全过。

`node tests/run-all.mjs` → **12/12**；`git diff --check` 干净。无本地 tsc，类型由 jiti 运行时加载
与测试执行间接验证。

## 3. 未处理（历史数据，非本次范围）

- 已存在的 12 个归档里的重复条目、`INDEX.md` 的 2 条悬空行未回改（`.agents/memory/session-logs/`
  被本地 `.gitignore` 忽略，属机器本地状态；如需可另行清理）。
- 扩展运行在 `~/.pi/agent/git/...` 的 v0.1.11+ clone 上，本修复需重新打包/发布/重装并重启才生效。

## 4. 独立评审

见 `session-log-append-duplication-review-round1-independent.txt`。
