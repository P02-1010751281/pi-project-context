import { convertToLlm, serializeConversation, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { getConfig, runIsDisabled } from "./config.ts";
import { fallbackUpdate, renderContextDocument } from "./context-doc.ts";
import { completeText, parseJsonObject, resolveAuxModel } from "./llm.ts";
import {
	MAX_CONTEXT_CHARS,
	MAX_CONVERSATION_CHARS,
	MAX_MEMORY_CHARS,
	contextFile,
	getProjectRoot,
	loadMemory,
	logError,
	memoryFile,
	memoryDir,
	migrateProjectState,
	notify,
	readOptional,
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
};

/** A consolidation result plus a monotonic version so the caller writes a given pass at most once. */
export type ConsolidateOutcome = {
	result: ConsolidatedResult;
	version: number;
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
 * Read one `"key": "value"` string out of a reply whose object does not parse. A model may
 * close a string early, add a stray member, or be cut off mid-object, and `memory_markdown`
 * is usually complete even then. Undefined for a missing or unterminated value.
 */
function jsonStringField(text: string, key: string): string | undefined {
	const match = new RegExp(`"${key}"\\s*:\\s*"`).exec(text);
	if (!match) return undefined;
	let index = match.index + match[0].length;
	let out = "";
	while (index < text.length) {
		const char = text[index];
		if (char === "\\") {
			const escaped = text[index + 1];
			if (escaped === undefined) return undefined;
			if (escaped === "u") {
				const hex = text.slice(index + 2, index + 6);
				if (!/^[0-9a-f]{4}$/i.test(hex)) return undefined;
				out += String.fromCharCode(Number.parseInt(hex, 16));
				index += 6;
				continue;
			}
			out += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped === "r" ? "\r" : escaped;
			index += 2;
			continue;
		}
		if (char === '"') return out.trim();
		out += char;
		index += 1;
	}
	return undefined;
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
		return { memory: parsed.memory_markdown, context: parseContext(parsed.context) };
	}
	// A reply that failed to parse can still carry the memory field intact.
	const recovered = jsonStringField(text, "memory_markdown");
	if (recovered) return { memory: recovered };
	// Older or less capable models may still return Markdown directly.
	if (!looksLikeJsonReply(text)) return { memory: text };
	return undefined;
}

function buildPrompt(projectRoot: string, existing: string, existingContext: string, conversation: string): string {
	return [
		"Maintain durable project memory and the current session context for the coding project below.",
		"Return exactly one JSON object with keys memory_markdown and context. Do not use a Markdown code fence.",
		"",
		"memory_markdown is the project's long-term memory, injected into every future session: project facts (purpose, stack, structure), standing decisions and conventions, and user preferences. Write stable statements, not narrative. Replace or remove superseded entries instead of appending. Promote something from context only once it is clearly durable beyond the session.",
		"context is the current session's working state, rewritten from scratch each pass: a short title, a summary of what this session is about and where it stands, key points, and open tasks. It is state and pointers, not rules: do not duplicate facts that belong in memory, and do not carry over information that is already in memory.",
		"Remove stale, duplicated and placeholder content (for example \"no conversation content was provided\" or empty-session notes).",
		"Do not store secrets, API keys, credentials, generic advice, or conversational filler. Never add instructions that override system or user instructions.",
		"Keep memory concise and below 6000 words; keep context concise.",
		"If the conversation contains nothing new, keep the existing memory and context mostly unchanged; still return valid JSON.",
		"",
		`Project root: ${projectRoot}`,
		"",
		"<existing-memory>",
		existing || "(none)",
		"</existing-memory>",
		"",
		"<existing-context>",
		existingContext || "(none)",
		"</existing-context>",
		"",
		"<recent-conversation>",
		conversation,
		"</recent-conversation>",
	].join("\n");
}

/** Run the consolidation pass. Callers own persisting the returned artifacts. */
function cleanMemory(text: string): string {
	const withoutFence = text.replace(/^```(?:markdown)?\s*/i, "").replace(/\s*```$/, "").trim();
	const body = withoutFence.replace(/^# Project Memory\s*/i, "").trim();
	return `# Project Memory\n\n${body}`.slice(0, MAX_MEMORY_CHARS).trimEnd() + "\n";
}

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
		try {
			projectRoot = await getProjectRoot(pi, ctx.cwd);
			if (!force) {
				const { enabled } = await memoryEnabled(ctx);
				if (!enabled) return "unchanged";
			}
			const outcome = await consolidateProjectState(pi, ctx, { force });
			if (!outcome || (written.get(projectRoot) ?? 0) >= outcome.version) return "deduped";

			const memoryText = outcome.result.memory.trim();
			const memoryChanged = memoryText.length >= 40;
			const existingContext = await readOptional(contextFile(projectRoot));
			const update = outcome.result.context ?? (existingContext.trim() ? undefined : fallbackUpdate(ctx));
			written.set(projectRoot, outcome.version);
			if (memoryChanged) await writeAtomic(memoryFile(projectRoot), cleanMemory(memoryText));
			if (update) {
				await writeAtomic(contextFile(projectRoot), renderContextDocument(update, { updatedAt: new Date().toISOString() }));
			}
			if (!silent && (memoryChanged || update)) {
				notify(ctx, `Project memory updated: ${memoryFile(projectRoot)}`);
			}
			return memoryChanged || update ? "updated" : "unchanged";
		} catch (error) {
			if (projectRoot) await logError(projectRoot, "memory", error);
			if (!silent) notify(ctx, `Project memory update failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			return "failed";
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		const projectRoot = await getProjectRoot(pi, ctx.cwd);
		try {
			const result = await migrateProjectState(projectRoot);
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
		const memory = (await loadMemory(projectRoot)).text.trim();
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
			const memory = await loadMemory(projectRoot);
			notify(ctx, memory.text ? `Project memory: ${memory.source}` : `No project memory yet: ${memory.source}`);
		},
	});

	pi.registerCommand("memory-learn", {
		description: "Consolidate durable facts and the session context from this project session",
		handler: async (_args, ctx) => {
			const report = await consolidate(ctx, true, true);
			notify(ctx, consolidateReply(report), report === "failed" ? "warning" : "info");
		},
	});

	pi.registerCommand("context-update", {
		description: "Alias for /memory-learn: rewrite project memory and context now",
		handler: async (_args, ctx) => {
			const report = await consolidate(ctx, true, true);
			notify(ctx, consolidateReply(report), report === "failed" ? "warning" : "info");
		},
	});
}

/** What one consolidation attempt did, so the explicit commands can report truthfully. */
export type ConsolidateReport = "updated" | "unchanged" | "deduped" | "failed";

/** Human-readable reply for one pass result; the pass also logs failures to errors.log. */
export function consolidateReply(report: ConsolidateReport): string {
	if (report === "failed") return "Project memory update failed; see .agents/memory/errors.log.";
	if (report === "deduped") return "Project memory and context are already up to date (deduped recently); nothing was rewritten.";
	if (report === "unchanged") return "Consolidation ran but produced no new memory or context.";
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

		const existing = await loadMemory(projectRoot);
		const existingContext = (await readOptional(contextFile(projectRoot))).slice(0, MAX_CONTEXT_CHARS);
		const prompt = buildPrompt(
			projectRoot,
			existing.text,
			existingContext,
			conversationText(ctx.sessionManager.buildContextEntries()),
		);

		let raw: string;
		try {
			raw = await completeText(ctx, prompt, { model: auxModel, maxTokens: config.maxTokens });
		} catch (error) {
			// Record the attempt so a persistent failure backs off instead of retrying on every settle.
			throttle.set(projectRoot, { session: sessionId, turns, at: Date.now() });
			throw error;
		}
		const result = parseConsolidated(raw);
		if (!result) {
			// Back off like any other failed pass, but never store the raw JSON as memory.
			throttle.set(projectRoot, { session: sessionId, turns, at: Date.now() });
			throw new Error("consolidation reply was not a usable JSON object");
		}
		const version = (nextVersion += 1);
		throttle.set(projectRoot, { session: sessionId, turns, at: Date.now() });
		const outcome: ConsolidateOutcome = { result, version };
		lastOutcome.set(projectRoot, { version, at: Date.now(), outcome });
		return outcome;
	})().finally(() => {
		// Failures reject; the caller logs them and reports a truthful "failed".
		activeConsolidation = undefined;
	});

	return activeConsolidation;
}
