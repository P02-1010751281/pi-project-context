---
name: pi-project-context-status-renderer-dedup
description: "Unify duplicated status wording across pi-project-context command entry points into one shared renderer, pinned by cross-entry equality and single-sided mutation."
---

<!-- autolearn-generated: this skill may be superseded by a later autolearn pass -->

# Unify duplicated status wording across command entry points

## When to use
Two entry points print the same status fact from two separate implementations and the wordings have drifted — e.g. `/project-context status` versus `/memory` (as of v0.2.1: `memoryStatusLine()` in `extensions/project-context/index.ts` versus its own if-chain in `extensions/project-context/memory/report.ts`). Also use it *before* adding a new status branch, so the branch lands in one place.

## Step 1 — find both renderers

From the repo root:
```
rg -n "memoryStatus|No project memory yet|cannot be read" extensions/project-context
```
Two hits mean two renderers — that is the shape to look for; a single hit means the wording is already shared and there is nothing to unify. Diff the branches by hand, because the drift hides in the branch *set* rather than in shared lines: the pass that motivated this skill found `/memory` carrying a journal-unreadable recovery branch (`delete it to rebuild from MEMORY.md, or restore from memory-log-*.jsonl`) that the umbrella line lacked, and the same states worded differently on each side (`… but cannot be read; see errors.log` versus `… but cannot be read`; `No project memory yet: X` versus a bare source plus size).

## Step 2 — create the shared renderer
Add `extensions/project-context/memory/status.ts` exporting exactly two symbols:
- `memoryStatusMessage()` — the single user-visible wording;
- `memoryStatusLevel()` — the severity, for colouring or toast choice.

One function must cover every branch: normal, empty, at cap (truncated), poisoned (raw JSON from the old bug), damaged lines, file unreadable, journal unreadable.

## Step 3 — rewire the call sites
Point both `index.ts` and `memory/report.ts` at the shared function and delete the imports that fall unused on each side (that pass dropped several from each file). Result: the umbrella status line gains the journal-unreadable recovery hint and the permission hint, an empty memory prints `(empty)`, and every other string stays byte-identical.

## Step 4 — pin with cross-entry equality tests
In `tests/memory-ops-test.mjs` add 6 fixtures (normal, empty, at cap, poisoned, journal-unreadable, file-unreadable) × 3 assertions, each asserting both entry points render identical text for the same state.

## Step 5 — mutation check (the trap)
- Delete the journal-unreadable branch → the journal fixture must fail.
- Mutate the wording at exactly ONE call site → the equality assertions must fail.
- Mutating the shared function alone will NOT redden the equality assertions, because both sides move together. Always mutate one side, then revert and re-confirm 0 failures.

## Step 6 — gate and release
`node tests/run-all.mjs` must stay green. Because this changes user-visible text under `extensions/`, it is a behaviour change: add the CHANGELOG fix entry, then cut a release (new tag, pin bump, `pi update --extensions` — see the release/pin skill) and restart pi, because replacing the on-disk code does not affect running sessions.

## Notes
- Prefer keeping the umbrella's extra branches over trimming `/memory`, so no recovery instruction is lost.
- After the merge, `memory/status.ts` is the invariant "the one memory-status wording both entry points print" — grep for a second wording before adding any new status text.
