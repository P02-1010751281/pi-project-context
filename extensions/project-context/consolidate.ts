import { convertToLlm, serializeConversation, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { configFile, getConfig, runIsDisabled } from "./config.ts";
import { fallbackUpdate, renderContextDocument } from "./context-doc.ts";
import { completeText, parseJsonObject, resolveAuxModel } from "./llm.ts";
import {
	MAX_CONTEXT_CHARS,
	MAX_CONVERSATION_CHARS,
	backupMemoryBeforeWrite,
	contextFile,
	getProjectRoot,
	isMemoryTruncated,
	loadMemory,
	logError,
	memoryFile,
	memoryDir,
	migrateProjectState,
	normalizeMemoryDocument,
	notify,
	recordMemoryDocument,
	readJsonStringField,
	readOptional,
	withMemoryLock,
	writeAtomic,
} from "./project-state.ts";

/**
 * The project-state consolidation pass: one model call that rewrites durable project
 * memory (MEMORY.md) and the current session's working context (CONTEXT.md).
 *
 * All hooks and the throttle/single-flight state live in this one module, so a pass
 * cannot be duplicated by pi's per-extension module registries. The `memory` feature
 * switch gates the automatic pass and the injection; explicit commands always run.
 *
 * Cadence (`consolidateTurns` / `consolidateIntervalMs` / `forceDedupeMs`) lives in
 * project-context.json and matches the dsh plugin's defaults.
 */

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

/**
 * Render the active conversation for the prompt. `convertToLlm` expects AgentMessage[]
 * (plain `{role, content}` records), not SessionEntry[] wrappers, so entries are projected
 * first; passing them directly silently produced an empty conversation.
 */
function conversationText(entries: SessionEntry[]): string {
	const messages = entries.flatMap((entry) => sessionEntryToContextMessages(entry));
	const serialized = serializeConversation(convertToLlm(messages));
	if (serialized.length <= MAX_CONVERSATION_CHARS) return serialized;
	const head = Math.floor(MAX_CONVERSATION_CHARS * 0.35);
	return `${serialized.slice(0, head)}\n\n[...middle of conversation omitted...]\n\n${serialized.slice(-(MAX_CONVERSATION_CHARS - head))}`;
}

function userTurnCount(branch: SessionEntry[]): number {
	return branch.filter((entry) => entry.type === "message" && entry.message.role === "user").length;
}

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

/** Characters of the raw reply kept in a failure record; `errors.log` caps the whole record anyway. */
const MAX_LOGGED_REPLY_CHARS = 4000;

/** Attach the head of the reply the model actually sent so errors.log can be diagnosed later. */
function replyHead(raw: string): string {
	const head = raw.slice(0, MAX_LOGGED_REPLY_CHARS);
	const notice = raw.length > head.length ? `\n[...reply omitted after ${head.length} of ${raw.length} chars...]` : "";
	return `--- raw reply ---\n${head}${notice}`;
}

/** Worst-case output tokens per character for dense scripts (a Han character is close to one token). */
const DENSE_TOKENS_PER_CHAR = 1;
/** Conservative rate for markdown, paths and ASCII prose (real tokenizers need less). */
const ASCII_TOKENS_PER_CHAR = 0.4;
/** Extra cost for a quote or backslash, which JSON escaping doubles when the reply re-emits it. */
const ESCAPE_TOKENS_PER_CHAR = 0.2;
/** Output room reserved for the JSON scaffolding and the rewritten context. */
export const REPLY_OUTPUT_MARGIN_TOKENS = 1024;
/** Chars kept per artifact when the budget allows; the split also reserves it as a token floor. */
const MIN_CLIP_CHARS = 400;
/** Hard ceiling for an adaptive output cap when the model reports no limit of its own. */
export const MAX_ADAPTIVE_OUTPUT_TOKENS = 32_768;

/** What the pass sends instead of the stored artifacts, plus the budget it asks for. */
type MemoryInput = { text: string; contextText: string; maxTokens: number; clipped: boolean };

/**
 * Conservative output-token rate for text the reply must re-emit. Dense scripts (CJK and every
 * other non-ASCII script, including emoji) are charged a full token per code point; ASCII prose
 * is charged 0.4; quotes and backslashes pay extra for their JSON escape. Never underestimates.
 */
export function replyTokenRate(text: string): number {
	if (!text) return ASCII_TOKENS_PER_CHAR;
	let tokens = 0;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if (code > 0x7f) tokens += DENSE_TOKENS_PER_CHAR;
		else tokens += ASCII_TOKENS_PER_CHAR + (char === '"' || char === "\\" ? ESCAPE_TOKENS_PER_CHAR : 0);
	}
	// Rate per UTF-16 unit, so `text.length * rate` stays the token estimate.
	return tokens / text.length;
}

