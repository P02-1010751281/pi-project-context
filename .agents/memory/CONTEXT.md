# Project Context

Last updated: 2026-10-06T07:30:43.608Z

## Summary

This session turned the previous session's memory-loss finding into v0.4.4. The user picked option (b) - fix the consolidation rules so a pass compresses instead of dropping - and added "清理残留" (leave no residuals) plus: dsh's share of the work is the user's, in that other repo. Independent review round 1 rejected my first fix because my root cause was wrong; I reproduced the reviewer's claim myself and confirmed the loss comes from the renderer's fixed per-section shares, not from the model deleting entries. The fix was re-aimed at both prompt sites, round 2 passed, a nit-cleanup commit closed round 12's findings, and v0.4.4 was released (tag pushed to both remotes, pi-config pin bumped, install verified, sandboxes cleaned). Acceptance is explicitly open: it needs the first pass after a pi restart to compress the complete over-share memory without losing entries. The tracked MEMORY.md now holds the complete 137-entry version.

## Key points

- Final state: master 7ab60c9 on both push URLs, worktree clean except `?? .agents/memory/skill-candidates/`, suite 15/15 plus the hygiene gate, range diff --check clean.
- Root cause was corrected by review and verified by me: `renderMemoryDocument` (memory/sections.ts) enforces fixed per-section shares and drops whole entries; the committed memory was over three shares (Invariants +852, Pitfalls +239, Index +544) with Project at 71%, and rendering it yields sectionDropped=3 / droppedItems=9 that match the field file's missing entries byte for byte across the shared sections. The model had kept those entries.
- Round chain: R1 at 65e9283 CHANGES-REQUESTED (root cause wrong, acceptance signal structurally invalid, retry sentence conflicted with the main rule) -> re-aimed fix aaafd0b -> R2 PASSED / RELEASE-OK: yes; then a release commit 009cceb closing R2's nits and two code suggestions, plus c9d4db6 closing round 12's nits (CRLF hole in the hygiene gate, MIN-side ratio assertion, audit counts, config comment, first-line-overflow inventory case, docs wording).
- Mutation matrix on the new prompt sites: main-rule deletion 3 red, note deletion exactly 1 red, old wording 4 red, retry regression 4 red; minimum-side ratio mutation now reddens 3 named assertions (was green before).
- Prompt cost: main prompt +376 characters (4,145 -> 4,521, ~94 tokens per consolidation) and the retry sentence +158 only when a section overflows.
- v0.4.4 release verified: tag object 5982fd9f, peeled 009cceb, both remotes show master and v0.4.4 at the peeled commit; pi-config pin commit ed4a732 bumped settings.json and README.md to @v0.4.4; installed clone describe v0.4.4 with zero dirty and 15/15 self-test; the removed wording `remove the least durable` is absent from the installed tree.
- MEMORY.md is restored to the complete 137-entry / 31,774-character version (it equals HEAD, so `git checkout --` needed no commit). It is deliberately over three section shares: the first pass after the pi restart is the acceptance test for the new compression rule.
- Sandbox hygiene was paid for again: the two 185 MB review copies were removed and /tmp is back to 58%.
- The second-layer finding - fixed shares versus this repo's content distribution, where ~2,000 characters of the total cap stay unused - is recorded in .codestable/attention.md and the fix note, for the owner to decide.

## Open tasks

- v0.4.4's acceptance rule is superseded: the string it watched (`memory exceeded a section budget:`) no longer exists and the pass-drops it counted were the renderer's per-section shares. v0.4.5 makes the shares targets and the log line `memory document reached its cap:`; a restart is still needed to load it.
- Owner: the section-share question is decided and shipped (v0.4.5, shares are targets so only the document cap drops entries). New small decision: the memory now sits at ~99.9% of `maxMemoryChars`, so every pass that adds entries has to condense elsewhere - raise the cap (`/memory max-memory`) or curate the memory once.
- Restart pi before the host reflects v0.4.4; the session that ran the install still loads v0.4.3 modules.
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

<!-- latest-session-title: Shipped v0.4.4: consolidation now compresses to the section budgets instead of dropping entries -->
