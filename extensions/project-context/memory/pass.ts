/**
 * The pass itself: one throttled, single-flight consolidation per project.
 */

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getConfig } from "../shared/config.ts";
import { modelBlocked, noteModelFailure, noteModelSuccess } from "../shared/call-policy.ts";
import { type CompletionOutcome, completeWithMeta, resolveAuxModel } from "../shared/llm.ts";
import { MAX_CONTEXT_CHARS, contextFile, errorText, exceedsMemoryCap, getProjectRoot, loadMemory, logError, notify, readOptional } from "../shared/project-state.ts";
import { type MemoryInput, fitMemoryInput } from "./input.ts";
import { type ConsolidatedResult, parseConsolidated } from "./parse.ts";
import { buildPrompt } from "./prompt.ts";
import { conversationText, userTurnCount } from "../shared/conversation.ts";
import { RETRY_OUTPUT_HEADROOM_TOKENS } from "../shared/output-budget.ts";
import { replyHead } from "../shared/text.ts";

/** A consolidation result plus a monotonic version so the caller writes a given pass at most once. */
export type ConsolidateOutcome = {
	result: ConsolidatedResult;
	version: number;
	/** The prompt could not carry the whole memory inside the model's output budget. */
	clipped: boolean;
};

type PassState = { session: string; turns: number; at: number };

let nextVersion = 0;

let activeConsolidation: Promise<ConsolidateOutcome | undefined> | undefined;

const throttle = new Map<string, PassState>();

const lastOutcome = new Map<string, { version: number; at: number; outcome: ConsolidateOutcome }>();

