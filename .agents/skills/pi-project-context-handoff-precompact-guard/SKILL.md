---
name: pi-project-context-handoff-precompact-guard
description: "Change or diagnose pi-project-context's handoff guard (session_before_compact), trigger predicate and replayed successor messages: fixtures, mutations, pi host checks."
---

<!-- autolearn-generated: this skill may be superseded by a later autolearn pass -->

# Handoff-before-compaction guard: change, test, diagnose

Use when touching the `session_before_compact` handler, the shared handoff trigger predicate, the cancelled/failed-handoff cooldown, the shape of the replayed messages, or the replay verdict that the successor session sees.

## Where the code lives

- Handler registration and the guard: `extensions/project-context/index.ts` -> `handoff/run.ts`; trigger predicate `maybeTrigger`; cooldown/backoff clocks in `handoff/state.ts` (`handoffCooldownUntil()`).
- `session_before_compact` must be in the expected event list of `tests/registration-test.mjs`; add it there in the same commit or that test goes red.
- Docs that must move with a behavior change: `docs/handoff.md`, `CHANGELOG.md`.

## Rules the guard must keep

- `maybeTrigger` stays the single gate owner. The settle trigger and the compaction guard both call it, and each call site keeps its own cooldown/failure-backoff clock. When adding a third caller, add a comment at the call site recording that, so nobody re-derives the predicate and silently drops the clocks.
- The guard preempts pi's compaction so handoff runs first; compaction must proceed (no `cancel`) when the handoff fails or is cancelled.
- A synchronous `sendUserMessage` throw inside `maybeTrigger` must arm failure backoff, otherwise the guard re-cancels compaction on every turn after one bad send. Async send failures are pi's to record; state that boundary in `docs/handoff.md` instead of inventing a hook.

## Writing the test (fixture gotchas)

1. A short/two-message fixture makes the guard path untestable: the handoff skips with `nothing older than the recent window to drop` before any cancellation, so the cancellation assertions pass for the wrong reason. Build a real parent-linked branch (a dozen entries with parent links) through `tests/harness.mjs` so there is something to drop.
2. Pass the full event payload, not a stub: `runHandlers(pi, "session_before_compact", ctx, { reason: "overflow", willRetry: true, signal: undefined })` - fidelity with pi's payload is itself an assertion target.
3. Cover three outcomes in one test: guard cancels on a real trigger (`result?.cancel === true`), compaction proceeds after a failed handoff, compaction proceeds after a cancelled handoff.
4. Assert the cancelled-handoff cooldown through `handoffCooldownUntil()` plus the notification text (`cancelled by another extension`), not through the notification alone - the timestamp is the behavior.
5. Use a fresh `makePi`/ctx for the cancelled path so leftover state from the failed path cannot mask it.

## Mutation matrix

- Delete one arm at a time (the guard's cancel, the cooldown arm on the cancelled path, the send-failure backoff) and re-run the file. Each deletion must turn a check red.
- A first run that shows 0 FAIL is a fixture finding, not a code finding: trace which skip returned early, fix the fixture, then re-mutate. Do not record the arm as non-load-bearing until the fixture reaches it.
- Keep a positive control alongside each mutation so a red result cannot come from a broken fixture.

## Replayed message shape: keep pi's record, do not trim it

When the handoff rewrites the replayed messages, the successor's assistant records must keep the field shape pi expects: a **fresh, zeroed `usage` object** (same keys as a live call, one object per message - never shared with the predecessor's record) and `stopReason`/`rawStopReason` dropped.

- Deleting the `usage` key instead of zeroing it is the trap: pi's consumers then read undefined and crash or misclassify. Expect the overflow classifier, the footer usage totals and the post-compaction context accounting to be the three that break.
- Pin the shape against the installed host functions rather than a stub: import `isContextOverflow`, `addUsageToTotals`, `calculateContextTokens` from the installed bundle in `tests/handoff-test.mjs` and run the replayed records through them.
- Assert freshness explicitly: two replayed messages must not reference the same usage object.

## The replay verdict is deliberate

- pi runs `_checkCompaction(lastAssistant, false)` in `_prepareRun` before the successor's first call, so a replay carrying `stopReason: "error"` reads as explicit overflow and `stopReason: "length"` below cap reads as recoverable - either one compacts the session right after handoff. Dropping the verdict on arrival is the fix, not an oversight.
- When this looks wrong, pin both arrival paths in `tests/handoff-test.mjs` and mutate the "keep stopReason" variant; it must go red.
- Rationale wording lives in `docs/architecture.md` / `CHANGELOG.md`; keep it accurate ("drop the verdict", not "preserve the field shape").

## Verify pi-host claims against the installed bundle

Read the actual host source before asserting a residual is a pi limitation:

```
V=$(cat ~/.pi/agent/install/current-version)
B=~/.pi/agent/install/releases/$V/node_modules/@earendil-works/pi-coding-agent/dist
P=~/.pi/agent/install/releases/$V/node_modules/@earendil-works/pi-ai/dist
rg -n 'session_before_compact|_prepareRun|_checkCompaction|explicitOverflow' $B
rg -n 'isContextOverflow|isRecoverableLength' $P/utils/overflow.js $B
rg -n 'addUsageToTotals|calculateContextTokens' $B
rg -n 'sendUserMessage|interface AssistantMessage|stopReason' $P/types.d.ts
```

Cite `file:line` in the review report. A residual whose fix needs an unobservable event (e.g. a `void`-returning `sendUserMessage` whose rejection is swallowed by `runner.emitError`, with no extension-facing error event) is closed as "blocked on a pi API change", not fixed by adding a hook.

## Run

```
node tests/handoff-test.mjs
node tests/registration-test.mjs
node tests/run-all.mjs
```

All checks must pass. No runtime behavior change means no new tag - say so explicitly in the report. A runtime change to this surface is release-worthy: cut the tag through the release skill rather than leaving it unreleased. The installed clone lags the repo through the pin, so its copy of this test belongs to the installed tag; run it there only after a release to verify the shipped build, never as proof for an unreleased working tree.
