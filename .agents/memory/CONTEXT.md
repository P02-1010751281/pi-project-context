# Project Context

Last updated: 2026-10-19T01:47:20.089Z

## Summary

Implementation pass on the handoff-before-compaction issue, followed by a prefix-cache field experiment. The issue was added because handoff must fire before pi's compaction, which would otherwise cause exactly the context loss handoff exists to avoid. New behavior: a `session_before_compact` handler cancels compaction so the handoff runs first; the settle trigger and the guard share one trigger predicate with the cooldown/failure-backoff clocks kept at both call sites. Tests extended in tests/handoff-test.mjs (overflow-event fidelity with willRetry/signal, cancelled-handoff cooldown via a real 12-message branch, compaction-proceeds-after-cancel) and tests/registration-test.mjs (the new event in the expected list); docs/handoff.md and CHANGELOG updated. A mutation removing the cancelled-handoff cooldown arm showed 0 FAIL at first, which was traced to the two-message fixture hitting the `nothing older` skip; after giving the fixture a real branch the check passes and the arm is load-bearing. Then a field experiment on deepseek-v4-pro measured prefix-cache behavior across a handoff: same-session cacheRead grew 384 -> 2048 over 6 turns; the successor's own first call dropped to 384 (the static system block) and rebuilt to 1408 from its own prefix; keep=0 and `/new` controls also started at 384. Conclusion: the loss is one conversation-prefix miss, not a system-block loss, and total tokens can still be lower. Written up in .codestable/audits/2026-10-18-handoff-prefix-cache-field-run.md and committed as 96d1709, after the fix commit c653f1f.

## Key points

- New `session_before_compact` handler cancels compaction so handoff runs first; session_before_compact joined the expected event list in tests/registration-test.mjs.
- maybeTrigger stays the only gate owner with cooldown/backoff clocks kept at each call site; run.ts has a comment recording that so a third caller cannot skip them.
- A two-message fixture makes the guard path untestable: `nothing older than the recent window to drop` skips before cancellation, so the cancelled-handoff test needed a real 12-entry parent-linked branch.
- The cancelled-handoff cooldown is asserted through handoffCooldownUntil() (handoff/state.ts) plus the notification text, and the mutation removing the cooldown arm from the cancelled path is now red.
- Overflow-event fidelity: the test now passes { reason: 'overflow', willRetry: true, signal: undefined } to session_before_compact.
- Prefix-cache field run (deepseek-v4-pro, 6 turns + /handoff now): predecessor cacheRead 384/768/1024/1408/1792/2048; successor's own first call cacheRead 384 with input 1060, then 1408/1408.
- Controls: keep=0 successor first call cacheRead 384; `/new` first call cacheRead 384. So the static system block crosses sessions and replay order is not the cause of the first-call number.
- Interpretation: one conversation-prefix miss per handoff; total tokens can fall (predecessor last total 2463 vs successor first 1446), so lost cacheRead is not automatically worse cost.
- Only static content is optimizable: keep system prompt/tools/skills/memory render byte-stable and avoid changing the memory render at handoff time; a handoff preamble cannot help the first call of a chain.
- A single successor run showed cacheRead=0 on the first call and repeated as 384; recorded as cold noise, not a mechanism conclusion. Relay cache_control passthrough remains unverified.

## Open tasks

- Finish/close the handoff-before-compaction issue: review round, then release as v0.4.9 or later (tag, both push URLs, pin bump in ~/.pi with pull --rebase, pi update --extensions, installed-clone probe, evidence commit).
- Decide whether the handoff-before-compaction slice keeps the cancelled-handoff cooldown arm as is or also covers other extensions cancelling mid-flight; the current behavior is: cooldown armed, next automatic compaction proceeds.
- Decide whether any change follows from the prefix-cache finding (e.g. a note in docs/handoff.md or threshold.ts that the drop costs one conversation-prefix miss) or whether the audit stays the only record.
- Confirm whether 99c9e74 was released as v0.4.9; if not, complete that release.
- Land the three round-26 nits as post-PASS follow-ups stating the PASS covers 99c9e74: relabel the 17-red mutation, narrow CHANGELOG's not-load-bearing sentence, add the two fence-indentation unit cases to tests/sections-test.mjs.
- Decide the baseline residual scope: C alone (exclude system entries from plain) or C plus record-eligibility plus A.
- Have the next memory curation pass propose retirements rather than compression, since the render sits near the cap.
- Sibling consumer repos (their call): test a pi-rendered MEMORY.md against HEAD before committing or merging, merge back UniField's dropped curated block, and decide on their unpushed local commits.
- Non-code residuals still open: readRenderWithMtime's mtime+size blind spot and the SIGKILL failure path's leftover temp directories.

<!-- latest-session-title: Handoff before compaction: session_before_compact guard, cancelled-handoff cooldown test, prefix-cache field run -->
