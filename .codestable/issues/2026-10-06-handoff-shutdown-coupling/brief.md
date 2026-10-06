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
