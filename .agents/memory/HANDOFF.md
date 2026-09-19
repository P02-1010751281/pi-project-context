# pi 会话 01a0b746-4389-75fb-b815-6d33a28a1800 的交接文档

- 生成时间：2026-09-19T03:15:37.260Z
- 项目：/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context
- 会话日志：.agents/memory/session-logs/01a0b746-4389-75fb-b815-6d33a28a1800/session.md
- 会话索引：.agents/memory/session-logs/INDEX.md

## 目标
修复并验证：
- `MEMORY.md` 末行截断与 `maxMemoryChars` 透传。
- auto-handoff 阈值偏低并重新推导预算公式。
- `CONTEXT.md` 静默停更。
- 排查交接后模型回到 default。
- 完成 lane A 第 2 轮复审及真实 headless RPC 验证。

## 约束与偏好
- 不得擅自提交、推送、打 tag 或发版，等待 owner 明确指示。
- 提交信息须为英文：`type(scope): imperative summary`；文档/artifact 使用简体中文。
- lane A 必须在只读 `/tmp` 沙箱运行，并校验 `git status --porcelain`。
- handoff 改动完成后必须按 `.agents/skills/pi-project-context-headless-rpc-handoff-validation/SKILL.md` 做真实 RPC 验证。
- 偏好最小、根治、不留隐患的改动。

## 进展
### 已完成
- [x] 实现 `maxMemoryChars` 显式透传、整行截断、marker、幂等处理；删除进程级 `setMemoryCharLimit`/`memoryCharLimitValue`。
- [x] 修复 `CONTEXT.md` 缺失/未闭合时的 `recovered` trace。
- [x] 重写 `resolveThreshold()`：窗口比例下限、摘要模型窗口/tier/usable 上界及 `Threshold.bound` 状态说明。
- [x] handoff staging 时 `ctx.model` 缺失现在写入 `errors.log`，明确提示 successor 会使用 default model。
- [x] 修复 legacy OMP migration 漏传 cap：
  - `migrateProjectState(projectRoot, limit)`
  - `consolidate.ts` 从 `getConfig(projectRoot).maxMemoryChars` 读取并传入。
  - 同时传入 `decodePoisonedMemory` 与 `recordMemoryDocument`。
- [x] 修复 poisoned JSON 与 cap 同时发生时通知/命令回复吞掉 cap 诊断的问题。
- [x] 新增迁移 cap、tier bound、usable-window status suffix 等测试。
- [x] 变异验证通过：删除 migration caller 或 writer 的 limit 透传，各击中 1 条目标断言。
- [x] 定向测试通过：
  - `handoff`: 148 条 OK
  - `consolidation`: 236 条 OK
  - `sync`: 29 条 OK
- [x] `node tests/run-all.mjs`：9/9 通过。
- [x] lane A 第 2 轮完成：无 blocking；发现的 migration important 已修复。
- [x] 复审 artifact 已更新：
  - `.codestable/issues/2026-09-18-memory-cap-and-adaptive-threshold/memory-cap-and-adaptive-threshold-review.md`
  - `...-fix-note.md`
  - `...-review-round2-independent.txt`
- [x] `git diff --check` 通过，残留引用搜索无结果。

### 进行中
- [ ] 按 headless RPC skill 执行真实 sandbox handoff 验证，并检查 `HANDOFF.md`、memory artifacts、session/model 记录。
- [ ] 根据 RPC 验证结果更新 artifact 和最终报告。

### 受阻
- 无硬阻塞。真实 RPC 需要可用的 provider/model 认证与正确 JSONL 输入协议。

## 关键决策
- **阈值以 `handoffThresholdRatio × window` 为自适应下限**：避免 1M 窗口被绝对 target 锁在约 6–10%。
- **摘要窗口 cap 无条件生效**：`prefixRoom = max(MIN_SUMMARIZE_TOKENS, summarizerWindow - SUMMARY_OUTPUT_RESERVE_TOKENS)`。
- **`Threshold.bound` 只记录最终严格更小的 cap**：与原 `Math.min` 数值语义一致，同时让 status 解释低阈值原因。
- **无法从 `ctx.model` 缺失推断 provider/model**：不伪造 fallback ID，只记录明确错误。
- **不引入第二套 tokenizer 或分块摘要**：当前 prefix budget 保守但可接受。
- **非 successor 的 `reason !== "new"` 静默 return 保持不变**：属于既有保护路径。

## 下一步
1. 创建临时 sandbox，按 `SKILL.md` 使用：
   ```bash
   pi --mode rpc -ne -ns -nt --thinking off \
     -e /run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/index.ts \
     -- <prompt>
   ```
2. 通过 JSONL RPC 驱动足够会话内容，必要时在 sandbox 配置中降低 `handoffKeepTokens`/阈值，使 handoff 真正触发。
3. 检查 sandbox `.agents/memory/HANDOFF.md`、`MEMORY.md`、`memory.jsonl`、`errors.log`，以及 session JSONL 中的 `model_change`。
4. 记录 RPC 命令、输出摘要与是否成功恢复模型。
5. 再运行 `node tests/run-all.mjs`，核对 `git status --short` 与 `git diff --check`。
6. 更新 review/fix-note/report，向 owner 汇报；不要提交或发布。

## 关键上下文
- 仓库：`/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context`
- 当前分支/HEAD：`master` / `0586d47`
- 尚未提交、推送或发版。
- 关键函数：
  - `extensions/project-context/project-state.ts::migrateProjectState`
  - `extensions/project-context/consolidate.ts`
  - `extensions/project-context/handoff.ts::resolveThreshold`
  - `extensions/project-context/handoff.ts::restoreHandoffSessionSettings`
- lane A 第 2 轮复审结果：`EXIT=0`、9491 bytes、无 blocking。
- RPC 文档：`/home/user/.local/lib/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`
- skill：`.agents/skills/pi-project-context-headless-rpc-handoff-validation/SKILL.md`
- 最近已确认 RPC 协议为严格 JSONL；应读取 `rpc.md` 的 prompting/command 格式后再执行。

<read-files>
/home/user/.agents/skills/pi-project-context-headless-rpc-handoff-validation/SKILL.md
/home/user/.agents/skills/ponytail/SKILL.md
/home/user/.local/lib/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.agents/skills/pi-project-context-headless-rpc-handoff-validation/SKILL.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.codestable/issues/2026-09-18-memory-cap-and-adaptive-threshold/memory-cap-and-adaptive-threshold-report.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.codestable/issues/2026-09-18-memory-cap-and-adaptive-threshold/memory-cap-and-adaptive-threshold-review-round2-independent.txt
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/README.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/config.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/index.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/tests/harness.mjs
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/README.md
</read-files>

<modified-files>
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.codestable/issues/2026-09-18-memory-cap-and-adaptive-threshold/memory-cap-and-adaptive-threshold-fix-note.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.codestable/issues/2026-09-18-memory-cap-and-adaptive-threshold/memory-cap-and-adaptive-threshold-review-round2-prompt.txt
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.codestable/issues/2026-09-18-memory-cap-and-adaptive-threshold/memory-cap-and-adaptive-threshold-review.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/consolidate.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/handoff.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/project-state.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/tests/consolidation-test.mjs
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/tests/handoff-test.mjs
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/tests/sync-test.mjs
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/tests/sync-test.mjs
/tmp/migrate-cap-mutations.mjs
/tmp/mutate3.mjs
</modified-files>
