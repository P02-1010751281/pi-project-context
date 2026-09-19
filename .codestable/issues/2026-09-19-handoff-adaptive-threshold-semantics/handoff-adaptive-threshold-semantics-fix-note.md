---
doc_type: issue-fix
issue: 2026-09-19-handoff-adaptive-threshold-semantics
status: confirmed
path: standard
fix_date: 2026-09-19
related: [handoff-adaptive-threshold-semantics-analysis.md]
tags: [handoff, adaptive-threshold, budget, diagnostics]
---

# 修复记录：auto = 模型的质量拐点（窗口比例 + 实测绝对带）

## 1. 改动

### `extensions/project-context/handoff.ts`

- 用**保守拟合曲线**替换固定比例/硬夹取（v0.1.10 决策：K 从 273K 下调到人群中位 157K，过渡点从 650K 提前到 450K）：

  ```ts
  const KNEE_ASYMPTOTE_TOKENS = 157_000;
  const KNEE_TRANSITION_TOKENS = 450_000;
  const KNEE_TRANSITION_STEEPNESS = 0.04;

  function kneeTokens(window: number): number {
    const z = Math.log(window / KNEE_TRANSITION_TOKENS) / KNEE_TRANSITION_STEEPNESS;
    return Math.round(window - (window - KNEE_ASYMPTOTE_TOKENS) / (1 + Math.exp(-z)));
  }
  ```

  `resolveThreshold()` 自适应分支用 `boundary = Math.min(usable - TIER_EDGE_MARGIN, kneeTokens(window))`；
  随后 caps 只降（summarizer → tier → usable），`tokens < floor` → undefined。`/auto-handoff auto` 无参数；
  `handoffThresholdRatio` 只服务固定模式。
- 曲线参数与注释同步：`K=157K` 是实测扇点的人群中位数（46 个 ≥1M 模型：p25 127K / p50 157K / p75 190K）；
  `Wc=450K` 因为目前所有 500K+ 声明实测都偏大（grok-4.5/4.6 声明 500K、家族实测 ~195K；
  DeepSeek-V4.1-Flash / GLM-5.3 / Qwen3.8 声明 1M、实测 130–170K）。≤~400K 的诚实窗口不受影响；
  强模型的保守代价（GPT-5.6 ~250K、Gemini 3.7 ~450K、GPT-6 ≥512K 早于自身拐点）已写入注释。

### `tests/handoff-test.mjs`

- wide（1M）→ 157,000 / `auto 157k (16%)` / summarize 125,076。
- 272K 诚实窗口 → 251,616；400K 诚实窗口 → 379,616；768K 饱和 → 157,001（钉住平台）。
- heavy（usage 512K）→ 583,924 / bound `target` / summarize 64,000（物理下限接管）。
- tier 用例档位改为 120K → 116,000 / bound `tier`；summarizer 用例窗口改为 128K → 127,156 / bound `summarizer`
  （两个 cap 必须低于新的 157K 平台才会接管）；quiet 会话 fixture 从 200K 降到 120K（低于新阈值）；
  64K usable cap（43,616）保持。

### 文档与 skill

- `docs/handoff.md`：保守曲线公式（纯文本 + LaTeX）、含义条目（K/Wc 取值依据与被替换的 273K/650K 拟合）、状态行样例。
- `docs/configuration.md`、review skill、`MEMORY.md` 同步。

### 复审响应（round 1 后）

- `handoff.ts` tier cap 改为**只降不跨档**：`tierEdge - TIER_EDGE_MARGIN < floor` 直接返回 undefined；恰好等于时 cap 到 `floor`（旧门控 `tierEdge > floor + margin` 恰好在这种情况下静默跳过 cap，把声明 500K/1M 的模型放行到计价档之外）。
- `Threshold.summarizeTokens` 语义改写为「cap 之后的**预计**摘要输入」（真实切点只会更短；整段窗口装在单轮时 handoff 会跳过并提示）；`resolveThreshold` / `statusText` / 类型注释同步。
- `/auto-handoff target` 文案从「至少摘要 64k」改为「cap 前目标 ~64k，物理下限保持 8k」。
- `tests/handoff-test.mjs`：ratio 拒绝用例改为尝试 `auto 0.7`（配置 0.6）+ 断言仍为 0.6，消灭「告警但仍写入」的变异盲区；新增 tier 边界用例（恰好 `floor+4000` → 39,924 / bound `tier` / summarize 8,000；低于则 undefined）。
- 文档同步：LaTeX 补 `\operatorname{round}`；状态行「实际摘要量」改为「预计摘要输入」+ 跳过说明；tier 不跨档写入公式含义；`configuration.md` 补 `handoffAdaptive + ratio` 旧配置的迁移说明；`README.md`/`docs/README.md` 索引改指本 issue；`MEMORY.md`/`CONTEXT.md`/`HANDOFF.md` 清理陈旧语义。

