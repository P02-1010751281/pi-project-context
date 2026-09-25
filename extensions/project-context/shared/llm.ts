import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notify } from "./project-state.ts";

/**
 * Minimal model plumbing shared by the extension passes that ask a model for JSON.
 * Passes own their prompts, throttles and persistence; this module only talks to the model.
 *
 * Failure contract: a provider failure (`stopReason` "error"/"aborted") throws instead of
 * returning empty text, so a caller that does not handle it must fail its own pass. Other stop
 * reasons ("stop", "length", "pending", "deferred", "toolUse") return whatever text arrived.
 */

export function extractText(response: { content: Array<{ type: string; text?: string }> }): string {
	return response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

export function parseJsonObject(text: string): Record<string, unknown> | undefined {
	const candidate = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
	try {
		return JSON.parse(candidate) as Record<string, unknown>;
	} catch {
		// Fall through to a braced-object scan for models that add prose around the JSON.
	}
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start === -1 || end <= start) return undefined;
	try {
		return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/** Configured routes that did not resolve; warn once per process instead of on every pass. */
const warnedRoutes = new Set<string>();

/**
 * The model for an auxiliary call: the configured `provider`/`model` route when it resolves
 * and is authorized, otherwise the session model when it is. Undefined when neither works.
 */
export function resolveAuxModel(
	ctx: ExtensionContext,
	config: { provider: string; model: string },
): NonNullable<ExtensionContext["model"]> | undefined {
	const sessionModel = ctx.model && ctx.modelRegistry.hasConfiguredAuth(ctx.model) ? ctx.model : undefined;
	if (!config.provider || !config.model) return sessionModel;
	const configured = ctx.modelRegistry.find(config.provider, config.model);
	if (configured && ctx.modelRegistry.hasConfiguredAuth(configured)) return configured;
	const key = `${config.provider}/${config.model}`;
	if (!warnedRoutes.has(key)) {
		warnedRoutes.add(key);
		notify(
			ctx,
			`project-context: auxiliary model ${key} is unavailable; ${sessionModel ? "using the session model" : "no authenticated model available"}`,
			"warning",
		);
	}
	return sessionModel;
}

/** What a completion returned beyond its text: how it ended and what it spent. */
export type CompletionOutcome = {
	/** Visible reply text; hidden reasoning is not included. */
	text: string;
	/** Provider stop reason; "length" means the reply was cut off by the output cap. */
	stopReason?: string;
	errorMessage?: string;
	/** Reasoning tokens the provider reported; they are a subset of the output cap. */
	reasoningTokens: number;
};

/**
 * One-shot completion with the resolved auxiliary model. Callers check auth before calling.
 * A provider failure (`stopReason` error/aborted) throws instead of returning empty text: an
 * empty reply must never be mistaken for "the model had nothing to say".
 */
export async function completeWithMeta(
	ctx: ExtensionContext,
	prompt: string,
	options: { maxTokens?: number; model?: NonNullable<ExtensionContext["model"]> } = {},
): Promise<CompletionOutcome> {
	const model = options.model ?? ctx.model;
	if (!model) throw new Error("no model selected");
	const response = await ctx.modelRegistry.complete(
		model,
		{ messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
		{ maxTokens: options.maxTokens ?? 8192, cacheRetention: "none", sessionId: uuidv7() },
	);
	const result = response as { stopReason?: unknown; errorMessage?: unknown; usage?: { reasoning?: unknown } };
	const stopReason = typeof result.stopReason === "string" ? result.stopReason : undefined;
	const errorMessage = typeof result.errorMessage === "string" && result.errorMessage ? result.errorMessage : undefined;
	const text = extractText(response);
	if (stopReason === "error" || stopReason === "aborted") {
		// The provider answered with a failure and no text; parsing that as Markdown would keep the
		// previous memory and leave only a misleading "no context" trace in errors.log.
		throw new Error(errorMessage ? `model call ${stopReason}: ${errorMessage}` : `model call ${stopReason}`);
	}
	if ((stopReason === "pending" || stopReason === "deferred" || stopReason === "toolUse") && text.trim() === "") {
		// A call that never produced a final text answer has nothing to parse: treating its empty
		// string as Markdown would silently leave the previous memory in place as "up to date".
		throw new Error(errorMessage ? `model call ${stopReason}: ${errorMessage}` : `model call ${stopReason} without text`);
	}
	const reasoning = result.usage?.reasoning;
	return {
		text,
		stopReason,
		errorMessage,
		reasoningTokens: typeof reasoning === "number" && Number.isFinite(reasoning) && reasoning > 0 ? reasoning : 0,
	};
}

/** The visible text of one model call; see completeWithMeta for the failure semantics. */
export async function completeText(
	ctx: ExtensionContext,
	prompt: string,
	options: { maxTokens?: number; model?: NonNullable<ExtensionContext["model"]> } = {},
): Promise<string> {
	return (await completeWithMeta(ctx, prompt, options)).text;
}
