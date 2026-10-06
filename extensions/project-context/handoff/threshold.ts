/**
 * The trigger: the conservative quality knee, the physical floor, the pricing-tier cap, and the receipt
 * that names which term bound.
 */

import { type ContextUsage, type ExtensionContext, buildContextEntries, estimateTokens, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { MAX_THRESHOLD_RATIO, MIN_DROP_TOKENS } from "../shared/config.ts";
import { fmtPct, fmtTokens } from "./format.ts";
import { config } from "./settings.ts";

/** pi's default compaction reserve; window headroom used by the threshold math. */
const WINDOW_RESERVE_TOKENS = 16_384;

/** Stay this far below a cost tier edge so streaming growth cannot cross it. */
const TIER_EDGE_MARGIN = 4_000;

/**
 * Conservative quality knee of long-context models, fitted to MRCR 8-needle data (GDM-MRCRv2 /
 * Context Arena population + vendor reports, 2026-09):
 *   knee(W) = W - (W - K) * sigmoid(ln(W / Wc) / s)
 * Observed honest windows (≤ ~400K: Codex 272K/400K, Claude 200K) keep their own boundary. The
 * transition starts at Wc = 450K because every 500K+ declaration measured so far is inflated —
 * grok-4.5/4.6 declare 500K while the family knee is ~195K, and DeepSeek-V4.1-Flash / GLM-5.3 /
 * Qwen3.8 declare 1M with measured knees of 130–170K. Beyond the transition the knee saturates at
 * K = 157K, the population median (46 models ≥ 1M: p25 127K / p50 157K / p75 190K). Deliberately
 * conservative: strong 1M models (GPT-5.6 ~250K, Gemini 3.7 ~450K, GPT-6 ≥ 512K) trigger earlier
 * than their own knee. The previous fit anchored K at 273K (GPT-5.6 / OpenAI's first tier) with
 * Wc = 650K, which let inflated declarations run 2–3× past their knee.
 */
const KNEE_ASYMPTOTE_TOKENS = 157_000;

const KNEE_TRANSITION_TOKENS = 450_000;

const KNEE_TRANSITION_STEEPNESS = 0.04;

/** Fitted knee curve: the share of the window that is still reliable. */
function kneeTokens(window: number): number {
	const z = Math.log(window / KNEE_TRANSITION_TOKENS) / KNEE_TRANSITION_STEEPNESS;
	return Math.round(window - (window - KNEE_ASYMPTOTE_TOKENS) / (1 + Math.exp(-z)));
}

/**
 * Which guardrail produced the final value: the adaptive guardrail (`adaptive` — the lower of the
 * conservative knee curve and the last usable point) or the first pricing tier (`tier`). Only
 * informative: the number is the contract, this says what to raise when it looks low.
 */
export type ThresholdBound = "adaptive" | "tier";

export interface Threshold {
	tokens: number;
	label: string;
	bound?: ThresholdBound;
	/** Projected dropped prefix after the guardrails: `tokens - baseline - keep`. The cut at handoff time can only be shorter (a single turn can hold the whole window), never longer. */
	dropTokens?: number;
	/** A manually configured `handoffBudgetSummaryTokens` the guardrail landed below, when there is one. */
	override?: ThresholdOverride;
}

/**
 * A manually-set `handoffBudgetSummaryTokens` that the guardrail overrode, and the term that bound below it.
 *
 * The trigger has two sources — what the model actually supports (the knee curve, then the usable
 * window) and what the user set by hand (`/handoff threshold 0.6`) — and the guardrail owns the trigger.
 * A manual setting it cannot honour must therefore be **named**: a user who raises the target and sees
 * nothing change has been sent to a control that does nothing.
 */
export interface ThresholdOverride {
	/** The threshold the configured target asked for: `baseline + keep + handoffBudgetSummaryTokens`. */
	asked: number;
	/** What the guardrail resolved instead. */
	tokens: number;
	/** The term that bound the trigger below `asked`. */
	by: "quality" | "window" | "tier";
}

/** Everything that is not conversation: system prompt, tool schemas, injected memory/context. */
/** The measured non-conversation baseline. Exported so tests can pin the floor boundary exactly. */
export function baselineTokens(ctx: ExtensionContext, usage: ContextUsage): number {
	const entries = buildContextEntries(ctx.sessionManager.getBranch(), ctx.sessionManager.getLeafId());
	const contextTokens = entries
		.flatMap(sessionEntryToContextMessages)
		.reduce((sum, message) => sum + estimateTokens(message), 0);
	return Math.max(0, (usage.tokens ?? contextTokens) - contextTokens);
}

/** First request-wide pricing tier edge, e.g. a long-context surcharge. Model metadata. */
function firstCostTierEdge(model: NonNullable<ExtensionContext["model"]>): number | undefined {
	const edges = (model.cost?.tiers ?? [])
		.map((tier) => tier.inputTokensAbove)
		.filter((edge): edge is number => typeof edge === "number" && edge > 0)
		.sort((a, b) => a - b);
	return edges[0];
}

/**
 * Resolve the trigger threshold from model info and measured usage:
 * - fixed: ratio * contextWindow, refused below the same physical floor the adaptive branch uses.
 * - adaptive: `min(knee(window), usable - TIER_EDGE_MARGIN)` — the quality knee and the last usable
 *   point, two terms only — lowered further by the first cost tier so no surcharge is crossed.
 *   `handoffBudgetSummaryTokens` does **not** take
 *   part: a manual preference must not lift the trigger above the honest knee, because distrusting a
 *   declared window is what the curve is for. When the guardrail lands below what the target asked
 *   for, the returned `override` says so and the status line names it.
 */
/** Exported so tests can pin the threshold math without a live session. */
export function resolveThreshold(
	ctx: ExtensionContext,
	usage: ContextUsage,
): Threshold | undefined {
	const window = usage.contextWindow;
	if (window <= 0) return undefined;
	if (!config.handoffThresholdAuto) {
		const tokens = Math.min(Math.round(config.handoffThresholdRatio * window), window - TIER_EDGE_MARGIN);
		if (tokens <= 0) return undefined;
		// The physical floor is a refusal gate in fixed mode too: below it a handoff would drop less than
		// `MIN_DROP_TOKENS`, replacing context without buying anything. It needs no model - only the measured
		// baseline and the carried-window budget - so both modes agree on what counts as worthwhile.
		if (tokens < baselineTokens(ctx, usage) + config.handoffBudgetRecentTokens + MIN_DROP_TOKENS) return undefined;
		return { tokens, label: `${fmtPct(config.handoffThresholdRatio * 100)} of window` };
	}
	const model = ctx.model;
	if (!model || usage.tokens === null) return undefined;

	const baseline = baselineTokens(ctx, usage);
	const keep = config.handoffBudgetRecentTokens;
	const floor = baseline + keep + MIN_DROP_TOKENS;
	const usable = window - WINDOW_RESERVE_TOKENS;
	if (usable <= floor) return undefined; // window too small for this configuration

	// Auto hands off at the guardrail alone: the lower of the model's conservative quality knee (honest
	// windows keep their own boundary, large ones saturate at the population-median knee) and the last
	// usable point before pi's own compaction reserve, minus the tier margin. `handoffBudgetSummaryTokens` is a
	// **manual request**, not a term on this line: a local preference must not lift the trigger above the
	// honest knee. What the request asked for is reported instead (`override`) so the status line can
	// name it. `handoffThresholdRatio` belongs to fixed mode.
	const knee = kneeTokens(window);
	const windowRoom = usable - TIER_EDGE_MARGIN;
	const qualityBinds = knee <= windowRoom;
	let tokens = qualityBinds ? knee : windowRoom;
	let bound: ThresholdBound = "adaptive";
	const asked = baseline + keep + config.handoffBudgetSummaryTokens;
	// A cap only takes over when it really is lower; recording which one decided is what lets the
	// status line explain an apparently low threshold instead of contradicting the floor.
	const cap = (value: number, name: ThresholdBound): void => {
		if (value < tokens) {
			tokens = value;
			bound = name;
		}
	};
	const tierEdge = firstCostTierEdge(model);
	if (tierEdge !== undefined) {
		// The first pricing tier is the other surcharge guard. It can only bind at or above the
		// physical floor; below that a handoff that both drops a prefix and stays in the cheap tier is
		// impossible, so fail closed instead of silently crossing the paid boundary (the old
		// `tierEdge > floor + margin` gate skipped the cap exactly in that case).
		if (tierEdge - TIER_EDGE_MARGIN < floor) return undefined;
		cap(tierEdge - TIER_EDGE_MARGIN, "tier");
	}
	// The physical floor is a **refusal gate, not a lift**. Below it a handoff would replace less than a
	// worthwhile drop, and raising the trigger to the floor is exactly the `max(boundary, targetValue)`
	// the quality layer forbids (see `resolveThreshold`'s doc block).
	if (tokens < floor) return undefined;
	// The status line reports the projected dropped prefix after caps, not the configured minimum: the
	// cut at handoff time can only be shorter (a single huge turn can hold the whole window), never
	// longer. The tier cap can leave less than `handoffBudgetSummaryTokens` droppable.
	return {
		tokens,
		label: `auto ${fmtTokens(tokens)} (${fmtPct((tokens / window) * 100)})`,
		bound,
		dropTokens: tokens - baseline - keep,
		override: asked > tokens
			? { asked, tokens, by: bound === "adaptive" ? (qualityBinds ? "quality" : "window") : bound }
			: undefined,
	};
}

/**
 * Why {@link resolveThreshold} returned `undefined`, named as the term that actually decided.
 *
 * The receipt used to render every refusal as "auto (no room at this window)" — an assertion about
 * the window. Only one of these causes is about the window; the others are an unknown window/unknown
 * model or usage, a fixed ratio that rounds to zero or lands below the physical floor, a **pricing tier**
 * that would be crossed, and the adaptive guardrail itself sitting below the floor a worthwhile drop needs
 * (the knee, or the window's last tier margin). Sending a user to change the model or the target when the cause is
 * billing (or when nothing is known yet) is the misattribution this names away.
 */
export type ThresholdRefusal =
	| "no-window"
	| "fixed-ratio-rounds-to-zero"
	| "no-model-or-usage"
	| "window-too-small"
	| "below-first-tier"
	| "below-quality-knee"
	| "below-usable-window"
	| "fixed-below-floor";

/**
 * The refusal cause behind `resolveThreshold(...) === undefined`, or `undefined` when it resolves.
 * Read-only companion: it replays the same terms in the same order and only reports a cause once the
 * real function has refused, so the diagnosis cannot drift from the formula it mirrors.
 */
export function thresholdRefusal(
	ctx: ExtensionContext,
	usage: ContextUsage,
): ThresholdRefusal | undefined {
	if (resolveThreshold(ctx, usage) !== undefined) return undefined;
	const window = usage.contextWindow;
	if (window <= 0) return "no-window";
	if (!config.handoffThresholdAuto) {
		const tokens = Math.min(Math.round(config.handoffThresholdRatio * window), window - TIER_EDGE_MARGIN);
		return tokens <= 0 ? "fixed-ratio-rounds-to-zero" : "fixed-below-floor";
	}
	const model = ctx.model;
	if (!model || usage.tokens === null) return "no-model-or-usage";
	const floor = baselineTokens(ctx, usage) + config.handoffBudgetRecentTokens + MIN_DROP_TOKENS;
	const usable = window - WINDOW_RESERVE_TOKENS;
	if (usable <= floor) return "window-too-small";
	const tierEdge = firstCostTierEdge(model);
	if (tierEdge !== undefined && tierEdge - TIER_EDGE_MARGIN < floor) return "below-first-tier";
	// The adaptive guardrail itself sits below the floor: either the model's knee says the window is not
	// reliable that far, or the window's last tier margin leaves too little. Name which, composing the
	// two terms exactly as `resolveThreshold` does. No cap can cause this: the only cap left is the tier
	// edge, which is gated above the floor.
	return kneeTokens(window) <= usable - TIER_EDGE_MARGIN ? "below-quality-knee" : "below-usable-window";
}

/**
 * The refusal sentence for the status line. Each cause names the comparison that failed, so the
 * receipt cannot attribute one refusal to another.
 */
export function thresholdRefusalText(reason: ThresholdRefusal, ctx: ExtensionContext, usage: ContextUsage): string {
	const window = usage.contextWindow;
	const floor = baselineTokens(ctx, usage) + config.handoffBudgetRecentTokens + MIN_DROP_TOKENS;
	const usable = window - WINDOW_RESERVE_TOKENS;
	switch (reason) {
		case "no-window":
			return config.handoffThresholdAuto
				? "auto (the context window is not known yet)"
				: `fixed ${fmtPct(config.handoffThresholdRatio * 100)} (the context window is not known yet)`;
		case "fixed-ratio-rounds-to-zero":
			return `fixed ${fmtPct(config.handoffThresholdRatio * 100)} (this ratio resolves to no positive threshold at a ${fmtTokens(window)}-token window)`;
		case "fixed-below-floor":
			// Name a lever that actually works with these numbers: when even the largest legal ratio cannot
			// clear the floor, raising it is not a lever and only the carried-window budget is.
			const largestRatio = Math.min(Math.round(MAX_THRESHOLD_RATIO * window), window - TIER_EDGE_MARGIN);
			const lever = largestRatio >= floor
				? "raise /handoff threshold or lower /handoff budget recent"
				: "lower /handoff budget recent (no ratio fits this window at this baseline)";
			return `fixed ${fmtPct(config.handoffThresholdRatio * 100)} (the ${fmtTokens(Math.min(Math.round(config.handoffThresholdRatio * window), window - TIER_EDGE_MARGIN))}-token threshold is below the ${fmtTokens(floor)}-token floor a worthwhile handoff needs at this baseline; ${lever})`;
		case "no-model-or-usage":
			return "auto (the session model or its token usage is not known yet)";
		case "window-too-small":
			return `auto (window too small: ${usable} usable tokens after the ${WINDOW_RESERVE_TOKENS} reserve, below the ${floor} floor)`;
		case "below-first-tier":
			return "auto (crossing the first pricing tier would not leave room for a worthwhile handoff, so the handoff is skipped rather than billed)";
		case "below-quality-knee":
			return `auto (the model's quality knee of ${fmtTokens(kneeTokens(window))} is below the ${fmtTokens(floor)} floor a worthwhile handoff needs at this window, so the handoff is skipped rather than run past the knee; a smaller baseline or keep is the lever)`;
		case "below-usable-window":
		default:
			return `auto (the last ${TIER_EDGE_MARGIN} tokens of the ${usable}-token usable window leave ${fmtTokens(usable - TIER_EDGE_MARGIN)}, below the ${fmtTokens(floor)} floor a worthwhile handoff needs; a larger window is the lever, not a larger target)`;
	}
}

/** Status suffix for a threshold that a cap decided, so a low value never looks unexplained. */
export function capSuffix(bound: Threshold["bound"]): string {
	if (bound === "tier") return " · capped by the first pricing tier";
	return "";
}

/**
 * The status-line warning for a manual target the guardrail overrode. Both numbers and the lever are
 * named, so the receipt cannot send the user back to the same ineffective control.
 */
export function thresholdOverrideText(override: ThresholdOverride, window: number): string {
	const guardrail = override.by === "quality"
		? `the model's quality knee allows ${fmtTokens(override.tokens)} at this window`
		: override.by === "window"
			? `only ${fmtTokens(override.tokens)} tokens fit this ${fmtTokens(window)}-token window after the ${WINDOW_RESERVE_TOKENS}-token request reserve and the ${TIER_EDGE_MARGIN}-token tier margin`
			: `the first pricing tier leaves ${fmtTokens(override.tokens)}`;
	return `handoff budget summary ${fmtTokens(config.handoffBudgetSummaryTokens)} is not applied in full: it needs a ${fmtTokens(override.asked)}-token threshold and ${guardrail}, so the auto guardrail decides — lower /handoff budget summary`;
}
