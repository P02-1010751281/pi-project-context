/**
 * Auto Handoff — start a fresh session when the context window gets too full.
 *
 * When context usage crosses a threshold, the older part of the session is
 * summarized with pi's built-in compaction summarizer, the most recent
 * messages are carried over verbatim (like compaction's keepRecentTokens),
 * and the work continues in a new session. This trades one summarization call
 * for much smaller per-turn input afterwards, while keeping the recent raw
 * context that protects answer quality.
 *
 * Threshold:
 *   - auto (default): trigger once the context can give up ~autoTargetTokens
 *     (default 64k) on top of the measured baseline + keepRecent, bounded by
 *     half the usable window and by the model's first cost tier. Derived from
 *     model info (contextWindow, cost tiers) and measured usage, not a fixed %.
 *   - fixed: /auto-handoff 0.5 uses 0.5 * contextWindow.
 *
 * Summary calls default to thinking off: on reasoning models thinking and the
 * answer share the response cap (deepseek sends thinking:{type:enabled} with no
 * separate budget), so session-level thinking can truncate a large summary.
 * `/auto-handoff thinking session` restores pi's session-level behavior; a
 * truncated summary is retried with more output room either way.
 *
 * Guard: an automatic handoff never answers a question the previous session
 * left open for the user. If the last assistant message is a pending question,
 * the continuation is still sent, but carries the open question plus an explicit
 * "wait for the user's answer" instruction (wait, the default). `/auto-handoff
 * guard` picks the behavior: wait, draft (leave it in the editor for review),
 * send (continue without waiting), or skip (no handoff until the user answers).
 * A handoff requested manually with /auto-handoff now is never guarded.
 *
 * Commands:
 *   /auto-handoff                show status
 *   /auto-handoff on|off         enable/disable (persisted per project)
 *   /auto-handoff auto           adaptive threshold (persisted)
 *   /auto-handoff 0.6 | 60%      fixed-ratio threshold (persisted)
 *   /auto-handoff target 64k     auto mode: tokens to summarize per handoff
 *   /auto-handoff thinking off   summary thinking level: off (default, fast) or session
 *   /auto-handoff keep 20k|0     recent tokens carried over verbatim (persisted)
 *   /auto-handoff send|draft     auto-send the continuation, or leave it in the editor
 *   /auto-handoff guard wait|draft|send|skip  pending-question behavior (default wait)
 *   /auto-handoff now            hand off right now (force)
 *
 * Settings live in `<project>/.agents/memory/project-context.json` (see config.ts); the
 * `handoff` feature switch is the same one `/project-context off handoff` toggles.
 *
 * CLI flags:
 *   --handoff-ratio 0.4|auto|off initial threshold for this run
 *   --no-auto-handoff            disable for this run
 *   --no-project-context         disable every project-context feature for this run
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	buildContextEntries,
	type ContextUsage,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	estimateTokens,
	findCutPoint,
	generateSummaryWithUsage,
	type SessionEntry,
	type SessionManager,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_HANDOFF, getConfig, type HandoffSettings, MAX_KEEP_RECENT_TOKENS, MIN_SUMMARIZE_TOKENS, peekConfig, runIsDisabled, setFeature, updateHandoff } from "./config.ts";
import { getProjectRoot } from "./project-state.ts";

type Config = HandoffSettings;

const DEFAULT_CONFIG: Config = { ...DEFAULT_HANDOFF };
/** pi's default compaction reserve; window headroom used by the threshold math. */
const WINDOW_RESERVE_TOKENS = 16_384;
/** Output room for the summary call (0.8 * this is the maxTokens cap). */
const SUMMARY_OUTPUT_RESERVE_TOKENS = 32_768;
const SUMMARY_FOCUS =
	"This summary covers the older part of the previous session; its most recent messages are carried over separately. " +
	"Preserve exact file paths, function names, commands, error messages, and unfinished work. Keep it concise.";
