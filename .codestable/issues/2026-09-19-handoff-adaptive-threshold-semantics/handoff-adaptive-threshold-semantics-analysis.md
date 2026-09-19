---
doc_type: issue-analysis
issue: 2026-09-19-handoff-adaptive-threshold-semantics
status: confirmed
root_cause_type: design-semantics
created_at: 2026-09-19
related: [handoff-adaptive-threshold-semantics-report.md]
tags: [handoff, adaptive-threshold, budget, diagnostics]
---

# 根因分析与再推导：auto = 模型的质量拐点（窗口比例 + 实测绝对带）

## 1. 结论

auto 的语义经过五次收敛，最终定为「声明窗口的质量拐点」：

1. v0.1.9 `max(8000, min(S, room/2))` 把 auto 封顶在 64k（大窗口不随窗口增长）。
2. `max(B+K+S, rW)` 退化成窗口比例（`r` 本是固定模式参数）。
3. 窗口末点 `usable − 4000`（1M → 980k/98%）越过了质量拐点。
4. 纯比例 `0.25 × W`：1M 合理，但把 Codex 的 272K/400K 诚实窗口压到物理下限（~107k）。
5. 首版拟合：`knee(W) = W − (W − 273K)·σ(ln(W/650K)/0.04)`（锚 GPT-5.6 / OpenAI 首档）。
6. 最终（owner 决策「保守曲线 A」）：`knee(W) = W − (W − 157K)·σ(ln(W/450K)/0.04)`，
   `T0 = max(min(U − 4000, knee(W)), B + K + S)`——K 取实测拐点人群 p50（157K），Wc 提前到 450K，
   把声明 500K/1M 的虚高窗口收敛回平台；≤~400K 诚实窗口不变。纯平 `min(W, 157K)` 平台被否
   （对强 1M 模型过早）。

## 2. 数据

主数据：MRCR 8-needle（GDM-MRCRv2 / Context Arena，2026-09-19；本地导出
`~/Downloads/mrcr-leaderboard-8-needle-2026-09-19.csv`，184 行 / 73 模型 / 79 变体）。

- 「跌 10%」在对数长度上插值：1M 级模型的拐点/窗口 = **0.13–0.29**（中位 ≈0.19、上四分位 ≈0.24），
  绝对值 **166K–304K**；GPT-5.6 ≈ 273K/1.05M（0.26）。
- 交叉资料：
  - CodingFleet（2026）：多针 `>75%` 可用区间 / 声明窗口 = 0.13（Gemini 3.1）、0.20（Opus 4.7、DeepSeek V4 Pro）、
    0.49–0.50（Opus 4.6、GPT-5.5）；「>512K 没有多针可靠的模型」。
  - ofox.ai：RULER/MRCR/NoLiMa 显示 frontier 可靠多针检索约 **200–400K 绝对**，与声明窗口脱钩。
  - RULER / Awesome Agents：有效上下文 ≈ **60–70%** 声明值（口径更宽，含单针与聚合任务）。
  - yage.ai 曲线：128K 以下 frontier 几乎同分；GPT-5.4 超过 256K 开始陡降（256–512K 57.5%，512K–1M 36.6%）。
- 结论：拐点不是固定比例，也不是硬阶梯，而是对「窗口 → 拐点」的拟合曲线（见下）。

### 拟合

形式取 logistic 混合（W 小时 knee→W；W 大时 knee→K）：

```text
knee(W) = W - (W - K) * sigmoid(ln(W / Wc) / s)
```

| 参数组 | K | Wc | s | 1.05M 处 | RMSE(log) |
|---|---|---|---|---|---|
| 全部点 | 180K | 775K | 0.12 | 244K | 0.101 |
| 去弱模型 | 240K | 725K | 0.06 | 242K | 0.103 |
| **锚 GPT-5.6（首版；已被保守曲线替换）** | **273K** | **650K** | **0.04** | **273K** | 0.176 |

拟合点与权重（首版）：128K/200K/272K/400K/512K → 自身（权重 1，厂商声明的有效窗口）；1.05M → 273K
（权重 2，GPT-5.6 / OpenAI 首档）；CSV 跌 10% 中位 1M → 191K（权重 1）；弱模型 2M → 188K、10M → 166K
（权重 0.5/0.3）。不锚定时拟合约 240K。

首版上线后被新证据推翻（详见 `handoff-adaptive-threshold-semantics-data-report.md` §11）：
**500K/1M 的声明普遍虚高**——grok-4.5/4.6 声明 500K、家族实测 ~195K；DeepSeek-V4.1-Flash / GLM-5.3 /
Qwen3.8 声明 1M、实测 130–170K；而 GPT-6（512K–1M 仍有 96.3%）说明新一代可以更晚。窗口函数无法
区分模型族，只能选保守侧：`K=157K`（≥1M 窗口 46 个模型的实测拐点中位：p25 127K / p50 157K /
p75 190K），`Wc=450K`（观测到的诚实声明只到 ~400K）。

