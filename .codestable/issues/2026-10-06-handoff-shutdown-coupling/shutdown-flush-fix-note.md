# 修复说明：退出改做不调模型的 flush（选项 ①）

**状态**：已实现，等待发布与真机重启。改动只影响 `session_shutdown` 这一条路径，`agent_settled` 与 `/memory update` 未动。

## 为什么

- 现场事实（唯一一条）：`errors.log` 的 2026-09-22 行，模型调用抛错经 `consolidate` 逸出 `session_shutdown` handler
  进 `ExtensionRunner.emit -> emitSessionShutdownEvent`。该链的唯一来源就是 teardown 上的那次模型调用。
- 那条调用同时是**唯一绕过节流**的 pass：`agent_settled` 受 `consolidateTurns`(6) 与 `consolidateIntervalMs`(5min)
  双重节流，`session_shutdown` 用 `force=true` 绕过。owner 在权衡「尾部缺口 / 保持现状 / 调小节流」后选 ①。

## 改了什么

| 文件 | 变化 |
| --- | --- |
| `extensions/project-context/memory/store.ts` | 把 `recordMemoryDocument` 内联的「采纳外部编辑」抽成导出函数 `adoptExternalEdit()`；新增 `flushMemoryRender()`（自己持锁：先采纳，再把 journal 的 fold 写回文件；文件已是该 fold 时 no-op） |
| `extensions/project-context/shared/project-state.ts` | barrel 导出 `flushMemoryRender` 与 `FlushResult` |
| `extensions/project-context/memory/report.ts` | `session_shutdown` 从 `consolidate(ctx, true, true)` 换成 `flushMemoryRender(...)`，仍在同一个守卫内；`logError` 键 `shutdown:consolidate` → `shutdown:flush` |
| `tests/consolidation-test.mjs` | 9 个原本用 `session_shutdown` 驱动 consolidation 的用例改走显式 `/memory update`（存档层仍在 exit 写）；新增两组钉：`the exit flushes without a model call`（无模型调用、手改被采纳进 journal 且有日志、文件仍是 journal 的渲染、退出不合成内容、尾部在归档里）与 `the settle pass is still the automatic writer`（节流满足时 `agent_settled` 仍写 `MEMORY.md`/`CONTEXT.md`） |

## 有意保留 / 有意不做

- **文件写回**（`flushMemoryRender` 的第二半）**保留**：采纳之后文件与 fold 的字节在规范化下可能不同（空白，或手改超帽被裁），
  这一步把文件留成 journal 的渲染，也让「退出后磁盘即 journal 视图」成为不变量。**没有对应的现场事故**（实测 8/8 仓的折叠
  与手写文件逐字节一致），所以它是完整性论证而非事故驱动；正常退出（无手改）时它是 no-op，不产生写入或 mtime 变动。
- **不做**：退出时写 `CONTEXT.md`（那需要模型回复，正是要摘掉的东西）；也不调小节流（那会把辅助调用变成每轮一次）。

## 代价（已在 CHANGELOG 与架构文档里写明）

某次 pass 之后、会话结束前的内容（最多 6 轮 / 5 分钟）不再进入 `MEMORY.md`，只留在 `session-logs/` 归档里。
自动写入只剩被节流的 `agent_settled` 与显式 `/memory update`。

## 待办（不属于本次改动）

- 发布：CHANGELOG 用的是 v0.4.6（未发布）段；版本号（patch 还是 minor）由发布步决定。
- 真机：宿主 pin 已是 `@v0.4.5`，本次改动要等下一个 tag + 重启才对运行中的会话生效。
- 独立审查：本改动尚未跑冻结修订的独立审查轮（见 `.agents/skills/pi-project-context-independent-review/`）。
