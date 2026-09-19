# pi 会话 01a0b992-9ad4-75fb-b815-6da5d4bcd963 的交接文档

- 生成时间：2026-09-19T13:19:06.954Z
- 项目：/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context
- 会话日志：.agents/memory/session-logs/01a0b992-9ad4-75fb-b815-6da5d4bcd963/session.md
- 会话索引：.agents/memory/session-logs/INDEX.md

## 目标
- 修正 `pi-project-context` 扩展的自适应 handoff 阈值（auto）语义：auto 应落在模型**质量拐点**上，公式简单、模型无关、对新模型安全，不接受参数。
- 本轮具体产出：把拟合曲线改为「保守曲线 A」（K=157K / Wc=450K），同步代码/测试/文档/记忆/issue 工件，然后走独立 review → 发布 v0.1.10。
- 已完成的数据调研（Context Arena API、厂商技术报告、community 自测）沉淀为技术报告工件。

## 约束与偏好
- `/auto-handoff auto` 不接受参数；`handoffThresholdRatio` 只服务固定模式（`/auto-handoff 0.6`）。
- 公式要简单，不堆场景；caps 只降不升；文档用中文；提交信息英文 Conventional Commits。
- owner 明确否决：逐模型表（会过时）、覆盖机制 `handoffOverrides`、纯平保守平台 `min(W, 157K)`（对强 1M 模型过早）。
- owner 已授权 commit/tag/push/更新 `~/.pi`；不新增 `package.json`；目录仓库（`pi-custom-providers` 等）改动不属本任务。
- 独立 review 必须在只读沙箱 `/tmp/pc-threshold-review` 进行，不得改动仓库沙箱。

## 进展
### 已完成
- owner 决策「保守曲线 A」：`K=157_000`、`Wc=450_000`、`s=0.04`（备选 B=200K/500K 未采用）。
- `extensions/project-context/handoff.ts`：常量改为 `KNEE_ASYMPTOTE_TOKENS = 157_000`、`KNEE_TRANSITION_TOKENS = 450_000`、`KNEE_TRANSITION_STEEPNESS = 0.04`，注释重写（人群 p50、Wc=450K 依据、被替换的 273K/650K 拟合、刻意保守说明）。`kneeTokens()` 形式不变；`resolveThreshold` 逻辑不变。
- `tests/handoff-test.mjs` 钉值更新并全绿：wide(1M) → `157_000` / `auto 157k (16%)` / summarize `125_076`；272K → `251_616`；400K → `379_616`；768K → `157_001`；heavy(usage 512K) → `583_924`（bound `target`，summarize `64_000`）；tier 夹具 200K 档 → `120_000` 档 → `116_000`（bound `tier`）；summarizer 夹具 200K → `128_000` → `127_156`（bound `summarizer`）；quiet fixture usage `200_000` → `120_000`（percent 12）并改注释。
- 验证：`node tests/run-all.mjs` → **All 9 tests passed**；`git diff --check` 干净；`HANDOFF_DEBUG` 无残留。
- 文档/记忆已更新：`docs/handoff.md`（纯文本公式、LaTeX、含义条目、状态行样例）、`docs/configuration.md`（L77 说明）、`.agents/memory/MEMORY.md`（adaptive threshold 描述、rejected alternatives、design references、状态行样例、pinned test values、regression signature）。
- issue 工件已更新：`handoff-adaptive-threshold-semantics-analysis.md`（§1 新增第 6 条、§2 新增推翻段落、§3 公式与行为、§4 数值表、§5 决策说明、§6 新增来源）、`handoff-adaptive-threshold-semantics-fix-note.md`（§1 常量与理由、测试条目、§2 数值表 + 历史对照）、`handoff-adaptive-threshold-semantics-review-prompt.txt`（公式、依据、行为、状态行样例、改动清单、review 第 4/7/8 项）。
- `handoff-adaptive-threshold-semantics-data-report.md` 已写好（§1–§12）：Context Arena 活接口结构、CSV 缺 `reasoning_mode` 的证据（gpt-5.5 五档 85.8/83.0/79.3/67.0/28.3 @128k）、OAI-MRCR 2/4/8 针（112 旧模型、与新站仅 1 个 slug 交集 `google/gemini-3-flash-preview`）、GraphWalks 404、外部测试评估、§11 厂商技术报告、§11.6 linux.do 的 V4.1-Flash 自测曲线。