/** Stay this far below a cost tier edge so streaming growth cannot cross it. */
const TIER_EDGE_MARGIN = 4_000;
const SUMMARY_TIMEOUT_MS = 180_000;
const FAILURE_BACKOFF_MS = 5 * 60_000;
const RETRIGGER_COOLDOWN_MS = 30_000;

let config: Config = { ...DEFAULT_CONFIG };
/** Project whose project-context.json supplied the current settings. */
let configRoot: string | undefined;
/** Per-run override from --no-auto-handoff / --handoff-ratio off. */
let flagEnabled = true;
/** Set while a handoff is being generated/replaced so a second settle cannot stack one. */
let inFlight = false;
let cooldownUntil = 0;
let failureBackoffUntil = 0;

/** Feature switch (`/project-context off handoff`) plus run-level overrides. */
function handoffEnabled(): boolean {
	return !runIsDisabled() && flagEnabled && (peekConfig(configRoot)?.features.handoff ?? false);
}

/** Load the project's handoff settings into the local working copy. */
async function syncConfig(root: string | undefined): Promise<void> {
	configRoot = root;
	if (!root) return;
	config = (await getConfig(root)).handoff;
}

async function saveConfig(): Promise<void> {
	if (!configRoot) return;
	try {
		await updateHandoff(configRoot, config);
	} catch {
		// Best effort; a read-only project dir must not break the session.
	}
}

/** Accepts "0.5", "50%", or "50". */
function parseRatio(input: string): number | undefined {
	const text = input.trim().toLowerCase().replace(/%$/, "");
	const value = Number(text);
	if (!Number.isFinite(value)) return undefined;
	const ratio = value > 1 ? value / 100 : value;
	return ratio > 0.05 && ratio < 0.98 ? ratio : undefined;
}

/** Accepts "12k", "12000", "1.5k". */
function parseTokenCount(input: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)(k)?$/.exec(input.trim().toLowerCase());
	if (!match) return undefined;
	const value = Number(match[1]) * (match[2] ? 1_000 : 1);
	return Number.isFinite(value) ? Math.round(value) : undefined;
}

function fmtTokens(tokens: number): string {
	if (tokens < 1_000) return String(tokens);
	return `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1)}k`;
}

