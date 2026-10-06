# Project Context

Last updated: 2026-10-06T10:48:15.064Z

## Summary

Released v0.4.5, the fix for the memory-entry loss: renderMemoryDocument now allocates each section min(need, target), pools the slack and lends it to over-target sections, so entries are dropped only when the whole document reaches maxMemoryChars. The pool is measured against the document's real body (cap minus memoryStructureOverheadChars), which was the blocking finding in round 1. Six independent flash review rounds ran; R1-R5 were all the same class (a user-visible sentence promising what the code does not do) and R6 passed with five wording nits, closed in the release commit 6e8170d. Tag d856f3a, pin 57eccbc, installed clone at v0.4.5 with 15/15 self-test; the record commit ffa4cdb carries the release facts. The acceptance run on the installed revision shows no cap line and renderer droppedItems=0, but the model itself still rewrote 138 entries down to 130 because the memory sits 7 characters under its cap - that residual is now the single open decision for the owner.

## Key points

- Final state: master ffa4cdb on both push URLs, worktree clean, suite 15/15 plus the hygiene gate, `git diff --check v0.4.4..HEAD` clean.
- Fix: renderMemoryDocument allocates min(need, target) per section, pools the slack, lends by overage ratio, and each per-item cap follows the post-borrow allowance; only the document reaching maxMemoryChars drops entries.
- Pool basis was the review's blocking finding: it must be cap minus memoryStructureOverheadChars (67), not the floored target sum (31,922, 11 characters short), or the repo's own memory (31,993) still loses entries.
- Evidence: the field 138-entry input renders with droppedItems=0 (previously 9); two pinned properties each over 2,000 random caps (fits => drops nothing; any input stays under the cap); mutation matrix M1 6 red / M2 1 / M2' 9 / M3 1 / M4 1.
- Prompt layer (v0.4.4, unchanged here): the main rule asks for compression first and the exactly-one condensation retry fires on a section overflow instead of on a character cap; prompt cost is +376 characters on the main prompt plus the retry sentence only on overflow.
- Round chain: R1-R5 CHANGES-REQUESTED, all on notices promising what the code does not do (pool basis, cut-only reported as reaching the cap, a log-sample pointer, throttled samples, cross-sequence, a dangling status pointer) -> the fix inlines the drop samples and deletes the log pointer; R6 PASSED / RELEASE-OK: yes with five wording nits, closed in 6e8170d.
- Release: tag object d856f3a, peeled 6e8170d, both remotes at master and v0.4.5; pi-config pin commit 57eccbc; installed clone describe v0.4.5, dirty 0, 15/15 self-test, all new symbols present and the retired ones absent.
- Acceptance run on the installed revision: no cap line in errors.log, renderer sectionDropped=0 droppedItems=0, but the same pass logged `memory regression: 24` (exact-match counting merges and rewrites) and net entries went 138 -> 130.
- Sandbox hygiene: the six review copies plus probes (~1.5 GB) were removed; /tmp is back to 64%.

## Open tasks

- Owner decision (only open item): the memory sits at 31,993 of a 32,000 cap, so every pass that adds an entry must remove one - raise maxMemoryChars via `/memory max-memory <n>` (about 1,000 more injected tokens per session) or curate the memory once; recorded in .codestable/attention.md.
- Restart pi before the host reflects v0.4.5; the session that ran the install still loads the older modules.
- Owner plus host: run one real TUI handoff to expose the A+B snap/anchor path and the cwd fallback boundaries, and exercise `/handoff threshold <ratio>` in fixed mode so the refusal is seen live.
- Watch a real session JSONL for a read of .agents/memory/* as field evidence of progressive-disclosure compliance, and log it in the cost audit.
- Watch for a real autolearn merge that hits the 8000-character inventory cap, confirming the truncation marker in the field rather than only in synthetic tests.
- Record the summary-chain deletion adjustment in .codestable/issues/2026-10-05-handoff-last-turn-not-replayed/ (design banner already names f19dc93 and b4c9405).
- The seven owner forks in .codestable/issues/2026-10-05-autolearn-progressive-disclosure/ section 0 remain unanswered; slice A1 unimplemented, autolearn B1' parked.
- The pi-style turn-prefix second handoff summary stays designed-not-built in section 7 of handoff-last-turn-design.md and needs its own go-ahead.
- Owner decides on the prefix-cache skill's recommendations (session-stable injected memory, no render at handoff time, showCacheMissNotices/cacheWarming) and whether to measure cacheRead against the system block on a real route.
- Owner review of remaining audit findings: handoff/memory shutdown coupling, per-session migration retirement window, lock hygiene.
- dsh-side R-2 (whether that plugin reads handoffThinking) is the owner's item in the dsh repo and stays struck from this repo's residual list.
- Sibling consumer repos (their call): test a pi-rendered MEMORY.md against HEAD before committing or merging it, merge back UniField's dropped curated block, decide on their unpushed local commits.

<!-- latest-session-title: Shipped v0.4.5: per-section shares are targets and the memory no longer loses entries to the renderer -->
