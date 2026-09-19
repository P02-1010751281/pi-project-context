---
doc_type: data-report
issue: 2026-09-19-handoff-adaptive-threshold-semantics
status: confirmed
created_at: 2026-09-19
related: [handoff-adaptive-threshold-semantics-analysis.md, handoff-adaptive-threshold-semantics-report.md]
tags: [handoff, adaptive-threshold, data-sources, long-context, evidence]
---

# 长上下文数据源技术报告：MRCR 全量接口与其他测试的可用性

调研时间：2026-09-19。目的：为 handoff auto 的「质量拐点（knee）」提供可复核的
逐档（per-bin）数据源，并确认除 MRCR 8-needle 之外是否存在可用的其他测试数据。

## 1. 结论摘要

1. 用户重下的 `~/Downloads/mrcr-leaderboard-8-needle-2026-09-19.csv` 是
   **GDM-MRCRv2 Full (8-Needle) 的用户侧导出**，站点背后有活接口，数据比 CSV 完整：
   184 条目 = 73 模型 × reasoning 变体，8k–1M 逐档分数 + 分位数 + 置信区间 + 样本数。
2. **CSV 导出缺 `reasoning_mode` 列**；同模型多行是不同推理档位（medium/xhigh/high/low/默认），
   不是重复采样。接口里有该字段，CSV 没有。
3. 站点家族里还藏着**第二个测试 OAI-MRCR**（老站），带 **2/4/8 针**三个难度变体，
   但只有 112 个旧模型；与新站 73 个模型的 slug 交集**只有 1 个**
   （`google/gemini-3-flash-preview`），不足以对新模型做跨 harness 验证。
4. GraphWalks 只有导航链接，页面 404，**没有数据**。
5. 外部测试（RULER / HELMET / NoLiMa / LongBench Pro / AA-LCR / Chroma context rot）
   均不覆盖 2026-09 这一代模型；GPT-6 / Gemini 3.8 / Grok 4.7–4.8 / DeepSeek 4.1
   仍无公开逐档曲线，只有 OpenAI 自报的两个 MRCR 8-needle 档位。
6. 因此：**拐点计算可以升级为「每模型自己的逐档曲线 + 置信区间」**（替换 128k/1M
   保持率代理）；但「新模型无数据」的结构性问题不变，保守默认 + 逐模型覆盖的
   架构结论不变。

## 2. 数据源总览

| # | 数据源 | 测试/版本 | 模型覆盖 | 逐档数据 | 获取方式 |
|---|---|---|---|---|---|
| 1 | Context Arena 新站 | GDM-MRCRv2 Full / Lite（8 针） | 73 模型 / 184 条目（含 GPT-5.4–5.6、Gemini 3.x、GLM-5.3、Grok-4.20、Opus-5 等） | 8k/16k/32k/64k/128k/256k/512k/1M，含 CI 与 n_tests | `contextarena.ai/api/*` |
| 2 | Context Arena 老站 | OAI-MRCR（2 / 4 / 8 针） | 112 个旧模型（最新约 Gemini 3.1 Pro、Claude Opus 4.5、GLM-4.7、DeepSeek V3.2） | 同上 | `api.contextarena.ai/mrcr/*` |
| 3 | 老站 GraphWalks | GraphWalks | —— | —— | 页面 404，无数据 |
| 4 | RULER / HELMET / NoLiMa / LongBench Pro | 各自 | 均停在更早世代 | 部分有逐档，但无新模型 | 论文/GitHub/聚合站 |
| 5 | Artificial Analysis AA-LCR | 长文档推理（10k–100k） | 较新（Kimi K3、Fable 5.1 等） | 仅总分，无长度衰减曲线 | 评测页 |
| 6 | Chroma context rot | 18 模型（2025） | 旧 | 定性「全部退化」 | 报告页 |
| 7 | 厂商自报 | OpenAI MRCR v2 8-needle | GPT-6 Astra、GPT-5.6 Sol | 仅 256K–512K、512K–1M 两档 | OpenAI GPT-6 发布页 |

## 3. GDM-MRCRv2（新站，当前模型的唯一逐档数据）

### 3.1 接口

