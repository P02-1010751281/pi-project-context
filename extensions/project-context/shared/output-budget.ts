/**
 * How many tokens one auxiliary model call may spend: the reasoning reserve for the hidden
 * thinking that shares the output cap, the adaptive growth boundary, and the retry headroom.
 */

/** Output room reserved for the JSON scaffolding and the rewritten context. */
export const REPLY_OUTPUT_MARGIN_TOKENS = 1024;

/** Share of the content tokens a reasoning model may spend on hidden thinking before its JSON. */
const REASONING_RESERVE_RATIO = 0.35;

/** Floor for the reasoning reserve, so even a small memory gets thinking room. */
const MIN_REASONING_RESERVE_TOKENS = 1024;

/** Ceiling for the reasoning reserve: above this, condensing the memory is the better trade. */
const MAX_REASONING_RESERVE_TOKENS = 8192;

/** Extra output room one truncated retry may ask for on top of the fitted budget. */
export const RETRY_OUTPUT_HEADROOM_TOKENS = 4096;

/** Chars kept per artifact when the budget allows; the split also reserves it as a token floor. */
export const MIN_CLIP_CHARS = 400;

/** Hard ceiling for an adaptive output cap when the model reports no limit of its own. */
export const MAX_ADAPTIVE_OUTPUT_TOKENS = 32_768;

/**
 * Extra output tokens a reasoning model needs beyond the text it must re-emit. Providers report
 * those thinking tokens as a subset of the output, so a budget that only pays for the visible
 * memory and context gets its JSON cut off mid-string (`stopReason: "length"`).
 */
export function reasoningReserveTokens(contentTokens: number, model: { reasoning?: boolean }): number {
	if (model.reasoning !== true || contentTokens <= 0) return 0;
	return Math.min(MAX_REASONING_RESERVE_TOKENS, Math.max(MIN_REASONING_RESERVE_TOKENS, Math.round(contentTokens * REASONING_RESERVE_RATIO)));
}

/** Split a token budget between two artifacts: each keeps a floor, the rest follows the need. */
export function allocateTokens(budget: number, memoryTokens: number, contextTokens: number): { memory: number; context: number } {
	if (memoryTokens + contextTokens <= budget) return { memory: memoryTokens, context: contextTokens };
	const active = (memoryTokens > 0 ? 1 : 0) + (contextTokens > 0 ? 1 : 0);
	if (active === 0) return { memory: 0, context: 0 };
	if (memoryTokens === 0) return { memory: 0, context: budget };
	if (contextTokens === 0) return { memory: budget, context: 0 };
	const floor = Math.min(MIN_CLIP_CHARS, Math.floor(budget / 2));
	let memory = Math.min(memoryTokens, floor);
	let context = Math.min(contextTokens, floor);
	let rest = Math.max(0, budget - memory - context);
	// Whatever a floored artifact does not need flows to the other one, by remaining need.
	const needMemory = memoryTokens - memory;
	const needContext = contextTokens - context;
	if (rest > 0 && needMemory + needContext > 0) {
		const giveMemory = Math.min(needMemory, rest * (needMemory / (needMemory + needContext)));
		const giveContext = Math.min(needContext, rest - giveMemory);
		memory += giveMemory;
		context += giveContext;
	}
	return { memory, context };
}

/**
 * Raise the configured output cap to what the pass needs, bounded by the model's own limit and the
 * configured ceiling. Without model metadata an adaptive cap could exceed what the provider
 * accepts, so the pass never asks for more than the ceiling; an over-long input is then clipped.
 */
export function adaptiveOutputTokens(configured: number, needed: number, model: { maxTokens?: number }, ceiling: number): number {
	const cap = typeof model.maxTokens === "number" && model.maxTokens > 0 ? model.maxTokens : undefined;
	const grown = Math.max(configured, needed);
	return Math.min(cap ? Math.min(grown, cap) : grown, Math.max(configured, ceiling));
}