## 2. 数值（实测）

| 场景 | auto | bound |
|---|---|---|
| 1M 窗口，无档位 | 157k（16%） | adaptive |
| 1.05M 窗口（GPT-5.6） | 157k（15%） | adaptive |
| 1M + 120K 档位 | 116k（12%） | tier |
| 768K 窗口 | 157k（20%） | adaptive |
| 600K 窗口 | 157k（26%） | adaptive |
| 500K 窗口（grok-4.5/4.6） | 180k（36%） | adaptive |
| 400K 窗口 | 380k（95%） | adaptive |
| 272K 窗口 | 252k（93%） | adaptive |
| 200K 窗口 | 180k（90%） | adaptive |
| 128K 窗口 | 108k（84%） | adaptive |
| 64K 窗口 | 43.6k（68%） | usable |
| 固定模式 `/auto-handoff 0.6` | 60% of window | —— |

历史对照（已废弃的 273K/650K 拟合）：1M → 273k（27%）、768K → 281k（37%）、600K → 561k（94%）、
500K → 480k；它会把声明 500K/1M 的弱模型放行到拐点外 2–3 倍。

## 3. 测试

- `node tests/run-all.mjs`：9/9 通过；`git diff --check` 干净。

## 4. 独立 review

### Round 1（2026-09-19，沙箱 `/tmp/pc-threshold-review-v2`）

- 沙箱：`cp -a` 仓库工作树全量副本（含 `.git` 与未提交改动），基线 `/tmp/rev-v2-baseline-status.txt`（22 行）、`/tmp/rev-v2-baseline-files.txt`（265 个文件的 mtime/size）；事后两份 `diff` 均为空 → 零写入。
- 运行：`pi -p --no-session --no-extensions --no-skills --no-prompt-templates --tools read,bash --model openai-codex/gpt-5.6-luna "$(cat /tmp/rev-v2-prompt.txt)"`（前台，900s 上限；提示词含只读规则、分桶、对抗轮、VERDICT）。
- VERDICT：**CHANGES-REQUESTED**（无 blocking，5 Important / 3 Minor）。
- 转录：`handoff-adaptive-threshold-semantics-review-round1-independent.txt`。

| # | 判定 | 处理 |
|---|---|---|
| I1 tier cap 在低门槛被静默绕过 | 接受 | `tierEdge - 4000 < floor` → undefined；恰好相等 → cap 到 floor；新增 2 个测试 |
| I2 `summarizeTokens` 可能高于真实切点 | 部分接受 | 语义改为「cap 后的预计摘要输入」；跳过路径已有测试（nothing older）+ 文档说明 |
| I3 极小 auxiliary（`A ≲ 40K`）的 cap 仍可能请求不可执行 | 残余风险 | 保留最小前缀行为（上一轮决定），记入 §6 |
| I4 记忆/文档/迁移说明陈旧 | 接受 | `MEMORY.md` ratio 语义、`CONTEXT.md` 重写、`HANDOFF.md` 待办勾除、README/docs 索引、`configuration.md` 迁移说明 |
| I5 ratio 参数测试无变异鉴别力 | 接受 | 用例改为 `auto 0.7`，断言仍为 0.6 |
| M1 LaTeX 缺 round | 接受 | 补 `\operatorname{round}` |
| M2 target 文案过度承诺 | 接受 | 改为「cap 前目标 + 8k 物理下限」 |
| M3 参数依据与 RMSE 表关系 | 接受 | `analysis.md` 注明 157K/450K 是人群中位 + 政策选择，非表内拟合；说明口径 |