function fmtPct(percent: number): string {
	return `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	try {
		if (ctx.hasUI) ctx.ui.notify(message, type);
	} catch {
		// The UI may already be tearing down; notifications must never break a handler.
	}
}

function cleanHeaders(headers: Record<string, string | null> | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const cleaned: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (typeof value === "string") cleaned[key] = value;
	}
	return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

function usageText(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	if (!usage || usage.tokens === null) return "unknown";
	return `${fmtTokens(usage.tokens)}/${fmtTokens(usage.contextWindow)} (${fmtPct(usage.percent ?? 0)})`;
}

interface Threshold {
	tokens: number;
	label: string;
}

/** Everything that is not conversation: system prompt, tool schemas, injected memory/context. */
function baselineTokens(ctx: ExtensionContext, usage: ContextUsage): number {
	const entries = buildContextEntries(ctx.sessionManager.getBranch(), ctx.sessionManager.getLeafId());
	const contextTokens = entries
		.flatMap(sessionEntryToContextMessages)
		.reduce((sum, message) => sum + estimateTokens(message), 0);
	return Math.max(0, (usage.tokens ?? contextTokens) - contextTokens);
}

/** First request-wide pricing tier edge, e.g. a long-context surcharge. Model metadata. */
function firstCostTierEdge(model: NonNullable<ExtensionContext["model"]>): number | undefined {
	const edges = (model.cost?.tiers ?? [])
		.map((tier) => tier.inputTokensAbove)
		.filter((edge): edge is number => typeof edge === "number" && edge > 0)
		.sort((a, b) => a - b);
	return edges[0];
}

/**
 * Resolve the trigger threshold from model info and measured usage:
 * - fixed: ratio * contextWindow.
 * - auto: give up ~autoTargetTokens per handoff, bounded by half the usable
 *   window and by the first cost tier so a surcharge is not crossed.
 */
function resolveThreshold(ctx: ExtensionContext, usage: ContextUsage): Threshold | undefined {
	const window = usage.contextWindow;
	if (window <= 0) return undefined;
	if (config.threshold !== "auto") {
		const tokens = Math.min(Math.round(config.threshold * window), window - TIER_EDGE_MARGIN);
		return tokens > 0 ? { tokens, label: `${fmtPct(config.threshold * 100)} of window` } : undefined;
	}
	const model = ctx.model;
	if (!model || usage.tokens === null) return undefined;

	const baseline = baselineTokens(ctx, usage);
	const keep = config.keepRecentTokens;
	const floor = baseline + keep + MIN_SUMMARIZE_TOKENS;
	const usable = window - WINDOW_RESERVE_TOKENS;
	if (usable <= floor) return undefined; // window too small for this configuration

	const conversationRoom = usable - baseline - keep;
	const targetOlder = Math.max(
		MIN_SUMMARIZE_TOKENS,
		Math.min(config.autoTargetTokens, Math.floor(conversationRoom / 2)),
	);
	let tokens = baseline + keep + targetOlder;
	const tierEdge = firstCostTierEdge(model);
	if (tierEdge !== undefined && tierEdge > floor + TIER_EDGE_MARGIN) {
		tokens = Math.min(tokens, tierEdge - TIER_EDGE_MARGIN);
	}
	tokens = Math.min(tokens, usable - TIER_EDGE_MARGIN);
	if (tokens < floor) return undefined;
	return { tokens, label: `auto ${fmtTokens(tokens)} (${fmtPct((tokens / window) * 100)})` };
}

function statusText(ctx: ExtensionContext): string {
	const keep = config.keepRecentTokens > 0 ? `~${fmtTokens(config.keepRecentTokens)} recent kept` : "summary only";
	const usage = ctx.getContextUsage();
	let thresholdLabel = config.threshold === "auto" ? "auto" : fmtPct(config.threshold * 100);
	if (usage && usage.tokens !== null) {
		const threshold = resolveThreshold(ctx, usage);
		if (threshold) thresholdLabel = threshold.label;
		else if (config.threshold === "auto") thresholdLabel = "auto (no room at this window)";
	}
	const target = config.threshold === "auto" ? ` · target ${fmtTokens(config.autoTargetTokens)}` : "";
	return `Auto handoff ${handoffEnabled() ? "ON" : "OFF"} · threshold ${thresholdLabel}${target} · ${keep} · mode ${config.mode} · guard ${config.guard} · context ${usageText(ctx)}`;
}

interface FileOps {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

/** Mirror pi's compaction file tracking so the handoff summary carries the same file index. */
function createFileOps(): FileOps {
	return { read: new Set(), written: new Set(), edited: new Set() };
}

function extractFileOpsFromMessage(message: AgentMessage, ops: FileOps): void {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return;
	for (const block of message.content) {
		if (!block || typeof block !== "object" || !("type" in block) || block.type !== "toolCall") continue;
		if (!("name" in block) || !("arguments" in block)) continue;
		const args = block.arguments as { path?: unknown } | undefined;
		if (!args || typeof args.path !== "string") continue;
		if (block.name === "read") ops.read.add(args.path);
		else if (block.name === "write") ops.written.add(args.path);
		else if (block.name === "edit") ops.edited.add(args.path);
	}
}

/** Cumulative across pi-generated compactions, like pi's own compaction. */
function collectFileOps(entries: SessionEntry[]): FileOps {
	const ops = createFileOps();
	for (const entry of entries) {
		if (entry.type === "compaction") {
			const details = entry.fromHook ? undefined : (entry.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined);
			if (details) {
				if (Array.isArray(details.readFiles)) {
					for (const file of details.readFiles) if (typeof file === "string") ops.read.add(file);
				}
				if (Array.isArray(details.modifiedFiles)) {
					for (const file of details.modifiedFiles) if (typeof file === "string") ops.edited.add(file);
				}
			}
			continue;
		}
		for (const message of sessionEntryToContextMessages(entry)) extractFileOpsFromMessage(message, ops);
	}
	return ops;
}

function computeFileLists(ops: FileOps): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...ops.edited, ...ops.written]);
	return {
		readFiles: [...ops.read].filter((file) => !modified.has(file)).sort(),
		modifiedFiles: [...modified].sort(),
	};
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}

/** Roles appendMessage() accepts as raw conversation messages. */
function isReplayableRole(role: string): boolean {
	return role === "user" || role === "assistant" || role === "toolResult" || role === "custom" || role === "bashExecution";
}

/** Replay recent entries verbatim into the replacement session. Never throws. */
function replayEntries(sessionManager: SessionManager, entries: SessionEntry[]): number {
	let appended = 0;
	for (const entry of entries) {
		for (const message of sessionEntryToContextMessages(entry)) {
			if (!isReplayableRole(message.role)) continue;
			try {
				sessionManager.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]);
				appended += 1;
			} catch {
				// A malformed historical message must not abort the handoff.
			}
		}
	}
	return appended;
}

/** Plain text of a message, ignoring tool calls and non-text blocks. */
function messageText(message: AgentMessage): string {
	if (!Array.isArray(message.content)) return "";
	const parts: string[] = [];
	for (const block of message.content) {
		if (!block || typeof block !== "object" || !("type" in block)) continue;
		if (block.type === "text" && "text" in block && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n").trim();
}

/** Phrasings that mark the assistant's last message as awaiting a user decision. */
const PENDING_QUESTION_PATTERNS =
	/would you like|shall i\b|should i\b|do you want|let me know|your call|which (?:one|option|approach|direction|do you)|please (?:confirm|choose|decide)|awaiting your|waiting for your|需要我|要不要|是否需要|是否要|请你(?:确认|选择|决定)|等你(?:确认|回复|决定)/i;

function textAsksQuestion(text: string): boolean {
	// Fenced code must not contribute a stray "?" to the check.
	const clean = text.replace(/```[\s\S]*?```/g, " ");
	const lines = clean.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
	const lastLine = lines.length > 0 ? lines[lines.length - 1] : "";
	const stripped = lastLine.replace(/[*_`~)\]"'）】》]+$/g, "").trimEnd();
	if (stripped.endsWith("?") || stripped.endsWith("？")) return true;
	return PENDING_QUESTION_PATTERNS.test(clean.slice(-400));
}