```bash
curl -s https://contextarena.ai/api/available-needles
# {"mode":"full","needles":[8]}   （?mode=lite 同样只提供 8 针）

curl -s 'https://contextarena.ai/api/models' -o api-new-models.json
curl -s 'https://contextarena.ai/api/needle-summary?needles=8' -o new-ns8-full.json     # 1,337,559 B
curl -s 'https://contextarena.ai/api/needle-summary?needles=8&mode=lite' -o new-ns8-lite.json
```

- `available_bins = [8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576]`。
- 184 个条目 = 73 个唯一 `model_slug`；重复 slug 由 `reasoning_mode` 区分：
  `enabled`(33) / `high`(27) / `low`(27) / `medium`(20) / `max`(13) / `xhigh`(11) /
  `minimal`(5) / `null`(48)。
- `needles=2|4` 在新站返回空（97 B），即新站只有 8 针。

### 3.2 每条目字段

模型级：`model_slug, provider_name, max_context_length, openrouter_name, quantization,
reasoning_mode, reasoning_default, reasoning_levels, can_reason, routing,
pricing_metadata{pricing_prompt, pricing_completion, pricing_threshold_tokens,
pricing_prompt_above_threshold, pricing_completion_above_threshold},
latest_run_timestamp, api_created_at/updated_at, run_provider_names, sponsors,
is_new, is_deprecated, has_sufficient_data, has_incomplete_bins(_128k), unranked,
overall_metrics{auc_1m, auc_128k, cum_avg_*, avg_score_overall, total_*_cost}`。

每档 `bin_metrics["<tokens>"]`：`avg_score, min_score, max_score, median_score,
q1_score, q3_score, stddev, n_tests, avg_token_efficiency, is_incomplete,
total_prompt/cache_read/completion/reasoning/on_demand_input/cost_bin,
ci_50/75/90/95/98/99_lower|upper`。

### 3.3 CSV 与接口的差异（重要）

CSV 的 12 列只是接口的浅层投影，**没有 `reasoning_mode`**。证据：`openai/gpt-5.5` 的
5 条记录元数据完全相同，只有推理档位不同——

| reasoning_mode | 128k | 512k | 说明 |
|---|---|---|---|
| xhigh | 85.8% | 54.2% | |
| medium | 83.0% | 57.6% | |
| high | 79.3% | 54.4% | |
| low | 67.0% | 54.3% | |
| （默认） | 28.3% | 24.9% | 与最低档差距 >50 个点 |

直接按 CSV 行取数（或取最大/均值）会混档，拐点估计失真。**必须显式选档**
（建议：默认档或最高档，并在报告中标明）。

### 3.4 Full vs Lite

同一批 73 模型、同样 8 档，两个版本分数略有差异（同测试不同子集），可作稳定性检查：

| 模型 | 512k Full | 512k Lite |
|---|---|---|
| openai/gpt-5.6-sol | 61.9% | 60.4% |
| google/gemini-3.7-flash | 65.1% | 64.2% |
| z-ai/glm-5.3 | 36.2% | 40.5% |

## 4. OAI-MRCR（老站）

```bash
curl -s https://api.contextarena.ai/mrcr/available-needles        # [2,4,8]
curl -s https://api.contextarena.ai/mrcr/models -o api-old-models.json   # 112 模型
curl -s 'https://api.contextarena.ai/mrcr/needle-summary?needles=8' -o old-ns8.json
curl -s 'https://api.contextarena.ai/mrcr/needle-summary?needles=4' -o old-ns4.json
curl -s 'https://api.contextarena.ai/mrcr/needle-summary?needles=2' -o old-ns2.json
```

- 字段结构与新站同族：`bin_metrics` 同名，且同样带 `ci_50~99` 与 `n_tests`；老站另有 `efficiency_*` 字段。
- 模型集合是旧世代：含 `openai/gpt-5.2*`、`google/gemini-3.1-pro-preview`、
  `anthropic/claude-opus-4.5`、`z-ai/glm-4.7`、`deepseek/deepseek-v3.2` 等。
- 8 针可用模型 65 个；2 针 112 个；4 针介于两者。
- **与新站交集仅 1 个模型**（`google/gemini-3-flash-preview`），
  无法用于「当前模型」的跨 harness 拐点验证；只能验证**方法学**
  （拐点口径是否随针数变化）。

## 5. GraphWalks

