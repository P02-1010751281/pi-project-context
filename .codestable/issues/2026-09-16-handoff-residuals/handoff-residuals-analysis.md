---
doc_type: issue-analysis
issue: 2026-09-16-handoff-residuals
status: open
path: quick
created_at: 2026-09-16
related: [handoff-residuals-report.md]
tags: [handoff, tests, flakiness]
---

# handoff 记录在案残余 分析

## R1 轮内切分：方案选择

根因（`handoff.ts::runHandoff`）：

```ts
const cut = findCutPoint(allEntries, 0, allEntries.length, config.handoffKeepTokens);
firstKeptIndex = cut.firstKeptEntryIndex;
if (cut.isSplitTurn && cut.turnStartIndex >= 0 && cut.turnStartIndex < firstKeptIndex) {
    firstKeptIndex = cut.turnStartIndex;   // ← 拉回轮起点：单轮超预算时 older 变空
}
```

候选方案：

| 方案 | 做法 | 结论 |
|---|---|---|
| A | 整轮纳入 older、keep 为空（`firstKeptIndex = allEntries.length`） | ✗ 最新一轮对话只剩摘要，用户刚说的话从回放里消失，UX 风险高 |
| B | 内容级裁剪：保留消息结构，把大 toolResult 的 content 换成占位符 | ✗ 需要额外的裁剪预算、选择策略与文案，改动面与风险都大于 C |
| C（采纳） | 直接用 `findCutPoint` 的 `firstKeptEntryIndex`（允许轮内切），回放块首消息用 user 角色的 `SPLIT_TURN_MARKER` 占位 | ✓ 复用宿主保证，改动最小 |

方案 C 的依据：

- **配对与孤儿结果**：pi 的 `findValidCutPoints` 只在 user/assistant/bashExecution/custom/summary 类
  消息上切，**永不在 toolResult 上切**；但切点**可以**落在 `branch_summary`/`compaction` 条目上，从而把某个
  toolResult 与其已进前缀的 toolCall 分开。这类「孤儿结果」在回放里非法（provider 拒绝无 call 的 result），
  因此由 `replayMessagesFor` 按 `toolCallId` 匹配整体剔除（不只切点头部），并通过 `droppedOrphans`
  收集器交回 `runHandoff`，**追加进摘要输入**——内容不丢，回放结构合法。
- **首消息必须 user**：轮内切会让回放块以 assistant 开头，Anthropic/Gemini 路由直接 400
  —— 这正是 round-2 blocking finding 的成因。`REPLAY_MARKER` 用「替换旧提示词」保住了 user 开头；
  轮内切没有可替换的用户消息，因此**新增**一条 user 角色的 `SPLIT_TURN_MARKER`
  （`[turn prefix summarized during handoff]`），语义真实：该前缀确实进了摘要。判定用
  `USER_FACING_ROLES = {user, custom, bashExecution}`（后两者经会话转换映射到 user 角色），
  任何其他首角色都会补 marker。
- **记账**：`olderTokens` 只算「前缀」（不含折入的孤儿），因为孤儿仍留在原始 kept slice 里参与
  `sliceTokens`；`baselineNow = usage − olderTokens − sliceTokens` 因此不会对同一份 token 双重扣减。
  孤儿本体计入 `keptTokens`/`summaryTokens` 之外的摘要输入，`estimateTokens` 走宿主实现。
- **无内容丢失**：轮内切掉的前缀照常进入 `olderMessages`（`olderEntries = allEntries.slice(0, firstKeptIndex)`），
  摘要覆盖它；`collectFileOps(olderEntries)` 也因此首次覆盖到大轮内的文件操作。
- **记账一致**：marker 由 `replayMessagesFor()` 统一插入，`keptMessages`/`keptTokens`、
  `carriedMessages` 与 `replayEntries()` 共用同一函数，不存在只改一处的可能。
- **风险与缓解**：`auto` 路径的 `MIN_SUMMARIZE_TOKENS=8k` 下限、`estimatedAfter` 预检、pending-question
  guard 均不变；唯一行为变化是「过去整轮回放、现在按预算截断并摘要前缀」，即预算语义更诚实。

