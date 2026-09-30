# pi 会话 01a0f19c-40e0-75f6-9452-fa8df68590f0 的交接文档

- 生成时间：2026-09-30T10:01:36.698Z
- 项目：/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context
- 会话日志：.agents/memory/session-logs/01a0f19c-40e0-75f6-9452-fa8df68590f0/session.md
- 会话索引：.agents/memory/session-logs/INDEX.md

## 目标
- 修复两个项目（UniField、Quantum_Matrix）pi-project-context 扩展"频频报警"的问题，并按批准的 A+B 方案落地改进。
- 按最终确认的施工顺序实施：1) B1+B2/B3（降噪）；2) M1+M2+M6（闸门层）；3) S1+S3+M3/M4/M7（结构层+可见性）；4) S2+S5（单独立项）。

## 约束与偏好
- 用户选择方案 (b)：**不配置** `provider`/`model`（不做 A1），但保留"连续失败自动停用本次会话"兜底（并入 B2 冷却逻辑）。
- 改动需附带各自测试。
- M2/M5 动到记忆/压缩协议边界，按项目惯例需走 `.agents/skills/pi-project-context-sandboxed-independent-review` 独立只读评审。
- S 层会改变记忆对外形态，需向后兼容已有自由结构（不能重排导致丢事实）。
- 用简体中文回复。

## 进展
### 已完成
- 定位 "报警"：两个活着的 pi 进程 PID 3225（cwd=UniField）、PID 3278（cwd=Quantum_Matrix），均 11:22 启动。运行版本确认为 **v0.1.11**（pin `pi-project-context@v0.1.11`，已装 clone HEAD `ed2704c`），纠正了记忆里"跑 v0.1.10/旧进程"的过时信息。
- 报警清单：`[memory]/[autolearn] Error: model call error: Connection error / Request timed out`、`memory exceeded maxMemoryChars (32000)`、`adopted an externally edited MEMORY.md`（QM 141 次、UniField 28 次）。会话模型 = `commandcode-c02-1010751281 / deepseek/deepseek-v4.1-flash`。
- 根因：辅助模型回退到会话模型（`resolveAuxModel` in `shared/llm.ts`）；**autolearn 失败无退避**（03:13–03:19 六连发）；memory 有 5 分钟 throttle、handoff 有 `FAILURE_BACKOFF_MS`（`handoff/state.ts:10`）。
- 已完成 B1 + B2/B3 实现：
  - 新建 `extensions/project-context/shared/call-policy.ts`：`classifyModelFailure`、`noteModelFailure`、`noteModelSuccess`、`modelCooldownRemaining`、`modelAutoDisabled`、`modelBlocked`；常量 `AUTH_COOLDOWN_MS=30*60_000`、`QUOTA_COOLDOWN_MS=15*60_000`、`TRANSIENT_BASE_COOLDOWN_MS=5*60_000`、`TRANSIENT_MAX_COOLDOWN_MS=30*60_000`、`AUTO_DISABLE_AFTER=5`。
  - 改 `memory/pass.ts`：throttle 后加 `if (!force && modelBlocked("memory", projectRoot)) return cached?.outcome;`；`call()` 成功时 `noteModelSuccess`、失败时 `noteModelFailure`。
  - 改 `memory/report.ts`：新增 `memoryFailureNotice()`、`MEMORY_PAUSED_NOTICE`、`disablesAnnounced` Set，按失败类输出不同 toast 文案。
  - 改 `autolearn/pass.ts`：gate 加 `if (!force && modelBlocked("autolearn", projectRoot)) return;`；首个 `completeText` 成功后 `noteModelSuccess`；catch 加 `noteModelFailure`。
  - 新建 `tests/call-policy-test.mjs`（分类/冷却/退避/自动停用/autolearn 不重试/memory 退避端到端）。
  - `node tests/run-all.mjs` → **All 10 tests passed**。
- 修复了 `autolearn/pass.ts` 与 `tests/call-policy-test.mjs` 的缩进。

