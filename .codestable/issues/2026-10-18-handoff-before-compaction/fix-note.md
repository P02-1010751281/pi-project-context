# Fix note: handoff before compaction

## Fix

- `handoff/run.ts`: extracted `handoffDue(ctx, usage)` from `maybeTrigger` (enabled, TUI, usage,
  `resolveThreshold`, usage at/above it, no in-flight). `maybeTrigger` keeps its idle/cooldown/
  backoff checks and uses the predicate.
- `handoff/run.ts`: registered `session_before_compact`. For automatic reasons (`threshold`,
  `overflow`) it checks cooldown/backoff, then `handoffDue`, and returns `{ cancel: true }`.
  `manual` is ignored.
- `docs/handoff.md`, `CHANGELOG.md`: describe the pre-compaction guard and its manual exception.

## Verification

- `a due handoff cancels threshold compaction`: with usage 190K on a 200K window, the handler
  returns `{ cancel: true }`.
- `manual compaction is not cancelled`: `reason: "manual"` returns no cancel.
- `automatic overflow compaction is cancelled for a due handoff`: `reason: "overflow"` cancels.
- `compaction proceeds below the handoff threshold`: usage 100K returns no cancel.
- `compaction proceeds outside the TUI`: print mode returns no cancel.
- `the pre-compaction guard hands the trigger back to settle`: a canceled compaction followed by
  `agent_settled` still schedules `/handoff force-auto`.
- `compaction proceeds after a failed handoff`: the mock's failed `force-auto` arms the failure
  backoff; the next `session_before_compact` does not cancel.
- `the cancelled handoff arms its cooldown`: a `newSession` returning `{ cancelled: true }` arms
  the shared cooldown clock (observed through the same module instance). The failed-handoff test
  covers the guard's no-cancel behavior after a clock is armed.
- Full suite: `node tests/run-all.mjs` -> `All 15 tests passed.`

## Mutations (applied to a copy, restored; `node tests/handoff-test.mjs`)

- remove the `session_before_compact` handler -> 2 FAIL;
- exclude `overflow` (`reason !== "threshold"`) -> 1 FAIL;
- remove the TUI guard -> 1 FAIL;
- remove the cooldown/backoff guard -> 1 FAIL;
- remove the cancelled-handoff cooldown arm -> 1 FAIL.

## Residuals

- A `_prepareRun` threshold compaction is canceled before the prompt; the prompt can run over the
  threshold before the settle-time handoff.
- Usage unavailable -> no cancel.
- Manual `/compact` is not preempted; a handoff cancelled by another extension arms the cooldown,
  so the next automatic compaction proceeds.
- Overflow is preempted; if the handoff fails, the failure backoff lets the next compaction run.