## R2 调用点钉住：注入路径

`generateSummaryWithUsage` 由 pi SDK 提供，扩展模块通过 `@earendil-works/pi-coding-agent` 导入。
harness 的 jiti loader 已用 alias 指向 `dist/index.js`，因此**给 `loadNamespace/loadDefault` 增加
可选 alias 覆盖**即可注入 stub：测试在 tmp 里生成

```js
export * from "<pi>/dist/index.js";
export async function generateSummaryWithUsage(messages, model, reserve, apiKey, headers, signal, focus, previousSummary, thinking) {
    return globalThis.__handoffStub(messages, { focus, previousSummary, thinking });
}
```

ESM 规则：显式导出优先于 `export *`，因此只有这一个符号被影子化，其余 SDK 导出不变。
配合 ctx 上的 `newSession` mock（捕获 `setup()` 里 `appendMessage` 出来的回放消息 +
replacement ctx 的 notify/sendUserMessage），可断言的真实链路：

1. 摘要输入是**切掉的前缀 + 折入的孤儿结果**（含大 toolResult，且不含被保留的近期消息）；
2. `summaryFocus(language)` 随会话语言（older 英文 + carried 中文 ⇒ zh）；
3. 模型返回的英文模板标题在**进入 prompt 前**已被 `localizeSummaryHeadings` 映射为中文；
4. 回放是切后 slice、首消息为 `SPLIT_TURN_MARKER`（user）、之后角色序列 `user,assistant,user`；孤儿结果**不**进回放；
5. `HANDOFF.md` 落盘内容同样是本地化后的摘要。

已知不可变异检出的细化（round 3 N2）：`carriedMessages`（原始）与 `keptMessages`（marker 替换后）
在可达场景下语言结果等价（stale prompt 与 marker 都被 `languageSamples` 过滤），因此该区别**故意不断言**；
有意义的方向已钉住——把 carried 换成空数组会让「the summary call carries the conversation language」变红。

## R3 固定等待：替换策略（含 round-1 修复）

- 「持锁期间不得有第二个临界区」的两处：改为**确定性嵌套竞争** —— 持锁者在自己的临界区内启动
  followers/contenders，然后让出 3×( `setImmediate` + `setTimeout(0)` )；`overlaps`/`contendedOverlap`
  在「持锁者仍在临界区内」或「并发进入」时置真。round 1 的 all-attempted 屏障被独立复审判定为**空转**
  （计数在调用前同步自增，判断即返回），已废弃。
  诚实边界：进程内窗口无法击败**任意延迟**的旁路；round 3/4 实测「无锁 + 立即进入」「无锁 + `setTimeout(0)`
  延迟」「锁在 action 前释放」等真实串行化失败 8/8~12/12 捕获，正确锁 15 次 0 假红；真正的互斥权威是
  跨进程探针（3 个子进程 + 共享日志），它对该类旁路稳定红灯。
- 被窃锁后的第三方阻塞：`waitUntil(() => thirdAttempted)` + 事件循环回合，随后断言仍未进入。
- 等待窃锁者进入：`waitUntil(() => thiefEntered, 3_000)`。
- 统一入口：harness 新增 `waitUntil(predicate, timeoutMs, stepMs)`（支持异步谓词）；
  `handoff-test.mjs` 的旧 `waitFor`、300ms 负断言收敛到该 helper。
- 同类清理（round 3 复审发现的 flake）：`switches-test.mjs` 的 5 处固定 sleep 换成条件等待/有界负向探针
  （`stayedQuiet`），`MEMORY.md rewritten` 改为等文件内容（原写法在负载下会读到写盘前的文件）；
  `autolearn-test.mjs` 的 50ms 负等待换成 `quietAfterSettle`。
- **保留**：锁 deadline 测试（`a held claim cannot bypass the lock deadline`）本身在测 deadline，
  必须真实等待；它断言上界 <8s，属被测语义而非竞态窗口。