老站导航有 `/graphwalks` 链接，实际返回 404（浏览器抓包确认只有壳页面与字体请求）。
无数据可用，不再追踪。

## 6. 外部测试的可用性评估

| 测试 | 结论 | 原因 |
|---|---|---|
| RULER（NVIDIA） | 不可用 | 公开结果停旧世代；repo 无 2026-09 结果 |
| HELMET（Princeton） | 不可用 | 同上 |
| NoLiMa | 不可用 | LLM Stats 榜单当前 0 个模型 |
| LongBench Pro | 参考 | 46 模型双语（2026-01），无当前世代 |
| AA-LCR | 参考 | 只测 10k–100k，仅总分 |
| Chroma context rot | 参考 | 18 模型（2025），仅定性 |
| 厂商自报 | 仅 GPT-6 | MRCR 8-needle 256–512K 100%、512K–1M 96.3%（Sol 91.5% / 73.8%）；Gemini 3.8 / Grok 4.7–4.8 / DeepSeek 4.1 无曲线 |

## 7. 数据质量与陷阱

1. **变体混行**：同 slug 多条 = 推理档位（新站）或模型版本（老站），统计前必须分组。
2. **AUC 归一化范围**：AUC 只在模型自身 `max_context_length` 内归一，
   跨模型比较 AUC@1M 对 sub-1M 窗口模型无意义。
3. **incomplete bins**：高分模型常在 1M 档缺数据（`is_incomplete`，或 `bin_metrics` 直接缺少
   `1048576` 键），例如 `openai/gpt-5.6-sol`、`z-ai/glm-5.3` 曲线止于 512k。
4. **非单调**：如 `google/gemini-3.7-flash` 256k（89.0%）> 128k（88.6%），
   拐点应由曲线拟合/阈值穿越确定，不能用「首次下降」。
5. **CI 可用**：新站每档带 50–99% 置信区间与 `n_tests`，可判断拐点是否显著。
6. **基线口径敏感**：以 8k/16k 为基线（≈100%）还是以 128k 为基线，
   得到的「跌 10%」拐点可差一倍（例：`gpt-5.6-sol` 128k=92.4 → 256k=83.5 →
   区间内穿越 90% 线）。报告必须写明口径。

## 8. 逐档曲线示例（新站，取该模型最高档）

| 模型（档位） | 8k | 16k | 32k | 64k | 128k | 256k | 512k | 1M |
|---|---|---|---|---|---|---|---|---|
| openai/gpt-5.6-sol (max) | 100 | 100 | 98.0 | 98.8 | 92.4 | 83.5 | 61.9 | – |
| google/gemini-3.7-flash (high) | 100 | 100 | 98.6 | 93.1 | 88.6 | 89.0 | 77.7 | 63.5 |
| z-ai/glm-5.3 (high) | 96.0 | 94.9 | 94.3 | 89.6 | 69.3 | 55.8 | 41.9 | – |
| x-ai/grok-4.20 (enabled) | 95.2 | 59.9 | 61.9 | 39.0 | 19.4 | 15.9 | 11.7 | 8.2 |

观察：`gpt-5.6-sol` 的 10% 跌落发生在 128k–256k 之间（强模型拐点较晚：Sol ~256K、Gemini 3.7 ~450K、
GPT-6 ≥512K；保守曲线对它们偏早，见 §11.5）；
`grok-4.20` 在 16k 已崩（该模型长上下文能力整体弱）；
`glm-5.3` 在 64k–128k 之间穿越 90%。这些结论此前只能靠 128k/1M 保持率代理，
现在可直接从曲线得到。

## 9. 对阈值设计的含义

- 可用「逐档曲线 + CI」重算 73 模型的人群分布（knee 绝对/占比），
  替换代理拟合；口径需固定（建议：以 8k/16k 基线跌 10%，线性插值到 log 长度）。
- 逐模型覆盖表可以用**同一接口**在需要时刷新，不必手工维护（但仍属「快照」，
  只能作为校准参考，不能编进扩展做运行时决策）。
- GPT-6 这一代仍不在任何逐档数据集里：架构上仍需「保守默认 + 逐模型覆盖」，
  数据报告只能把「已知模型的拐点」做得更准。

## 10. 复现与本地工件

本次抓取保存在 `/tmp/evals/`（时间 2026-09-19 20:1x）：