/**
 * The question the session is waiting on, if its last conversational message is
 * an assistant question. Auto handoff must not answer it on the user's behalf.
 */
function findPendingQuestion(entries: SessionEntry[]): string | undefined {
	let last: { role: string; text: string } | undefined;
	for (const entry of entries) {
		for (const message of sessionEntryToContextMessages(entry)) {
			if (message.role !== "user" && message.role !== "assistant") continue;
			const text = messageText(message);
			if (text.length > 0) last = { role: message.role, text };
		}
	}
	if (!last || last.role !== "assistant") return undefined;
	return textAsksQuestion(last.text) ? last.text : undefined;
}

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
async function generateHandoffSummary(
	ctx: ExtensionContext,
	model: NonNullable<ExtensionContext["model"]>,
	auth: SummaryAuth,
	messages: AgentMessage[],
	previousSummary: string | undefined,
): Promise<string> {
	const primary: NonNullable<ExtensionContext["thinkingLevel"]> = config.summaryThinking === "session"
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
				SUMMARY_FOCUS,
				previousSummary,
				attempt.thinking,
				undefined,
				auth.env,
			);
			return text;
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

/**
 * Summarize the older context and continue in a fresh session.
 * Must run with an ExtensionCommandContext, because newSession() is command-only.
 */
