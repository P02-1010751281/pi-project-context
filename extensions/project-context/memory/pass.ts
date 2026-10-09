/**
 * The pass itself: one throttled, single-flight consolidation per project.
 */

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getConfig } from "../shared/config.ts";
import { modelBlocked } from "../shared/call-policy.ts";
import { type AuxCallState, type CompletionOutcome, callAux, pickToolCall, resolveAuxModel } from "../shared/llm.ts";
import { MAX_CONTEXT_CHARS, contextFile, errorText, exceedsMemoryCap, getProjectRoot, loadMemory, logError, notify, readOptional } from "../shared/project-state.ts";
import { type MemoryInput, fitMemoryInput } from "./input.ts";
import { type ConsolidatedResult, parseConsolidated, parseContext } from "./parse.ts";
import { buildPrompt } from "./prompt.ts";
import { conversationText, userTurnCount } from "../shared/conversation.ts";
import { RETRY_OUTPUT_HEADROOM_TOKENS } from "../shared/output-budget.ts";
import { replyHead } from "../shared/text.ts";
import {
	type MemoryRender,
	type MemorySections,
	RECORD_MEMORY_TOOL,
	normalizeMemoryEntry,
	renderMemoryDocument,
	hasMemoryDocumentShape,
	sectionsFromMarkdown,
	sectionsFromToolCall,
	sectionsSemanticallyEmpty,
	isHeadingOnlyDocument,
} from "./sections.ts";

/** Which entry produced the memory this pass would write; the report words its notices per entry. */
type ConsolidateKind = "structured" | "fallback-sections" | "fallback-opaque";

/** Entries the new memory no longer carries, for the regression guard's report. */
export type RemovedEntries = { count: number; samples: string[] };

/**
 * The length from which an opaque reply is treated as a document candidate at all: below it the reply is
 * normally the memory re-emitted in a handful of words, and report.ts names "too short to be a change"
 * rather than emptiness. Both sides read this one number.
 */
export const OPAQUE_DOCUMENT_MIN_CHARS = 40;


/** A consolidation result plus a monotonic version so the caller writes a given pass at most once. */
export type ConsolidateOutcome = {
	result: ConsolidatedResult;
	version: number;
	/** The prompt could not carry the whole memory inside the model's output budget. */
	clipped: boolean;
	/** Which entry the memory came from. */
	kind: ConsolidateKind;
	/** No section held an entry worth storing, so the memory must not be written at all. */
	semanticEmpty: boolean;
	/** Sections that lost at least one entry because the document was at its cap. */
	sectionDropped: number;
	/** Entries dropped because the document was at its cap, not because their section was over its share. */
	droppedItems: number;
	/** Samples of those dropped entries, so the log can name what went instead of only counting it. */
	droppedSamples: string[];
	/** Entries clipped to their section's per-item cap. */
	itemTruncated: number;
	/** Invariants/Pitfalls entries the previous memory had and this one does not. */
	removed?: RemovedEntries;
	/** The memory this pass's prompt was built from, byte for byte. The write path refuses a reply
	 * whose baseline no longer matches what is stored: publishing it would overwrite a newer edit. */
	basisKey: string;
};

type PassState = { session: string; turns: number; at: number };

/** A reply read into the shape this pass writes: the sections when it had them, plus the context. */
type ResolvedReply = { kind: ConsolidateKind; sections?: MemorySections; result: ConsolidatedResult };

let nextVersion = 0;

let activeConsolidation: Promise<ConsolidateOutcome | undefined> | undefined;

const throttle = new Map<string, PassState>();

const lastOutcome = new Map<string, { version: number; at: number; outcome: ConsolidateOutcome }>();

/**
 * Read one reply.
 *
 * The tool call is the preferred entry. When the model answers with text instead — because it chose
 * not to call the tool, or because the route dropped `tools` — the same sections are recovered from
 * the Markdown, so both entries render through one renderer and one set of budgets.
 *
 * `allowTools` is false for the retry and condensation prompts, which deliberately carry no tool.
 */
function resolveReply(completion: CompletionOutcome, allowTools: boolean): ResolvedReply | undefined {
	if (allowTools) {
		// Throws when the reply called some other tool and carried no text: there is nothing to fall
		// back to, and returning undefined would feed "" to the parser and read as a silent success.
		const args = pickToolCall(completion.toolCalls, RECORD_MEMORY_TOOL.name, completion.text);
		if (args !== undefined) {
			const sections = sectionsFromToolCall(args);
			if (sections) {
				const record = args as Record<string, unknown>;
				// memory and context are validated apart: a broken context must not cost a good memory.
				const context = parseContext(record.context);
				const contextUnusable = context === undefined && record.context !== undefined && record.context !== null;
				return {
					kind: "structured",
					sections,
					result: { memory: "", context, ...(contextUnusable ? { contextUnusable: true } : {}) },
				};
			}
			// The expected tool was called with arguments this pass cannot read. With text to fall back to
			// the text path still applies; with nothing to parse it is an error, not an empty memory.
			if (completion.text.trim() === "") {
				throw new Error(`the ${RECORD_MEMORY_TOOL.name} call carried unusable arguments and no text`);
			}
		}
	}
	const parsed = parseConsolidated(completion.text);
	if (!parsed) return undefined;
	const sections = sectionsFromMarkdown(parsed.memory);
	if (sections) return { kind: "fallback-sections", sections, result: parsed };
	return { kind: "fallback-opaque", result: parsed };
}

