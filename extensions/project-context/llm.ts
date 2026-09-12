import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Minimal model plumbing shared by the extension passes that ask a model for JSON.
 * Passes own their prompts, throttles and persistence; this module only talks to the model.
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

/** One-shot completion with the session's current model. Callers check auth before calling. */
export async function completeText(ctx: ExtensionContext, prompt: string, options: { maxTokens?: number } = {}): Promise<string> {
	if (!ctx.model) throw new Error("no model selected");
	const response = await ctx.modelRegistry.complete(
		ctx.model,
		{ messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
		{ maxTokens: options.maxTokens ?? 8192, cacheRetention: "none", sessionId: uuidv7() },
	);
	return extractText(response);
}
