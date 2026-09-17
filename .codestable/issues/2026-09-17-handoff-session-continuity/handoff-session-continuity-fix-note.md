---
doc_type: issue-fix
issue: 2026-09-17-handoff-session-continuity
status: confirmed
path: quick
fix_date: 2026-09-17
related: [handoff-session-continuity-report.md, handoff-session-continuity-analysis.md, handoff-session-continuity-review.md]
tags: [handoff, session, settings, ui]
---

# handoff 设置继承与会话树扁平化 修复记录

触发：owner 现场反馈「handoff 后新 session 的模型设置又变成 default」「pi tree 层级变得异常的深」（2026-09-17）。
两个根因、两处修复；独立 lane A 复审两轮（无 blocking），真机 A/B 端到端验证通过。owner 于 2026-09-17 确认采用 B1（根扁平）。**本次提交含代码与全部 artifact，尚未推送**（等 owner 决定推送/发版）。

## 1. 改动文件

| 文件 | 内容 | 增量 |
|---|---|---|
| `extensions/project-context/handoff.ts` | 设置 staging/恢复 + 父链扁平化 | +约 200 |
| `extensions/project-context/index.ts` | `session_start` 调恢复（`--no-project-context` 跳过，异常吞掉不影响启动） | +6/−2 |
| `extensions/project-context/project-state.ts` | marker 进 `MEMORY_GITIGNORE_LINES`；`ensureMemoryGitignore` 导出 | +2/−2 |
| `tests/harness.mjs` | `makePi` 增加 `setModel`/`getThinkingLevel`/`setThinkingLevel` 记录桩与 `setModelResult` | +11 |
| `tests/handoff-test.mjs` | 新增 29 条断言（staging/扁平化/恢复/负例/gitignore/提前退出/抛错清理） | +约 190 |

合计 `5 files changed, 441 insertions(+), 34 deletions(-)`（含既有工作树内容；本次相关部分见 `handoff-session-continuity-e2e.mjs`、review 转录与 patch）。

## 2. 根因 A：`newSession` 不继承 model/thinking

- `ctx.newSession(options)` 只有 `{parentSession, setup, withSession}`，**没有** model/thinking 选项；替换会话由 `createRuntime` 按配置默认重建（`dist/core/agent-session-runtime.js:150-171`）。
- `setup()` 只重灌 `messages`；`withSession()` 的 `ReplacedSessionContext` 没有 setter；替换后旧 `pi`/旧 ctx stale。
- 唯一可用点：**新扩展实例的 `session_start`**（实测时序 `setup` 回放 → rebind/`bindExtensions` 发 `session_start` → `withSession` 发续接提示词）。
- 实现：
  - `stageHandoffSessionSettings()`（切换前）：把 `{previousSessionFile, model:{provider,id}, thinkingLevel, at}` 原子写入 `<project>/.agents/memory/handoff-session-settings.json`；写前 `ensureMemoryGitignore`；`result.cancelled` 或 `newSession` 抛错时清除。
  - `restoreHandoffSessionSettings()`（`session_start`）：guard（`reason==="new"` 且 `previousSessionFile` 非空）→ `getProjectRoot` → 读 marker → TTL（10 分钟）→ predecessor 相等 → **先清 marker 再应用** → `ctx.modelRegistry.find` → `pi.setModel` → `pi.getThinkingLevel` 比较后 `pi.setThinkingLevel`；与替换会话当前设置相同则跳过（避免每次 handoff 多写一条 `model_change`）。
  - 失败全部 fail-open 且可诊断：marker 不可读 → 当作无；模型解析不到/无认证/抛错 → 用户可见 warning（抛错另记 `logError "handoff:restore-model"`）；`setThinkingLevel` 抛错 → `logError "handoff:restore-thinking"`；staging 写盘失败 → `logError "handoff:stage-session-settings"`，不阻断交棒。
  - 只对 handoff 生效：用户 `/new`、`resume`、`fork` 不带匹配的 predecessor，一律不继承（保持 pi 原生语义）。

## 3. 根因 B：父链逐次加深会话树

