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
  追加时从 `cursor.dest.size`（archive 的实际字节数，`sameStamp` 已保证就是我们写的那份）读取，
  读完再从 `stampOf(rawPath)` 刷新游标。归档大小永远等于已写字节，不可能像独立 `stat` 那样
  跑到已复制内容之外，因此“写完再重放同一区间”不可能发生。
- **同一会话的写进程内串行化。** `archive.ts` 只对 turn/settle 路径排队，而 `/session-log`
  命令与任何直接调用者会绕过队列；两个调用者读到同一游标会各自追加同一段尾巴。新增按
  `projectRoot\0sessionId` 的 promise 链（`rawFlights`）串行 `writeSessionOnce`。
- **重建路径不植入合成字节。** 源文件末尾没有换行时按原样复制，不再补 `\n`，保证
  “archive 始终是 source 的字节前缀”，游标偏移与源偏移始终对齐；空/不可读源才回落到
  header+entries 合成路径。
- **短读不回填 NUL。** `readSlice` 使用 `handle.read` 返回的 `bytesRead` 截断 buffer；否则一次
  短读会把 `\0` 写进归档并被游标记为已复制。
- **同 inode 覆盖写检测。** 追加前用 256 字节的边界探针比较 archive 与 source 在同一偏移的字节；
  同 inode 的 truncate+rewrite 不改变 inode、也可能不缩小大小，仅靠 inode+size 守不住。

## 2. 测试

`tests/sync-test.mjs` 新增四个场景：

- `session.jsonl handles a partial line and a growing rewrite`
  - 半行分两次落盘：先断言 archive 是 source 的前缀（无合成字节），再断言补全后两者相等；
  - 同 inode 变大的原地重写必须整体重建（断言 archive === source）。
- `overlapping writes for one session are serialized`：`Promise.all` 两次并发写同一会话，
  断言 archive === source。
- `session.jsonl does not duplicate under a concurrent writer`：4000 行初始源 + 持续 `appendFile`
  的并发写入者，期间反复刷新，断言 archive === source 且无重复 id。
- 既有 “a flush with no new bytes writes nothing” 断言加入 inode 比较，不再依赖毫秒级 mtime。

`node tests/run-all.mjs` → **12/12**；`git diff --check` 干净。

### 变异矩阵（在 `/tmp` 副本上，绝不动沙箱）

| 还原的生产行 | 被哪个用例杀死 |
| --- | --- |
| 去掉 `rawFlights` 串行化 | “overlapping writes do not duplicate the tail” |
| 去掉 `appendBoundaryIntact` 守卫 | “a growing in-place rewrite rebuilds” |
| 还原合成换行（`existingRaw + "\n"`） | “a half-written line is copied without a synthetic byte” |
| 整段还原到修复前 | 并发写入者两断言的 2 项 |
| `readSlice` 忽略 `bytesRead` | 无确定性用例（见残余） |

## 3. 未处理（历史数据，非本次范围）

- 已存在的 12 个归档里的重复条目未回改；`INDEX.md` 的 2 条悬空行已就地清理
  （`.agents/memory/session-logs/` 被本地 `.gitignore` 忽略，属机器本地状态）。
- 扩展运行在 `~/.pi/agent/git/...` 的 v0.1.11+ clone 上，本修复需重新打包/发布/重装并重启才生效。
- 残余：跨进程同会话写者仍无锁（与 `session-logs` 一贯做法一致）；`bytesRead` 分支属防御性修复，
  当前用例无法确定性触发短读；边界探针只保证最近 256 字节的前缀一致。

## 4. 独立评审

- 第 1 轮（`session-log-append-duplication-review-round1-independent.txt`）：**CHANGES-REQUESTED**，
  发现并发同 key 写重复（I1）、`readRange` 忽略 `bytesRead`（I2）、同 inode 变大重写未检测（I3）
  以及测试强度问题；本轮已全部修复，并把弱断言改成整文件相等断言。
- 第 2 轮（对修复增量的聚焦复核）：见 `session-log-append-duplication-review-round2-independent.txt`。
