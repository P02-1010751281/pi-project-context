# Handoff before compaction

## Problem

pi's automatic compaction runs inside the post-run loop, before the `agent_settled` extension
event: `_handlePostAgentRun()` calls `_checkCompaction()`, which emits `session_before_compact`,
and `_emitAgentSettled()` runs in the `finally` of `_runAgentRun`. The handoff's only automatic
trigger was `agent_settled`.

The adaptive handoff threshold is `min(knee, W - 16384 - 4000)`; pi compacts at `W - 16384`. On a
272K window pi compacts at 256.0K and the handoff line is 252.1K: only 4K apart. A single turn can add more than 4K, cross
both lines, and let pi compact first. The handoff then reads the compacted branch, so the original
messages are gone — the exact loss the handoff exists to avoid. A fixed ratio above the reserve
line has the same shape.

## Decision

Register `session_before_compact`. When a handoff is already due — enabled, TUI, usage available,
the threshold resolves, usage is at/above it, and no in-flight/cooldown/backoff is active — cancel
automatic `threshold` and non-retrying `overflow` compaction (`{ cancel: true }`). The existing
`agent_settled` trigger then runs on the intact branch. Manual `/compact` is left alone: it is an
explicit user choice. An `overflow` event with `willRetry` is left to pi: that compaction is pi's
only path back into the interrupted turn, and a settle handoff cannot retry it, so preempting it
would turn a recoverable overflow into a dead turn. If the handoff fails, the failure backoff makes
the next automatic compaction proceed; if it skips because there is nothing older than the keep
window, the skip's cooldown prevents a cancel loop.

## Residuals

- A threshold compaction can also be emitted by `_prepareRun` before a prompt. Canceling there lets
  that prompt run before the settle-time handoff; the branch is preserved but the prompt can be
  over the threshold.
- If `getContextUsage()` is unavailable, the guard cannot resolve the threshold and pi compacts.
- Manual `/compact` is not preempted. A handoff cancelled by another extension arms the retrigger
  cooldown, so the next automatic compaction proceeds.
- An `overflow` recovery with `willRetry` is not preempted: pi compacts and retries the interrupted
  turn, and the handoff sees the compacted branch afterward. This is the deliberate cost of not
  losing the turn; if the handoff fails, the failure backoff lets the next compaction proceed.
