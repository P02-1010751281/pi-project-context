# Project Context

Last updated: 2026-10-06T04:38:57.444Z

## Summary

Continuation pass after the v0.4.3 release: the release artifacts were verified untouched (tag b26c2db / peeled b9085d5 identical on both remotes, pin 3c5dad6, installed clone describe v0.4.3 with zero dirty), and the only open item was the memory render the previous session's shutdown pass left in the worktree. That render both added the v0.4.3 facts and silently dropped 11 durable entries (5 Invariants / 4 Pitfalls / 3 Index), noticed only by the log-only `memory regression:` guard line; 10 entries were restored, 1 explicitly superseded entry retired, and one long-wrong Index pointer for .codestable/attention.md corrected. The structural cause - MEMORY.md sits about one entry under its cap, so a pass must drop to add - was recorded in .codestable/attention.md as an owner decision instead of a unilateral fix. Everything is committed and pushed to both remotes; the tree is clean apart from the intentionally untracked skill-candidates/ directory.

## Key points

- Final state: master 5a92c54 on both push URLs, worktree clean except `?? .agents/memory/skill-candidates/` (untracked pipeline state by design), suite 15/15 plus `repo hygiene (no trailing blank line) ... ok`, `git diff --check` empty.
- v0.4.3 release verified intact and needing no rework: tag object b26c2db3106df81889158d4a99adccec3ee6ce1d, peeled b9085d5e58e33533cbd96e565a4cd06adc498ba4, pi-config pin v0.4.3, installed clone describe v0.4.3 with zero dirty; this session started after the install, so it is running v0.4.3.
- The shutdown render (written 2026-10-06T04:30:56Z) added 6 v0.4.3 facts and corrected 2 others, but dropped 11 durable entries - 5 Invariants, 4 Pitfalls, 3 Index - and only logged `memory regression: 3 Invariants/Pitfalls entry(ies) are no longer present`, because the guard is log-only by design (pass.ts:318 warns then publishes).
- Restored verbatim: the pi-config pin-bump rule, the render-commit rule, the knob-census rule, the pointer-section traversal invariant, three sweep pitfalls, and the Index pointers for tests/sections-test.mjs, the cost audit and .codestable/attention.md. Retired: the pi compaction-summary history, which its own text already limited to reading old artifacts and which v0.4.1's chain deletion superseded. Two apparent losses were actually merges (the config-document rule folded into the knob-usage pitfall; the /tmp sandbox size corrected).
- A long-repeated Index fact was wrong and is fixed: attention.md was described as a running review checklist, while the file is the CodeStable entry notes every sub-skill reads before starting.
- Memory now holds 137 entries in 31,774 of 32,000 characters (226 headroom), which is why a consolidation pass cannot add without dropping.
- The cap finding is recorded in .codestable/attention.md with its evidence (three errors.log regression lines - 14, 20-segment-budget, 3 - plus this measured 11-entry loss) and three options for the owner: accept natural trimming (current), tighten the consolidation rules to compress rather than delete via the pi-project-context-consolidation-prompt-rule skill (recommended), or raise maxMemoryChars at the cost the audit measured.
- Round 12's nits were closed before this pass's commits landed: the hygiene gate now catches a CRLF blank tail, the ratio-coupling guard has a minimum-side assertion (the MIN 0.2 + hardcoded-0.1 mutation reddens 3 named assertions), the config comments point at the constants, the audit counts match, and the docs sentence says the scheduled trigger is refused while /handoff now does not consult the threshold.
- Commits from this pass: 8baab6f (render refresh), 793b708 and 8cf0a9f (attention.md finding plus its rewrap), 5a92c54 (session snapshot: CONTEXT.md, HANDOFF.md, project-context.json).
- CONTEXT.md and HANDOFF.md in the worktree are pi-written session state; project-context.json's only change is the advanced autolearnAt offset.

## Open tasks

- Owner picks one of the three cap options in .codestable/attention.md; option (b) needs a prompt-rule cycle with render-side acceptance, option (c) a cost re-check.
- Restart pi before the host reflects v0.4.3: the session that ran the install is not the one loading the newest modules.
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

<!-- latest-session-title: Restored the render the shutdown pass dropped and recorded the cap finding -->
