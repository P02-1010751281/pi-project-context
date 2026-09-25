/**
 * Reading the consolidation reply: the parsed shapes, the tolerant JSON scan, and the per-field
 * verdicts the caller reports.
 */

import { parseJsonObject } from "../shared/llm.ts";
import { readJsonStringField } from "../shared/project-state.ts";

export type ContextUpdate = {
	title: string;
	summary: string;
	key_points: string[];
	open_tasks: string[];
};

export type ConsolidatedResult = {
	memory: string;
	context?: ContextUpdate;
	/** The reply carried a `context` member that could not be used (wrong shape), rather than none. */
	contextUnusable?: boolean;
	/** The reply carried no usable context (its object never closed), so only the memory field was recovered. */
	recovered?: boolean;
};

function parseContext(value: unknown): ContextUpdate | undefined {
	if (!value || typeof value !== "object") return undefined;
	const context = value as Partial<ContextUpdate>;
	if (typeof context.summary !== "string") return undefined;
	// The prompt names these keys and their types, so a present-but-wrong-typed list means the reply
	// drifted (e.g. `keyPoints`, or a single string): drop the whole context instead of quietly
	// emptying the field, which is how the previous CONTEXT.md went stale unnoticed.
	const wrongType = (items: unknown): boolean => items !== undefined && items !== null && !Array.isArray(items);
	if (wrongType(context.key_points) || wrongType(context.open_tasks)) return undefined;
	const strings = (items: unknown): string[] =>
		Array.isArray(items) ? items.filter((item): item is string => typeof item === "string") : [];
	return {
		title: typeof context.title === "string" ? context.title : "Untitled session",
		summary: context.summary,
		key_points: strings(context.key_points),
		open_tasks: strings(context.open_tasks),
	};
}

/**
 * Read `memory_markdown` out of a reply whose object does not parse. A model may close the string
 * early, add a stray member, or be cut off mid-object, and the field is usually complete even
 * then; an unterminated value is rejected here (stored files are handled by the read-side heal).
 */
function jsonStringField(text: string): string | undefined {
	const field = readJsonStringField(text, "memory_markdown");
	return field?.complete ? field.value.trim() : undefined;
}

/** A reply that meant to be the requested JSON object; it must never be stored as memory. */
function looksLikeJsonReply(text: string): boolean {
	const candidate = text.replace(/^```(?:json)?\s*/i, "").trim();
	return candidate.startsWith("{") || /"memory_markdown"\s*:/.test(candidate);
}

/** Undefined means the pass must fail without touching MEMORY.md. */
export function parseConsolidated(text: string): ConsolidatedResult | undefined {
	const parsed = parseJsonObject(text);
	if (parsed && typeof parsed.memory_markdown === "string") {
		const context = parseContext(parsed.context);
		// Absent and explicitly null both mean "nothing to say"; a present but unusable member means
		// the model answered in another shape, which the caller reports once instead of silently
		// leaving CONTEXT.md stale.
		const contextUnusable = context === undefined && parsed.context !== undefined && parsed.context !== null;
		return { memory: parsed.memory_markdown, context, ...(contextUnusable ? { contextUnusable: true } : {}) };
	}
	// A reply that failed to parse can still carry the memory field intact.
	const recovered = jsonStringField(text);
	// The object never closed: everything after the memory field — the context among it — was never
	// emitted (or the reply is malformed). Either way CONTEXT.md would age silently without a trace.
	if (recovered) return { memory: recovered, recovered: true };
	// Older or less capable models may still return Markdown directly.
	if (!looksLikeJsonReply(text)) return { memory: text };
	return undefined;
}