### 已完成（本轮会话续跑）
- [x] ✅ `report.md`「期望」段已改为保守曲线（157K/450K）。
- [x] ✅ `audit.md` 公式与钉值已同步（含「本次（未发布）— auto = 保守拟合的拐点曲线」小节）。
- [x] ✅ `data-report.md` §12 已补「已决（2026-09-19，owner 选 A）」。
- [x] ✅ review skill `SKILL.md` 已核实并改为保守曲线（旧的 273K/650K 仅作为「已撤回」历史注记保留）。
- [x] ✅ 独立 review round 1 完成（新沙箱 `/tmp/pc-threshold-review-v2`，零写入已证明）：VERDICT CHANGES-REQUESTED，无 blocking；tier cap fail-closed、ratio 测试变异盲区、记忆/文档同步已修，复审转录已归档。

### 受阻
- 无硬阻塞。注意 live pi 进程 PID `367149`（v0.1.7 时代代码）会重写 `.agents/memory/*`，未重启看不到新行为。

## 关键决策
- **最终公式 = 保守曲线 A**：`knee(W) = W − (W − 157000)·σ(ln(W/450000)/0.04)`；`T0 = max(min(U−4000, knee(W)), baseline+keep+handoffTargetTokens)`；caps 依序 summarizer → first tier edge−4000 → U−4000，只降；低于 `baseline+keep+8000` 返回 undefined。
- **依据**：46 个 ≥1M 模型实测拐点 p25=127K / p50=157K / p75=190K；所有 500K+ 声明实测虚高（grok-4.5/4.6 声明 500K、家族 ~195K；V4.1-Flash/GLM-5.3/Qwen3.8 声明 1M、实测 130–170K）；≤~400K 诚实窗口（Codex 272K/400K、Claude 200K）保持不变；强模型（GPT-5.6 ~250K、Gemini 3.7 ~450K、GPT-6 ≥512K）刻意偏早。
- **否决项**：逐模型表、`handoffOverrides` 覆盖机制、纯平 `min(W,157K)` 平台、备选参数组 B(200K/500K)、旧的 273K/650K 拟合。
- 已知差异由固定模式承担：`/auto-handoff <ratio>` 仍是会话内手动杠杆。

## 后续步骤
1. ~~完成剩余工件同步~~ ✅ 已完成；~~核实 review skill~~ ✅ 已核实。
2. ~~重跑 `node tests/run-all.mjs` 与 `git diff --check`~~ ✅ 9/9、干净（复审修复后需再跑一次）。
3. ~~独立 review（lane A）~~ ✅ round 1 已完成（CHANGES-REQUESTED）；待修复后跑 round 2 复验增量。
4. review 通过 → commit → annotated tag v0.1.10 → Forgejo+GitHub 双推 → bump `~/.pi/agent/settings.json` 与 `~/.pi/README.md` 的 `@v0.1.9` → pi-config commit → `pi update --extensions` → 真机探针 → 证据落 `fix-note` §5。
5. 提醒 owner：重启 live pi（PID 367149）；待定是否提交 `.codestable/issues/2026-09-19-handoff-adaptive-threshold-semantics/`（含 data-report）与 4 个 autolearn skill。