/** The final memory text for a resolved reply: the renderer's output when there are sections. */
function memoryTextFor(resolved: ResolvedReply, render: MemoryRender | undefined): string {
	return render ? render.text : resolved.result.memory;
}

/**
 * What the new memory no longer says, per durable section.
 *
 * `Project` and `Index` are deliberately excluded: they are meant to be rewritten every pass, and
 * reporting them would bury the signal. This cannot judge whether a removal was *right* — only that
 * it happened — so it reports and never blocks.
 */
function removedSectionEntries(before: MemorySections, after: MemorySections): RemovedEntries {
	const gone = (key: "invariants" | "pitfalls"): string[] => {
		const kept = new Set(after[key].map((entry) => normalizeMemoryEntry(entry)));
		return before[key].map((entry) => normalizeMemoryEntry(entry)).filter((entry) => entry !== "" && !kept.has(entry));
	};
	const removed = [...gone("invariants"), ...gone("pitfalls")];
	return { count: removed.length, samples: removed.slice(0, 3) };
}

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
			notify(ctx, "Memory: skipped — no authenticated model available", "warning");
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

		// The pass-scoped sticky no-tools switch lives here; `callAux` owns the fallback itself and
		// records success/failure, so a `tools` rejection burns one failure slot, not two.
		const auxState: AuxCallState = {};
		const call = async (prompt: string, input: MemoryInput, withTools: boolean): Promise<CompletionOutcome> => {
			try {
				return await callAux(ctx, prompt, {
					model: auxModel,
					maxTokens: input.maxTokens,
					tools: withTools ? [RECORD_MEMORY_TOOL] : undefined,
					scope: "memory",
					projectRoot,
					state: auxState,
				});
			} catch (error) {
				// Record the failed attempt so a persistent failure backs off instead of retrying every settle.
				throttle.set(projectRoot, { session: sessionId, turns, at: Date.now() });
				throw error;
			}
		};

		let usedInput = fitted;
		let completion = await call(promptFor(usedInput), usedInput, true);
		// A truncated tool call is never accepted: pi-ai repairs a truncated arguments string into a
		// shape-valid object, so "there is a tool call" is not evidence that its contents arrived. A
		// *text* reply that stopped at the cap is a different case and keeps the old behaviour below —
		// the JSON parsed to the end, so nothing was lost.
		const truncatedToolCall = completion.stopReason === "length" && (completion.toolCalls?.length ?? 0) > 0;
		let resolved = truncatedToolCall ? undefined : resolveReply(completion, true);
		if (!resolved) {
			// Providers occasionally return a transient fence/prose/truncated-shape response even when
			// the same request can complete on the next call. A reply cut off at the output cap is retried
			// with extra headroom: the request cap grows when the model allows it, and when the cap is
			// already binding the reserve grows instead, so less content is re-emitted; either way the
			// reminder asks the model to condense. Anything else keeps the same budget with a strict
			// reminder. A second failure still fails closed and never stores raw model output as memory.
			const truncated = completion.stopReason === "length";
			// `reasoningReserveTokens` is capped at 8192, and a route can spend far more on hidden thinking than
			// that: the field case (Quantum_Matrix, 2026-10-08) spent 20489 tokens and left 11721 for a reply that
			// needed ~33k, so the retry asked for the usual +4096 and was cut off again. Carry the spend the
			// provider just reported into the retry's headroom, so a route that thinks this much gets room for it
			// on the second call (the request still stops at the model's own limit and the configured ceiling).
			const observedReasoning = truncated ? Number(completion.reasoningTokens ?? 0) : 0;
			const retryHeadroom = Math.max(RETRY_OUTPUT_HEADROOM_TOKENS, observedReasoning);
			usedInput = truncated
				? fitMemoryInput(
					existing.text,
					existingContext,
					config.maxTokens,
					auxModel,
					config.maxOutputTokens,
					retryHeadroom,
				)
				: fitted;
			const reminder = truncated
				? "Your previous response was cut off by the output limit. Retry this same consolidation now; condense the memory and context so the complete JSON object fits in this response."
				: "Your previous response was not a usable JSON object. Retry this same consolidation now.";
			const retryPrompt = `${promptFor(usedInput)}\n\n${reminder} Return exactly one complete JSON object with string memory_markdown and object context (summary string, title string, key_points array, open_tasks array); no prose, Markdown fence, ellipsis, or unfinished value.`;
			// Deliberately without the tool: this prompt asks for the text shape, and a tool call here
			// could not be parsed anyway.
			completion = await call(retryPrompt, usedInput, false);
			resolved = resolveReply(completion, false);
		}
		if (!resolved && completion.stopReason === "length") {
			// Two attempts both hit the cap: name the real cause instead of the generic parse message.
			throttle.set(projectRoot, { session: sessionId, turns, at: Date.now() });
			const reasoningNote = completion.reasoningTokens > 0 ? `, ${completion.reasoningTokens} spent on hidden reasoning` : "";
			throw new Error(`consolidation reply was cut off by the model output limit (${usedInput.maxTokens} tokens requested${reasoningNote}); raise maxOutputTokens or trim MEMORY.md\n${replyHead(completion.text)}`);
		}
		if (!resolved) {
			// Back off like any other failed pass, but never store the raw JSON as memory.
			throttle.set(projectRoot, { session: sessionId, turns, at: Date.now() });
			throw new Error(`consolidation reply was not a usable JSON object\n${replyHead(completion.text)}`);
		}
		let render = resolved.sections ? renderMemoryDocument(resolved.sections, config.maxMemoryChars) : undefined;
		// The same quality loop the whole-document cap used to drive. The renderer keeps the text inside
		// the cap by construction, so what is left to react to is a render that had to give up whole
		// entries — which, since the per-section shares became targets, means the document itself was
		// full rather than one section being over its share. The opaque entry has no section counts, so
		// it keeps the cap test — otherwise the path most likely to overflow would lose the loop.
		const needsCondense = render ? render.sectionDropped > 0 : exceedsMemoryCap(resolved.result.memory, config.maxMemoryChars);
		if (needsCondense) {
			// One bounded condensation attempt turns a silent loss into a curated shrink; if it fails or
			// still does not fit, keep the first result and let the cap report speak.
			const limit = config.maxMemoryChars;
			const condensePrompt = `${promptFor(usedInput)}\n\nYour previous memory_markdown overflowed the document's character cap, so whole entries would be dropped when it is written. Retry this same consolidation and rewrite memory_markdown until the whole document fits that cap (the per-section numbers are targets, not caps): keep every durable fact that is still true, merge duplicates within a section, deduplicate across sections, then condense the wording — delete an entry only when it is superseded or already covered elsewhere. Return exactly one complete JSON object with string memory_markdown and object context; no prose or code fence.`;
			let condensed: ResolvedReply | undefined;
			try {
				condensed = resolveReply(await call(condensePrompt, usedInput, false), false);
			} catch (error) {
				// A failed condensation must not discard the valid first result (which the cap report still
				// speaks for); `call` already recorded the failure, so only leave a diagnostic here.
				await logError(projectRoot, "memory", new Error(`condensation retry failed; keeping the over-cap reply so its cap report speaks: ${errorText(error)}`));
			}
			const condensedRender = condensed?.sections ? renderMemoryDocument(condensed.sections, limit) : undefined;
			const condensedText = condensed ? memoryTextFor(condensed, condensedRender) : "";
			// Whole-entry drops are the thing being condensed away; an entry merely clipped to its
			// section's per-item cap is a bounded line, not a loss, so it does not block adoption.
			// An empty reply — or one that condensed into a bare heading skeleton — is never adopted: it
			// would throw away the first result to store nothing.
			const condensedEmpty = condensed?.sections ? sectionsSemanticallyEmpty(condensed.sections) : isHeadingOnlyDocument(condensedText);
			const adopt =
				condensed !== undefined &&
				condensedText.trim() !== "" &&
				!condensedEmpty &&
				(condensedRender ? condensedRender.sectionDropped === 0 : !exceedsMemoryCap(condensedText, limit));
			if (condensed && adopt) {
				// Adopt only the condensed memory: a compacted retry may drop the context section, and the
				// first reply's context is real work that would otherwise be thrown away.
				resolved = {
					kind: condensed.kind,
					sections: condensed.sections,
					result: {
						...condensed.result,
						context: condensed.result.context ?? resolved.result.context,
						contextUnusable: condensed.result.context ? condensed.result.contextUnusable : resolved.result.contextUnusable,
					},
				};
				render = condensedRender;
			}
		}

		const sections = resolved.sections;
		// The opaque entry has no sections, so its half of the gate is "is this a document at all": a
		// reply that is nothing but headings would otherwise replace a real memory with a skeleton.
		// The field case this closes: at settle a conversational opening line was published as the whole
		// document, replacing a 29.9 KB four-section memory. That line *carried* the canonical
		// `# Project Memory` title (`# Project Memory\n\nI'll review the frozen revision …`).
		// Round 15 then walked the acceptance face: "the body carries a heading, a bullet entry or a fence"
		// still let `# Project Memory\n\nI'll do:\n- review` through - one bullet of prose replaced the
		// whole memory. A reply is a document only when it carries at least one section heading with at
		// least one entry under it: stricter than "some marker exists anywhere", looser than the full
		// four-section parse, which deliberately sends anything unusual back to the verbatim path and
		// would refuse a legitimate partial document (`## Project\n- x`).
		// The *stored* side is judged by that same parse OR by substance, because a hand-written
		// non-canonical memory (the field's six-section file) is exactly as much to lose as a canonical
		// one, and a store below the floor (a fresh project) has nothing to protect.
		const replyIsDocument = hasMemoryDocumentShape(resolved.result.memory);
		const storedIsDocument =
			sectionsFromMarkdown(existing.text) !== undefined ||
			existing.text.replace(/^\s*#\s*Project Memory[ \t]*(?:\r?\n|$)/i, "").trim().length >= OPAQUE_DOCUMENT_MIN_CHARS;
		// Below that floor the length rule in report.ts skips the write and reports "too short to be
		// a change" - the honest reason - so a short reply keeps that report (registered residual R-F3)
		// instead of this refusal.
		// The reply counts as a document only when it carries this extension's own shape: a known
		// `## <section>` heading at column 0 with a `- ` entry at column 0 under it, outside fenced blocks.
		// A wider hand-rolled markdown subset lived here for four review rounds (18-21), each finding another
		// fail-open, and its only gain was accepting reply shapes this extension never writes - so the gate is
		// the schema itself (see the review report's route decision).
		const conversationalOpaque =
			storedIsDocument &&
			!replyIsDocument &&
			resolved.result.memory.trim().length >= OPAQUE_DOCUMENT_MIN_CHARS;
		const semanticEmpty = sections ? sectionsSemanticallyEmpty(sections) : isHeadingOnlyDocument(resolved.result.memory) || conversationalOpaque;
		if (semanticEmpty) {
			// A reply with no entries at all renders as a bare four-heading skeleton, and an opaque reply
			// that is only headings is the same thing with the headings lost. Writing either would replace
			// a real memory with nothing, so the write is skipped outright — and because that is a silent
			// no-op from the outside, it always leaves a diagnostic.
			if (existing.text.trim()) {
				await logError(projectRoot, "memory", "the consolidation reply was not a writable memory document; the stored memory was kept unchanged");
			}
		}
		// The guard runs on the sections this pass would actually write and on the stored memory, both
		// before any clipping, so a clipped entry is not counted as a removal.
		let removed: RemovedEntries | undefined;
		if (!semanticEmpty) {
			const oldSections = sectionsFromMarkdown(existing.text);
			if (!sections) {
				// This pass answered on the opaque entry, so there is no new side to diff. Only worth saying
				// when something is actually stored; a fresh project has nothing to compare.
				if (existing.text.trim()) {
					await logError(projectRoot, "memory", "memory regression guard skipped: this pass did not produce sections");
				}
			} else if (!oldSections) {
				// A free-form or opaque stored memory has nothing to compare against; saying "N entries
				// were removed" there would be a wholesale false alarm.
				if (existing.text.trim()) {
					await logError(projectRoot, "memory", "memory regression guard skipped: the stored memory is not a plain four-section bullet document");
				}
			} else {
				removed = removedSectionEntries(oldSections, sections);
				if (removed.count > 0) {
					await logError(projectRoot, "memory", `memory regression: ${removed.count} Invariants/Pitfalls entry(ies) are no longer present, e.g. ${removed.samples.join(" | ")}`);
				}
			}
		}
		const version = (nextVersion += 1);
		throttle.set(projectRoot, { session: sessionId, turns, at: Date.now() });
		// `clipped` describes the prompt the writing reply actually saw: a truncated retry may have
		// sent less content than the first attempt, and the callers report that as a lossy rewrite.
		const outcome: ConsolidateOutcome = {
			result: { ...resolved.result, memory: memoryTextFor(resolved, render) },
			version,
			basisKey: existing.text,
			clipped: usedInput.clipped,
			kind: resolved.kind,
			semanticEmpty,
			sectionDropped: render?.sectionDropped ?? 0,
			droppedItems: render?.droppedItems ?? 0,
			droppedSamples: render?.droppedSamples ?? [],
			itemTruncated: render?.itemTruncated ?? 0,
			...(removed ? { removed } : {}),
		};
		lastOutcome.set(projectRoot, { version, at: Date.now(), outcome });
		return outcome;
	})().finally(() => {
		// Failures reject; the caller logs them and reports a truthful "failed".
		activeConsolidation = undefined;
	});

	return activeConsolidation;
}
