---
doc_type: issue-report
issue: 2026-09-16-handoff-residuals
status: open
path: quick
created_at: 2026-09-16
related: [handoff-language-and-replay-fix-note.md, consolidated-memory-json-poison-fix-note.md]
tags: [handoff, tests, flakiness]
---

# handoff 记录在案残余 问题报告

## 触发

owner 指令「残余处理掉」（2026-09-16）：把前两个 issue 里**记录在案、未修**的残余一并关闭，
不留待办。涉及三条，全部为 pre-existing、此前明确记为「accepted / 不在本 issue 范围」。

## 残余清单

### R1 单轮超大时自动交棒无法进行（功能缺口）

- 现象：当会话的大部分上下文落在**同一轮**里（真机：源会话 54k token，单轮 4×12.8k toolResult，
  `handoffKeepTokens=2000`），`findCutPoint` 的切点落在这轮内部；`runHandoff` 为「保持整轮、
  toolCall/toolResult 成对」把切点拉回该轮起点 ⇒ `olderMessages` 为空 ⇒ 直接 return，交接不发生。
- 影响：阈值已过却永远跳过（C3 之后至少会 warn 一次 + 30s 冷却，用户能看到原因，但**功能仍然不可用**）。
- 记录位置：`handoff-language-and-replay-analysis.md:77`、`…-fix-note.md` §5（「真正的修复需要在轮内切分，风险高，本 issue 不做」）。

### R2 handoff 调用点未被测试钉住（覆盖缺口）

- 现象（review round 5 F3/F5）：`localizeSummaryHeadings` 与
  `languageMessagesFor(olderMessages, carriedMessages)` 只有**纯函数**级测试；把调用点改错（例如
  把未本地化的摘要塞进 prompt、或把 `olderMessages` 而非「older+carried」喂给语言判定）测试仍全绿。
- 需要的能力：可注入的 summarizer（`generateSummaryWithUsage` 来自 pi SDK）+ `newSession` mock。

### R3 `consolidation-test.mjs` 的固定等待（flaky 风险）

- 现象：4 处 `setTimeout(10/20/30/100ms)` 作为竞态窗口（写锁串行化×2、被窃锁的第三方阻塞、
  陈旧锁争用），负载高时窗口可能不足 ⇒ 假绿或假红（此前实测含 4×CPU 负载的稳定性验证）。

## 验收标准

1. R1：单轮超出 keep 预算时交接正常发生，且回放块结构合法（首个消息为 user 角色、toolCall/
   toolResult 配对不破、被切掉的前缀进入摘要）；
2. R2：把上述两个调用点改错时测试变红（变异可检出）；
3. R3：测试无固定等待，仅保留条件等待与事件循环屏障（锁 deadline 断言本身除外）；
4. `node tests/run-all.mjs` 9/9，且 handoff 断言数只增不减。
