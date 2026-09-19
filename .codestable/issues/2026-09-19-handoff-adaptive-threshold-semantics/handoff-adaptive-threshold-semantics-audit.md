---
doc_type: issue-audit
issue: 2026-09-19-handoff-adaptive-threshold-semantics
status: confirmed
audit_date: 2026-09-19
related: [handoff-adaptive-threshold-semantics-report.md, handoff-adaptive-threshold-semantics-analysis.md]
tags: [handoff, adaptive-threshold, audit, workspace]
---

# 审计：v0.1.8–v0.1.10 三次修复的状态盘点（owner 要求）

## 结论

三次修复（v0.1.8 内存渲染/阈值恢复、v0.1.9 consolidation 输出预算、本次 auto 阈值）在代码层面
分别自洽；「混乱」主要来自三处：**陈旧写进程**、**文档/记忆漂移**、**测试脚手架与状态文案的过时描述**。
本文件列出全部发现与处置，✅ = 本轮已修。

## 1. 陈旧写进程（最大混乱源）

- PID `367149`（`pi`）启动于 2026-09-18 22:14，cwd = 本仓库：它加载的是 **v0.1.7 时代**安装的扩展，
  早于 v0.1.8（09-19 15:11）与 v0.1.9（09-19 15:30）的安装。
- 证据：进程启动时间；`.agents/memory/*` 的 mtime（16:27 consolidation、16:42 HANDOFF）由该进程写入；
  `errors.log` 最后两条（06:36/07:11「carried no context section」）正是 v0.1.9 修复前的症状。
- 影响：
  - owner 看到的 `/auto-handoff status` 仍是 **pre-v0.1.8 的 64k 公式**——最初的投诉很可能来自这里；
  - live consolidation 没有 reasoning 预留与 finish-reason 处理，memory 渲染由旧 cap 逻辑写；
  - 工作树的修复对当前会话不生效。
- 行动：**重启该 pi 会话**才会加载 v0.1.9 + 本次改动；重启前不要用 live 行为判断修复。
- 相关 skill：`.agents/skills/pi-project-context-stale-writer-process-check`（本会话 autolearn 产出，
  与本条诊断一致）。

## 2. 修复轮次状态

### v0.1.8（`27f7043`）— 内存渲染/cap、阈值重写、设置恢复、poison 诊断

- 代码/测试保持通过；`resolveThreshold` 的 caps 与 `bound` 语义在本次 auto 目标改动后依然成立
  （summarizer / tier / usable 用例全绿）。
- 漂移：MEMORY.md 的 "Adaptive threshold formula" 与 "current code yields ~400K" 写的是
  v0.1.8/0.1.9 语义 → ✅ 已按新语义改写（窗口推导 + `summarize` 状态行）。

### v0.1.9（`0af9ec6`）— reasoning 预留 + finish reason + 截断重试

- 独立 review round1–round3 无遗留 blocking/important/minor；残余（无 structured output、
  不做分块摘要、reasoning 元数据缺失时保守）已记录，属接受项。
- autolearn 沿用 `MAX_SKILL_BODY_CHARS`（字符）作为 reasoning 预留基数——偏保守但安全，非缺陷。
- ✅ 无需改动。

### 本次（未发布）— auto = 保守拟合的拐点曲线

- ✅ 公式定为 `knee(W) = W − (W − 157000)·sigmoid(ln(W/450000)/0.04)`、
  `T0 = max(min(U − 4000, knee(W)), B + K + S)`；caps 只降不升。
- ✅ 曲线参数：K=157K 是 ≥1M 窗口 46 个模型的实测拐点中位（p25 127K / p50 157K / p75 190K）；
  Wc=450K 因为所有 500K+ 声明实测都虚高（grok-4.5/4.6 声明 500K 实测 ~195K，DeepSeek-V4.1-Flash /
  GLM-5.3 / Qwen3.8 声明 1M 实测 130–170K）。行为：≤400K 取自身边界（272K 93%、400K 95%）、
  500K 36%、600K 26%、768K 20%、1M 16%、≥1M 饱和 157K。此前「窗口末点」「纯比例」「硬夹取」
  「K=273K/Wc=650K」「纯平 157K 平台」都已撤回。
- ✅ `/auto-handoff auto` 不接受参数；`handoffThresholdRatio` 只服务固定模式（`/auto-handoff 0.6`
  → `60% of window`）。
- ✅ 测试与文档同步：wide 157,000（`auto 157k (16%)`，summarize 125,076）/ 400K 379,616 /
  768K 157,001 / 272K 251,616 / heavy 583,924 (`bound target`) / tier 120K → 116,000 /
  summarizer 128K → 127,156；`docs/handoff.md`、skill、`MEMORY.md` 已改。