### Round 2（2026-09-19，沙箱 `/tmp/pc-threshold-review-v3`，聚焦增量）

- 范围：只复核修复增量（tier fail-closed、`auto 0.7` 变异鉴别力、`summarizeTokens` 语义、文档/记忆同步），不做全量变异矩阵；工具调用 ≤ 12 次。
- 基线 `/tmp/rev-v3-baseline-status.txt`（25 行）/ `/tmp/rev-v3-baseline-files.txt`（266 文件）；事后两份 `diff` 为空 → 零写入。
- 复审者独立复跑了 `node tests/run-all.mjs`（9/9），并核验：`floor=39,924`；`43,924-4,000` 恰等于 floor → `39,924 / bound=tier / summarize=8,000`；`43,000` → fail-closed；120K/128K/272K 与重 baseline 分别得到 116K tier cap、127,156 summarizer cap、251,616 adaptive、583,924 target，未被误伤；`auto 0.7` 用例必杀「告警但写入 0.7」。
- VERDICT：**PASSED**（无 blocking / important / minor）。
- 转录：`handoff-adaptive-threshold-semantics-review-round2-independent.txt`（670 B）。

## 5. 发布证据

- round 1 零写入证据：`/tmp/rev-v2-baseline-status.txt` / `/tmp/rev-v2-baseline-files.txt` 对照 diff 为空；转录 106 行 / 6,067 B 已归档。
- round 2 零写入证据：`/tmp/rev-v3-baseline-status.txt` / `/tmp/rev-v3-baseline-files.txt` 对照 diff 为空；转录 670 B 已归档；VERDICT PASSED。
- 复审修复后复跑：`node tests/run-all.mjs` 9/9；`git diff --check` 干净。
- **v0.1.10 发布（2026-09-19）**：
  - 提交：`3ee5794` fix(handoff)、`7f2ebe9` docs(handoff)、`25b41d6` docs(memory)、`cc6f6df` docs(codestable)；annotated tag `v0.1.10` → `cc6f6df`。
  - 双推：Forgejo 与 GitHub mirror 均更新 `master`（`95a6590..cc6f6df`）与 `v0.1.10`；`git ls-remote` 确认。
  - pi-config：pin 从 `@v0.1.9` 升到 `@v0.1.10`（`~/.pi/agent/settings.json` + `~/.pi/README.md`），commit `42d7631`，已推送。
  - `pi update --extensions` → 安装副本 `~/.pi/agent/git/git.lentech.site/C02-1010751281/pi-project-context` 位于 `cc6f6df`，`handoff.ts` 含 `KNEE_ASYMPTOTE_TOKENS = 157_000`。
  - 安装副本测试：`node tests/handoff-test.mjs` → `handoff: all checks passed.`
  - settings-installed 探针：沙箱 `/tmp/pc-v0110-probe-bFwq`（默认 settings，未用 `-ne`/`-e`）；`pi -p --model openai-codex/gpt-5.6-luna --thinking off` → `PROBE-OK`；扩展从 settings pin 加载并真实 consolidation 写出 `.agents/memory/CONTEXT.md` + `session-logs/01a0b9fc…/{session.md,session.jsonl}`，无 `errors.log`；单轮无 durable 记录故无 `MEMORY.md`（预期）。

## 6. 残余风险

- **极小 auxiliary 摘要窗口**（`A ≲ 40K`，即 `A - 32768 < 8000`）：cap 仍把阈值压到 `floor`（summarize ≈8k），但该请求本身可能超过 `A`（8k 输入 + 32k 输出 reserve + system prompt）。现实中没有 16K 摘要模型；把 sub-40k 摘要模型视为配置错误（handoff 会失败，不会静默降质）。
- **状态行的 `summarize` 是预计值**：整段窗口装在单轮时 handoff 会跳过并提示 `nothing older than the recent window to summarize`，实际摘要量可能小于显示值（状态值仍是 cap 后的上界，不会再显示配置下限）。
- **单条消息内部无法切分**（pi 不能回放半条消息）：超大单轮只能等后续轮次才能被摘要，这是 pi 的会话结构限制。
