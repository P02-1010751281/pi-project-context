import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classifyModelFailure, noteModelFailure, noteModelSuccess } from "./call-policy.ts";
import { notify } from "./project-state.ts";

/**
 * Minimal model plumbing shared by the extension passes that ask a model for JSON.
 * Passes own their prompts, throttles and persistence; this module only talks to the model.
 *
 * Failure contract: a provider failure (`stopReason` "error"/"aborted") throws instead of
 * returning empty text, so a caller that does not handle it must fail its own pass. Other stop
 * reasons ("stop", "length", "pending", "deferred", "toolUse") return whatever text arrived.
 */

function extractText(response: { content: Array<{ type: string; text?: string }> }): string {
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
function auxRouteFor(
	ctx: ExtensionContext,
	config: { provider: string; model: string },
): { model: NonNullable<ExtensionContext["model"]> | undefined; unavailable?: string } {
	const sessionModel = ctx.model && ctx.modelRegistry.hasConfiguredAuth(ctx.model) ? ctx.model : undefined;
	if (!config.provider || !config.model) return { model: sessionModel };
	const configured = ctx.modelRegistry.find(config.provider, config.model);
	if (configured && ctx.modelRegistry.hasConfiguredAuth(configured)) return { model: configured };
	return { model: sessionModel, unavailable: `${config.provider}/${config.model}` };
}

/**
 * The route an auxiliary call will use, decided without the dead-route warning: the configured
 * `provider`/`model` when it resolves and is authorized, otherwise the session model when it is.
 * A reader that only needs a model property (a status read comparing `reasoning`) must use this
 * instead of `resolveAuxModel`, whose warning a read must not send - the decision stays in one place
 * so the two readers cannot drift.
 */
export function peekAuxModel(
	ctx: ExtensionContext,
	config: { provider: string; model: string },
): NonNullable<ExtensionContext["model"]> | undefined {
	return auxRouteFor(ctx, config).model;
}

export function resolveAuxModel(
	ctx: ExtensionContext,
	config: { provider: string; model: string },
): NonNullable<ExtensionContext["model"]> | undefined {
	const { model, unavailable } = auxRouteFor(ctx, config);
	if (unavailable && !warnedRoutes.has(unavailable)) {
		warnedRoutes.add(unavailable);
		notify(
			ctx,
			`project-context: auxiliary model ${unavailable} is unavailable; ${model ? "using the session model" : "no authenticated model available"}`,
			"warning",
		);
	}
	return model;
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
	/**
	 * Tool calls the reply carried, arguments already parsed by pi-ai. Present only when at least one
	 * usable call arrived. Deliberately name-agnostic: which name a caller accepts is its own policy.
	 */
	toolCalls?: AuxToolCall[];
};

/** One tool offered to an auxiliary call; `parameters` is a plain JSON Schema object. */
export type AuxTool = {
	name: string;
	description: string;
	parameters: unknown;
	constrainedSampling?: { type: "json_schema"; strict: "prefer" | "require" } | false;
};

/** A tool call the model asked for, with its already-parsed arguments object. */
type AuxToolCall = { name: string; arguments: unknown };

/**
 * Pull the usable tool calls out of a response.
 *
 * pi-ai normalizes every provider's wire format to `type: "toolCall"` (`function_call` / `functionCall`
 * are OpenAI/Google wire names, not part of the normalized content model), so one extraction covers
 * every route. A part without a non-null object `arguments` is not a call we can use.
 */
function extractToolCalls(response: { content: Array<{ type: string }> }): AuxToolCall[] {
	const calls: AuxToolCall[] = [];
	for (const part of response.content) {
		if (part.type !== "toolCall") continue;
		const candidate = part as { name?: unknown; arguments?: unknown };
		if (typeof candidate.name !== "string" || candidate.name === "") continue;
		const args = candidate.arguments;
		if (typeof args !== "object" || args === null || Array.isArray(args)) continue;
		calls.push({ name: candidate.name, arguments: args });
	}
	return calls;
}

/**
 * A completion that produced no usable reply.
 *
 * `kind` separates "the provider failed" from "the reply never finished", both of which would fail
 * identically without `tools`; `callAux` uses that to avoid doubling the calls an outage makes.
 */
class AuxCallError extends Error {
	readonly kind: "provider" | "incomplete";

	constructor(message: string, kind: "provider" | "incomplete") {
		super(message);
		this.kind = kind;
	}
}

/**
 * One-shot completion with the resolved auxiliary model. Callers check auth before calling.
 * A provider failure (`stopReason` error/aborted) throws instead of returning empty text: an
 * empty reply must never be mistaken for "the model had nothing to say".
 */
async function completeWithMeta(
	ctx: ExtensionContext,
	prompt: string,
	options: { maxTokens?: number; model?: NonNullable<ExtensionContext["model"]>; tools?: AuxTool[] } = {},
): Promise<CompletionOutcome> {
	const model = options.model ?? ctx.model;
	if (!model) throw new Error("no model selected");
	const response = await ctx.modelRegistry.complete(
		model,
		{
			messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
			...(options.tools?.length ? { tools: options.tools as never } : {}),
		},
		{ maxTokens: options.maxTokens ?? 8192, cacheRetention: "none", sessionId: uuidv7() },
	);
	const result = response as { stopReason?: unknown; errorMessage?: unknown; usage?: { reasoning?: unknown } };
	const stopReason = typeof result.stopReason === "string" ? result.stopReason : undefined;
	const errorMessage = typeof result.errorMessage === "string" && result.errorMessage ? result.errorMessage : undefined;
	const text = extractText(response);
	const toolCalls = extractToolCalls(response);
	if (stopReason === "error" || stopReason === "aborted") {
		// The provider answered with a failure and no text; parsing that as Markdown would keep the
		// previous memory and leave only a misleading "no context" trace in errors.log.
		throw new AuxCallError(errorMessage ? `model call ${stopReason}: ${errorMessage}` : `model call ${stopReason}`, "provider");
	}
	if ((stopReason === "pending" || stopReason === "deferred" || stopReason === "toolUse") && text.trim() === "" && toolCalls.length === 0) {
		// A call that never produced a final text answer has nothing to parse: treating its empty
		// string as Markdown would silently leave the previous memory in place as "up to date". A
		// tool call is a real answer, so only a text-less reply with no usable call is an error.
		throw new AuxCallError(errorMessage ? `model call ${stopReason}: ${errorMessage}` : `model call ${stopReason} without text`, "incomplete");
	}
	const reasoning = result.usage?.reasoning;
	return {
		text,
		stopReason,
		errorMessage,
		reasoningTokens: typeof reasoning === "number" && Number.isFinite(reasoning) && reasoning > 0 ? reasoning : 0,
		...(toolCalls.length > 0 ? { toolCalls } : {}),
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

/**
 * Pick the tool call a caller asked for; the one place the "unusable call" policy lives.
 *
 * `completeWithMeta` is name-agnostic, so it hands back every call it extracted — including names
 * this caller does not accept, which is what lets it tell these two apart:
 *
 * - a call with another name **and** readable text is the fail-open text path; `undefined` sends the
 *   caller on to parse the text;
 * - a call with another name **and** no text has nothing to fall back to, so it is an error —
 *   returning `undefined` there would feed `""` to the parser and read as a silent no-op success.
 */
export function pickToolCall(toolCalls: AuxToolCall[] | undefined, name: string, text: string): unknown | undefined {
	const match = toolCalls?.find((call) => call.name === name);
	if (match) return match.arguments;
	if (toolCalls?.length && text.trim() === "") {
		const names = toolCalls.map((call) => call.name).join(", ");
		throw new Error(`model called ${names} without text; expected ${name}`);
	}
	return undefined;
}

/** Per-pass state for `callAux`. The sticky no-tools switch belongs to the pass, not the module. */
export type AuxCallState = { toolsDisabled?: boolean; toolsAttempted?: boolean };

/**
 * Whether dropping `tools` could plausibly fix this failure.
 *
 * A completion that never produced a usable reply fails the same way with or without `tools`, so
 * retrying it would only double the calls a provider outage makes — the burst `call-policy.ts`
 * exists to prevent, and its cooldown is armed from these very failures. A route that rejects the
 * `tools` parameter reports something else entirely (a 400 about the parameter, a schema error),
 * which is not one of the provider classes below.
 */
function toolsFallbackApplies(error: unknown): boolean {
	if (error instanceof AuxCallError) return false;
	const kind = classifyModelFailure(error);
	return kind !== "auth" && kind !== "quota" && kind !== "transient";
}

/**
 * One auxiliary model call, with the shared tools fallback and failure accounting.
 *
 * Both JSON-consuming passes (consolidation and autolearn) call through here, so the "a route may
 * reject the `tools` parameter" handling and the `noteModelSuccess` / `noteModelFailure` bookkeeping
 * exist once instead of once per pass.
 *
 * Fallback is unconditional beyond the one check above, one-shot and sticky: when the **first**
 * tools-carrying call of a pass throws, the route may simply not accept `tools` at all, so the call
 * is retried once without them and no later call in the pass carries them again. A failure after a
 * tools call has already succeeded is a real provider failure for that route, so it is not retried.
 *
 * `noteModelFailure` is recorded once, only after both attempts fail: one `tools` rejection must not
 * burn two of `AUTO_DISABLE_AFTER`'s slots.
 */
export async function callAux(
	ctx: ExtensionContext,
	prompt: string,
	options: {
		model?: NonNullable<ExtensionContext["model"]>;
		maxTokens?: number;
		tools?: AuxTool[];
		scope: string;
		projectRoot: string;
		state: AuxCallState;
	},
): Promise<CompletionOutcome> {
	const wantsTools = Boolean(options.tools?.length) && !options.state.toolsDisabled;
	// Only the first tools-carrying call of a pass may fall back: if the route accepted `tools` once,
	// a later failure is the provider's, not the parameter's. Marked before the call so a successful
	// tools call also counts as "this route accepts tools".
	const firstToolsCall = wantsTools && !options.state.toolsAttempted;
	if (wantsTools) options.state.toolsAttempted = true;
	let lastError: unknown;
	let withTools = wantsTools;
	for (;;) {
		try {
			const outcome = await completeWithMeta(ctx, prompt, { model: options.model, maxTokens: options.maxTokens, tools: withTools ? options.tools : undefined });
			noteModelSuccess(options.scope, options.projectRoot);
			return outcome;
		} catch (error) {
			lastError = error;
			if (!withTools) break;
			if (!firstToolsCall || !toolsFallbackApplies(error)) break;
			// The first tools call threw and the failure could be the parameter: drop `tools` for the rest
			// of the pass and retry once without them.
			withTools = false;
			options.state.toolsDisabled = true;
		}
	}
	noteModelFailure(options.scope, options.projectRoot, lastError);
	throw lastError;
}