### 进行中
- [ ] 复核 B1+B2/B3 的最终 diff（`git diff --check` 已 clean；无本地 tsc，需注意类型）。

### 阻塞
- (无)

## 关键决策
- **报警确认口径**：两个项目 = UniField + Quantum_Matrix（扫描 Projects 下所有 `errors.log`，仅这两个 9-29/9-30 有报错，各 19 条）。
- **根因分层**：结构无关（M1/M2/M6/M7：预算注入、压缩阶段、粘性 marker、上限对齐）vs 结构有关（S1–S4，S5 终极形态）。
- **结构证据**：UniField 27604 字符/11 节/101 bullet（49 条 >200 字符，均长 269，知识库风格）；QM 11009 字符/5 节/50 bullet（索引风格）。0 条完全重复 → 靠"只增不删"膨胀。
- **内存易触顶原因**：prompt 只写 "below 6000 words"、`maxMemoryChars` 从未注入；cap 只在写路径砍尾（`clipToLineBoundary`）；整篇重写；marker 会粘住；32000 中文字≈16k–32k token 撞 `MAX_ADAPTIVE_OUTPUT_TOKENS=32768`。
- **检测到 `MEMORY.md` 与 journal 分叉**（QM 17:25 render=17998 而 journal 最新=11009；UniField render=27604 而 journal=18751），源于扩展外写入者（手改/`git checkout HEAD -- .agents/memory/MEMORY.md`）。

## 下一步
1. 完成 B1+B2/B3 diff 复核（含类型/缩进）；确认无回归（已 `run-all.mjs` 全绿）。
2. 进入 M1（把 `maxMemoryChars` 注入 `memory/prompt.ts`）+ M2（溢出即压缩第二阶段，复用 retry）+ M6（修粘性 truncation marker），附测试。
3. 再做 S1（固定最小 schema + 每节预算）+ S3（指针化约束）+ M3/M4/M7。
4. S2 + S5（增量 ops 协议）单独立项，走独立只读 sandbox 评审。

## 关键上下文
- 仓库根：`/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context`
- 当前 git 工作树改动：`.agents/memory/CONTEXT.md`、`.agents/memory/project-context.json`（M），以及本次新增/修改的扩展与测试文件。
- 关键常量/文件：`shared/limits.ts`（`MAX_MEMORY_CHARS=32_000`、`MIN_MEMORY_CHARS=4_000`、`MAX_MEMORY_CHARS_LIMIT=200_000`）、`shared/output-budget.ts`（`MAX_ADAPTIVE_OUTPUT_TOKENS=32_768`、`REPLY_OUTPUT_MARGIN_TOKENS=1024`、`RETRY_OUTPUT_HEADROOM_TOKENS=4096`）、`memory/document.ts`（`normalizeMemoryDocument`、`clipToLineBoundary`、`memoryTruncationMarker`）、`memory/input.ts`（`fitMemoryInput`）、`memory/store.ts:65`（adoption logError）、`shared/error-log.ts`（`MAX_ERROR_LOG_BYTES=1_000_000`）。
- 测试运行：`node tests/run-all.mjs`（10 个测试文件，60s 超时）；harness `tests/harness.mjs`（`loadDefault`、`loadNamespace`、`makeCtx`、`makePi`、`makeSessionManager`、`runHandlers`、`waitUntil`、`PC`）。
- 项目配置：UniField `maxMemoryChars=36000`；QM `maxMemoryChars=32000`；两者 `provider=""`/`model=""`、`consolidateTurns=6`、`consolidateIntervalMs=300000`、`autolearnTurns=20`、`autolearnIntervalMs=1800000`。
- 历史 cap 命中：UniField 2 次、QM 5 次；6 个归档带截断标记。
- 用户最后消息 "ok" 表示批准施工顺序并开始实施。

<read-files>
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/memory/store.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/shared/error-log.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/shared/notify.ts
</read-files>

<modified-files>
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/autolearn/pass.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/memory/pass.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/memory/report.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/shared/call-policy.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/tests/call-policy-test.mjs
</modified-files>
