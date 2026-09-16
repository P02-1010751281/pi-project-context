---
doc_type: issue-design
issue: 2026-09-15-consolidated-memory-json-poison
status: reviewed
author: pi
created: 2026-09-15
round: 22
---

# 记忆 journal 化：append-only 真相 + 派生渲染（owner 要求「统一一下」）

## 背景

owner 追问「现在不是 append-only + 读取合并吗？」后确认：会话存档是 `session.jsonl`（append-only）+ `session.md`（渲染），
而 `MEMORY.md` 是整档覆盖。owner 指示按同一模型统一记忆写入路径。

## 设计

- `memory.jsonl`（`.agents/memory/memory.jsonl`）= 唯一权威，append-only；每行一条记录
  `{"ts":ISO,"op":"replace"|"append","text":string}`。追加是单次 `write(2)`，写入在 `MEMORY.md.lock` 内串行。
- `MEMORY.md` = 派生渲染（人读、注入、外部编辑入口），由折叠结果或本次结果重新生成，可随时重建。
- 读取（`loadMemory`）：journal 存在时折叠记录（`replace` 覆盖、`append` 追加、最后 `normalizeMemoryDocument`）；
  journal 不存在时保持旧路径（直接读 `MEMORY.md`，含污染解码）→ 老项目零迁移成本。
- 外部编辑：判据为「渲染归一后内容 ≠ 折叠结果」**且** 渲染 mtime > journal mtime（两个条件同时成立）。
  写入总是「先追加 journal 再渲染」，内容相等的自家渲染不会被误判；命中时读取优先采信该渲染，
  下一次写入先把它作为一条 `replace` 收进 journal（历史保留），再追加本次结果。同一 mtime tick 内的外部编辑会被 journal 覆盖（mtime 粒度残余）。
- 损坏容忍：无法解析的行跳过并计数（`LoadedMemory.damaged`，整理时写 `errors.log`，`/memory` 提示）；
  整份 journal 有内容但无可用记录时 fail closed（unreadable），不静默回退旧渲染。
- 轮换：journal > 512KB 时在锁内折成一条 `replace`，旧文件改名 `memory-log-<stamp>-<8hex>.jsonl` 归档（先写折叠临时文件，任一步失败都回滚/放弃，不让 journal 路径消失）；
  归档按 mtime 保留最新 5 份、一小时内不删。
- 迁移：`recordMemoryDocument` 首次写入时把当前 `MEMORY.md`（经污染解码）作为 journal 基线；OMP legacy 导入改走同一入口。

## 不变量

1. 读路径零副作用（不写字、不建备份、不记日志）。
2. journal 只追加，永不原地覆盖；渲染可重建。
3. 覆盖渲染前必有字节级备份（`backupMemoryBeforeWrite`）且在同一把锁内。
4. 写入失败不得留下「渲染新于 journal」的假外部编辑：追加成功后才渲染。

## 接受的残余

- 轮换期间与追加并发：追加若落在改名后的归档 inode 上，内容仍在归档文件中（证据保留），但不在折叠视图里；
  下次整理会重算。触发需两进程恰在轮换窗口并发。
- 既有锁协议的残余（check→unlink 悬挂窗、node:fs 无 flock）不变。