- pi 的会话选择器按会话头 `parentSessionPath` 建树（`dist/modes/interactive/components/session-selector.js:164`），而每次 handoff 都挂当前会话为父级 ⇒ 每 handoff 一层。
- 实现：`resolveHandoffParentSession()` 沿会话文件首行（只读 64KB 头）走到**最早祖先**（hop ≤ 32、去环、读不到则回退当前会话），`newSession({parentSession: root})` ⇒ 深度恒定 2 层，血缘仍保留（同一工作流挂在最初根下）。
- 方案取舍证据（供决策复核）：选择器缩进 = 每层 3 字符（`session-selector.js:433-440`）、threaded 模式**全展开不可折叠**、全文除 `parentSessionPath` 外**无任何动作使用父链**（纯视觉）；父子排序按子树最新活动降序（`:186-201`），单链渲染顺序为旧→新，故链式下**最新会话永远在链底**且缩进随 handoff 次数增长。逐跳血缘另有更耐久载体：交接提示词「上一会话 id + 原始记录」、`.agents/memory/HANDOFF.md` 逐次归档、会话文件名 ISO 时间戳、回放尾部原文 ⇒ 树缩进不是唯一提醒。

## 4. 验证矩阵

| 层 | 结果 |
|---|---|
| 全量套件 | `node tests/run-all.mjs` **9/9**（改动前后各一次） |
| handoff 断言 | 新增 29 条（staging/keyed/gitignore/扁平化/恢复/等值跳过/负例/提前退出/取消/抛错）全绿 |
| 变异自检 | 九道闸门一一正交：m1→5 红、m2→2、m3→1、m4→2、m5→3、m6→1、m7→1、m8→1、m9→1；无假红、无恒真探针 |
| 独立复审 | lane A ×2 轮（`/tmp` 只读沙箱，两轮 `git status` 前后 0 行差异、无文件被写）；R1 无 blocking（important×2 + minor×4）→ 全部关闭；R2 closure 无 blocking、无新增 important |
| 真机 A/B | RPC、两次连续 handoff、`handoffKeepTokens=50`：新代码 **11/11**；已装 v0.1.5 旧代码 **4/11** |

证据文件：`handoff-session-continuity-e2e.mjs`（探针）、`handoff-session-continuity-e2e-fixed.txt`（新代码）、`handoff-session-continuity-e2e-installed-v0.1.5.txt`（旧代码对照）。

### 真机 A/B 明细（同场景：会话中途 `set_model deepseek/deepseek-v4-flash` + `set_thinking_level low` → `/auto-handoff now` ×2）

| 观测点 | 旧（已装 v0.1.5） | 新（本工作树） |
|---|---|---|
| 新会话 `model_change` | 只有创建默认 `deepseek-flash` | 默认 + **`deepseek-v4-flash`**（恢复） |
| 新会话 `thinking_level_change` | 只有创建默认 `max` | 默认 + **`low`**（恢复） |
| 替换会话实际状态 | 默认模型/`max` | `deepseek-v4-flash` / `low`（`get_state` 实测） |
| handoff #1 的 `parentSession` | 原会话 | 原会话（两者一致） |
| handoff #2 的 `parentSession` | **handoff #1 的会话**（树加深） | **原会话（根，深度恒定）** |
| staging 文件 | 不存在 | staging 后被消费，无残留 |

## 5. 残余与已知边界

- **会话头首行 >64KB 时不扁平化（R1-F5，接受）**：`SESSION_HEADER_BYTES=64KB`，截断导致 `JSON.parse` 失败 → 回退「挂当前会话」（= 旧行为）。会话头仅 `type/version/id/timestamp/cwd/parentSession`，无现实触发场景。
- **staging 与切换之间进程崩溃**：marker 残留，由 10 分钟 TTL + predecessor 匹配双重限制，且下次 handoff 会覆写；不产生错误继承。
- **同项目两个 pi 进程在同一瞬间各触发一次 handoff**：单文件 marker 可能被后者覆写，前者当次不继承（仅设置、不影响会话与回放）；实际需要两个进程在同一秒内交棒，影响面极小。
- **两个 handoff 之间用户手动 `/model`**：继承的是 staging 时刻（= 切换前）的设置，属预期语义。
- **`getProjectRoot` 仍会经 handoff 自身的 `session_start`（`syncConfig`）无条件跑一次**：既有行为、按 cwd 缓存（R2 记为信息性，未改）。
- 未提交：本修复在工作树内；已装副本仍是 v0.1.5 旧代码。运行中的 pi 进程继续跑旧扩展，需要提交/发版 + 重启才生效。