/** Clip from the original text to a char limit, keeping the original when it already fits. */
function clipTo(text: string, limit: number): string {
	return text.length <= limit ? text : limit <= 0 ? "" : clipText(text, limit);
}

/** Split a token budget between two artifacts: each keeps a floor, the rest follows the need. */
function allocateTokens(budget: number, memoryTokens: number, contextTokens: number): { memory: number; context: number } {
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

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
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

/** Head and tail of a text, shortened to a char limit (the `\n\n` joiner included). */
export function clipText(text: string, limit: number): string {
	if (text.length <= limit) return text;
	if (limit < 16) {
		let cut = Math.max(0, limit);
		// Never end on a high surrogate: a lone half cannot be re-encoded by a provider.
		if (cut > 0 && isHighSurrogate(text.charCodeAt(cut - 1))) cut -= 1;
		return text.slice(0, cut);
	}
	const size = limit - 2;
	let head = Math.ceil(size * 0.6);
	if (head > 0 && head < text.length && isHighSurrogate(text.charCodeAt(head - 1))) head -= 1;
	let tailStart = text.length - (size - head);
	if (tailStart > head && isLowSurrogate(text.charCodeAt(tailStart))) {
		if (isHighSurrogate(text.charCodeAt(tailStart - 1))) {
			// Include the pair's high surrogate and take the extra unit back out of the head, so
			// the result never exceeds `limit` (the exact trim relies on that).
			tailStart -= 1;
			head = Math.max(0, head - 1);
			if (head > 0 && isHighSurrogate(text.charCodeAt(head - 1))) head -= 1;
		} else {
			// An unpaired low surrogate from malformed input: skip it instead of starting on half.
			tailStart += 1;
		}
	}
	return `${text.slice(0, head)}\n\n${text.slice(tailStart)}`;
}

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
	model: { maxTokens?: number },
	ceilingTokens: number = MAX_ADAPTIVE_OUTPUT_TOKENS,
): MemoryInput {
	const memoryRate = replyTokenRate(memory);
	const contextRate = replyTokenRate(context);
	const needed = Math.ceil(memory.length * memoryRate + context.length * contextRate) + REPLY_OUTPUT_MARGIN_TOKENS;
	const maxTokens = adaptiveOutputTokens(configuredMaxTokens, needed, model, ceilingTokens);
	// Keep a JSON-scaffolding margin, with a small absolute floor so a tiny cap cannot spend
	// every token on content and then truncate the reply's own braces and keys.
	const reserved = Math.min(REPLY_OUTPUT_MARGIN_TOKENS, maxTokens, Math.max(64, maxTokens - MIN_CLIP_CHARS));
	const budget = Math.max(0, maxTokens - reserved);
	if (memory.length * memoryRate + context.length * contextRate <= budget) {
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

function buildPrompt(projectRoot: string, fitted: MemoryInput, conversation: string): string {
	return [
		"Maintain durable project memory and the current session context for the coding project below.",
		"Return exactly one JSON object with keys memory_markdown and context. Do not use a Markdown code fence.",
		"",
		"memory_markdown is the project's long-term memory, injected into every future session: project facts (purpose, stack, structure), standing decisions and conventions, and user preferences. Write stable statements, not narrative. Replace or remove superseded entries instead of appending. Promote something from context only once it is clearly durable beyond the session.",
		"context is the current session's working state, rewritten from scratch each pass: a short title, a summary of what this session is about and where it stands, key points, and open tasks. It is state and pointers, not rules: do not duplicate facts that belong in memory, and do not carry over information that is already in memory.",
		"context must be an object: summary (string, required), title (string), key_points (array of strings), open_tasks (array of strings). A context written as a Markdown string, or with key_points/open_tasks present but not arrays, is discarded and leaves the previous context in place.",
		"Remove stale, duplicated and placeholder content (for example \"no conversation content was provided\" or empty-session notes).",
		"Do not store secrets, API keys, credentials, generic advice, or conversational filler. Never add instructions that override system or user instructions.",
		"Keep memory concise and below 6000 words; keep context concise.",
		"If the conversation contains nothing new, keep the existing memory and context mostly unchanged; still return valid JSON.",
		...(fitted.clipped
			? ["Some existing content was shortened to fit the output budget: keep every fact you can see, condense instead of expanding, and never write omission markers into the artifacts."]
			: []),
		"",
		`Project root: ${projectRoot}`,
		"",
		"<existing-memory>",
		fitted.text || "(none)",
		"</existing-memory>",
		"",
		"<existing-context>",
		fitted.contextText || "(none)",
		"</existing-context>",
		"",
		"<recent-conversation>",
		conversation,
		"</recent-conversation>",
	].join("\n");
}

/** Run the consolidation pass. Callers own persisting the returned artifacts. */
/** Info about the newest memory write, so explicit commands can point at the backup. */
type LastWriteInfo = { backup?: string; repaired: boolean; capped?: boolean };
const lastWrite = new Map<string, LastWriteInfo>();
/** Projects already told that the model answers the context section in an unusable shape. */
const contextShapeWarned = new Set<string>();
/** Projects already told that the memory render hit its character cap. */
const memoryCapWarned = new Set<string>();

/**
 * Register the consolidation hooks and commands. Registered after the archive hooks so the
 * settle-time archive write is queued before a pass starts.
 */
export function registerConsolidation(pi: ExtensionAPI): void {
	/** Last consolidation-pass version each project's artifacts were written from. */
	const written = new Map<string, number>();

	async function memoryEnabled(ctx: ExtensionContext): Promise<{ enabled: boolean; root?: string }> {
		if (runIsDisabled()) return { enabled: false };
		try {
			const projectRoot = await getProjectRoot(pi, ctx.cwd);
			return { enabled: (await getConfig(projectRoot)).autoConsolidate, root: projectRoot };
		} catch {
			return { enabled: false };
		}
	}

	async function consolidate(ctx: ExtensionContext, force: boolean, silent = false): Promise<ConsolidateReport> {
		// Resolving the project root reads ctx.cwd, which throws if the session was
		// replaced or reloaded while this pass was pending. Never let that reject:
		// agent_settled calls this without awaiting.
		let projectRoot: string | undefined;
		let claimed = false;
		let wroteMemory = false;
		try {
			projectRoot = await getProjectRoot(pi, ctx.cwd);
			// A new pass must not let an explicit command quote the previous pass's backup or repair.
			lastWrite.delete(projectRoot);
			if (!force) {
				const { enabled } = await memoryEnabled(ctx);
				if (!enabled) return "unchanged";
			}
			const outcome = await consolidateProjectState(pi, ctx, { force });
			if (!outcome || (written.get(projectRoot) ?? 0) >= outcome.version) return "deduped";
			// Claim the version before any await so a concurrent pass cannot write the same pass twice.
			written.set(projectRoot, outcome.version);
			claimed = true;
			// The cap the write path renders with; the pass itself resolved the same config just now.
			const maxMemoryChars = (await getConfig(projectRoot)).maxMemoryChars;
			const memoryText = outcome.result.memory.trim();
			const memoryChanged = memoryText.length >= 40;
			const existingContext = await readOptional(contextFile(projectRoot));
			const update = outcome.result.context ?? (existingContext.trim() ? undefined : fallbackUpdate(ctx));
			if (outcome.result.contextUnusable && !contextShapeWarned.has(projectRoot)) {
				// A model that answers in another shape would otherwise leave CONTEXT.md stale for
				// days without a trace: nothing failed, so nothing was logged anywhere.
				contextShapeWarned.add(projectRoot);
				const kept = existingContext.trim() ? "the previous CONTEXT.md is kept" : "only a placeholder context was written";
				await logError(projectRoot, "memory", `the consolidation reply carried a context section that could not be used (expected an object with title/summary/key_points/open_tasks); ${kept}`);
			} else if (!outcome.result.context && existingContext.trim() && !contextShapeWarned.has(projectRoot)) {
				// Same failure class, one step further back: no context member at all. The reply was either
				// cut off at the output cap (the memory alone filled it) or simply left the section out;
				// either way the kept CONTEXT.md ages silently, which is how it stayed a day behind.
				contextShapeWarned.add(projectRoot);
				await logError(
					projectRoot,
					"memory",
					`the consolidation reply carried no context section${outcome.result.recovered ? " (its object never closed, so only memory_markdown could be recovered)" : ""}; the previous CONTEXT.md is kept and stays stale until a pass returns one`,
				);
			}
			let backup: string | undefined;
			let storedPoisoned = false;
			let cappedMemory = false;
			if (memoryChanged) {
				// Always keep the bytes that are on disk right now, whatever this pass believed
				// earlier; the lock keeps another process from replacing them mid-write. The journal
				// is the source of truth: this pass appends its document, then MEMORY.md is rendered.
				const snapshot = await withMemoryLock(memoryFile(projectRoot), async () => {
					const kept = await backupMemoryBeforeWrite(memoryFile(projectRoot));
					await recordMemoryDocument(projectRoot, memoryText, maxMemoryChars);
					return kept;
				});
				backup = snapshot.path;
				storedPoisoned = snapshot.poisoned;
				wroteMemory = true;
				// The marker is the durable trace; the log entry and the reply are the loud ones.
				cappedMemory = isMemoryTruncated(normalizeMemoryDocument(memoryText, maxMemoryChars));
				lastWrite.set(projectRoot, { backup, repaired: storedPoisoned, capped: cappedMemory });
				if (storedPoisoned) {
					await logError(projectRoot, "memory", `replaced a stored JSON reply with markdown; original kept at ${backup ?? "(none)"}`);
				}
				if (cappedMemory && !memoryCapWarned.has(projectRoot)) {
					// A marker nobody reads is still a silent loss: say it once per project per process,
					// and point at the knob that lifts the cap.
					memoryCapWarned.add(projectRoot);
					await logError(
						projectRoot,
						"memory",
						`memory exceeded maxMemoryChars (${maxMemoryChars}): the tail was dropped on a line boundary, whole lines only — raise maxMemoryChars in project-context.json or trim MEMORY.md`,
					);
				}
			}
			if (update) {
				await writeAtomic(contextFile(projectRoot), renderContextDocument(update, { updatedAt: new Date().toISOString() }));
			}
			const report: ConsolidateReport = memoryChanged || update ? (outcome.clipped ? "clipped" : "updated") : "unchanged";
			if (outcome.clipped && (memoryChanged || update)) {
				// Always leave a trace: the UI warning below is a no-op headless, and commands report separately.
				await logError(projectRoot, "memory", "consolidation shortened the existing memory or context to fit the model output budget");
			}
			if (!silent && (memoryChanged || update)) {
				const clippedNote = report === "clipped" ? " The rewrite also shortened the content to fit the model output budget." : "";
				if (storedPoisoned && memoryChanged) {
					const capNote = cappedMemory
						? ` It also hit its ${maxMemoryChars}-character cap; the tail was dropped on a line boundary.`
						: "";
					notify(ctx, `Project memory was raw JSON from the old bug and is now Markdown${backup ? ` (backup: ${backup})` : ""}.${capNote}${clippedNote}`, "warning");
				} else if (cappedMemory) {
					notify(
						ctx,
						`Project memory hit its ${maxMemoryChars}-character cap: the tail was dropped on a line boundary (whole lines only) and MEMORY.md ends with a truncation marker. Raise maxMemoryChars in ${configFile(projectRoot)} or trim it.`,
						"warning",
					);
				} else if (report === "clipped") {
					notify(ctx, backup ? `${CLIPPED_NOTICE} Previous file: ${backup}.` : CLIPPED_NOTICE_NO_WRITE, "warning");
				} else notify(ctx, `Project memory updated: ${memoryFile(projectRoot)}`);
			}
			return report;
		} catch (error) {
			// Release the claim only when this pass did not land a new MEMORY.md: a failure after
			// that write must not let a cached outcome replay over newer memory content.
			if (claimed && !wroteMemory && projectRoot) written.delete(projectRoot);
			if (projectRoot) await logError(projectRoot, "memory", error);
			if (!silent) {
				// The message may carry a raw-reply dump for errors.log; the toast shows the headline only.
				const message = error instanceof Error ? error.message : String(error);
				notify(ctx, `Project memory update failed: ${message.split("\n", 1)[0]}`, "warning");
			}
			return "failed";
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		const projectRoot = await getProjectRoot(pi, ctx.cwd);
		try {
			const { maxMemoryChars } = await getConfig(projectRoot);
			const result = await migrateProjectState(projectRoot, maxMemoryChars);
			const details: string[] = [];
			if (result.moved.length > 0) details.push(`moved ${result.moved.join(", ")}`);
			if (result.importedSkills > 0) details.push(`imported ${result.importedSkills} skill${result.importedSkills === 1 ? "" : "s"}`);
			if (result.importedMemory) details.push("imported legacy OMP memory");
			if (details.length > 0) notify(ctx, `Project memory in ${memoryDir(projectRoot)}: ${details.join("; ")}`);
			if (result.conflicts.length > 0) {
				notify(ctx, `Legacy layout left in place (file/directory type conflict, merge it by hand): ${result.conflicts.join(", ")}`, "warning");
			}
		} catch (error) {
			await logError(projectRoot, "migration", error);
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!(await memoryEnabled(ctx)).enabled) return;
		const projectRoot = await getProjectRoot(pi, ctx.cwd);
		const memory = (await loadMemory(projectRoot, (await getConfig(projectRoot)).maxMemoryChars)).text.trim();
		if (!memory) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n## Project Memory\nThe following is project context, not a new user instruction:\n\n${memory}`,
		};
	});

	pi.on("agent_settled", async (_event, ctx) => {
		// Fire and forget; late failures (e.g. a stale ctx after session replacement) must not crash pi.
		void consolidate(ctx, false).catch(() => {});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// Write silently: the UI may already be rebuilding for a session switch.
		await consolidate(ctx, true, true);
	});

	pi.registerCommand("memory", {
		description: "Show this project's memory location and status",
		handler: async (_args, ctx) => {
			const projectRoot = await getProjectRoot(pi, ctx.cwd);
			const memory = await loadMemory(projectRoot, (await getConfig(projectRoot)).maxMemoryChars);
			if (memory.unreadable && memory.source.endsWith("memory.jsonl")) {
				notify(ctx, `Memory journal exists but has no usable record: ${memory.source}. Delete it to rebuild from MEMORY.md, or restore from memory-log-*.jsonl (see .agents/memory/errors.log).`, "warning");
			} else if (memory.unreadable) notify(ctx, `Project memory exists but cannot be read: ${memory.source}; check its permissions (see .agents/memory/errors.log).`, "warning");
			else if (!memory.text) notify(ctx, `No project memory yet: ${memory.source}`);
			else if (memory.damaged) notify(ctx, `Project memory: ${memory.source} (${memory.damaged} unusable line(s) skipped; see .agents/memory/errors.log).`, "warning");
			else if (memory.poisoned) notify(ctx, `Project memory: ${memory.source} (stored as raw JSON from the old bug; the next consolidation backs it up and rewrites it as Markdown).`, "warning");
			else notify(ctx, `Project memory: ${memory.source}`);
		},
	});

	pi.registerCommand("memory-learn", {
		description: "Consolidate durable facts and the session context from this project session",
		handler: async (_args, ctx) => {
			const projectRoot = await getProjectRoot(pi, ctx.cwd);
			const report = await consolidate(ctx, true, true);
			notify(ctx, consolidateReply(report, lastWrite.get(projectRoot)), report === "failed" || report === "clipped" ? "warning" : "info");
		},
	});

	pi.registerCommand("context-update", {
		description: "Alias for /memory-learn: rewrite project memory and context now",
		handler: async (_args, ctx) => {
			const projectRoot = await getProjectRoot(pi, ctx.cwd);
			const report = await consolidate(ctx, true, true);
			notify(ctx, consolidateReply(report, lastWrite.get(projectRoot)), report === "failed" || report === "clipped" ? "warning" : "info");
		},
	});
}

/** What one consolidation attempt did, so the explicit commands can report truthfully. */
export type ConsolidateReport = "updated" | "clipped" | "unchanged" | "deduped" | "failed";

/** Shown when the pass had to shorten stored content to fit the model output budget. */
const CLIPPED_NOTICE =
	"Project memory and context updated, but existing content was shortened to fit the model output budget; the previous MEMORY.md is kept as a backup in .agents/memory — review it if older details matter.";
/** The same notice for command replies, which cannot know whether a backup was written. */
const CLIPPED_NOTICE_NO_WRITE =
	"Project memory and context were updated, but existing content was shortened to fit the model output budget; review MEMORY.md, CONTEXT.md and the .agents/memory backups if older details matter.";

/** Human-readable reply for one pass result; the pass also logs failures to errors.log. */
export function consolidateReply(report: ConsolidateReport, info?: LastWriteInfo): string {
	if (report === "failed") return "Project memory update failed; see .agents/memory/errors.log.";
	if (report === "clipped") return info?.backup ? `${CLIPPED_NOTICE} Previous file: ${info.backup}.` : CLIPPED_NOTICE_NO_WRITE;
	if (report === "deduped") return "Project memory and context are already up to date (deduped recently); nothing was rewritten.";
	if (report === "unchanged") return "Consolidation ran but produced no new memory or context.";
	if (info?.repaired && info.backup) {
		const capNote = info.capped ? " It also hit its maxMemoryChars cap and its tail was dropped on a line boundary." : "";
		return `Project memory and context updated; the stored raw JSON reply was replaced (backup: ${info.backup}).${capNote}`;
	}
	if (info?.capped) return `Project memory updated, but it is at its maxMemoryChars cap and its tail was dropped (whole lines only); raise maxMemoryChars in project-context.json or trim MEMORY.md.`;
	return "Project memory and context updated.";
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
		const fitted = fitMemoryInput(existing.text, existingContext, config.maxTokens, auxModel, config.maxOutputTokens);
		const prompt = buildPrompt(projectRoot, fitted, conversationText(ctx.sessionManager.buildContextEntries()));

		let raw: string;
		try {
			raw = await completeText(ctx, prompt, { model: auxModel, maxTokens: fitted.maxTokens });
		} catch (error) {
			// Record the attempt so a persistent failure backs off instead of retrying on every settle.
			throttle.set(projectRoot, { session: sessionId, turns, at: Date.now() });
			throw error;
		}
		let result = parseConsolidated(raw);
		if (!result) {
			// Providers occasionally return a transient fence/prose/truncated-shape response even when
			// the same request can complete on the next call. Retry once with a short contract reminder;
			// a second failure still fails closed and never stores raw model output as memory.
			const retryPrompt = `${prompt}\n\nYour previous response was not a usable JSON object. Retry this same consolidation now. Return exactly one complete JSON object with string memory_markdown and object context (summary string, title string, key_points array, open_tasks array); no prose, Markdown fence, ellipsis, or unfinished value.`;
			try {
				raw = await completeText(ctx, retryPrompt, { model: auxModel, maxTokens: fitted.maxTokens });
			} catch (error) {
				throttle.set(projectRoot, { session: sessionId, turns, at: Date.now() });
				throw error;
			}
			result = parseConsolidated(raw);
		}
		if (!result) {
			// Back off like any other failed pass, but never store the raw JSON as memory.
			throttle.set(projectRoot, { session: sessionId, turns, at: Date.now() });
			throw new Error(`consolidation reply was not a usable JSON object\n${replyHead(raw)}`);
		}
		const version = (nextVersion += 1);
		throttle.set(projectRoot, { session: sessionId, turns, at: Date.now() });
		const outcome: ConsolidateOutcome = { result, version, clipped: fitted.clipped };
		lastOutcome.set(projectRoot, { version, at: Date.now(), outcome });
		return outcome;
	})().finally(() => {
		// Failures reject; the caller logs them and reports a truthful "failed".
		activeConsolidation = undefined;
	});

	return activeConsolidation;
}
