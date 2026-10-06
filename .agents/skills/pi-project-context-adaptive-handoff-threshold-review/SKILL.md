---
name: pi-project-context-adaptive-handoff-threshold-review
description: "Derive, test, and independently review adaptive handoff thresholds and their diagnostic caps in pi-project-context."
---

<!-- autolearn-generated: this skill may be superseded by a later autolearn pass -->

## When to use
Use when changing adaptive handoff thresholds, budget formulas, summarizer limits, pricing-tier caps, or `/handoff status` diagnostics.

> **v0.4.x 更新（2026-10-05）**：本技能正文里的阈值公式与状态行措辞是 v0.4.0 之前的旧形态——旧公式
> `T0 = max(min(usable − 4000, knee), baseline + keep + S)` 已被 `docs/handoff.md` 明确禁止（`S` 不参与公式、
> 物理下限是**拒绝门**不是抬升、且 v0.4.3 起对固定比例模式同样生效），summarizer 容量 cap 随摘要链在 v0.4.1 删除，
> 状态行现为 `drop N` / `drop budget N`。
> 现行语义以 `docs/handoff.md` 为准；键名已更到 `handoffBudgetRecentTokens` / `handoffBudgetSummaryTokens`。

## Procedure
1. Inspect `extensions/project-context/handoff/run.ts`, `tests/handoff-test.mjs`, and the configuration documentation in `README.md`.
2. Verify the budget in this order:
   - `usable = contextWindow - 16384`
   - reserve `baseline + handoffBudgetRecentTokens`
   - require at least 8,000 summarizable tokens
   - compute the conservative knee `knee = W - (W - 157000) * sigmoid(ln(W / 450000) / 0.04)` and set `T0 = max(min(usable - 4000, knee), baseline + keep + handoffBudgetSummaryTokens)`
   - cap by summarizer capacity, first pricing tier, then `usable - 4000`
   - disable the threshold if it falls below the minimum floor.
3. Ensure `/handoff status` identifies the binding cap (`summarizer`, `tier`, or `usable`) rather than displaying a contradictory ratio, and that `/handoff threshold auto` rejects a trailing ratio (fixed mode owns `handoffThresholdRatio`).
4. Add or update tests for: ratio floor, small summarizer windows, pricing-tier caps, usable-window caps, disabled thresholds, and status diagnostics.
5. Run the full suite:
   ```bash
   node tests/run-all.mjs
   ```
6. For boundary changes, run an independent read-only review against a sandbox copy. Preserve the original working-tree status and record the transcript under `.codestable/issues/<issue>/`.
7. Do not treat provider failures (402/429/quota/credit errors) as successful real-provider handoff validation; report them separately from deterministic tests.


## Gotchas
- Adaptive auto is a conservative knee curve: `knee(W) = W - (W - 157000) * sigmoid(ln(W / 450000) / 0.04)`. Honest windows (≤ ~400K: Codex 272K/400K, Claude 200K) keep their own boundary; the 450K transition saturates at 157K — the population median of measured MRCR knees (46 models ≥ 1M: p25 127K / p50 157K / p75 190K). Wc = 450K because every measured 500K+ declaration is inflated (grok-4.5/4.6 declare 500K with a ~195K family knee; DeepSeek-V4.1-Flash / GLM-5.3 / Qwen3.8 declare 1M with measured knees of 130–170K). Deliberately conservative: GPT-5.6 (~250K), Gemini 3.7 (~450K) and GPT-6 (≥ 512K) trigger earlier than their own knee. Handing off at the declared window end (98%) is the regression this replaced.
- The earlier 273K/650K fit (anchored to GPT-5.6 / OpenAI's first pricing tier) was withdrawn because it let inflated 500K/1M declarations run 2–3× past their knee; a flat `min(W, 157K)` plateau was also rejected (too early for strong 1M models). Changing `KNEE_*` means revising this reasoning; expected values: 1M → 157,000 (`auto 157k (16%)`, summarize 125,076), 768K → 157,001, 600K → 157,333, 500K → 179,975, 400K → 379,616, 272K → 251,616. Cap fixtures must stay below 157K (tier 120K → 116,000; summarizer 128K → 127,156).
- The physical floor `baseline + keep + MIN_DROP_TOKENS` takes over only with a heavy baseline or a window below ≈116K; a small auxiliary model can still cap below the curve.
- The status line reports the effective summarize amount (`summarize 125k`), not the configured minimum; without usage it echoes `target`.
- Test the cap reason and exact status text, not only the numeric threshold.
