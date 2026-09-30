/**
 * Failure policy for the auxiliary model calls.
 *
 * A broken route (expired auth, exhausted quota, flaky relay) used to be retried on every settle
 * and reported on every attempt, so one outage produced a burst of identical failures. This module
 * classifies the failure, parks the next automatic attempt behind a cooldown, and disables the
 * pass for the rest of the session after too many consecutive provider failures. Explicit commands
 * pass `force` and deliberately bypass the park: a human asking for a pass should always get one.
 */

/** What kind of failure a thrown model error is. */
export type ModelFailureKind = "auth" | "quota" | "transient" | "shape" | "other";

/** Auth will not repair itself inside a session: park long and let the user notice. */
export const AUTH_COOLDOWN_MS = 30 * 60_000;
/** A quota window is usually minutes to hours: back off hard, but not forever. */
export const QUOTA_COOLDOWN_MS = 15 * 60_000;
/** First transient cooldown; each consecutive transient failure doubles it. Matches the memory throttle. */
export const TRANSIENT_BASE_COOLDOWN_MS = 5 * 60_000;
/** Ceiling for the transient cooldown. */
export const TRANSIENT_MAX_COOLDOWN_MS = 30 * 60_000;
/** Consecutive provider failures after which an automatic pass parks for the rest of the session. */
export const AUTO_DISABLE_AFTER = 5;

const SHAPE_RE = /not a usable JSON object|cut off by the model output limit|no context section|did not return the expected JSON|was not a usable JSON object/i;
const AUTH_RE = /\b40[13]\b|authentication failed|invalid api key|model_not_in_plan|permission denied|unauthori[sz]ed/i;
const QUOTA_RE = /\b(402|429)\b|insufficient (balance|credits|quota)|usage limit|quota exceeded|rate limit/i;
const TRANSIENT_RE = /connection error|timed? ?out|etimedout|econnreset|econnrefused|eai_again|socket hang up|fetch failed|network error|stream (error|ended|closed)|terminated|aborted|temporarily unavailable|\b50[234]\b/i;

/**
 * Classify a thrown model error. Shape failures (a reply the parser refused) are not provider
 * failures: they must not arm the provider cooldown, because the existing parse throttle already
 * backs them off and treating them as an outage would park a healthy route.
 */
export function classifyModelFailure(error: unknown): ModelFailureKind {
	const text = error instanceof Error ? error.message : String(error);
	if (SHAPE_RE.test(text)) return "shape";
	if (AUTH_RE.test(text)) return "auth";
	if (QUOTA_RE.test(text)) return "quota";
	if (TRANSIENT_RE.test(text)) return "transient";
	return "other";
}

type FailureState = { kind: ModelFailureKind; failures: number; until: number; disabled: boolean };

/** What one recorded failure means for the caller: how long to park, and whether to speak. */
export type FailureRecord = {
	kind: ModelFailureKind;
	failures: number;
	cooldownMs: number;
	disabled: boolean;
	/** True for the first provider failure since the last success — the one worth surfacing. */
	firstSinceSuccess: boolean;
};

const states = new Map<string, FailureState>();

function stateKey(scope: string, projectRoot: string): string {
	return `${scope}\u0000${projectRoot}`;
}

function cooldownFor(kind: ModelFailureKind, failures: number): number {
	if (kind === "auth") return AUTH_COOLDOWN_MS;
	if (kind === "quota") return QUOTA_COOLDOWN_MS;
	if (kind === "transient") return Math.min(TRANSIENT_MAX_COOLDOWN_MS, TRANSIENT_BASE_COOLDOWN_MS * 2 ** Math.max(0, failures - 1));
	return 0;
}

function isProviderFailure(kind: ModelFailureKind): boolean {
	return kind === "auth" || kind === "quota" || kind === "transient";
}

/** Record one failure and arm the cooldown. Shape/other failures leave the cooldown untouched. */
export function noteModelFailure(scope: string, projectRoot: string, error: unknown): FailureRecord {
	const kind = classifyModelFailure(error);
	const id = stateKey(scope, projectRoot);
	const previous = states.get(id);
	if (!isProviderFailure(kind)) {
		return {
			kind,
			failures: previous?.failures ?? 0,
			cooldownMs: 0,
			disabled: previous?.disabled ?? false,
			firstSinceSuccess: !previous || previous.failures === 0,
		};
	}
	const sameEpisode = previous?.kind === kind && previous.failures > 0;
	const failures = (sameEpisode ? previous.failures : 0) + 1;
	const cooldownMs = cooldownFor(kind, failures);
	const disabled = failures >= AUTO_DISABLE_AFTER;
	states.set(id, { kind, failures, until: Date.now() + cooldownMs, disabled });
	return { kind, failures, cooldownMs, disabled, firstSinceSuccess: !sameEpisode };
}

/** The route answered: any earlier outage is over and the failure count starts from zero. */
export function noteModelSuccess(scope: string, projectRoot: string): void {
	states.delete(stateKey(scope, projectRoot));
}

export function modelCooldownRemaining(scope: string, projectRoot: string): number {
	const state = states.get(stateKey(scope, projectRoot));
	if (!state) return 0;
	return Math.max(0, state.until - Date.now());
}

export function modelAutoDisabled(scope: string, projectRoot: string): boolean {
	return states.get(stateKey(scope, projectRoot))?.disabled ?? false;
}

/** True while an automatic pass must not call the model again. */
export function modelBlocked(scope: string, projectRoot: string): boolean {
	const state = states.get(stateKey(scope, projectRoot));
	if (!state) return false;
	return state.disabled || state.until > Date.now();
}