async function runHandoff(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const trigger = args.trim();
	const force = trigger === "force" || trigger === "force-auto";
	// "force-auto" marks the scheduled agent_settled trigger; only it applies the
	// pending-question guard, so /auto-handoff now keeps the configured mode.
	const autoTriggered = trigger === "force-auto";
	try {
		if (!ctx.isIdle()) {
			notify(ctx, "Auto handoff skipped: the agent is busy.", "warning");
			return;
		}
		const model = ctx.model;
		if (!model) {
			notify(ctx, "Auto handoff skipped: no model selected.", "warning");
			return;
		}

		const usage = ctx.getContextUsage();
		let threshold: Threshold | undefined;
		if (!force) {
			if (!handoffEnabled()) return;
			if (!usage || usage.tokens === null || usage.percent === null) return;
			threshold = resolveThreshold(ctx, usage);
			if (!threshold || usage.tokens < threshold.tokens) return;
		}

		const allEntries = buildContextEntries(ctx.sessionManager.getBranch(), ctx.sessionManager.getLeafId());
		if (allEntries.length === 0) return;

		// Older context gets summarized; the recent tail is carried over verbatim.
		let firstKeptIndex = allEntries.length;
		if (config.keepRecentTokens > 0) {
			const cut = findCutPoint(allEntries, 0, allEntries.length, config.keepRecentTokens);
			firstKeptIndex = cut.firstKeptEntryIndex;
			// Keep whole turns so tool calls and their results replay as a pair.
			if (cut.isSplitTurn && cut.turnStartIndex >= 0 && cut.turnStartIndex < firstKeptIndex) {
				firstKeptIndex = cut.turnStartIndex;
			}
		}
		const olderEntries = allEntries.slice(0, firstKeptIndex);
		const keptEntries = allEntries.slice(firstKeptIndex);
		// If the older span starts with a previous compaction, let the summarizer update it
		// instead of feeding the old summary in as ordinary conversation.
		const previousCompaction = [...olderEntries].reverse().find((entry) => entry.type === "compaction");
		const olderMessages = olderEntries
			.filter((entry) => entry.type !== "compaction")
			.flatMap(sessionEntryToContextMessages);
		const keptMessages = keptEntries.flatMap(sessionEntryToContextMessages);

		// Skip when there is nothing real to summarize (e.g. only a previous compaction summary).
		if (!olderMessages.some((message) => message.role === "user" || message.role === "assistant")) return;

		const olderTokens = olderMessages.reduce((sum, message) => sum + estimateTokens(message), 0);
		const keptTokens = keptMessages.reduce((sum, message) => sum + estimateTokens(message), 0);
		// Floor: below this the summary saves too little and drops too much detail.
		if (!force && olderTokens < MIN_SUMMARIZE_TOKENS) return;

		// Pending-question guard: only automatic handoffs consult it, so an explicit
		// /auto-handoff keeps the configured mode. "skip" leaves the session as-is
		// until the user answers; "draft" is applied further below.
		const pendingQuestion = findPendingQuestion(allEntries);
		const guardApplies = autoTriggered && pendingQuestion !== undefined;
		if (guardApplies && config.guard === "skip") {
			cooldownUntil = Date.now() + RETRIGGER_COOLDOWN_MS;
			notify(ctx, "Auto handoff skipped: the session is waiting for your answer (guard=skip).", "warning");
			return;
		}

		notify(ctx, `Auto handoff: summarizing ~${fmtTokens(olderTokens)} of context, keeping ~${fmtTokens(keptTokens)} recent...`, "info");

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			notify(ctx, `Auto handoff skipped: ${auth.error}`, "error");
			return;
		}
		const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;

		const summary = await generateHandoffSummary(ctx, requestModel, auth, olderMessages, previousCompaction?.summary);

		const { readFiles, modifiedFiles } = computeFileLists(collectFileOps(olderEntries));
		const summaryWithIndex = `${summary}${formatFileOperations(readFiles, modifiedFiles)}`;
		const summaryTokens = Math.ceil(summaryWithIndex.length / 4);
		if (!force && usage && usage.tokens !== null && threshold) {
			// Baseline = system prompt, tool schemas, and injected memory/context.
			const baselineNow = Math.max(0, usage.tokens - olderTokens - keptTokens);
			const estimatedAfter = baselineNow + keptTokens + summaryTokens + 1_500;
			if (estimatedAfter >= threshold.tokens) {
				notify(
					ctx,
					`Auto handoff skipped: the fresh session would start at ~${fmtTokens(estimatedAfter)}, too close to the ${threshold.label} threshold to help.`,
					"warning",
				);
				return;
			}
		}

		// "wait" (default) keeps the continuation automatic but hands the open
		// question to the new session with a do-not-answer instruction; "draft"
		// additionally leaves the prompt in the editor for review.
		const guardWaiting = guardApplies && config.guard !== "send";
		const guardDraft = guardWaiting && config.guard === "draft";
		const useDraft = config.mode === "draft" || guardDraft;
		const percentText = usage && usage.percent !== null ? fmtPct(usage.percent) : "over threshold";
		const carryLine = keptTokens > 0
			? "The handoff summary below covers the earlier part of that session; its most recent messages were carried over verbatim."
			: "The handoff summary below is the only context carried from that session.";
		const previousSessionId = ctx.sessionManager.getSessionId();
		const previousSessionFile = ctx.sessionManager.getSessionFile();
		const detailLines = [
			`- Previous session id: ${previousSessionId}`,
			previousSessionFile ? `- Raw transcript (JSONL): ${previousSessionFile}` : undefined,
			"- The project context session index (## Session index) links the Markdown log for that id.",
			"If a needed detail is missing from this summary, look it up there (grep, do not load whole files).",
		].filter((line): line is string => line !== undefined);
		const pendingLines = guardWaiting
			? ["", "## Pending question (waiting for the user)", "", pendingQuestion ?? "", ""]
			: [];
		const closingLine = guardWaiting
			? "The task is paused on the pending question above. Do not choose an option or start work on the user's behalf; wait for their answer."
			: "Continue the task from where it left off.";
		const handoffPrompt = [
			`This session continues work handed off from a previous session (${percentText} of its context window had been used).`,
			carryLine,
			"Verify the current state of files with tools before re-applying changes, and do not redo completed work.",
			...(guardWaiting
				? ["The previous session stopped while waiting for the user's answer, so the decision is still open."]
				: []),
			"",
			"## Handoff Summary",
			"",
			summaryWithIndex,
			"",
			"## Previous session details",
			...detailLines,
			...pendingLines,
			closingLine,
		].join("\n");

		// A new prompt can arrive while the handoff summary is being generated.
		// Replacing the session now would abort that run and leave its user message
		// unanswered (and the TUI stuck on "Working"), so skip and let the next
		// agent_settled retrigger once the session is idle again.
		if (!ctx.isIdle()) {
			cooldownUntil = Date.now() + RETRIGGER_COOLDOWN_MS;
			notify(ctx, "Auto handoff skipped: the agent became busy while summarizing. It will retry when idle.", "warning");
			return;
		}

		const parentSession = ctx.sessionManager.getSessionFile();
		const result = await ctx.newSession({
			parentSession,
			setup: async (sessionManager) => {
				replayEntries(sessionManager, keptEntries);
			},
			withSession: async (replacementCtx) => {
				try {
					if (useDraft) {
						replacementCtx.ui.setEditorText(handoffPrompt);
						notify(
							replacementCtx,
							guardDraft
								? `Auto handoff: fresh session prepared, but left for your review because the previous session was waiting on your answer (${percentText} full). Answer in the prompt, then press Enter.`
								: `Auto handoff: fresh session prepared (previous was ${percentText} full). Review the prompt, then press Enter to continue.`,
							"info",
						);
					} else {
						await replacementCtx.sendUserMessage(handoffPrompt);
						notify(
							replacementCtx,
							guardWaiting
								? `Auto handoff: continued in a fresh session (previous was ${percentText} full); the open question was carried over and the agent will wait for your answer.`
								: `Auto handoff: continued in a fresh session (previous was ${percentText} full, summary ~${fmtTokens(summaryTokens)}, kept ~${fmtTokens(keptTokens)} recent).`,
							"info",
						);
					}
				} catch (error) {
					notify(replacementCtx, `Auto handoff: failed to start the continuation — ${errorText(error)}`, "error");
				}
			},
		});
		if (result.cancelled) {
			notify(ctx, "Auto handoff cancelled by another extension.", "warning");
			return;
		}
		cooldownUntil = Date.now() + RETRIGGER_COOLDOWN_MS;
	} catch (error) {
		failureBackoffUntil = Date.now() + FAILURE_BACKOFF_MS;
		notify(ctx, `Auto handoff failed: ${errorText(error)}. Staying in this session; pi auto-compaction still applies.`, "error");
	} finally {
		inFlight = false;
	}
}

