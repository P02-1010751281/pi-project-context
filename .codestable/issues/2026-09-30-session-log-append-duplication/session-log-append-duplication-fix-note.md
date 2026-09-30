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
  “archive 始终是 source 的字节前缀”，游标偏移与源偏移始终对齐；trim 后为空的源才回落到
  header+entries 合成路径（此时不登记游标）。
- **短读不回填 NUL。** `readBytes` 使用 `handle.read` 返回的 `bytesRead` 截断 buffer；否则一次
  短读会把 `\0` 写进归档并被游标记为已复制。
- **同 inode 覆盖写的边界检测。** 追加前用 `Buffer.equals` 比较 archive 与 source 在
  `[size-256, size)` 的字节；不同则整体重建。探针整体包在 `try` 中，读失败按“不再可信”处理并重建。
  **边界（明确限定）**：只比较最近 256 字节——同 inode 的 truncate+rewrite 若保持这 256 字节不变
  且不缩小（罕见：正常 harness 会话文件是追加写），仍不会被发现。全量前缀校验需要每次刷新 O(n)
  读取，已明确不采用。

## 2. 测试

`tests/sync-test.mjs` 新增/加强：

- `session.jsonl handles a partial line and a growing rewrite`
  - 半行分两次落盘：先断言 archive 是 source 的前缀（无合成字节），再断言补全后相等；
  - 边界处变化的同 inode 变大重写必须整体重建（整文件相等断言）；
  - 同大小、探针窗口不变的 rename 替换必须靠 inode 检查重建。
- `overlapping writes for one session are serialized`：`Promise.all` 并发写同一会话，断言相等。
- `session.jsonl does not duplicate under a concurrent writer`：4000 行初始源 + 持续 `appendFile`
  的并发写入者，期间反复刷新，断言相等且无重复 id。
- 既有 “a flush with no new bytes writes nothing” 断言加入 inode 比较，不再依赖毫秒级 mtime。

`node tests/run-all.mjs` → **12/12**；`git diff --check` 干净。

### 变异矩阵（在 `/tmp` 副本上，绝不动沙箱）

| 还原的生产行 | 被哪个用例杀死 |
| --- | --- |
| 去掉 `rawFlights` 串行化 | “overlapping writes do not duplicate the tail” |
| 去掉 `appendBoundaryIntact` 守卫 | “a growing in-place rewrite at the boundary rebuilds” |
| 还原合成换行 | “a half-written line is copied without a synthetic byte” |
| 去掉 inode 守卫 | “an inode-changing replacement rebuilds” |
| 整段还原到修复前 | 并发写入者两断言 |
| `readBytes` 忽略 `bytesRead` | 无确定性用例（见残余） |
| 去掉 `if (tail)` | 无确定性用例（见残余） |

## 3. 残余（已知且接受）

- **探针窗口盲区**：同 inode 重写若保持最近 256 字节且不缩小，不会被检测（§1 已限定）。
- **未 pinned 的守卫**：`readBytes` 的 `bytesRead` 截断与追加路径的 `if (tail)` 都是防御性分支，
  公开接口无法确定性触发短读/收缩竞态，故无回归用例；逻辑经代码审查确认。
- **跨进程同会话写者**无锁（与 `session-logs` 既有做法一致）。
- **UTF-8 跨字节切分**：`readBytes` 在某字节偏移解码可能产生 U+FFFD；完成下一轮后前缀探针会
  触发重建并恢复字节一致（复现探针 P-G 已确认自愈）。
- 历史数据：已存在的 12 个归档里的重复条目未回改；`INDEX.md` 的 2 条悬空行已就地清理
  （`.agents/memory/session-logs/` 被本地 `.gitignore` 忽略，属机器本地状态）。
- 扩展运行在 `~/.pi/agent/git/...` 的 v0.1.11+ clone 上，本修复需重新打包/发布/重装并重启才生效。

## 4. 独立评审

- 第 1 轮（`session-log-append-duplication-review-round1-independent.txt`）：**CHANGES-REQUESTED**
  —— 并发同 key 写重复（I1）、`readRange` 忽略 `bytesRead`（I2）、同 inode 变大重写未检测（I3）
  与测试强度问题。
- 第 2 轮（`session-log-append-duplication-review-round2-independent.txt`）：**CHANGES-REQUESTED**
  —— I1/I2/N1–N3 已修或已限定；指出 I3 仅收窄到 256 字节窗口、修复记录过度声明，以及若干
  未 pinned 守卫。
- 本轮（对第 2 轮的响应）：探针改为 `Buffer.equals`、探针读失败强制重建、去掉单行 `readRange`
  包装、trim 空源不登记游标、补 inode 替换用例，并把 256 字节边界与残余写入记录。
