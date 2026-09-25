/**
 * Fitting the memory + context documents into the consolidation request's input budget.
 */

import { MAX_ADAPTIVE_OUTPUT_TOKENS, MIN_CLIP_CHARS, REPLY_OUTPUT_MARGIN_TOKENS, adaptiveOutputTokens, allocateTokens, reasoningReserveTokens } from "../shared/output-budget.ts";
import { clipTo, replyTokenRate } from "../shared/text.ts";

/** What the pass sends instead of the stored artifacts, plus the budget it asks for. */
export type MemoryInput = { text: string; contextText: string; maxTokens: number; clipped: boolean };

/**
 * Match the output budget to everything the reply must re-emit. A large memory is what truncated
 * replies (and the poisoned files they used to leave) came from: the cap is raised up to the
 * model's own limit, and when even that cannot hold memory plus context, both are shortened
 * head-and-tail so the reply can still come back complete and parseable. Each artifact is budgeted
 * by its own token rate: a large cheap context must not let a small dense memory pass the cap.
 */
export function fitMemoryInput(
	memory: string,
	context: string,
	configuredMaxTokens: number,
	model: { maxTokens?: number; reasoning?: boolean },
	ceilingTokens: number = MAX_ADAPTIVE_OUTPUT_TOKENS,
	extraHeadroomTokens = 0,
): MemoryInput {
	const memoryRate = replyTokenRate(memory);
	const contextRate = replyTokenRate(context);
	const contentTokens = memory.length * memoryRate + context.length * contextRate;
	// A reasoning model emits hidden thinking before its JSON, and those tokens count against the
	// same output cap: without room for them the reply is cut mid-string even though the content
	// itself would fit. A retry after a truncation may ask for extra headroom on top.
	const reasoningReserve = reasoningReserveTokens(contentTokens, model);
	const needed = Math.ceil(contentTokens) + REPLY_OUTPUT_MARGIN_TOKENS + reasoningReserve + extraHeadroomTokens;
	const maxTokens = adaptiveOutputTokens(configuredMaxTokens, needed, model, ceilingTokens);
	// What the visible content must not spend: the JSON-scaffolding margin, the reasoning room and
	// any retry headroom. The reserve never eats the clip floor, and a capped model keeps at least
	// half its cap for content so a clipped rewrite can still say something.
	const desiredReserve = REPLY_OUTPUT_MARGIN_TOKENS + reasoningReserve + extraHeadroomTokens;
	const reserved = Math.min(desiredReserve, Math.max(0, maxTokens - MIN_CLIP_CHARS), Math.max(REPLY_OUTPUT_MARGIN_TOKENS, Math.round(maxTokens * 0.5)));
	const budget = Math.max(0, maxTokens - reserved);
	if (contentTokens <= budget) {
		return { text: memory, contextText: context, maxTokens, clipped: false };
	}
	// Over budget: each artifact keeps a floor in tokens and the rest follows its measured need, so
	// a big cheap artifact cannot crowd out a small dense one. Repeat with the clipped texts' own
	// rates: clipping can change the density, and the reallocation only shrinks what is over.
	const initial = allocateTokens(budget, memory.length * memoryRate, context.length * contextRate);
	let text = clipTo(memory, Math.floor(initial.memory / Math.max(memoryRate, 0.001)));
	let contextText = clipTo(context, Math.floor(initial.context / Math.max(contextRate, 0.001)));
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const textTokens = text.length * replyTokenRate(text);
		const contextTokens = contextText.length * replyTokenRate(contextText);
		if (textTokens + contextTokens <= budget + 0.5) break;
		const next = allocateTokens(budget, textTokens, contextTokens);
		const stepText = clipTo(memory, Math.floor(next.memory / Math.max(replyTokenRate(text), 0.001)));
		const stepContext = clipTo(context, Math.floor(next.context / Math.max(replyTokenRate(contextText), 0.001)));
		if (stepText.length === text.length && stepContext.length === contextText.length) break;
		text = stepText;
		contextText = stepContext;
	}
	// Clipping can also come out lighter than the original text, leaving budget unused. Fill it
	// by growing both artifacts toward their full length; a step that overshoots is retried
	// smaller, and the last fitting result is kept.
	let step = 1;
	for (let attempt = 0; attempt < 12 && step > 0.002; attempt += 1) {
		const textTokens = text.length * replyTokenRate(text);
		const contextTokens = contextText.length * replyTokenRate(contextText);
		const spare = budget - (textTokens + contextTokens);
		if (spare <= Math.max(0.5, budget * 0.005)) break;
		const rateText = Math.max(replyTokenRate(text), 0.001);
		const rateContext = Math.max(replyTokenRate(contextText), 0.001);
		const needText = Math.max(0, memory.length - text.length) * rateText;
		const needContext = Math.max(0, context.length - contextText.length) * rateContext;
		if (needText + needContext <= 0) break;
		const growText = (spare * step * needText) / (needText + needContext) / rateText;
		const growContext = (spare * step * needContext) / (needText + needContext) / rateContext;
		const grownText = clipTo(memory, Math.min(memory.length, text.length + Math.ceil(growText)));
		const grownContext = clipTo(context, Math.min(context.length, contextText.length + Math.ceil(growContext)));
		const grownTokens = grownText.length * replyTokenRate(grownText) + grownContext.length * replyTokenRate(grownContext);
		if (grownTokens > budget + 0.5) {
			step /= 2;
			continue;
		}
		text = grownText;
		contextText = grownContext;
		step = 1;
	}
	// Absolute safety: the char count of a clip cannot exceed its token count (rate ≤ 1.0).
	if (text.length * replyTokenRate(text) + contextText.length * replyTokenRate(contextText) > budget + 0.5) {
		const safe = allocateTokens(budget, text.length * replyTokenRate(text), contextText.length * replyTokenRate(contextText));
		text = clipTo(text, Math.floor(safe.memory));
		contextText = clipTo(contextText, Math.floor(safe.context));
	}
	// Exact trim: char rounding in the limits can leave a fraction of a token over budget.
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const textTokens = text.length * replyTokenRate(text);
		const contextTokens = contextText.length * replyTokenRate(contextText);
		const over = textTokens + contextTokens - budget;
		if (over <= 0.0001) break;
		if (textTokens >= contextTokens && text.length > 0) {
			text = clipTo(text, text.length - Math.max(1, Math.ceil(over / Math.max(replyTokenRate(text), 0.001))));
		} else if (contextText.length > 0) {
			contextText = clipTo(contextText, contextText.length - Math.max(1, Math.ceil(over / Math.max(replyTokenRate(contextText), 0.001))));
		} else break;
	}
	return { text, contextText, maxTokens, clipped: text.length < memory.length || contextText.length < context.length };
}
