---
doc_type: issue-review
issue: 2026-09-18-memory-cap-and-adaptive-threshold
status: confirmed
path: quick
created_at: 2026-09-18
rounds: 2
related: [memory-cap-and-adaptive-threshold-report.md, memory-cap-and-adaptive-threshold-fix-note.md, memory-cap-and-adaptive-threshold-review-round2-prompt.txt, memory-cap-and-adaptive-threshold-review-round2-independent.txt]
tags: [memory, truncation, maxMemoryChars, context, handoff, threshold]
---

# 记忆截断 + auto 阈值偏低 修复 Review

## 审查方式

- lane A：独立 `pi -p --no-session --no-extensions --no-skills --no-prompt-templates --tools read,bash --provider deepseek --model deepseek-v4-pro --thinking off`，
  在 `/tmp/mca-review` 只读沙箱副本上运行（`rsync -a --exclude node_modules` 整份工作树，含 `.git` 与未提交改动；`.agents/memory/session-logs/` 也在内，
  因此沙箱 `git status` 与仓库一致）。
- 零写入校验：进入/退出 `git status --porcelain` 12 行逐字比对（**一致**）；复审自建的探针只落在 `/tmp`，未触碰仓库。
  md5 基线复检时 `autolearn/config/consolidate/handoff/index/project-state` 六个文件「不符」属预期：它们是复审**之后**按 I1–I3/M1/M2 做的修复；
  复审期间未再改动的 `archive/context-doc/import-archive/llm` 等 md5 逐字节一致。
- 转录：`memory-cap-and-adaptive-threshold-review-round1-independent.txt`；prompt 入库（`…-review-prompt.txt`）。

## 轮次记录

| 轮次 | 结论 | 发现 | 处置 |
|---|---|---|---|
| 1 | **无 blocking**（三处改动的幂等性/自洽性/四路径一致性通过） | important ×3：I1 摘要模型窗口 ≤ `SUMMARY_OUTPUT_RESERVE_TOKENS` 时输入封顶被**静默跳过**（阈值可远超 aux 输入能力）；I2 `setMemoryCharLimit` 把「配置→限制」变成进程级可变状态，靠调用顺序保证、并发即串味；I3 `truncated` 把「对象未闭合」与「stray member / 畸形 JSON」混为一谈，errors.log 会说「被截断」而非「畸形」。minor ×6：M1 README「硬上限」与 marker 使文件实际超限不符；M2 marker 前缀过宽会误吃相似内容行；M3 `setMemoryCharLimit` 的 clamp 分支不可达；M4 `floor < usable ≤ floor+4000` 窄带返回 undefined；M5 `maybeTrigger` 每轮 settle 调 `resolveAuxModel` 带通知副作用；M6 reserve 语义偏保守（多扣 ~6.5k 输入余量） | I1/I2/I3 本轮修（见下）；M1/M2 修；M3 随 I2 消失；M4/M5/M6 明确接受（理由见 fix-note §7） |

## 复审指出的「本轮引入的新风险」

1. I2：隐式进程级限制 → 已改为**显式参数透传**（`normalizeMemoryDocument` / `foldMemoryJournal` / `memoryComparisonKey` / `loadMemory` / `recordMemoryDocument` 都带 `limit`），
   `getConfig` 不再写任何全局状态。
2. I1：小 aux 窗口下封顶失效 → 去掉 `if (prefixRoom > 0)` 分支，`prefixRoom = max(MIN_SUMMARIZE_TOKENS, summarizerWindow − SUMMARY_OUTPUT_RESERVE_TOKENS)`，
   摘要模型装不下连最小前缀时，阈值就停在最小前缀（而不是整个窗口占比）。
3. M1：README 宣称的「硬上限」与实测不符 → 文档改为「正文上限，marker 行不计入」。

## 复审后的改动与验证

- 全文测试：`node tests/run-all.mjs` **9/9 通过**（当时 handoff 143 断言、consolidation 236 断言；后续最终树为 handoff 148、consolidation 240、sync 29）。
- 新增/加强探针：`a summarizer below the output reserve still bounds the threshold`（I1）、
  `a look-alike line is not mistaken for the marker`（M2，初版探针被复审思路识破后改为「原样返回且位置不变」的强断言）、
  `an explicit limit caps the document`（I2 改为显式参数后的对应探针）。
- 变异矩阵（8 项，全部只红目标探针）：M1 下限 4 红、M2 摘要封顶 2 红、M3 整行截断+marker 9 红、M4 marker 形状校验 1 红、
  M5 `recovered` 标记 2 红、M6 省略 context trace 2 红、M7 写入未传 cap 1 红、M8 命令回复 cap 文案 1 红。
- 第 2 轮已按「无 blocking 后仍有阈值边界/限制透传逻辑改动」的约定完成，结果见下节。

## 第 2 轮：budget / handoff restore / cap 透传复审

- 复审命令仍是 lane A：`pi -p --no-session --no-extensions --no-skills --no-prompt-templates --tools read,bash --provider deepseek --model deepseek-v4-pro --thinking off`；沙箱 `/tmp/mca-review2`，转录 `memory-cap-and-adaptive-threshold-review-round2-independent.txt`，`EXIT=0`，9491 bytes。
- 沙箱零写入：开始/结束 `git status --porcelain` 一致；复审自建文件只在 `/tmp`。复审快照后的正式树修改另行记录，不伪装成复审覆盖。
- 结论：**无 blocking**；独立复审实测 `node tests/run-all.mjs` → 9/9 通过。
- Important：`migrateProjectState` 的 legacy OMP memory 分支未传项目 `maxMemoryChars`，导致配置 5000 仍可能按默认 32000 导入。已修：session_start 由 `getConfig(projectRoot).maxMemoryChars` 传入 `migrateProjectState`，再传至 `decodePoisonedMemory` / `recordMemoryDocument`；`sync-test.mjs` 新增真实 session_start 迁移 cap 回归。
- Minor 处置：修复 `statusText` 格式换行；更新 aux summarizer window 注释；把无区分度的 `clamped` 测试改为默认 cap 断言；新增 `tier` bound 与 `usable` suffix 探针；poisoned + capped 同时发生时通知/命令回复不再吞掉 cap 诊断。
- Minor 接受：会话/摘要模型 tokenizer 差异使 prefix budget 为保守 token 近似；不在本 issue 引入分块摘要或第二套 tokenizer。非 successor 的 `reason !== "new"` 静默 return 是既有保护路径，保持不动。
- 复审快照后的硬化：staging 时 `ctx.model` 缺失现在写 errors.log，说明 successor 只能保留 thinking、会沿用 pi default；没有可可靠的 model getter，因此不伪造 fallback ID。
- 真实 headless RPC：付费路由先后受 402/429/credits 阻断；改用已认证的 Command Code free 模型后完成 handoff。`/tmp/pi-project-context-real-rpc-pgqde64t` 中生成了 `HANDOFF.md`、两条 `memory.jsonl` replace、memory backup 与更新后的 `CONTEXT.md`；successor session 的 `model_change` 从默认 `poolside/laguna-s-2.1-free` 恢复到 staging 的 `inclusionai/ling-3.0-flash-sante:free`，无 errors.log。