- ⏸ 独立 review（lane A）：round #1 运行 53 分钟无报告（已终止）；变异矩阵 6/7 被杀，
  `auto 警告后仍写比例` 一项存活 → 已补「比例未落盘」断言并复验会红。
- ✅ 状态行原先改成 `summarize ≥64.0k`，在 usable cap 下会虚报（64k 窗口 + r 0.9 实际只有 23.6k）；
  现改为显示 `Threshold.summarizeTokens`（`tokens - baseline - keep`）的实际值；无 usage 时回退
  配置值 `target 64.0k`。
- ✅ `/auto-handoff target` 帮助文案改为 "minimum tokens summarized per handoff"。
- ✅ 测试：删掉 dead `floorPi` 加载；heavy 用例名去 stale；补 share 分支与 `summarize` 实际值断言。
- ✅ 文档：`docs/handoff.md`（公式 + 状态行语义）、`docs/configuration.md`（ratio/target 语义）、
  review skill（自适应 + 下限）同步。
- ⏸ 独立 review（lane A，`/tmp/pc-threshold-review` 沙箱）被 owner 叫停，未出报告；
  沙箱无写入（`git status` 前后一致）。review prompt 已更新到最终公式（自适应 + 下限），待 owner 允许后运行。

## 3. 工作区卫生

- 未跟踪对象（owner 决策）：
  - `.agents/skills/pi-project-context-memory-cap-truncation-triage/`（16:42 autolearn 生成，
    内容与 v0.1.8 cap 修复一致；建议提交）
  - `.agents/skills/pi-project-context-stale-writer-process-check/`（16:06 生成，内容与第 1 节一致；建议提交）
  - `.agents/memory/skill-candidates/pi-project-context-release-verification.md`（14:49 候选，待 approve/reject）
  - `.codestable/issues/2026-09-19-handoff-adaptive-threshold-semantics/`（本轮工件）
- 渲染文件：MEMORY.md ✅ 已按新语义修正两行；CONTEXT.md / HANDOFF.md 是会话快照，
  等重启后的 consolidation 重写（避免与旧写进程互踩）。

## 4. 仓库外（记录，不改）

- `pi-custom-providers` catalog：`scripts/refresh-catalog.mjs:181` 的 `familyMax("deepseek")=384000`
  把猜测/上下文尺寸写进 `maxTokens`（scnet `DeepSeek-V4-Flash-0731` 甚至 `maxTokens == contextWindow`）。
  仅在生成侧影响展示，pi 侧 `maxTokens` 只用于输出预留；列为可选后续。

## 5. 建议下一步

1. round 2 复验修复增量（新沙箱），通过后提交（英文 Conventional Commits；代码/文档/测试、memory render、issue 工件分开），
   打 tag v0.1.10，双推，bump pi-config pin，`pi update --extensions`，跑 settings 探针并记录证据。
2. owner 重启 pi 会话（PID 367149）加载新代码；否则旧进程会继续用旧语义重写 `.agents/memory/*`。
3. 决定 4 个未跟踪 autolearn skill 与 `.agents/memory/skill-candidates/` 的提交/拒绝。

## 6. 独立复审（round 1，2026-09-19）

- 沙箱 `/tmp/pc-threshold-review-v2`（`cp -a` 全量副本 + status/files 基线快照；事后两份 diff 为空 → 零写入）。
- 复审者：headless `pi -p`（`openai-codex/gpt-5.6-luna`，只读工具）；VERDICT **CHANGES-REQUESTED**，无 blocking。
- 转录：`handoff-adaptive-threshold-semantics-review-round1-independent.txt`；逐条处理见 fix-note §1「复审响应」与 §4。
- 修复已落地并复跑：9/9、`git diff --check` 干净；新增 tier 边界（floor+4000 → 39,924；低于 → undefined）与 `auto 0.7` 变异盲区用例。
- 本轮复审推翻/修正的自身旧结论：tier 门控 `>`、`summarizeTokens` 的「实际」措辞、`CONTEXT.md`/`HANDOFF.md` 快照陈旧、ratio 测试鉴别力。
- 残余风险见 fix-note §6（sub-40k auxiliary、预计值语义、单条消息不可切分）。
- round 2（聚焦增量，沙箱 `/tmp/pc-threshold-review-v3`）零写入、VERDICT **PASSED**（无 blocking/important/minor）；转录 `handoff-adaptive-threshold-semantics-review-round2-independent.txt`。