口径说明（复审 M3）：上表的 RMSE 与参数只描述首版 273K/650K 的来源；**采用值 157K/450K 不是表内拟合结果**，
而是「人群中位 + 政策选择」（数据混合同一模型的 reasoning 变体，去重后的 p50 仍约 157K）。「10% 跌落
166K–304K」是 1M 级**实测子集**的绝对区间，p25/p50/p75（127K/157K/190K）是含代理估计的
46 个 ≥1M 声明模型的人群分位；两者口径不同，不能直接相减比较。

## 3. 公式

```text
knee(W) = W - (W - 157000) * sigmoid(ln(W / 450000) / 0.04)
U = W - 16384
B = max(0, usage.tokens - estimateTokens(current branch))
F = B + K + 8000
T0 = max(min(U - 4000, knee(W)), B + K + S)
caps: summarizer → first pricing tier → U - 4000
```

- 曲线单调：≤~400K 基本 100%（诚实窗口，Codex 272K/400K 不被比例压小），450K–1M 过渡（500K → 36%、600K → 26%、768K → 20%），≥1M 饱和 157K（实测拐点人群中位），不再外推。保守代价：GPT-5.6（~250K）、Gemini 3.7（~450K）、GPT-6（≥512K）早于自身拐点。
- 物理下限 `B + K + S` 只在 baseline 很重或 `W ≲ 116K` 时接管；caps 只降。
- 实现：`kneeTokens(window)` + 三个 `KNEE_*` 常量（`handoff.ts`）。

## 4. 数值（实测，B≈23K / keep=20K / S=64K）

| 场景 | auto | bound |
|---|---|---|
| 1M 窗口，无档位 | 157k（16%） | adaptive |
| 1.05M 窗口（GPT-5.6） | 157k（15%） | adaptive |
| 1M + 120K 档位 | 116k（12%） | tier |
| 768K 窗口（平台） | 157k（20%） | adaptive |
| 600K 窗口 | 157k（26%） | adaptive |
| 500K 窗口（grok-4.5/4.6） | 180k（36%） | adaptive |
| 400K 窗口 | 380k（95%） | adaptive |
| 272K 窗口（Codex gpt-5.5） | 252k（93%） | adaptive |
| 200K 窗口 | 180k（90%） | adaptive |
| 128K 窗口 | 108k（84%） | adaptive |
| 64K 窗口 | 43.6k（68%） | usable |
| 固定模式 `/auto-handoff 0.6` | 60% of window | —— |

## 5. 数据要求

- 目录的 `contextWindow` / `cost.tiers` 只在低于拐点时才有约束力（cap 只降）。
- 拐点比例与绝对带都不按模型家族硬编码；per-model 曲线数据属于目录/评测，不进扩展。
- 最终采用保守曲线（K=157K / Wc=450K）而非纯平平台或逐模型表/覆盖：未知模型一律走模型无关的
  窗口函数；已知强/弱模型的差异由固定模式 `/auto-handoff <ratio>` 在会话内手动调节。

## 6. 来源清单

- 本地导出（GDM-MRCRv2 / Context Arena 8-needle 全榜）：`~/Downloads/mrcr-leaderboard-8-needle-2026-09-19.csv`
- Context Arena 榜单：https://contextarena.ai/
- CodingFleet「claimed vs usable」：https://codingfleet.com/blog/context-window-lie-how-well-ai-models-use-1m-tokens-2026
- yage.ai 长上下文综述（2026-03-15）：https://yage.ai/share/long-context-benchmark-en-20260315.html
- ofox.ai 长上下文评测分析：https://ofox.ai/blog/long-context-llm-benchmarks-200k-tokens-2026
- Awesome Agents 长上下文榜单：https://awesomeagents.ai/leaderboards/long-context-benchmarks-leaderboard/
- LLM Stats MRCR v2 (8-needle)：https://llm-stats.com/benchmarks/mrcr-v2-(8-needle)
- RULER（NVIDIA，arXiv:2404.06654）、Michelangelo/MRCR 论文（arXiv:2409.12640）、OpenAI MRCR 数据集：https://huggingface.co/datasets/openai/mrcr
- 抽取的正文快照：`/tmp/evals/{yage,ofox,benchlm,codingfleet,awesome,llmstats,contextarena}.md`
- 本轮新增（保守曲线依据，详见 `handoff-adaptive-threshold-semantics-data-report.md` §3/§4/§11）：
  Context Arena 活接口 `contextarena.ai/api/{available-needles,models,needle-summary?needles=8&mode=full|lite}`
  （184 条 = 73 模型 × reasoning 变体，逐档 CI/n）与老站 `api.contextarena.ai/mrcr/*`（2/4/8 针，仅旧模型）；
  DeepSeek-V4 技术报告 Figure 9（arXiv:2606.19348，0.82@256K、0.59@1M）、HF 博客；
  OpenAI GPT-6 发布页（MRCR 256–512K 100%、512K–1M 96.3%）；
  linux.do 主题 2892775（V4.1-Flash 自测：97.5→85.1→79.2→40.2→29.0，1M 档因输入+输出共享不可达）。
