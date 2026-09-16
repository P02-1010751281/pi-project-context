---
doc_type: issue-fix
issue: 2026-09-16-handoff-residuals
status: confirmed
path: quick
fix_date: 2026-09-16
related: [handoff-residuals-report.md, handoff-residuals-analysis.md, handoff-residuals-review.md]
tags: [handoff, tests, flakiness]
---

# handoff 记录在案残余 修复记录

触发：owner 指令「残余处理掉」（2026-09-16）。三条残余全部收口；后按 owner 指令「做了」又关闭了 m3（测试缺口）。`git diff --stat`（v0.1.5 前）= 6 files, +395/−103；m3 增量另计 +11/−1。

## 1. 改动文件

| 文件 | 内容 |
|---|---|
| `extensions/project-context/handoff.ts` | R1：切点不再回退到轮起点（直接用 `findCutPoint` 的 `firstKeptEntryIndex`）；新增 `SPLIT_TURN_MARKER` + `USER_FACING_ROLES`；`replayMessagesFor(entries, droppedOrphans?)` 按 `toolCallId` 剔除孤儿 toolResult 并把它们交回调用方；`runHandoff` 把孤儿结果折入摘要输入、`olderTokens` 只算前缀（避免双重扣减） |
| `tests/handoff-test.mjs` | R1/R2：轮内切分与孤儿结果的纯函数断言；SDK stub（jiti alias 影子化 `generateSummaryWithUsage`）+ `newSession` mock 的调用点钉住（两个端到端场景：轮内切分、孤儿折入） |
| `tests/harness.mjs` | `waitUntil`（支持异步谓词）、`loadNamespace/loadDefault` 的 alias 覆盖、`makeSessionManager.appendMessage`、`contentEntry`/`toolResultEntry` |
| `tests/consolidation-test.mjs` | R3：4 处固定等待 → 确定性嵌套竞争 + 事件循环屏障 |
| `tests/switches-test.mjs` | 复审发现的 flake：5 处固定 sleep → 条件等待/有界负向探针；`MEMORY.md rewritten` 改为等文件内容 |
| `tests/autolearn-test.mjs` | 同类：50ms 负等待 → `quietAfterSettle` 有界负向探针 |

## 2. R1：单轮超大不再阻断交接

- 旧行为：`isSplitTurn` 时把切点拉回该轮起点 ⇒ 单轮超出 keep 预算时 `olderMessages` 为空 ⇒ 直接 return（真机 54k 会话、单轮 4×12.8k toolResult 即此形状）。
- 新行为：直接采用轮内切点（pi 的切点从不在 toolResult 上，故回放仍可解析），被切掉的前缀进入摘要；若回放块以非 user 角色开头，则补一条 user 角色的 `SPLIT_TURN_MARKER`。
- **语义变化（有意）**：keep 预算从「整轮为单位的上界」变为「按预算截断 + 前缀进摘要」。过去「整轮保留」会让实际回放远超预算，现在预算语义诚实；代价是大轮的尾段会与摘要并存（不重复：尾段在回放、前缀在摘要）。
- **孤儿结果**：切点可落在 `branch_summary`/`compaction` 条目上而把某个 toolResult 与其已进前缀的 toolCall 分开。这类结果在回放里非法，现按 `toolCallId` 匹配整体剔除并**折入摘要输入**（内容不丢）。round 3 复审给出了端到端反例，round 4 复核确认闭合（变异去掉折入 → 断言红）。

## 3. R2：调用点钉住

- 注入路径：harness 支持 alias 覆盖 → 测试在 tmp 生成 `export * from "<pi>/dist/index.js"; export async function generateSummaryWithUsage(...) { return globalThis.__handoffStub(...) }`，ESM 显式导出优先于 `export *`，只影子化这一个符号。
- 配合 ctx 上的 `newSession` mock（捕获 `setup()` 的 `appendMessage` 回放 + replacement ctx 的 notify/sendUserMessage），钉住：
  1. 摘要输入是「切掉的前缀（含大 toolResult）+ 折入的孤儿」，且不含被保留的近期消息；
  2. `summaryFocus(language)` 随会话语言（older 英文 + carried 中文 ⇒ zh）；
  3. 模型返回的英文模板标题在进入 prompt 前已被 `localizeSummaryHeadings` 映射；
  4. 回放是切后 slice、首消息为 marker、角色序列 `user,assistant,user`、孤儿不进回放；
  5. `HANDOFF.md` 落盘内容同样是本地化后的摘要。
