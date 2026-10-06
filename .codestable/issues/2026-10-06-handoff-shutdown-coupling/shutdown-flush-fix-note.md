# 修复说明：退出改做不调模型的 flush（选项 ①）

**状态**：已实现并通过第 1 轮独立审查后的修复（`033fa75` 首版、`eff6a56` 修复）；等待第 2 轮审查、发布与真机重启。
改动只影响 `session_shutdown` 这一条路径，`agent_settled` 与 `/memory update` 未动。审查轮与逐条处置见
`shutdown-flush-review-report.md`。

## 为什么

- 现场事实（唯一一条）：`errors.log` 的 2026-09-22 行，模型调用抛错经 `consolidate` 逸出 `session_shutdown` handler
  进 `ExtensionRunner.emit -> emitSessionShutdownEvent`。该链的唯一来源就是 teardown 上的那次模型调用。
- 那条调用同时是**唯一绕过节流**的 pass：`agent_settled` 受 `consolidateTurns`(6) 与 `consolidateIntervalMs`(5min)
  双重节流，`session_shutdown` 用 `force=true` 绕过。owner 在权衡「尾部缺口 / 保持现状 / 调小节流」后选 ①。

## 改了什么

| 文件 | 变化 |
| --- | --- |
| `extensions/project-context/memory/store.ts` | 把 `recordMemoryDocument` 内联的「采纳外部编辑」抽成内部函数 `adoptExternalEdit()`（无外部消费者，故不导出）；新增 `flushMemoryRender()`：无 journal 直接返回（不建目录、不取锁）→ 采纳循环到稳定 → 文件与 fold 的比较键相同时不写 → 否则写前备份、重发 fold |
| `extensions/project-context/shared/project-state.ts` | barrel 导出 `flushMemoryRender`（`FlushResult` 无外部消费者，不导出） |
| `extensions/project-context/memory/report.ts` | `session_shutdown` 从 `consolidate(ctx, true, true)` 换成 `flushMemoryRender(...)`，仍在同一个守卫内；`ctx.cwd` 只读一次且受保护（catch 不再触碰 `ctx`）；加 `runIsDisabled`/`memoryEnabled` 门；`logError` 键 `shutdown:consolidate` → `shutdown:flush` |
| `tests/consolidation-test.mjs` | 8 个用 `session_shutdown` 驱动 consolidation 的用例改走显式 `/memory update`（主 e2e 两者都跑，只有它仍在 exit 断言存档层）；新增钉：退出无模型调用（`Date.now` 拨过去重窗，回退会红）、手改被采纳且有日志、退出不合成内容（mock 的退出回复带标记）、缺 render 重发且不追加 journal、陈旧 render 被 fold 替换且写了备份、无 journal 项目不落记忆状态、stale ctx 不 reject、settle 仍是自动写者 |

## 有意保留 / 有意不做

- **文件写回**（`flushMemoryRender` 的第二半）**保留**：真正的触发条件只有两个——文件缺失，或文件陈旧/撕裂于 journal。
  （首版注释/本说明曾写「采纳后因空白或超帽裁剪的字节差异触发」，**该说法不成立**：采纳追加的就是磁盘的 `renderKey`，
  比较键按构造相等，采纳后不会再写；超帽手改是「journal 存裁剪键、磁盘保留原文」。第 1 轮审查 I4 指出，已改。）
  它让「退出后磁盘即 journal 视图」成为不变量；正常退出无手改时是 no-op，不产生写入或 mtime 变动。
- **不做**：退出时写 `CONTEXT.md`（那需要模型回复，正是要摘掉的东西）；也不调小节流（那会把辅助调用变成每轮一次）。

## 代价（已在 CHANGELOG 与架构文档里写明）

两次 settle pass 之间结束的会话，其尾部不再进入 `MEMORY.md`，只留在 `session-logs/` 归档里。缺口长度由节流决定，
**不是固定上界**（记忆被故障策略 park 时可以是整段会话）。自动**生成新内容**只剩被节流的 `agent_settled` 与显式 `/memory update`。

## 待办（不属于本次改动）

- **第 2 轮独立审查**：第 1 轮的 blocking/important 已全部修复（`eff6a56`）；按纪律，修复后的修订需要自己的审查轮
  （冻结 + 字节一致沙箱 + 零写入证明，路由 `deepseek/deepseek-flash` + thinking high）。
- 发布：CHANGELOG 用的是 v0.4.6（未发布）段；版本号（patch 还是 minor）由发布步决定。
- 真机：宿主 pin 已是 `@v0.4.5`，本次改动要等下一个 tag + 重启才对运行中的会话生效。
- 本 issue 之外的现场发现：settle 路能把一段带 header 的散文回复整篇发布（沙箱里由已安装的 v0.4.5 实测），
  建议另开 issue；详见审查报告的残留风险节。
