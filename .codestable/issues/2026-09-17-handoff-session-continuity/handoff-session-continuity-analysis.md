---
doc_type: issue-analysis
issue: 2026-09-17-handoff-session-continuity
status: open
path: quick
created_at: 2026-09-17
related: [handoff-session-continuity-report.md]
tags: [handoff, session, settings, ui]
---

# handoff 后会话设置丢失与会话树过深 分析

## 1. 根因 A：`newSession` 不继承 model/thinking

代码级证据（pi 0.1.x 已装包）：

- `ctx.newSession(options)` 只有 `{ parentSession?, setup?, withSession? }`，**没有 model/thinking 选项**
  （`docs/extensions.md:1139`、`dist/core/extensions/types.d.ts:254` 起）。
- `dist/core/agent-session-runtime.js:147` `newSession()`：新建 `SessionManager` → `createRuntime({cwd, agentDir, sessionManager, sessionStartEvent})`
  ⇒ 新会话的模型/思考等级由**配置默认**解析，与旧会话无关。
- `setup(sm)` 在 `createRuntime` **之后**执行，且随后只做 `agent.state.messages = buildSessionContext().messages`
  —— 只重建消息，**不会**据 `setup` 写入的 `model_change`/`thinking_level_change` 改活会话的状态。
  因此"在 setup 里补条目"不足以修复活会话（只在以后 resume 该文件时生效）。
- 设置只能经扩展 `pi` API 写：`pi.setModel(model)`（`docs:1704`，内部 `appendModelChange`）
  与 `pi.setThinkingLevel(level)`（`docs:1718`，内部 `appendThinkingLevelChange`，会按模型能力 clamp）。
- **会话替换后旧的 `pi` / 旧 command `ctx` 是 stale，使用会抛错**（`docs:1265` 起 "stale after replacement"）；
  `withSession(ctx)` 拿到的是 `ReplacedSessionContext`（`extends ExtensionCommandContext`），
  该类型**没有** model/thinking setter（已核 types.d.ts）⇒ 在 `withSession` 里也改不了。
- 生命周期（`docs:432`）：旧实例 `session_shutdown` → 重新 rebind → **新扩展实例**收到 `session_start`
  `{reason:"new", previousSessionFile}` → `setup` → `withSession`。
  ⇒ **唯一能改设置的时机是新实例的 `session_start`**（实测时序：`createRuntime` → `setup` 回放 → rebind/bindExtensions 发 `session_start` → `withSession` 发 kickoff，因此它晚于回放、早于首轮/续接提示词）。

由此：要延续设置，必须在切会话前把"纯数据"带过去（文档也建议只跨替换携带 strings/ids/serialized config）。
旧实例与新实例之间没有共享闭包，唯一可靠通道是磁盘（项目 `.agents/memory/`）。

### 修复方案 A（建议）

1. `handoff.ts`：`ctx.newSession` 之前捕获 `ctx.model`（`{provider,id}`）与 `ctx.thinkingLevel`，
   原子写 `.agents/memory/.handoff-session-settings.json` = `{previousSessionFile, model, thinkingLevel, at}`；
   若 `result.cancelled` ⇒ 删除该文件。
2. `index.ts` 的 `session_start` 处理：marker 存在 ∧ `event.previousSessionFile` 与 marker 记录一致 ∧ 新鲜（<10min）时，
   经 `ctx.modelRegistry.find(provider,id)` 解析 → `await pi.setModel(model)` → `pi.setThinkingLevel(level)`
   （**先模型后思考等级**，因为等级按模型能力 clamp）→ 删除 marker；`setModel` 返回 false（无鉴权）时只 warn，
   不阻断会话开始；整段 try/catch，绝不让 session_start 抛错。
3. 只对 handoff 生效：用户显式 `/new` 不带 marker，保持 pi 原生"新会话用默认设置"语义。

### 验收/测试计划（方案 A）

- `tests/handoff-test.mjs`：断言切会话前写了 marker（含正确的 provider/id/level/previousSessionFile），
  `cancelled` 路径删除 marker。
- 新增 session_start 用例（harness 的 `runHandlers(pi,"session_start",ctx,event)`）：命中 marker ⇒ 断言
  `pi.setModel`/`pi.setThinkingLevel` 调用参数；反例：`previousSessionFile` 不匹配 ⇒ 不调用；过期 marker ⇒ 忽略并清理；
  模型解析不到 ⇒ warn 不抛。
- harness 的 `makePi` 目前没有 `setModel`/`setThinkingLevel` ⇒ 补记录型桩。
- 变异验证：去掉 marker 写入 ⇒ 用例红；去掉 `previousSessionFile` 校验 ⇒ 反例红。

## 2. 根因 B：父链逐次加深会话树

- `dist/modes/interactive/components/session-selector.js:164` 按 `parentSessionPath` 构建**会话选择器树**。
- `handoff.ts` 每次都以 `parentSession = ctx.sessionManager.getSessionFile()` 新建会话（与 pi 官方
  `examples/extensions/handoff.ts:178` 同款写法）⇒ 每 handoff 一层。
- 自动 handoff 在长流程里触发频繁，深度线性增长（UniField 一天 7 层）。

### 方案选择（需 owner 拍板）

| 方案 | 深度 | 血缘 | 说明 |
|---|---|---|---|
| **B1（已采用，owner 2026-09-17 确认）根扁平**：`parentSession` = 该链的最早祖先（沿 parentSession 头读，设 hop 上限 ~32，失败回退直接父级） | 恒定 ≤2 | 保留（都挂到最初的根） | 会话选择器里同一工作流变成兄弟节点，不再套娃；偏离 pi 官方示例的"链式"写法。决策依据：threaded 视图全展开不可折叠、除 `parentSessionPath` 外无动作使用父链、链式下最新会话被埋在链底（`session-selector.js:186-201、433-440`） |
| B2 不设 parent | 1（各自为根） | 丢失 | 选择器里变成平铺的多条新会话 |
| B3 维持现状 | 线性增长 | 链式 | 即当前行为（owner 已反馈过深） |

两处修复互相独立：A 改设置传递，B 只改 `parentSession` 的取值。

## 3. 风险与边界

- marker 残留：切会话崩溃/失败时留文件 ⇒ 以 `previousSessionFile` 匹配 + 10 分钟过期 + `cancelled` 清理三重兜底；不匹配时只清理不应用。
- 两个 handoff 并发：扩展已有单飞（`active`）保护，marker 单条记录足够。
- 思考等级 clamp：先应用模型再应用等级；`pi.setThinkingLevel` 会把不支持的等级 clamp 到 "off"。
- 与既有测试约定一致：不引入固定 sleep；marker 时钟用注入的 `now` 或显式 `at` 便于测试过期分支。
