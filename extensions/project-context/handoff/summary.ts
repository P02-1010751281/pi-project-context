/**
 * One summary call: the deadline, the auth route it needs, and the truncation retry.
 */

import { type AgentMessage } from "@earendil-works/pi-agent-core";
import { type ExtensionContext, generateSummaryWithUsage } from "@earendil-works/pi-coding-agent";
import { errorText, notify } from "../shared/project-state.ts";
import { cleanHeaders } from "./format.ts";
import { type HandoffLanguage, summaryFocus } from "./language.ts";
import { localizeSummaryHeadings } from "./prompt.ts";
import { config } from "./settings.ts";
import { SUMMARY_OUTPUT_RESERVE_TOKENS } from "./threshold.ts";

const SUMMARY_TIMEOUT_MS = 180_000;

interface SummaryAuth {
	apiKey?: string;
	headers?: Record<string, string | null>;
	env?: Record<string, string>;
}

/**
 * Generate the handoff summary with a token-cap fallback.
 * On reasoning models thinking and the answer share the response cap (deepseek sends
 * thinking:{type:enabled} with no separate budget), so a high thinking level over a
 * large context can truncate the summary. Summaries default to thinking off; if the
 * answer still hits the cap, retry with more output room.
 */
export async function generateHandoffSummary(
	ctx: ExtensionContext,
	model: NonNullable<ExtensionContext["model"]>,
	auth: SummaryAuth,
	messages: AgentMessage[],
	previousSummary: string | undefined,
	language: HandoffLanguage,
): Promise<string> {
	const primary: NonNullable<ExtensionContext["thinkingLevel"]> = config.handoffSummaryThinking === "session"
		? (ctx.thinkingLevel ?? "off")
		: "off";
	const attempts: Array<{ thinking: NonNullable<ExtensionContext["thinkingLevel"]>; reserveTokens: number }> = [
		{ thinking: primary, reserveTokens: SUMMARY_OUTPUT_RESERVE_TOKENS },
		{ thinking: primary, reserveTokens: SUMMARY_OUTPUT_RESERVE_TOKENS * 2 },
	];
	if (primary !== "off") attempts.push({ thinking: "off", reserveTokens: SUMMARY_OUTPUT_RESERVE_TOKENS });
	let lastError: unknown;
	for (const [index, attempt] of attempts.entries()) {
		try {
			const { text } = await generateSummaryWithUsage(
				messages,
				model,
				attempt.reserveTokens,
				auth.apiKey,
				cleanHeaders(auth.headers),
				AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
				summaryFocus(language),
				previousSummary,
				attempt.thinking,
				undefined,
				auth.env,
			);
			return localizeSummaryHeadings(text, language);
		} catch (error) {
			lastError = error;
			// Retry only token-cap truncations; aborts/provider errors should surface as-is.
			if (!/token cap|incomplete/i.test(errorText(error))) throw error;
			if (index < attempts.length - 1) {
				notify(ctx, `Auto handoff: summary hit the token cap (thinking=${attempt.thinking}), retrying with more room...`, "warning");
			}
		}
	}
	throw lastError;
}