| 文件 | 大小 | 内容 |
|---|---|---|
| `new-ns8.json` | 1,337,559 B | 新站 GDM-MRCRv2 Full 8 针全量 |
| `api-ns2.json` / `api-ns4.json` / `api-ns8.json` | 848,170 / 512,243 / 537,248 B | 老站 OAI-MRCR 2/4/8 针 |
| `api-models.json` | 46,122 B | 老站模型元数据（112 个） |
| `openai-gpt6.md` | 42,750 B | OpenAI GPT-6 发布页（含 MRCR 两档） |
| `morph.md` / `stab-deg.md` / `llmstats-lc.md` / `nolina.md` 等 | 见目录 | 外部测试调研快照 |

命令见 §3.1 / §4。数据文件较大，不进仓库；需要长期留档时另存到评测仓（待定）。

## 11. 厂商技术报告与系统卡（2026-09-19 扒取）

### 11.1 DeepSeek-V4 技术报告（arXiv 2606.19348，Figure 9）

**MRCR 8-needle 逐档曲线（Average MMR）**——目前唯一公开的厂商逐档曲线：

| 模型 | 8k | 16k | 32k | 64k | 128k | 256k | 512k | 1024k |
|---|---|---|---|---|---|---|---|---|
| DeepSeek-V4-Pro-Max | 0.90 | 0.85 | 0.94 | 0.90 | 0.92 | **0.82** | **0.66** | **0.59** |
| DeepSeek-V4-Flash-Max | 0.91 | 0.84 | 0.87 | 0.85 | 0.87 | **0.76** | **0.60** | **0.49** |

- 原文结论：「retrieval performance remains highly stable within a 128K context window. While a
  performance degradation becomes visible beyond the 128K mark...」（128K 内稳定，超过 128K 可见退化）。
- HF 博客复述：V4-Pro-Max「stays above 0.82 through 256K and holds at 0.59 at 1M」。
- MRCR 1M (MMR) / CorpusQA 1M (ACC)：Opus-4.6 92.9/71.7、Gemini-3.1-Pro 76.3/53.8、
  DS-V4-Pro 83.5/62.0、DS-V4-Flash-Max 78.7/60.5。
- **V4.1-Flash 没有公开的长上下文质量数据**：
  - 技术报告（2026-09-10 PDF）的 Long Context 基准只有 base 的 LongBench-V2（44.7/51.5/45.2），
    instruct 对比表（vs Opus-5.0/GPT-5.6 Sol/K3/GLM-5.3/DS-V4-Pro/Flash）没有长上下文行；
    与 context length 有关的图（Figure 2）是 decode FLOPs vs 长度（成本，不是质量）。
  - 官方发布页（deepseek.com，9-10）只讲架构与 KV cache（HBM 1/4、SSD 1/8）以及
    「外部测试显示性能/成本/速度优于 V4-Pro」，没有检索/长上下文分数。
  - 第三方：Context Arena 榜单尚未收录 V4.1-Flash（只有 `deepseek-v4-pro-0813`、`deepseek-v4-flash-0731`）；
    llm-stats / benchlm 的 V4.1-Flash 页也没有长上下文行。
  - 因此 V4.1-Flash 的拐点此前只能沿用 V4 家族曲线；**社区自测已补上一条 8-needle 曲线，见 §11.6**。

### 11.2 OpenAI GPT-6（发布页 + 系统卡）

- MRCR v2 8-needle：**256–512K = 100.0%**（Sol 91.5%）、**512K–1M = 96.3%**（Sol 73.8%）——仅两档。
- `deploymentsafety.openai.com/gpt-6-astra` 是安全分册（§1–§8+），无能力/长上下文表。
- 附带信号：Codex 改为「跨上下文窗口保留笔记、历史窗口可检索」，减少反复压缩。

### 11.3 xAI Grok 4.6 模型卡（media.x.ai，2026-08-12 rev2）

- 目录只有 Coding / Knowledge-work / Engineering acceleration / R&D enablement，
  **没有长上下文评测**（无 MRCR/RULER/NoLiMa/逐档表）；Grok 4.7/4.8 未见公开模型卡。

### 11.4 Google Gemini 3.8 Flash

- 模型卡 PDF（`storage.googleapis.com/deepmind-media/Model-Cards/Gemini-3-8-Flash-Model-Card.pdf`）
  以安全评测为主，无逐档长上下文表。
