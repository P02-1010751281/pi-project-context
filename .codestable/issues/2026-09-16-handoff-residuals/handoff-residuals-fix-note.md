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
- **m4（pre-existing，已于本轮修复，round 6 复审确认）**：`autolearn.ts` 的 `if (archived.size === 0 && !force) return;` 闸门原本在全部 9 个测试文件中都无检出力（变异为恒假后 `run-all` 仍 9/9 全绿）。修法：在 `tests/autolearn-test.mjs` 新增 **I 段** —— 独立 tmp 项目（`{autoLearn: true, autolearnAt: 0}`、材料/区间已到期、无归档会话）+ 第二个 pi 实例（`pi.exec` 按自身 cwd 定根，且单飞/throttle 状态不与主实例共享）+ 负探针（500ms 内不得调用模型）+ **正向对照**（放入一个归档会话后必须调用，防探针因 pass 根本跑不起来而假绿）。+34 行。
  - 变异矩阵（round 6 三档负载复核）：变异 archived 闸门 → I 段两条红（唯一）；变异开关 → 全绿（该项目开关即 true，非本探针职责）；变异 changed/due → 仅 H 段两条红、I 段绿 ⇒ 三段探针与三道闸门一一正交，无误报。
  - 复审 minor 已处置：正向对照前 `emptyProjectCalls = 0`（防“迟到调用喂饱对照”）；注释改为真实原因（单飞/throttle + cwd 定根，不再提“fresh config cache”）。
  - **接受的残余（round 6 实测边界）**：若模型调用延迟 >500ms（实际 5–20ms，余量 25–100×），I 段可漏检；彻底修需暴露 pass 完成信号（`active`），成本不划算。另：`agent_settled` 的 fire-and-forget 写与 `rm(tmp2)` 竞争，在 32 hogs + 破闸门变异时可留 `/tmp/pi-autolearn-empty-*`（仅含 `INDEX.md`）—— 纯 /tmp 卫生，且该 fire-and-forget 模式在 H/archive 段已存在，pristine 常规不可复现。
- **孤儿结果为有损剔除**：内容进摘要（模型摘要可能压缩细节），回放不含它；这是为 provider 结构合法性付的代价，已在 analysis 记录。
- **轮内切分有意的语义变化**：见 §2；若 owner 认为「整轮回放」更可取，可用 `handoffKeepTokens: 0`（summary-only）或回退该 commit 的切点逻辑。

## 7. 发布记录（v0.1.5）

| 项 | 值 |
|---|---|
| 代码提交 | `093dbf3`（三残余 + 4 轮复审产物）、`98aeedf`（m3 修复 + 第 5 轮产物） |
| 注解 tag | `v0.1.5` → tag 对象 `79b8c8f`，指向 `98aeedf` |
| 远端 | Forgejo + GitHub 镜像的 `master` 均为 `98aeedf`；tag 两处均有（推送时镜像出现过一次瞬时断连，重试后成功） |
| 安装切换 | `~/.pi/agent/settings.json` pin `@v0.1.4` → `@v0.1.5`（备份 `/tmp/settings.json.before-v0.1.5-20260916-090918`，1452 B）；`pi update --extensions`（非 `pi update`，避免误升 CLI） |
| 已装副本 | `/home/user/.pi/agent/git/git.lentech.site/C02-1010751281/pi-project-context` HEAD = `98aeedf`，工作树干净，`handoff.ts` 含 `SPLIT_TURN_MARKER`×4 / `droppedOrphans`×6（`git describe` 因无本地 tag 对象显示 `v0.1.0-26-g98aeedf`，按 commit 核对）。`pi list` 显示 `@v0.1.5` |

### 真机 A/B（证据：`handoff-residuals-midturn-e2e.txt`）

场景：turn 1 用 `read` 读 ~60 KB 文件（单轮 toolResult ≈ 12.8k token）+ turn 2 小轮，`handoffKeepTokens=50`，`/auto-handoff now`。

| | 旧代码 `e71e693` | 新代码（已装 v0.1.5） |
|---|---|---|
| 结果 | `skipped: nothing older…`，**不交棒**，无 `HANDOFF.md` | `summarizing ~12.8k … keeping ~14 recent`，**交棒成功** |
| 新会话回放 | — | 含 `SPLIT_TURN_MARKER`，不含大 toolResult |
| 附带复核 | — | 脚手架为中文（v0.1.4 的 `handoffLanguage: auto` 仍生效） |

注：新代码那一跑**不带 `-e`/`-ne`**，走 settings 已装包，因此这条同时也是「部署生效」的证明。RPC 路径不触发 TUI 自动阈值，故用 `/auto-handoff now`（force，同一条 `runHandoff`）；自动阈值路径已由早前的 pexpect 真 TUI 跑验证。

### 未在本轮完成

- 运行中的 pi 进程（pid 3100210，启动于 09-16 16:36）仍跑 v0.1.4 代码：重启后才吃到 v0.1.5。
- **m4** 已修（见 §6），但**尚未提交**：工作树内 `tests/autolearn-test.mjs` +34 行待 owner 决定是否提交/额外发布。
