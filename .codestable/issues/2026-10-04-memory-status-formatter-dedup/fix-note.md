---
doc_type: fix-note
issue: memory-status-formatter-dedup
date: 2026-10-04
released_in: v0.2.2
decision: owner instruction "3 做" (2026-10-04), after the command-surface audit
---

# 修复说明：memory 状态行单一化

## 现场事实（为什么动）

命令面审计发现 memory 状态有**两套实现**，而且已经漂移：

- `extensions/project-context/index.ts` 的 `memoryStatusLine()` —— `/project-context status` 用。
- `extensions/project-context/memory/report.ts` 的 if 链 —— `/memory` 用。

两者的分支集不同：`/memory` 有 **journal-unreadable** 分支（「journal 存在但没有可用记录，
删掉它可以从 `MEMORY.md` 重建，或从 `memory-log-*.jsonl` 恢复」），伞形状态行**没有**，
那种状态在伞形下只显示成一句通用的「cannot be read」；其余分支（empty / damaged / poisoned /
truncated）措辞两套，空记忆在 `/memory` 下是 `No project memory yet: …`、在伞形下是 `(empty)`。

这是纯代码重复（同一事实两个渲染点），不是用户面重叠，因此不需要设计文档：
本项目对删除**命令/动词/开关**要求现场事实，对合并重复实现不要求。

## 改动

- 新增 `extensions/project-context/memory/status.ts`：
  - `memoryStatusMessage(memory, cap)` —— 唯一的正文措辞，两个入口都调它。
    每条分支都以 `${source}` 开头，所以 `Memory: `（伞形）和 `Project memory: `（`/memory`）
    两个前缀都能读通。
  - `memoryStatusLevel(memory)` —— 对应分支的 `notify` 级别（unreadable/damaged/poisoned/截断 = warning）。
- `index.ts`：删掉本地 `memoryStatusLine()`，改调共享函数；连带清掉不再使用的
  `isMemoryTruncated`、`memoryDocumentChars`、`memorySizeLabel`、`LoadedMemory` 导入。
- `report.ts`：那条 if 链换成一行共享调用，同样清掉不再使用的导入
  （`memoryDocumentChars` 在文件别处仍用，保留）。

分支优先级取 `/memory` 原来的顺序（unreadable-journal → unreadable → damaged → poisoned → 截断 → 正常）；
`damaged` 与 `poisoned` 同时为真时（journal 有坏行 + 存的是旧 bug 的原始 JSON）现在报告坏行。

## 用户可见变化

- 伞形状态行补齐了 journal-unreadable 的恢复提示。
- `/memory` 无参输出改为共享文案：空记忆显示 `(empty)`（原 `No project memory yet: …`），
  其余分支措辞与伞形一致。
- 其余情况逐字节不变（级别也不变）。

## 回归钉子

`tests/memory-ops-test.mjs` 新增一个块，用**六个 fixture**（normal / empty / at the cap / poisoned /
journal unreadable / file unreadable）逐个驱动两个入口，断言正文逐字节相同，并断言 `/memory` 的级别。

变异验证（本轮实测）：

| 变异 | 期望 | 实测 |
| --- | --- | --- |
| 删掉 `status.ts` 的 journal-unreadable 分支 | journal 用例变红 | FAIL 2 行（journal 用例 + 汇总） |
| 让伞形入口单独走回旧措辞（模拟漂移） | 等式断言变红 | FAIL 15 行 |
| 还原 | 全绿 | FAIL 0 |

注意：只改共享函数的文案不会让等式断言变红（两入口一起变），所以**等式钉子必须靠单侧变异来验证**。

## 发布含义

代码改动落在 `extensions/`，所以 `extensions/` 不再是当前 tag 的字节副本：需要新 tag（v0.2.2）、
`~/.pi` pin 更新，以及**重启 pi**（`pi update --extensions` 只替换磁盘代码）。见同目录的
`release-v0.2.2-evidence.md`。

## 顺带（同一轮，非本修复）

- 新学到的技能 `skill-inventory-consolidation`（description 184 字符超本仓 170 上限、正文引用已被
  取代的计数）并入 `curated-surface-hygiene`（新增 §6 合并流程、§7 代码块内死路径、§8 provenance），
  目录删除；`command-surface-audit` 修正版本号措辞后纳入跟踪，其 §2 改为记录「已修复 + 钉子在哪」。
- pi 的硬上限经 pi 文档核实：name ≤ 64 字符、description ≤ 1024；本仓自设 description ≤ 170。
