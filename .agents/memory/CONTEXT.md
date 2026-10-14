# Project Context

Last updated: 2026-10-14T01:07:20.542Z

## Summary

Round 26 of the shutdown-flush review chain returned VERDICT: PASSED on the frozen revision 99c9e74, ending that chain; the three round-26 nits are post-PASS follow-ups. Whether 99c9e74 was actually released as v0.4.9 (tag, both push URLs, pin, installed-clone verification, probe, evidence) was never confirmed in this session and is still an open item. The session then turned to the handoff baseline residual issue: measurement showed that measureContext sums `plain` over pi's unfiltered branch, so the root system entry (content + sections + toolsAdded JSON, ~25,823 tokens locally) is subtracted via atRate and the baseline reads low by that amount, systematically lowering the floor (fail-open, early handoff). The proposed C fix (exclude system entries from plain) was evaluated and shown to remove only the constant bias: feeding the production measureContext a prefix truncated at each real usage record on a live session shows the C-style reading drifting 26,847 to 40,683 (13.8k) where the true overhead should be near constant, and the code's own calibration quantity (interval message-chars / prompt delta) spanning 0.17 to 19.90 across that session. Causes are predecessor-replayed records, context_edit/compaction points, and the injected memory block being refreshed inside the window. A (anchor estimate plus provider-exact increments) fixes the drift half but depends on the non-message overhead being constant between records, so it needs a record-eligibility rule; both C and A therefore need that rule. The measurement was archived into the issue dir and pushed as commit 6dd0ef8, verified present on both push URLs. The pending decision put to the operator is whether to fix the drift at all: C alone as a minimal slice with the drift registered as a residual, or C plus eligibility plus A.

## Key points

- measureContext's `plain` includes the root system entry because pi's getBranch() walks the parent chain unfiltered; sessionEntryToContextMessages returns system messages too, and pi's exported estimateTokens is chars/4 over content + sections + JSON(toolsAdded).
- Measured on a real repo session: system entry estimate 25,823 (sections 48,391 chars, toolsAdded 54,901 chars over 36 tools); prompt 115,265/118,233/121,119 against plainBefore 93,572/96,363/99,126 gives residuals 21,693/21,870/21,993, low by roughly atRate(system estimate).
- The probe that produced the issue's B_true (~17,766) counted message entries only, so it measures the intended non-droppable overhead; the shipped formula subtracts more and its floor sits systematically below the intended one (fail-open).
- All handoff test fixtures contain zero system entries, so every contract, mutation and probe validated a branch shape production never has; this is why two review rounds missed it.
- C fix (exclude system entries from plain) removes only the constant bias: on a live session the C-style reading still drifted 26,847 to 40,683 and the interval rate (message chars / prompt delta) spanned 0.17 to 19.90, so one session-level rate cannot serve every prefix.
- Drift causes visible in the data: predecessor-replayed records (prompt 131k against ~1.2k local messages), context_edit/compaction (prompt drops, local chars stay), and the injected block being refreshed inside the window (rate 19.9, impossible from text alone).
- A (anchor chars/8 lower bound plus provider-exact increments) gives a constructively stable, fail-closed reading (two sandboxes within +10) but assumes non-message overhead is constant between records, so it needs a record-eligibility rule (skip replays, re-anchor at context_edit/compaction, exclude overhead-changing intervals); C's per-sample form is immune to the third cause but not the first two.
- Evidence and probes for the issue were archived under .codestable/issues/2026-10-09-handoff-baseline-residual/ (baseline-includes-system-estimate.md, probe-rate-spread.mjs/.txt) and pushed as commit 6dd0ef8, verified on both push URLs.
- The github mirror's ssh ls-remote was flaky during this pass and needed retries, while the forgejo URL was reliable; only docs and probes were touched, no code.
- Existing context on the earlier questions still holds: the live status line's parenthetical is a below-quality-knee refusal, `drop budget` is the configured fallback display when the threshold cannot resolve, and in that state no auto handoff fires; pi already provides caching, so no new cache layer is warranted.

## Open tasks

- Decide the baseline issue's scope: C alone (exclude system entries from plain, plus a contract pinning the sandbox 17,760 and ctl 11,015 readings, drift registered as a residual) or C plus record-eligibility plus A.
- If C is chosen, implement it as its own slice: production change in handoff/threshold.ts, a fixture with a root system entry, and an in-fixture probe reproducing the ~25.8k shortfall before the fix.
- If the drift is to be fixed, define the record-eligibility rule first (skip predecessor-replayed records, re-anchor at context_edit/compaction, exclude intervals whose non-message overhead changed), since both C and A depend on it.
- Confirm whether 99c9e74 was released as v0.4.9; if not, complete the release: annotated tag, push to origin, confirm both push URLs report the tag, bump the pin in ~/.pi (settings.json and README.md) with pull --rebase, run pi update --extensions, verify the installed clone and run its probes, commit the evidence, restart pi.
- Land the three round-26 nits as post-PASS follow-ups while stating that the PASS covers 99c9e74 and that the code diff after it is empty: relabel the 17-red mutation, narrow CHANGELOG's not-load-bearing sentence to CRLF normalization, fence skipping and the {0,3} boundary, and add the two fence-indentation unit cases to tests/sections-test.mjs.
- Have the next memory curation pass propose retirements rather than compression, since the render sits within a few hundred characters of the cap.
- Decide the autolearn B1' layering on the recorded shape evidence or wait for a cost fact; the reopen condition is already recorded.
- Sibling consumer repos (their call): test a pi-rendered MEMORY.md against HEAD before committing or merging it, merge back UniField's dropped curated block, and decide on their unpushed local commits.
- Non-code residuals still open: readRenderWithMtime's mtime+size blind spot and the SIGKILL failure path's leftover temp directories.

<!-- latest-session-title: Handoff baseline residual: system entry in plain, C drift measured, C vs C+A decision pending -->