## 关键上下文
- 仓库：`/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context`，master，HEAD `95a6590`，最新 tag `v0.1.9`（`0af9ec6`）。
- 常量：`WINDOW_RESERVE_TOKENS=16_384`、`SUMMARY_OUTPUT_RESERVE_TOKENS=32_768`、`TIER_EDGE_MARGIN=4_000`、`MIN_SUMMARIZE_TOKENS=8_000`、`KNEE_* = 157_000/450_000/0.04`。
- 函数：`kneeTokens(window)`、`resolveThreshold(ctx, usage, summaryModel?)`、`baselineTokens()`、`firstCostTierEdge(model)`、`statusText()`、`maybeTrigger()`、`runHandoff()`；`Threshold.bound ∈ adaptive|target|summarizer|tier|usable`。
- 测试夹具：B=11,924、keep=20,000、S(handoffTargetTokens)=64,000；探针 `/tmp/knee-probe.mjs`、`/tmp/window-probe.mjs` 输出：64K→43,616(usable)、128K→107,616、200K→179,616、272K→251,616、400K→379,616、600K→157,333、768K→157,001、1M/1.05M→157,000。
- 数据证据：Context Arena 新站接口 `contextarena.ai/api/{available-needles,models,needle-summary?needles=8&mode=full|lite}`（184 条 = 73 模型 × reasoning 变体，逐档 `avg_score/n_tests/ci_50~99`）；老站 `api.contextarena.ai/mrcr/*`（needles `[2,4,8]`，112 旧模型，无 `bin_metrics` 之外新模型）；DeepSeek V4 报告 arXiv 2606.19348 Figure 9：V4-Pro-Max 0.90/0.85/0.94/0.90/0.92/0.82/0.66/0.59、V4-Flash-Max 0.91/0.84/0.87/0.85/0.87/0.76/0.60/0.49（8k→1024k）；V4.1-Flash 报告 PDF md5 `4535b6de69ce4e3a965e2fdb0ace5d85`（`/home/user/DeepSeek_V41_Tech_Report.pdf`）无 MRCR，LongBench-V2 44.7/51.5/45.2；GPT-6 MRCR 256–512K 100%、512K–1M 96.3%（Sol 91.5%/73.8%）；linux.do 2892775 V4.1-Flash 自测 97.5/97.6/95.2/85.1/79.2/40.2/29.0，1M 档不可达（需 1,048,383 输入 token，窗口输入+输出共享）。
- 本地工件：`/tmp/evals/`（`new-ns8.json` 1,337,559 B、`api-ns{2,4,8}.json`、`api-models.json`、`ds-fig9.png`、`ds-v41-pdf.txt`、`grok46-pdf.txt`、`Gemini-3-{7,8}-Flash-Model-Card.pdf/.txt`、`gpt6-card.txt`、`linuxdo.json`、`ld-081e287….png`）。
- 未跟踪：`.codestable/issues/2026-09-19-handoff-adaptive-threshold-semantics/`、`.agents/skills/pi-project-context-{memory-cap-truncation-triage,stale-writer-process-check,sandboxed-independent-review,gate-probe-mutation-check}/`、`.agents/memory/skill-candidates/`。
- 常用命令：`node tests/run-all.mjs`、`node tests/handoff-test.mjs`、`git diff --check`、`tvly search/extract`（TAVILY_API_KEY 已配）。

<read-files>
/tmp/evals/ds-fig9.png
/tmp/evals/ld-081e28724cc427b616f3ae4c14358d10713a4ef3.png
</read-files>

<modified-files>
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.agents/memory/MEMORY.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.codestable/issues/2026-09-19-handoff-adaptive-threshold-semantics/handoff-adaptive-threshold-semantics-analysis.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.codestable/issues/2026-09-19-handoff-adaptive-threshold-semantics/handoff-adaptive-threshold-semantics-data-report.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.codestable/issues/2026-09-19-handoff-adaptive-threshold-semantics/handoff-adaptive-threshold-semantics-fix-note.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.codestable/issues/2026-09-19-handoff-adaptive-threshold-semantics/handoff-adaptive-threshold-semantics-review-prompt.txt
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/docs/configuration.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/docs/handoff.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/handoff.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/tests/handoff-test.mjs
</modified-files>