- 变异矩阵（独立复审执行）：去掉 `localizeSummaryHeadings` 调用点 → 红；`languageMessagesFor(older, [])` → 红；去掉孤儿折入 → 红；收集器不 push → 红；回放不丢孤儿 → 红；不插 marker → 红。
- 诚实边界（round 3 N2）：`carriedMessages` 与 `keptMessages` 在可达场景下语言结果等价，该细化**故意不断言**；测试注释与 analysis 已相应收窄表述。

## 4. R3：竞态窗口与 flake

- 串行化断言改为**确定性嵌套竞争**：持锁者在自己临界区内启动 followers/contenders，再让出 3×(`setImmediate`+`setTimeout(0)`)；「持锁者仍在临界区内」或「并发进入」即判定重叠。round 1 的 all-attempted 屏障被复审判定空转（计数在调用前同步自增），已废弃。
- 诚实边界：进程内窗口无法击败**任意延迟**的旁路。实测真实串行化失败（无锁立即进入 / 无锁 `setTimeout(0)` 延迟 / 锁提前释放）8/8–12/12 捕获，正确锁 15 次 0 假红；**互斥权威是跨进程探针**（3 子进程 + 共享日志，稳定红灯）。
- `switches-test.mjs` 的负载 flake（复审发现，pre-existing）：`memory on consolidates` 等到 modelCalls 后立刻读文件，写入尚未落盘 ⇒ 改为等文件内容；5 处固定 sleep 换成条件等待/有界负向探针。
- 保留的唯一真实等待：锁 deadline 测试（本身在测 deadline，断言上界 <8s）。

## 5. 验证矩阵

| 层 | 结果 |
|---|---|
| 全量套件 | `node tests/run-all.mjs` **9/9**，空载 ×6、8–32 hog 负载 ×5 全绿（round 3/4 复审各自复跑） |
| handoff 断言 | 79 → **103**（含 9 条孤儿/轮内切分断言） |
| 变异自检（本人 + 复审） | 旁路锁 → 串行化断言红；`=== "assistant"` 收窄 → 孤儿断言红；去掉折入 → 摘要断言红；`stealStaleLock` no-op → 硬失败 |
| 独立复审 | lane A ×4 轮，均在 `/tmp` 只读沙箱副本，进入/退出 `git status` + 全仓库文件清单 diff **0 行**（四轮均零写入） |
| 时长 | consolidation ≈7.0s、switches ≈1.5s（60s/文件超时内） |

## 6. 残余与已知边界

- **m3（已于本轮修复，round 5 复审确认）**：`switches-test.mjs` 的负断言 `autolearn off: no scheduled pass` 原本同时被「开关 off / archived=0 / changed / due」多道闸门保护，只变异 autolearn 开关时仍绿。修法：`off autolearn` 提前到第一次 settle 之前；模型桩新增按提示词区分的 `learnCalls`；探针改为**累计**判定（`stayedQuiet(() => learnCalls > 0)`），使开关闸门与其它闸门彻底解耦。变异开关 → 探针红；变异 archived/due 闸门 → 预期绿（无假红）；`learnCalls` 全程 0。改动 +11/−1。
- **m4（pre-existing，未修，round 5 新发现）**：`autolearn.ts` 的 `if (archived.size === 0 && !force) return;` 闸门目前在全部 9 个测试文件中**都无检出力** —— 变异为恒假后 `run-all` 仍 9/9 全绿（与 m3 同类：探针被更靠前的闸门吸收）。建议修法：在 `autolearn-test.mjs` 加一条「有新材料 + due + 开关 on，但归档目录为空 ⇒ 不调用模型」的正面断言；修法明确、成本小，属另一子系统测试设计，需单独一轮复审。
- **孤儿结果为有损剔除**：内容进摘要（模型摘要可能压缩细节），回放不含它；这是为 provider 结构合法性付的代价，已在 analysis 记录。
- **轮内切分有意的语义变化**：见 §2；若 owner 认为「整轮回放」更可取，可用 `handoffKeepTokens: 0`（summary-only）或回退该 commit 的切点逻辑。
