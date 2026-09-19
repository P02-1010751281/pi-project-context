# Project Context

Last updated: 2026-09-19T14:05:00.000Z

## Summary

Adaptive handoff threshold rework is code-complete on the conservative knee curve A: `knee(W) = W − (W − 157000)·σ(ln(W / 450000) / 0.04)`, `T0 = max(min(usable − 4000, knee), baseline + keep + handoffTargetTokens)`, caps summarizer → first pricing tier → `usable − 4000` (only lower), undefined below `baseline + keep + 8000`. `handoffThresholdRatio` is fixed-mode only; `/auto-handoff auto` takes no parameter. Code, tests, docs, review skill, MEMORY.md and the issue artifacts all carry the new semantics; `node tests/run-all.mjs` is 9/9 and the status-line probes match. Independent lane-A review round 1 (`/tmp/pc-threshold-review-v2`, `openai-codex/gpt-5.6-luna`) returned CHANGES-REQUESTED with proven zero sandbox writes; its Important findings were triaged: the tier-cap fail-closed fix and the ratio-parameter mutation-gap test landed, `summarizeTokens` was reworded to a projected prefix, stale memory/doc/migration text was fixed, and a sub-40k auxiliary summarizer stays a documented residual risk. Release bookkeeping (commit/tag/push/pin/probe) and a re-review are open.

## Key points

- Final formula: `knee(W) = W − (W − 157000)·sigmoid(ln(W / 450000) / 0.04)`; `usable = W − 16384`; `floor = B + K + 8000`; caps in order summarizer → first tier edge−4000 → `usable − 4000`, only lowering; below floor → undefined.
- Curve basis: K=157K is the population median of measured MRCR 8-needle knees (46 models ≥1M: p25 127K / p50 157K / p75 190K); Wc=450K because every measured 500K+ declaration is inflated (grok-4.5/4.6 declare 500K, family ~195K; DeepSeek-V4.1-Flash / GLM-5.3 / Qwen3.8 declare 1M, measured 130–170K). Deliberately conservative for strong models (GPT-5.6 ~250K, Gemini 3.7 ~450K, GPT-6 ≥512K).
- Withdrawn alternatives: v0.1.9's `min(S, room/2)` cap (auto stuck at 64K), the two-term `max(B+K+S, rW)` (auto degenerates to the share), the half-window and window-end rules, the flat `min(W, 157K)` plateau (too early for strong 1M models), and the 273K/650K fit (ran inflated declarations 2–3× past their knee).
- `Threshold.summarizeTokens = tokens − baseline − keep` is the status line's projected summary input after caps (the real cut can only be shorter; a whole window in one turn makes the handoff skip with a warning). Falls back to configured `target` without usage.
- Tier cap fail-closed: a first-tier edge below `floor + 4000` returns undefined instead of silently crossing the paid boundary; exactly at `floor + 4000` it caps to the floor.
- Test pins: 1M → 157,000 (`auto 157k (16%)`, summarize 125,076); 400K → 379,616; 272K → 251,616; 768K → 157,001; heavy usage 512K → 583,924 (bound `target`); 120K tier → 116,000; tier edge at floor+4000 → 39,924; 128K summarizer → 127,156; 64K window → 43,616 (usable cap).
- Review round 1 transcript: `.codestable/issues/2026-09-19-handoff-adaptive-threshold-semantics/handoff-adaptive-threshold-semantics-review-round1-independent.txt`; verdict CHANGES-REQUESTED, no blocking findings.

## Open tasks

- Re-run the independent review on the fix delta (`/tmp/pc-threshold-review-v3` or equivalent), then release: commit, annotated tag v0.1.10, push both remotes, bump the `pi-config` pin, verify installed blobs, run a settings-installed probe, record evidence.
- Restart the live pi process (PID 367149) so it loads the new threshold code; until then the running session rewrites `.agents/memory/*` with the old semantics.
- Project skills were consolidated and committed: `memory-recovery` absorbed the truncation triage and stale-writer checks, `release-tag-and-pin-sync` absorbed the release-verification candidate, `write-lock-hardening` was promoted, and `sibling-repo-memory-sync` / `sandboxed-independent-review` / `gate-probe-mutation-check` were kept (backup: `/tmp/pc-skills-backup-20260919-220834.tar.gz`).

<!-- latest-session-title: Handoff adaptive threshold semantics: auto = conservative knee curve -->