export async function consolidateProjectState(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: { force?: boolean } = {},
): Promise<ConsolidateOutcome | undefined> {
	// Claim the single-flight slot synchronously so concurrent callers join this pass.
	if (activeConsolidation) return activeConsolidation;

	activeConsolidation = (async (): Promise<ConsolidateOutcome | undefined> => {
		const force = options.force ?? false;
		const projectRoot = await getProjectRoot(pi, ctx.cwd);
		const branch = ctx.sessionManager.getBranch();
		const turns = userTurnCount(branch);
		const sessionId = ctx.sessionManager.getSessionId();
		const previous = throttle.get(projectRoot);
		// The turn counter is session-local: after a session change, count from zero again.
		// Otherwise a fresh session would need `previous session turns + consolidateTurns` before learning.
		const baseline = previous?.session === sessionId ? previous.turns : 0;
		const cached = lastOutcome.get(projectRoot);
		const config = await getConfig(projectRoot);
		const throttled = !force && (turns - baseline < config.consolidateTurns || Date.now() - (previous?.at ?? 0) < config.consolidateIntervalMs);
		if (throttled) return cached?.outcome;
		if (force && cached && Date.now() - cached.at < config.forceDedupeMs) return cached.outcome;
		// A route that just failed stays parked: retrying on every settle is what turned one provider
		// outage into a burst. Explicit commands pass `force` and are deliberately not parked.
		if (!force && modelBlocked("memory", projectRoot)) return cached?.outcome;
		const auxModel = resolveAuxModel(ctx, config);
		if (!auxModel) {
			notify(ctx, "Project state update skipped: no authenticated model available", "warning");
			return undefined;
		}

		const existing = await loadMemory(projectRoot, config.maxMemoryChars);
		if (existing.unreadable) {
			await logError(projectRoot, "memory", "MEMORY.md exists but cannot be read; continuing with an empty memory (the write path fails closed).");
		} else if (existing.damaged) {
			// Skipped journal lines are otherwise invisible: the fold silently dropped them.
			await logError(projectRoot, "memory", `memory journal has ${existing.damaged} unusable line(s); they were skipped`);
		}
		const existingContext = (await readOptional(contextFile(projectRoot))).slice(0, MAX_CONTEXT_CHARS);
		const conversation = conversationText(ctx.sessionManager.buildContextEntries());
		const fitted = fitMemoryInput(existing.text, existingContext, config.maxTokens, auxModel, config.maxOutputTokens);
		// The reply must re-emit the whole document, so it is told the real render cap. Without this the
		// model only saw a word-count hint and could satisfy it while still overflowing maxMemoryChars.
		const budget = { maxMemoryChars: config.maxMemoryChars, currentChars: existing.text.length };
		const promptFor = (input: MemoryInput): string => buildPrompt(projectRoot, input, conversation, budget);

		// Record a failed attempt so a persistent failure backs off instead of retrying on every settle.
		const call = async (input: MemoryInput, promptOverride?: string): Promise<CompletionOutcome> => {
			try {
				const completion = await completeWithMeta(ctx, promptOverride ?? promptFor(input), { model: auxModel, maxTokens: input.maxTokens });
				// The route answered: any earlier outage is over and the next failure starts a new episode.
				noteModelSuccess("memory", projectRoot);
				return completion;
			} catch (error) {
				throttle.set(projectRoot, { session: sessionId, turns, at: Date.now() });
				noteModelFailure("memory", projectRoot, error);
				throw error;
			}
		};

		let usedInput = fitted;
		let completion = await call(usedInput);
		let result = parseConsolidated(completion.text);
		if (!result) {
			// Providers occasionally return a transient fence/prose/truncated-shape response even when
			// the same request can complete on the next call. A reply cut off at the output cap is retried
			// with extra headroom: the request cap grows when the model allows it, and when the cap is
			// already binding the reserve grows instead, so less content is re-emitted; either way the
			// reminder asks the model to condense. Anything else keeps the same budget with a strict
			// reminder. A second failure still fails closed and never stores raw model output as memory.
			const truncated = completion.stopReason === "length";
			usedInput = truncated
				? fitMemoryInput(existing.text, existingContext, config.maxTokens, auxModel, config.maxOutputTokens, RETRY_OUTPUT_HEADROOM_TOKENS)
				: fitted;
			const reminder = truncated
				? "Your previous response was cut off by the output limit. Retry this same consolidation now; condense the memory and context so the complete JSON object fits in this response."
				: "Your previous response was not a usable JSON object. Retry this same consolidation now.";
			const retryPrompt = `${promptFor(usedInput)}\n\n${reminder} Return exactly one complete JSON object with string memory_markdown and object context (summary string, title string, key_points array, open_tasks array); no prose, Markdown fence, ellipsis, or unfinished value.`;
			completion = await call(usedInput, retryPrompt);
			result = parseConsolidated(completion.text);
		}
		if (!result && completion.stopReason === "length") {
			// Two attempts both hit the cap: name the real cause instead of the generic parse message.
			throttle.set(projectRoot, { session: sessionId, turns, at: Date.now() });
			const reasoningNote = completion.reasoningTokens > 0 ? `, ${completion.reasoningTokens} spent on hidden reasoning` : "";
			throw new Error(`consolidation reply was cut off by the model output limit (${usedInput.maxTokens} tokens requested${reasoningNote}); raise maxOutputTokens or trim MEMORY.md\n${replyHead(completion.text)}`);
		}
		if (!result) {
			// Back off like any other failed pass, but never store the raw JSON as memory.
			throttle.set(projectRoot, { session: sessionId, turns, at: Date.now() });
			throw new Error(`consolidation reply was not a usable JSON object\n${replyHead(completion.text)}`);
		}
		if (exceedsMemoryCap(result.memory, config.maxMemoryChars)) {
			// The reply overflows the render cap, so the write path would drop its middle on a line
			// boundary. One bounded condensation attempt turns that silent loss into a curated shrink;
			// if it fails or still overflows, keep the first result and let the cap warning speak.
			const limit = config.maxMemoryChars;
			const condensePrompt = `${promptFor(usedInput)}\n\nYour previous memory_markdown exceeded the ${limit}-character cap, so its middle would be dropped. Retry this same consolidation and rewrite memory_markdown to fit under ${limit} characters: keep every durable fact, merge duplicates, and remove the least durable entries. Return exactly one complete JSON object with string memory_markdown and object context; no prose or code fence.`;
			let condensed: ConsolidatedResult | undefined;
			try {
				condensed = parseConsolidated((await call(usedInput, condensePrompt)).text);
			} catch (error) {
				// A failed condensation must not discard the valid first result (which the cap warning still
				// reports); `call` already recorded the failure, so only leave a diagnostic here.
				await logError(projectRoot, "memory", new Error(`condensation retry failed; keeping the over-cap reply so its cap warning speaks: ${errorText(error)}`));
			}
			if (condensed && !exceedsMemoryCap(condensed.memory, limit)) {
				// Adopt only the condensed memory: a compacted retry may drop the context section, and the
				// first reply's context is real work that would otherwise be thrown away.
				result = {
					...result,
					memory: condensed.memory,
					context: condensed.context ?? result.context,
					contextUnusable: condensed.context ? condensed.contextUnusable : result.contextUnusable,
				};
			}
		}
		const version = (nextVersion += 1);
		throttle.set(projectRoot, { session: sessionId, turns, at: Date.now() });
		// `clipped` describes the prompt the writing reply actually saw: a truncated retry may have
		// sent less content than the first attempt, and the callers report that as a lossy rewrite.
		const outcome: ConsolidateOutcome = { result, version, clipped: usedInput.clipped };
		lastOutcome.set(projectRoot, { version, at: Date.now(), outcome });
		return outcome;
	})().finally(() => {
		// Failures reject; the caller logs them and reports a truthful "failed".
		activeConsolidation = undefined;
	});

	return activeConsolidation;
}
