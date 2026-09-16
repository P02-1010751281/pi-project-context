---
doc_type: issue-review
issue: 2026-09-16-handoff-residuals
status: passed
path: quick
reviewer: independent pi CLI (lane A, read-only sandbox copies)
rounds: 4
created_at: 2026-09-16
---

# handoff 记录在案残余 修复 Review

## 审查方式

- lane A：独立 `pi` CLI 进程（独立上下文），参数
  `pi -p --no-session --no-extensions --no-skills --no-prompt-templates --tools read,bash`。
- 每轮在 `/tmp/pi-context-rev-handoff{6,7,8,9}/` 只读沙箱副本上审查工作树 diff（基线 HEAD `e71e693`）。
- 每轮跑前/跑后快照 `git status --porcelain` + 全仓库文件清单（path/size/mtime）并 diff：**四轮均零写入**。
- 记录：`handoff-residuals-review-round{1,2,3,4}-independent.txt`。

## 逐轮记录

| 轮 | 结论 | 主要发现 | 处置 |
|---|---|---|---|
| 1 | important ×2 | I1 all-attempted 屏障空转（旁路锁后 `!overlapped` 仍真）；I2 首消息不变量只覆盖 `assistant`，被过滤的 summary 条目可暴露孤儿 toolResult；M1 `stubCalls[0]` 无保护；M2 `globalThis.__handoffStub` 未清理 | 全部修复：嵌套竞争、`USER_FACING_ROLES` 放宽、可选链、`finally` 清理 |
| 2 | minor ×4 | N1 串行化窗口只覆盖 `setImmediate` 让出；N2 raw/marker 区别不可变异检出（断言表述过强）；N3 孤儿只修形状未修配对；N4 `stolen exactly once` 命名高于实际；另报告 `switches-test` 负载 flake（pre-existing） | 修复：混合回合让出、收窄表述、孤儿折入摘要、断言改名、flake 条件化 |
| 3 | minor ×3 | m1 孤儿**内容丢失**（不在回放也不在摘要，附端到端反例）；m2 混合让出对 `setTimeout(0)` 旁路捕获 8/10；m3 autolearn 负断言被多闸门过定（pre-existing） | m1 修复：`droppedOrphans` 收集器 + 折入 `olderMessages`；m2 让出加深至 3×(immediate+timeout) 并降级注释；m3 记入 fix-note §6 |
| 4 | minor ×5 | 重复 JSDoc；切点注释仍复述被证伪的前提；`baselineNow` 对孤儿双重扣减（当前 `force` 下不可达）；中段孤儿未清；m3 复现；analysis 文档漂移 | 全部修复：去重、改注释、`olderTokens` 只算前缀、孤儿按 `toolCallId` 全局剔除、analysis 更新 |

## 关键验证（复审方实际执行）

- **R1 正向**：真实 `findCutPoint` + 端到端 `runHandoff`，复现原始 54k/4×12.8k 缺陷场景 —— 旧代码 skip，新代码交接成功（`olderTokens≈12.8k`，回放 user-first）；20000 次随机良构切片 fuzz 中 `orphanResult=0`、`orphanCall=0`。
- **R1 变异**：去掉孤儿折入/收集器/回放剔除/marker 判定 → 各自对应断言红灯（5 组变异）。
- **R2 变异**：去掉 `localizeSummaryHeadings` 调用点、`languageMessagesFor(older, [])` → 红灯；stub 失效时断言干净失败（不抛 TypeError）。
- **R3 变异**：`withMemoryLock` 旁路（立即 / `setTimeout(0)` / 提前释放）→ 8/8–12/12 捕获；`stealStaleLock` no-op → 硬失败；正确锁 15 次 0 假红；跨进程锁测试对上述旁路稳定红灯。
- **性能/时间**：consolidation ≈7.0s、switches ≈1.5s、handoff 与其余文件均在 60s 超时内；空载 ×6、负载 ×5 全绿。

## 结论

四条 important（I1/I2/m1 + 孤儿配对闭合）全部修复并经变异验证；minor 全部处置或明确记入 fix-note §6（仅 m3 为 pre-existing 未修）。无 blocking。`status: passed`。
