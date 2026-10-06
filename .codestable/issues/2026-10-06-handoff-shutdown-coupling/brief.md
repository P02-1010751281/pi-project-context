# 交接与记忆 shutdown 耦合：立项记录（2026-10-06）

`handoff-config` 审计附注 §2.3 记的跨特性耦合残留，按「有据也需要单独立项」这条口径在这里立成一条可追踪的 issue。

## 现场事实（唯一一条，2026-09-22）

`errors.log` 里那条真失败链：`session_shutdown` 期间的记忆 consolidation 抛错
（`memory/pass.ts` ← `report.ts` 的通知路径）沿 `AgentSessionRuntime.teardownCurrent → newSession` 冒泡，
让 `runHandoff` 在 `ctx.newSession(...)` 上失败 ⇒ 走 catch-all 提示 + 失败退避。

## 之后的处置

- 已加**防御性 shutdown 守卫**（错误不再逃逸进 pi 的 runner）。该守卫无法在本仓 harness 里钉住——raw throw、
  缺 sessionManager/modelRegistry、不存在的 cwd、把记忆目录换成文件，四种构造都在 pass 内部被吞——所以它是「防御」而非「可复现修复」。
- 因此现在的状态是：**症状被挡住，耦合本身还在**（handoff 事务的成功仍依赖 memory 特性不在 shutdown 抛错）。

## 待定（设计问题，不是 bug 修复）

1. 把 consolidation pass 从 runner 的 teardown 路径上摘出来（shutdown 期间只落盘、不调模型），还是
2. 让 `newSession` 对 teardown 阶段的异常免疫（在 handoff 侧隔离），还是
3. 接受现状（守卫足够），只在审计里保留记载。

三条都要 owner 选；本文件只负责把「残留」变成「有编号的待决项」，不预设实现。
评分口径沿用仓规：主张新机制前先给出**本仓的现场事实**（本文件第 1 节即是）。

## 本仓建议（2026-10-06，**待 owner 拍板**，不是决定）

按现场证据建议**选 ③（接受现状、只留记载）**：

- 唯一一条现场事实是 2026-09-22；此后守卫在位，`errors.log`（191 行，跨 09-16→10-06）无复发。
- ①「摘出 teardown 的 consolidation」会改语义（shutdown 不再调模型，只剩落盘），②「handoff 侧隔离」只治症状：
  两者都是**无复发事实支撑的预防性改动**；按仓规，主张新机制前要有本仓现场事实。

**重开条件（写死）**：`errors.log` 再出现一条栈中含 `teardownCurrent` 或 `newSession` 的行 ⇒ 重开本 issue，优先选 ①。

## 选 ① 的后果（2026-10-06 代码核对，owner 未定）

注册点是 4 个，但**只有 2 个真的写记忆内容**（`memory/report.ts`）：

- `session_start` —— 只做布局迁移与配置提示，不写记忆内容；
- `before_agent_start` —— 只注入，不落盘；
- `agent_settled` —— `consolidate(ctx, false)`，自动、fire-and-forget、**被节流**：
  判据 `turns - baseline < consolidateTurns(6) || gap < consolidateIntervalMs(5min)` ⇒ 要**同时**满 6 轮且满 5 分钟；
- `session_shutdown` —— `consolidate(ctx, true, true)`，**强制**（绕过节流）、静默、在守卫里。

外加一条手动：`/memory update`（强制）。强制路只有 `forceDedupeMs(15s)` 去重：距上次 pass 完成不足 15 秒时直接复用上次结果（不调模型），
超过 15 秒就真跑一次。

⇒ **今天保证「会话尾部进 MEMORY.md」的其实是 exit 那次强制 pass，不是被节流的 settle pass。**
每次 pass 的成本 ≈ 1 次辅助模型调用 + 一份约 30 KB 的全文快照追加（本仓 `memory.jsonl` 4 条 = 121 KB）+ 一次全文 `MEMORY.md` 写；
节流是这笔成本的唯一上限，而 exit 那次**绕过节流**（每个会话至多一次）。

**选 ① 之后**的写入口＝自动 `agent_settled`（仍节流）＋ 手动 `/memory update`＋ 退出时只 flush（不调模型）。
代价＝丢掉「退出时强制合并一次」：距上次自动 pass 的那段（最多 6 轮 / 5 分钟）可能永不进 `MEMORY.md`，只留在 `session-logs/` 归档里
（pi 在 turn_end / agent_settled / session_shutdown 都归档，但归档只有指针可见，模型不会自己回去读）。收益＝teardown 路径上不再有网络调用，
09-22 那条链的根因消失。

**实现面**：`pass.ts` 抽一个不调模型的 flush（读 journal → fold → render → 写文件 + 采纳外部编辑；这三步已在 pass 内部，抽出来即可），
`report.ts` 的 `session_shutdown` 调用点换过去，测试钉「shutdown 不调辅助模型」与「flush 仍写文件并采纳外部编辑」；
`/memory update` 与 settle 路不动，CHANGELOG 记行为变化。
