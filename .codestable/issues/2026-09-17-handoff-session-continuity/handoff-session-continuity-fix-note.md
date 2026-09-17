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
- 运行中的 pi 进程（含发起本 issue 的那个）在重启前仍跑 v0.1.5 代码：本修复只对新启动的进程生效。

## 6. 发布记录（v0.1.6）

| 项 | 值 |
|---|---|
| 代码提交 | `8a2e6e4`（代码 + 测试 + 本 issue 全部 artifact，14 files, +1102/−34） |
| 注解 tag | `v0.1.6` → tag 对象 `3a0a372`，指向 `8a2e6e4` |
| 远端 | Forgejo + GitHub 镜像的 `master` 均为 `8a2e6e4`，tag 两处均有（`git ls-remote` 双远端核对） |
| 安装切换 | `~/.pi/agent/settings.json` pin `@v0.1.5` → `@v0.1.6`（切换前的版本见 `pi-config` 仓库 git 历史；`/tmp` 临时备份已随 2026-09-17 清理删除）；`pi update --extensions`（非 `pi update`） |
| 已装副本 | `~/.pi/agent/git/git.lentech.site/C02-1010751281/pi-project-context` HEAD = `8a2e6e4`，工作树干净，`handoff.ts` 含 `handoff-session-settings.json`/`resolveHandoffParentSession`/`HANDOFF_SETTINGS_TTL_MS` ×5；`pi list` 显示 `@v0.1.6` |
| 已装副本真机复验 | 用同一探针的模式 `old`（不传 `-ne`，即加载 settings 里已装的包）：**11/11**（切换前同一探针为 4/11）——证据 `handoff-session-continuity-e2e-installed-v0.1.6.txt` |

## 7. 发布后跟进：`ensureMemoryGitignore` 重复 header（根治）

同步项目记忆时发现本仓 `.agents/memory/.gitignore` 里有两段相同的 `# project-context: local artifacts, do not commit`。

- **根因**：`ensureMemoryGitignore`（`project-state.ts:159-176`）把 `${MEMORY_GITIGNORE_HEADER}\n` 无条件拼在追加块之前 —— 首次建文件时正确，但后续某个版本给 `MEMORY_GITIGNORE_LINES` 增行时会把 header 再写一遍（正是 v0.1.6 新增 `handoff-session-settings.json` 那行的效果）。
- **修复**：`const header = lines.has(MEMORY_GITIGNORE_HEADER) ? "" : `${MEMORY_GITIGNORE_HEADER}\n`;` —— 只在 header 缺失时写；`missing.length === 0` 仍提前返回（幂等）；注释行与现有行均不丢。
- **验证**：`tests/consolidation-test.mjs` 新增 2 条探针（①预置 `header + memory.jsonl` → header 仍只 1 条、原有行保留、缺失行补齐；②预置无 header 的用户行 → header 只加一次且在原文之后）；把修复退回「总是写 header」的变异只让探针①变红（1 条，无旁带红）；`node tests/run-all.mjs` **9/9**。
- **独立复审**：lane A 第 3 轮（只读沙箱 `/tmp/pc-gitignore-review`，`git status` 前后 0 行差异；复审在沙箱内做过变异-还原，沙箱文件与仓库 md5 一致）——逐项 (a)-(d) 通过，**无 blocking**；逐状态核对（文件缺失/空文件/只有 header/无尾换行/CRLF/二次调用）均为幂等且不丢行，5 处调用点与文档无旧行为依赖。
- **接受残余（minor）**：用户手写 header 但**大小写不同**时会再添一条 header。预存行为、注释行对 gitignore 无影响；正确修正需另建一个大小写折叠的集合（与现有大小写敏感的忽略模式集合并存），不值得为此增代码。
- **发布状态**：本改动在 `v0.1.6` 之后（master 领先已装 pin 一个 cosmetic 提交）；已装 v0.1.6 不受影响，需等下次实质改动一并发版。

## 8. 收尾清理（2026-09-17）

- `/tmp`：删除本项目历次评审/探针留下的 658 项沙箱与转录（`pi-context-rev*`、`rev-handoff*`、`mutA..D`/`mutLock*`/`mutSwitch`、`rev-bypass`/`rev-mut`/`rev-negmut*`/`rev-oldref*`/`rev-probe`、`laneA*`、`rev7-bud-*`、`probe8..22`、`tui-e2e*`、`handoff-*`、`settings-e2e*`、`rev-round*`、`gitignore-review-*` 等），共约 **1.6G**（`/tmp` 4.8G → 3.2G）；结论性转录与探针均已入库，被删的只是可重跑副本。保留 3 个 `settings.json.before-*` 之外的其它项目的沙箱（`ciphercat-*`、`uf-ckpt.tgz`、`ccsw` 等）未动。
- 真实 session 目录里一个旧探针残留（`~/.pi/agent/sessions/--tmp-pc-real-run--`，84K）已删；`~/.pi/agent/git/` 三个包克隆干净；`~/.pi/agent/extensions/` 是用户自写的 3 个扩展（`loop-guard.ts`/`model-roles.ts`/`retry-command.ts`），保留。
- 仓库内扫描无 `*.tmp`/`*~`/`*.bak`/`*.orig`/`.DS_Store`/`*.broken-*`/`*.steal` 残留；`MEMORY.md` 备份按上限保留 5 份；`.codestable/issues/` 4 个 issue 的证据链按惯例保留，`features/2026-09-15-codex-project-context-port/` 由并行 Codex 会话持有、保留。
- 切换前的 `settings.json` 备份改为引用 `pi-config` 仓库 git 历史（见 v0.1.4/v0.1.5/v0.1.6 三处记录的更新）。

## 9. 后续收口：本 issue 记录的残余（2026-09-17）

owner 追问「不是还有个残余项没修复吗？」后，本 issue 里三条「接受/未修」项已在
`.codestable/issues/2026-09-17-recorded-residuals/` 收口（代码 + 探针 + lane A 复审）：

| 本 issue 的记录 | 处置 |
|---|---|
| §5 R1-F5：会话头首行 >64KB 时不扁平化 | 修：`readSessionHeader` 按 chunk 读到换行（先合并再解码），上限改为约束**行长**且接受「恰好等于上限」（另加 1MB 病态上限），80KB / 恰好 1MB / 1.1MB 三种边界各有探针 |
| §5 staging 与切换之间崩溃 → marker 残留到 TTL | 修：`reason === "new"` 且前驱不匹配即清（只有那一个前驱的继任者能消费 marker，留着无用）；原「留着等 TTL」的探针随语义变更改写 |
| §7 接受残余（minor）：手写 header 大小写不同会再添一条 | 修：header 判定改为大小写不敏感（忽略模式仍大小写敏感），并加「别的拼写不被重复」探针 |

同轮另修：`/project-context status` 新增 `Memory:`/`Context:` 两行（后者含 CONTEXT.md 更新时间），以及
CONTEXT.md 停更的根因（prompt 未写 context 键名 + 静默丢弃）。
