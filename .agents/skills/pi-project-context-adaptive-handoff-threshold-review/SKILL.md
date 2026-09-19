---
name: pi-project-context-adaptive-handoff-threshold-review
description: "Derive, test, and independently review adaptive handoff thresholds and their diagnostic caps in pi-project-context."
---

## When to use
Use when changing adaptive handoff thresholds, budget formulas, summarizer limits, pricing-tier caps, or `/auto-handoff status` diagnostics.

## Procedure
1. Inspect `extensions/project-context/handoff.ts`, `tests/handoff-test.mjs`, and the configuration documentation in `README.md`.
2. Verify the budget in this order:
   - `usable = contextWindow - 16384`
   - reserve `baseline + handoffKeepTokens`
   - require at least 8,000 summarizable tokens
   - compute `olderTarget = max(8000, min(handoffTargetTokens, availableRoom / 2))`
   - set `T0 = max(baseline + keep + olderTarget, handoffThresholdRatio * window)`
   - cap by summarizer capacity, first pricing tier, then `usable - 4000`
   - disable the threshold if it falls below the minimum floor.
3. Ensure `/auto-handoff status` identifies the binding cap (`summarizer`, `tier`, or `usable`) rather than displaying a contradictory ratio.
4. Add or update tests for: ratio floor, small summarizer windows, pricing-tier caps, usable-window caps, disabled thresholds, and status diagnostics.
5. Run the full suite:
   ```bash
   node tests/run-all.mjs
   ```
6. For boundary changes, run an independent read-only review against a sandbox copy. Preserve the original working-tree status and record the transcript under `.codestable/issues/<issue>/`.
7. Do not treat provider failures (402/429/quota/credit errors) as successful real-provider handoff validation; report them separately from deterministic tests.

## Gotchas
- `handoffTargetTokens` is not the primary control on large windows when adaptive mode is enabled; the ratio floor usually dominates.
- A small auxiliary model can legitimately cap the threshold well below the configured ratio.
- Test the cap reason and exact status text, not only the numeric threshold.