function maybeTrigger(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!handoffEnabled() || inFlight) return;
	if (ctx.mode !== "tui") return;
	if (!ctx.isIdle()) return;
	const now = Date.now();
	if (now < cooldownUntil || now < failureBackoffUntil) return;

	const usage = ctx.getContextUsage();
	if (!usage || usage.tokens === null) return;
	const threshold = resolveThreshold(ctx, usage);
	if (!threshold || usage.tokens < threshold.tokens) return;

	inFlight = true;
	// Defer past agent_settled bookkeeping before the session is replaced.
	setTimeout(() => {
		try {
			// Extension commands execute immediately and get the command context needed for newSession().
			pi.sendUserMessage("/auto-handoff force-auto", { expandPromptTemplates: true });
		} catch (error) {
			inFlight = false;
			notify(ctx, `Auto handoff trigger failed: ${errorText(error)}`, "error");
		}
	}, 0);
}

export function registerHandoff(pi: ExtensionAPI): void {
	pi.registerFlag("handoff-ratio", {
		type: "string",
		description: "Auto handoff threshold: fixed ratio (0.4, 40%), auto, or off",
	});
	pi.registerFlag("no-auto-handoff", {
		type: "boolean",
		default: false,
		description: "Disable automatic fresh-session handoff",
	});

	// Flags are applied after extension load, so read them once the session is up.
	pi.on("session_start", async (_event, ctx) => {
		await syncConfig(await getProjectRoot(pi, ctx.cwd).catch(() => undefined));
		flagEnabled = true;
		const ratioFlag = pi.getFlag("handoff-ratio");
		if (typeof ratioFlag === "string") {
			const flag = ratioFlag.trim().toLowerCase();
			if (flag === "auto") config.threshold = "auto";
			else if (flag === "off") flagEnabled = false;
			else {
				const ratio = parseRatio(flag);
				if (ratio !== undefined) config.threshold = ratio;
			}
		}
		if (pi.getFlag("no-auto-handoff") === true) flagEnabled = false;
	});

	pi.on("agent_settled", (_event, ctx) => {
		maybeTrigger(pi, ctx);
	});

	pi.registerCommand("auto-handoff", {
		description: "Fresh session when context hits the threshold (status|on|off|auto|<ratio>|target|keep|thinking|send|draft|guard|now)",
		handler: async (args, ctx) => {
			if (!configRoot) await syncConfig(await getProjectRoot(pi, ctx.cwd).catch(() => undefined));
			const arg = args.trim().toLowerCase();
			const [head, value] = arg.split(/\s+/);
			if (!head || head === "status") {
				notify(ctx, statusText(ctx));
				return;
			}
			if (head === "keep") {
				if (value === "off") {
					config.keepRecentTokens = 0;
				} else {
					const tokens = parseTokenCount(value ?? "");
					if (tokens === undefined || tokens > MAX_KEEP_RECENT_TOKENS) {
						notify(ctx, "Usage: /auto-handoff keep <tokens|off> (e.g. keep 20k)", "warning");
						return;
					}
					config.keepRecentTokens = tokens;
				}
				await saveConfig();
				notify(
					ctx,
					config.keepRecentTokens > 0
						? `Auto handoff will keep ~${fmtTokens(config.keepRecentTokens)} recent tokens verbatim.`
						: "Auto handoff will use summary only (no recent carry-over).",
				);
				return;
			}
			if (head === "target") {
				const tokens = parseTokenCount(value ?? "");
				if (tokens === undefined || tokens < MIN_SUMMARIZE_TOKENS || tokens > MAX_KEEP_RECENT_TOKENS) {
					notify(ctx, "Usage: /auto-handoff target <tokens> (e.g. target 64k)", "warning");
					return;
				}
				config.autoTargetTokens = tokens;
				await saveConfig();
				notify(ctx, `Auto threshold will summarize ~${fmtTokens(tokens)} per handoff.`);
				return;
			}
			if (head === "thinking") {
				if (value !== "off" && value !== "session") {
					notify(ctx, "Usage: /auto-handoff thinking off|session", "warning");
					return;
				}
				config.summaryThinking = value;
				await saveConfig();
				notify(
					ctx,
					value === "off"
						? "Handoff summaries will run without thinking (faster, avoids the shared token cap)."
						: "Handoff summaries will use the session thinking level (may hit the shared token cap).",
				);
				return;
			}
			if (head === "auto") {
				config.threshold = "auto";
				await saveConfig();
				notify(ctx, statusText(ctx));
				return;
			}
			if (head === "on" || head === "off") {
				if (!configRoot) configRoot = await getProjectRoot(pi, ctx.cwd).catch(() => undefined);
				if (configRoot) await setFeature(configRoot, "handoff", head === "on");
				notify(ctx, head === "on" ? statusText(ctx) : "Auto handoff disabled.");
				return;
			}
			if (head === "send" || head === "draft") {
				config.mode = head;
				await saveConfig();
				notify(ctx, `Auto handoff mode: ${head}.`);
				return;
			}
			if (head === "guard") {
				if (value !== "wait" && value !== "draft" && value !== "send" && value !== "skip") {
					notify(ctx, "Usage: /auto-handoff guard wait|draft|send|skip", "warning");
					return;
				}
				config.guard = value;
				await saveConfig();
				notify(
					ctx,
					value === "wait"
						? "Pending-question guard: automatic handoffs continue, and the agent waits for your answer."
						: value === "draft"
							? "Pending-question guard: automatic handoffs wait for your review in the editor."
							: value === "send"
								? "Pending-question guard: automatic handoffs continue without waiting for your answer."
								: "Pending-question guard: automatic handoffs are skipped until the question is answered.",
				);
				return;
			}
			if (head === "now" || head === "run" || head === "force") {
				await runHandoff("force", ctx);
				return;
			}
			if (head === "force-auto") {
				await runHandoff("force-auto", ctx);
				return;
			}
			const ratio = parseRatio(head);
			if (ratio !== undefined) {
				config.threshold = ratio;
				await saveConfig();
				notify(ctx, `Auto handoff threshold set to ${fmtPct(ratio * 100)} of the window.`);
				return;
			}
			notify(ctx, `Unknown option "${arg}". Usage: /auto-handoff [on|off|auto|<ratio>|target <tokens>|keep <tokens>|thinking off|session|send|draft|guard <wait|draft|send|skip>|now|status]`, "warning");
		},
	});
}