- evals 方法页明确：**长上下文用 GDM-MRCR v2 的 128k 累计分**（self-computed，「full dataset
  available in our repository」）——与新站 Context Arena 同源。

### 11.5 对拐点研究的含义

1. DeepSeek V4 的独立 harness 曲线证实了拐点形态：≤128K 平稳（0.85–0.94）、256K 明显下探（0.82/0.76）、
   1M 剩 0.59/0.49 —— 与 Context Arena 的 MRCR 曲线方向一致。
2. 与保持率代理的对比：代理给出 DeepSeek 家族拐点 ≈130K（0.12 占比），而厂商实测 128K 仍有 0.92、
   256K 才跌到 0.82 —— **代理法对 DeepSeek 偏保守（拐点被估早）**，说明「跌 10%」的口径对曲线形状很敏感。
3. GPT-6 的 96.3%@512K–1M 再次说明新一代旗舰的拐点可远超 0.5×窗口；
   Gemini / xAI 不公开逐档数据，外部只能依赖 Context Arena。
4. 本地工件：`/tmp/evals/ds-fig9.png`（曲线图）、`ds-v4-report.txt`、`ds-v41-pdf.txt`、
   `grok46-pdf.txt`、`Gemini-3-{7,8}-Flash-Model-Card.pdf/.txt`、`gpt6-card.txt`、`gemini38-evals.txt`。

### 11.6 社区自测补充：DeepSeek-V4.1-Flash 的 MRCR v2 8-needle 曲线

来源：linux.do「关于ds v4.1的注意力，我测试了 MRCR v2」（2026-09-12，作者 xsmingerfan，
https://linux.do/t/topic/2892775）。图存 `/tmp/evals/ld-081e28724cc427b616f3ae4c14358d10713a4ef3.png`。

设置（图中标题/脚注）：mrcr_v2p1、8-needle、full-bin、**861 samples/model**、reasoningEffort=max、
no tools、no system prompt；V4.1-Flash 走 DSH 自有 provider（deepseek-flash = DeepSeek-V41-Flash）；
参考模型来自 contextarena.ai（reasoning_mode=max）。

| 档位 | 4k–8k | 8k–16k | 16k–32k | 32k–64k | 64k–128k | 128k–256k | 256k–512k |
|---|---|---|---|---|---|---|---|
| DeepSeek-V4.1-Flash（自测，95% CI） | 97.5 | 97.6 | 95.2 | 85.1 | 79.2 | **40.2** | **29.0** |

- 拐点在 **64K–128K 之后**：64k–128k 仍有 79.2，128k–256k 直接跌到 40.2（−49%），256k–512k 29.0。
- 作者观察：128K 以前相对前代大幅提升（接近国模第一）；256K 以后急速下降，甚至略弱于 V4-Flash 0731；
  GLM-5.3 相对 5.2 明显提升；Kimi 系列持续偏弱。
- **1M 档不可达**：任务需 1,048,383 输入 token，而窗口 1,048,576 是**输入+输出共享**，仅剠 ~3.7K 给回答；
  即 V4.1-Flash 的 1M 声明实际无法完成满档 MRCR。
- Caveat（作者自述）：29/861 样本在 reasoning 上耗尽 131K 输出预算。
- 对照：这是目前 V4.1-Flash 唯一的 8-needle 曲线；它在 128K 之后比 V4 家族曲线（Pro-Max 256K=0.82）更陡，
  但两者 harness/口径不同，不能直接比数值。

## 12. 结论与待决

- **已决（2026-09-19，owner 选 A）**：采用保守曲线 `knee(W) = W − (W − 157K)·σ(ln(W/450K)/0.04)`；
  不做逐模型表/覆盖机制，精度差异由固定模式 `/auto-handoff <ratio>` 承担。代码/测试/文档/记忆已同步。
- 待决（非本轮发布阻塞）：
  1. 是否用新站接口数据重算 73 模型的人群 knee 分布（并给出与当前拟合曲线的偏差）。
  2. 是否用老站 2/4/8 针在「1 个交集模型 + 旧模型」上验证拐点口径的稳定性。
  3. 目录（`models-store.json`）声明值与实测拐点的对照清单是否需要单独产出。
