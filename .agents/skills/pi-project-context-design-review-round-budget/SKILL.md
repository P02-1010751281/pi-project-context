---
name: pi-project-context-design-review-round-budget
description: "Budget, bookkeep and close independent design-review rounds for a pi-project-context issue design doc: per-round verdict/nature table, concrete stop rule, anti-growth rules, archive-banner hygiene."
---

# Budgeting independent design-review rounds (pi-project-context)

## When to use

An issue in this repo has a design doc under `.codestable/issues/<issue>/` and you are running per-round independent reviews (one round = one fresh reviewer pass over one frozen revision). Use this to keep the rounds finite, to classify what a round found, and to know when the next round stops paying. Applies to the current external-edit issue family (`.codestable/issues/2026-10-03-external-edit-adoption-overwritten/`) and to any future design-heavy issue.

## Concrete steps

1. **Freeze + sandbox before the round.** Copy the frozen revision into a `/tmp` sandbox, run a fresh read-only reviewer there, take the before/after zero-write proof, then archive the transcript next to the design doc — the mechanics, the flag traps, the `/tmp` budget and the `.agents/memory` prune all live in `pi-project-context-sandboxed-independent-review`. One design-round nuance of its own: the reviewer's sandbox writes `.agents/memory/*` at startup even with the extension disabled, so that directory is pruned from the proof instead of being treated as reviewer editing.
2. **One round per frozen revision**, and a `PASSED` round does not cover edits made after it — a fix needs its own round.
3. **Apply only findings you can trace to a field fact**, bump the design revision, re-run.
4. **A launch-time `429`/`402`/`403` is an unfiled round, not a blocked one.** Probe another route (`pi-project-context-headless-route-probe`) and write the serving model into that round's prompt: measured 2026-10-03, one provider's `429` parked a round for a day while three other routes answered.

## Per-round bookkeeping

One row per round: revision, verdict, blocking count, important count, and the *nature* of the findings. Verdict alone is not the signal — counts and nature are. Real table:

| round | rev | verdict | blocking | important | nature |
|---|---|---|---|---|---|
| R1 | v1 | CHANGES-REQUESTED | 2 | 8 | root: entry point absent, publish window unhandled |
| R2 | v2.1 | CHANGES-REQUESTED | 0 | 5 | structural: report semantics, contract, flow table |
| R3 | v3 | CHANGES-REQUESTED | 1 | 1 | regression: reordering dropped one append |
| R4 | v4 | CHANGES-REQUESTED | 0 | 2 | spec: side-effect gate, table cell |
| R5 | v4.1 | CHANGES-REQUESTED | 0 | 3 | spec: predicate exactness, missing errors.log line, test precondition |
| R6 | rev 6 (B revision, re-run cancelled) | CHANGES-REQUESTED | 1 | 3 | root: `renderKey` undefined plus a missing empty guard would have refused publication forever in a fresh project |
| R7 | rev 7 | CHANGES-REQUESTED | 0 | 3 | spec: the refusal reply lied, a source flip read false-stale, the repro predicate was inverted |
| R8 | rev 8 | CHANGES-REQUESTED | 0 | 1 | bookkeeping: an existing test depended on the stale reply being published |

All eight design rounds returned CHANGES-REQUESTED; that is not failure and not a reason to keep going forever. The last three asked for **no new mechanism**, which is the real convergence signal — and note *what* R8 still had left: a test-ledger entry, i.e. something a prose round can still see, whereas wiring, call ordering and predicate placement cannot be judged from prose at all.

## Stop rule

Stop design rounds and switch to **implementation + one code-review round** when the last two rounds have **zero blocking findings and every remaining important finding is spec-precision, fixture or wording class**. Rationale observed in practice: what is left at that point (wiring, call ordering, predicate placement) is exactly what a reviewer reading prose cannot see, so another prose round cannot retire it. Here the implementation came in at ~124 net added lines in the extension plus a 199-line test file against a ~270-line design — inside the 3x rule — and the residuals were already named R-1..R-15 in the design itself.

**The one round worth adding after implementation:** a review of a *frozen, already implemented* revision can use the code and the test suite as ground truth instead of reasoning over prose alone, so it can settle wording and residual questions a pre-implementation round cannot ("does the design's sentence describe what the code does?"). The external-edit issue spent exactly one such round (R9) after `00bf797`, on the owner's instruction — it is a validation round, not a design-iteration round, and it should not reopen the mechanism.

## Anti-growth rules (apply the moment a finding lands)

- If a finding asks for a **new mechanism** rather than a correction of an existing one, first ask which field fact (issue section 1) it serves. No field fact -> write it in the design's non-goals, not into the mechanism.
- Stop adding when a round merely echoes the previous round's additions.
- One theme per issue.
- If the design surface is >3x the code delta, require a **minimal fix surface** section: what is deliberately dropped plus the named residual list. Example: the B revision of the external-edit design drops the re-run loop (the complexity mother), the `memory-stale-*.md` archive, a `resolveMemory()` extraction, the test seam and every lock change, keeping only the `basisKey` refusal in the write path, one pre-append recheck, and the publish-side side-effect skip in `report.ts`.
- When a revision supersedes a longer one, keep the old text as `<name>-full-v<n>-archive.md` with an "archived, do not implement" banner at the top. Never delete it; the round history is the audit trail.

## Closing the loop with the owner

Report: the round table, what each round actually caught (the strongest argument that the rounds were worth their cost), the convergence argument, the total rounds (= model runs, ~10-20 min each here), and the explicit open choice (one more design round vs implement now with a code-review round after). Design/audit work stays in `.codestable` documents committed separately from any implementation commit.
