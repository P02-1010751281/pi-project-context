# Review report: handoff before compaction

| round | revision | verdict | blocking | important | nature |
|---|---|---|---|---|---|
| R1 | pre-compaction guard | PASSED | 0 | 1 | `session_before_compact` preempts automatic threshold/overflow; I-1 cancelled-cooldown pin was missing |
| R2 | `1a71b73` (v0.4.11 RC) | PASSED | 0 | 0 | post-PASS `willRetry` correction verified against pi 1.3.0; cap reviewed; nits A-1/B-1/B-2/B-3 and residual A-2 recorded as follow-ups |

## R1 (transcript: `review-round1-precompact-independent.txt`)

**VERDICT: PASSED**. Verified in installed pi 1.3.0 that `session_before_compact` runs before
`agent_settled`, that `{ cancel: true }` cancels threshold/overflow without a retry, and that the
settle event still fires on the intact branch. `handoffDue` matches the settle trigger; failure
backoff, skip cooldown and in-flight/disabled/print paths lean toward compaction rather than a
cancel loop. Mutations re-measured: remove handler 2 FAIL, exclude overflow 1, remove TUI guard 1,
remove cooldown/backoff 1.

I-1 (important): the cancelled-handoff cooldown arm was unpinned. Fixed post-PASS by loading
`handoff.ts` and `state.ts` through one jiti loader and pinning the shared cooldown clock; removing
the arm now gives 1 FAIL. Nits fixed: the 272K absolute figures, the cancelled-handoff residual
wording, the docs/CHANGELOG cooldown sentence, the registration surface, and the `handoffDue`
clock comment.

Post-PASS correction: the original R1 code cancelled `overflow` even when `willRetry` was true,
which skips pi's only retry path and turns a recoverable overflow into a dead turn. The handler now
lets retrying overflow recovery proceed; only completed (`willRetry: false`) overflow is
preempted. This is a code change after the PASS, so R1 no longer covers the current HEAD; a new
review round is required before release.


## R2 (transcript: `review-round2-release-independent.txt`)

**VERDICT: PASSED** on frozen revision `1a71b73`, the v0.4.11 release candidate. The reviewer
verified against installed pi 1.3.0 that `session_before_compact` runs before `agent_settled`, that
`{ cancel: true }` stops threshold and completed-overflow compaction, and that `willRetry: true`
really reaches `agent.continue()`; removing the `willRetry` arm gives 1 FAIL. It also reviewed the
previously unreviewed tool-result cap: default `0` is inert and byte-stable, only text blocks are
replaced, call/result pairing, images and nested calls survive, and the trim/recovery wording and
the re-read cost warning match the code. Full suite 15/15; sandbox status and file-stat diffs were
empty (zero-write proof).

Review nits, intentionally not fixed before the tag (a code change would invalidate the PASS):
- A-1: `maybeTrigger`'s send-failure catch does not arm the failure backoff; while a trigger keeps
  failing, the pre-compaction guard can keep cancelling. Pre-existing trigger code; follow-up.
- B-1: the cap receipt says "capped at ~N tokens" even when the marker itself exceeds a tiny N;
  reword or floor the advertised value. Follow-up.
- B-2: the in-replay trim marker is English-only inside zh continuations. Cosmetic follow-up.
- B-3: multiple oversized results, a measured rate ≠ 4, the `budget recent` receipt and a
  null-usage guard case are not pinned by tests. Suggestion.
- A-2 (residual-risk): replayed messages carry old usage, so a successor above pi's reserve line
  can trip `_prepareRun` compaction; at the default keep it is a no-op, but a `recent` budget above
  pi's 20k keep can summarize the replayed prefix on arrival. Pre-existing pi/handoff interaction,
  not introduced by this round.

The PASS covers `1a71b73` only; the tag points at that exact commit. Release follow-ups are tracked
in the release evidence and the next patch, not by rewriting the tag.
