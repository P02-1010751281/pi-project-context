/**
 * Per-session handoff state: what is in flight and the two cool-down clocks.
 *
 * These are single module-level values, not per-session maps, so they stay private here and are
 * reached through accessors: an imported `let` cannot be assigned by another module, and a split
 * that exported it would leave the writer and the reader silently out of step.
 */

/** Back off this long after a failed automatic handoff before trying again. */
export const FAILURE_BACKOFF_MS = 5 * 60_000;

/** Minimum gap between two automatic triggers. */
export const RETRIGGER_COOLDOWN_MS = 30_000;

/** Set while a handoff is being generated/replaced so a second settle cannot stack one. */
let inFlight = false;

let cooldownUntil = 0;

let failureBackoffUntil = 0;

/** Whether a handoff is currently being generated or replaced. */
export function handoffInFlight(): boolean {
	return inFlight;
}

/** Mark a handoff as running (`true`) or finished (`false`). */
export function setHandoffInFlight(value: boolean): void {
	inFlight = value;
}

/** Earliest time the next automatic trigger may run. */
export function handoffCooldownUntil(): number {
	return cooldownUntil;
}

/** Defer the next automatic trigger by `ms` from now. */
export function armHandoffCooldown(ms: number): void {
	cooldownUntil = Date.now() + ms;
}

/** Earliest time to retry after a failed automatic handoff. */
export function handoffFailureBackoffUntil(): number {
	return failureBackoffUntil;
}

/** Back off the next automatic attempt by `ms` from now. */
export function armHandoffFailureBackoff(ms: number): void {
	failureBackoffUntil = Date.now() + ms;
}
