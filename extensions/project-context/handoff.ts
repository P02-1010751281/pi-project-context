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
 *   - adaptive (default): trigger once the context can give up ~handoffTargetTokens
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
 *   /auto-handoff lang auto|zh|en  scaffolding language (default auto = conversation)
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

import { open, readFile, rm } from "node:fs/promises";
import path from "node:path";
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
import { DEFAULT_CONFIG, getConfig, MAX_KEEP_RECENT_TOKENS, MIN_SUMMARIZE_TOKENS, peekConfig, type ProjectContextConfig, runIsDisabled, setFeature, updateConfig } from "./config.ts";
import { resolveAuxModel } from "./llm.ts";
import { ensureMemoryGitignore, getProjectRoot, logError, memoryDir, safeSessionId, writeAtomic } from "./project-state.ts";
/** pi's default compaction reserve; window headroom used by the threshold math. */
const WINDOW_RESERVE_TOKENS = 16_384;
/** Output room for the summary call (0.8 * this is the maxTokens cap). */
const SUMMARY_OUTPUT_RESERVE_TOKENS = 32_768;
const SUMMARY_FOCUS =
	"This summary covers the older part of the previous session; its most recent messages are carried over separately. " +
	"Preserve exact file paths, function names, commands, error messages, and unfinished work. Keep it concise.";

/**
 * pi's summarization prompt demands an EXACT section format, so models keep copying its English
 * headings even when the focus line asks for another language (observed on deepseek-flash). Map the
 * fixed heading set deterministically instead of relying on the model to translate the template.
 */
const SUMMARY_HEADINGS: Record<HandoffLanguage, Record<string, string>> = {
	zh: {
		"## Goal": "## 目标",
		"## Constraints & Preferences": "## 约束与偏好",
		"## Progress": "## 进展",
		"### Done": "### 已完成",
		"### In Progress": "### 进行中",
		"### Blocked": "### 受阻",
		"## Key Decisions": "## 关键决策",
		"## Next Steps": "## 下一步",
		"## Critical Context": "## 关键上下文",
	},
	en: {
		"## 目标": "## Goal",
		"## 约束与偏好": "## Constraints & Preferences",
		"## 进展": "## Progress",
		// Model-side translations observed in real summaries (TUI run, 2026-09-16).
		"## 进度": "## Progress",
		"### 已完成": "### Done",
		"### 进行中": "### In Progress",
		"### 受阻": "### Blocked",
		"### 阻塞": "### Blocked",
		"## 关键决策": "## Key Decisions",
		"## 下一步": "## Next Steps",
		"## 关键上下文": "## Critical Context",
	},
};

/** Localize the headings pi's template prescribes; only exact heading lines outside code fences are touched. */
export function localizeSummaryHeadings(text: string, language: HandoffLanguage): string {
	const headings = SUMMARY_HEADINGS[language];
	let fence: string | undefined;
	return text
		.split("\n")
		.map((line) => {
			const trimmed = line.trim();
			const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
			if (fenceMatch) {
				// Track fenced code blocks so heading-shaped lines inside them stay untouched.
				if (fence === undefined) fence = fenceMatch[1][0];
				else if (trimmed.startsWith(fence)) fence = undefined;
				return line;
			}
			if (fence !== undefined) return line;
			const mapped = headings[trimmed];
			if (!mapped) return line;
			const indent = line.slice(0, line.indexOf(trimmed));
			return `${indent}${mapped}`;
		})
		.join("\n");
}

/** Languages the handoff scaffolding can be rendered in; `auto` resolves from the conversation. */
export type HandoffLanguage = "zh" | "en";

/** CJK ideographs; user messages are the most reliable signal of the conversation language. */
const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
/** CJK characters needed in the user messages before auto-detection picks Chinese. */
const LANGUAGE_CJK_MIN = 2;
/** Latin letters that make a sample set count as substantial English. */
const LANGUAGE_LATIN_MIN = 20;
const LATIN_PATTERN = /[A-Za-z]/g;

function countMatches(samples: string[], pattern: RegExp): number {
	let count = 0;
	for (const sample of samples) count += sample.match(pattern)?.length ?? 0;
	return count;
}

/** `auto` language rule: enough Chinese in the user's own messages means Chinese scaffolding. */
export function detectHandoffLanguage(samples: string[]): HandoffLanguage {
	return countMatches(samples, CJK_PATTERN) >= LANGUAGE_CJK_MIN ? "zh" : "en";
}

/** Language of the newest recognized continuation prompt, if the conversation has one. */
function promptLanguage(messages: AgentMessage[]): HandoffLanguage | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "user") continue;
		const text = messageText(message);
		if (!isHandoffPromptText(text)) continue;
		if (text.startsWith(HANDOFF_PROMPT_PREFIXES[1])) return "zh";
		if (text.startsWith(HANDOFF_PROMPT_PREFIXES[0])) return "en";
	}
	return undefined;
}

/** The summary focus passed to pi's compaction summarizer, in the resolved language. */
function summaryFocus(language: HandoffLanguage): string {
	return language === "zh"
		? `${SUMMARY_FOCUS} Write the whole summary in Simplified Chinese, including the section headings.`
		: `${SUMMARY_FOCUS} Write the whole summary in English, including the section headings.`;
}

/** Localized scaffolding for the continuation prompt and the archived handoff document. */
interface HandoffScaffolding {
	preamble: (percentText: string) => string;
	percentUnknown: string;
	carryKept: string;
	carrySummaryOnly: string;
	verify: string;
	guardWaiting: string;
	summaryHeading: string;
	detailsHeading: string;
	detailSessionId: (sessionId: string) => string;
	detailTranscript: (file: string) => string;
	detailIndex: string;
	detailLookup: string;
	pendingHeading: string;
	closingContinue: string;
	closingPaused: string;
	documentTitle: (sessionId: string) => string;
	documentCreated: (iso: string) => string;
	documentProject: (root: string) => string;
	documentLog: (rel: string) => string;
	documentIndex: string;
}

const SCAFFOLDING: Record<HandoffLanguage, HandoffScaffolding> = {
	en: {
		preamble: (percentText) => `This session continues work handed off from a previous session (${percentText} of its context window had been used).`,
		percentUnknown: "over threshold",
		carryKept: "The handoff summary below covers the earlier part of that session; its most recent messages were carried over verbatim.",
		carrySummaryOnly: "The handoff summary below is the only context carried from that session.",
		verify: "Verify the current state of files with tools before re-applying changes, and do not redo completed work.",
		guardWaiting: "The previous session stopped while waiting for the user's answer, so the decision is still open.",
		summaryHeading: "## Handoff Summary",
		detailsHeading: "## Previous session details",
		detailSessionId: (sessionId) => `- Previous session id: ${sessionId}`,
		detailTranscript: (file) => `- Raw transcript (JSONL): ${file}`,
		detailIndex: "- The project session index (.agents/memory/session-logs/INDEX.md) links the Markdown log for that id.",
		detailLookup: "If a needed detail is missing from this summary, look it up there (grep, do not load whole files).",
		pendingHeading: "## Pending question (waiting for the user)",
		closingContinue: "Continue the task from where it left off.",
		closingPaused: "The task is paused on the pending question above. Do not choose an option or start work on the user's behalf; wait for their answer.",
		documentTitle: (sessionId) => `# Handoff from pi session ${sessionId}`,
		documentCreated: (iso) => `- Created: ${iso}`,
		documentProject: (root) => `- Project: ${root}`,
		documentLog: (rel) => `- Session log: ${rel}`,
		documentIndex: "- Session index: .agents/memory/session-logs/INDEX.md",
	},
	zh: {
		preamble: (percentText) => `本会话接手上一会话（其上下文窗口已用 ${percentText}）。`,
		percentUnknown: "阈值以上",
		carryKept: "下面的交接摘要覆盖上一会话较早的部分；其最近的消息已原文带入本会话。",
		carrySummaryOnly: "上一会话只留下下面的交接摘要，没有原文带入。",
		verify: "动手前先用工具核对文件当前状态，不要重做已完成的工作。",
		guardWaiting: "上一会话停在等你回答的问题上，这个决定仍未决。",
		summaryHeading: "## 交接摘要",
		detailsHeading: "## 上一会话信息",
		detailSessionId: (sessionId) => `- 上一会话 id：${sessionId}`,
		detailTranscript: (file) => `- 原始记录（JSONL）：${file}`,
		detailIndex: "- 项目会话索引 .agents/memory/session-logs/INDEX.md 里有该 id 的 Markdown 日志。",
		detailLookup: "摘要里缺的细节去那里查（用 grep，不要把整个文件读进来）。",
		pendingHeading: "## 待用户回答的问题",
		closingContinue: "从上次中断处继续。",
		closingPaused: "任务停在上面的问题上。不要替用户选选项或开工，等用户回答。",
		documentTitle: (sessionId) => `# pi 会话 ${sessionId} 的交接文档`,
		documentCreated: (iso) => `- 生成时间：${iso}`,
		documentProject: (root) => `- 项目：${root}`,
		documentLog: (rel) => `- 会话日志：${rel}`,
		documentIndex: "- 会话索引：.agents/memory/session-logs/INDEX.md",
	},
};

/** Preamble prefixes of generated continuation prompts (one per scaffolding language). */
const HANDOFF_PROMPT_PREFIXES = [
	"This session continues work handed off from a previous session (",
	"本会话接手上一会话（",
];
/** Section headings that only generated continuation prompts contain. */
const HANDOFF_PROMPT_HEADINGS = ["## Handoff Summary", "## Previous session details", "## 交接摘要", "## 上一会话信息"];
/** Closing lines every generated prompt ends with. */
const HANDOFF_PROMPT_CLOSINGS = [
	SCAFFOLDING.en.closingContinue,
	SCAFFOLDING.en.closingPaused,
	SCAFFOLDING.zh.closingContinue,
	SCAFFOLDING.zh.closingPaused,
];

/**
 * True for a message the handoff itself generated. The preamble, a section heading and the
 * closing line must all match, so a user message quoting the prompt (or quoting it and adding
 * their own text) is not mistaken for one and stays in the carried-over conversation.
 */
export function isHandoffPromptText(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;
	if (!HANDOFF_PROMPT_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return false;
	if (!HANDOFF_PROMPT_HEADINGS.some((heading) => trimmed.includes(heading))) return false;
	return HANDOFF_PROMPT_CLOSINGS.some((closing) => trimmed.endsWith(closing));
}

export interface HandoffPromptParts {
	language: HandoffLanguage;
	percent: number | null;
	keptTokens: number;
	guardWaiting: boolean;
	pendingQuestion?: string;
	summaryWithIndex: string;
	previousSessionId: string;
	previousSessionFile?: string;
}

/** Assemble the user message that opens the replacement session (pure; unit-tested). */
export function buildHandoffPrompt(parts: HandoffPromptParts): string {
	const text = SCAFFOLDING[parts.language];
	const percentText = parts.percent === null ? text.percentUnknown : fmtPct(parts.percent);
	const detailLines = [
		text.detailSessionId(parts.previousSessionId),
		...(parts.previousSessionFile ? [text.detailTranscript(parts.previousSessionFile)] : []),
		text.detailIndex,
		text.detailLookup,
	];
	const pendingLines = parts.guardWaiting ? ["", text.pendingHeading, "", parts.pendingQuestion ?? "", ""] : [];
	return [
		text.preamble(percentText),
		parts.keptTokens > 0 ? text.carryKept : text.carrySummaryOnly,
		text.verify,
		...(parts.guardWaiting ? [text.guardWaiting] : []),
		"",
		text.summaryHeading,
		"",
		parts.summaryWithIndex,
		"",
		text.detailsHeading,
		...detailLines,
		...pendingLines,
		parts.guardWaiting ? text.closingPaused : text.closingContinue,
	].join("\n");
}

/**
 * Stand-in for a dropped continuation prompt. It keeps the replay block's user-first shape (a
 * block that opens with an assistant message is rejected by Anthropic/Gemini routes) and is
 * ignored by language sampling.
 */
export const REPLAY_MARKER = "[handoff prompt omitted]";

/**
 * Stand-in for the summarized prefix of a split turn. The keep-budget cut can land inside a turn,
 * and the replay block must open with a user message for Anthropic/Gemini routes to accept it.
 */
export const SPLIT_TURN_MARKER = "[turn prefix summarized during handoff]";

/**
 * Roles a provider renders as a user message: a replay block may open with one of these.
 * `custom`/`bashExecution` are turn starts that conversation conversion maps to the user role.
 */
const USER_FACING_ROLES = new Set(["user", "custom", "bashExecution"]);

/** Tool-call ids an assistant message issued. */
function toolCallIds(message: AgentMessage): string[] {
	if (!Array.isArray(message.content)) return [];
	const ids: string[] = [];
	for (const block of message.content) {
		if (block && typeof block === "object" && "type" in block && block.type === "toolCall" && "id" in block && typeof block.id === "string") ids.push(block.id);
	}
	return ids;
}

/**
 * Messages carried into the replacement session: stale continuation prompts become
 * {@link REPLAY_MARKER}, and a slice that opens mid-turn gets a {@link SPLIT_TURN_MARKER}
 * stand-in. Replayed verbatim a prompt reads as a fresh instruction and opens the new session
 * with a summary of an already-superseded state; dropping it entirely would let the block start
 * with an assistant message, which some providers reject.
 *
 * Tool results whose call is not part of the slice (a mid-turn cut can separate them) cannot be
 * replayed — providers reject a result without its call. They are handed back through
 * `droppedOrphans` so the caller can fold their content into the summary instead of losing it.
 */
export function replayMessagesFor(entries: SessionEntry[], droppedOrphans?: AgentMessage[]): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (const entry of entries) {
		for (const message of sessionEntryToContextMessages(entry)) {
			if (!isReplayableRole(message.role)) continue;
			messages.push(
				message.role === "user" && isHandoffPromptText(messageText(message))
					? ({ ...message, content: [{ type: "text", text: REPLAY_MARKER }] } as AgentMessage)
					: message,
			);
		}
	}
	const keptCallIds = new Set(messages.flatMap(toolCallIds));
	const replayable: AgentMessage[] = [];
	for (const message of messages) {
		if (message.role !== "toolResult") {
			replayable.push(message);
			continue;
		}
		const toolCallId = (message as { toolCallId?: string }).toolCallId;
		if (typeof toolCallId === "string" && keptCallIds.has(toolCallId)) replayable.push(message);
		else droppedOrphans?.push(message);
	}
	// A mid-turn cut leaves the slice opening on an assistant message, so the summarized prefix is
	// marked with a user-facing stand-in.
	if (replayable[0] && !USER_FACING_ROLES.has(replayable[0].role)) {
		replayable.unshift({ role: "user", content: [{ type: "text", text: SPLIT_TURN_MARKER }], timestamp: replayable[0].timestamp } as AgentMessage);
	}
	return replayable;
}

export interface HandoffDocumentParts {
	language: HandoffLanguage;
	previousSessionId: string;
	projectRoot: string;
	sessionLogRel: string;
	summaryWithIndex: string;
	createdAt?: string;
}

/** The archived `.agents/memory/HANDOFF.md` document (pure; unit-tested). */
export function buildHandoffDocument(parts: HandoffDocumentParts): string {
	const doc = SCAFFOLDING[parts.language];
	return [
		doc.documentTitle(parts.previousSessionId),
		"",
		doc.documentCreated(parts.createdAt ?? new Date().toISOString()),
		doc.documentProject(parts.projectRoot),
		doc.documentLog(parts.sessionLogRel),
		doc.documentIndex,
		"",
		parts.summaryWithIndex.trim(),
		"",
	].join("\n");
}

/**
 * Settings handover across a handoff. `ctx.newSession()` has no model/thinking option, so the
 * replacement session is built from pi's configured defaults; this stages the outgoing session's
 * settings next to the memory so the replacement's `session_start` can restore them. That handler
 * is the only usable point: `setup()` only rewrites messages, `withSession()` gets a context
 * without setters, and the old `pi`/`ctx` are stale once the switch starts.
 */
export const HANDOFF_SETTINGS_FILE = "handoff-session-settings.json";
/** A staged marker only has to survive the switch itself; anything older is a leftover. */
const HANDOFF_SETTINGS_TTL_MS = 10 * 60_000;
/** Session files grow to many MB; the header is the first (small) line. */
const SESSION_HEADER_BYTES = 64 * 1024;
/** Bound for the ancestor walk that flattens the session tree. */
const MAX_PARENT_HOPS = 32;

export interface HandoffSessionSettings {
	previousSessionFile: string;
	model?: { provider: string; id: string };
	thinkingLevel?: string;
	at: number;
}

/** The staged-settings path inside a project's memory directory. */
export function handoffSettingsFile(projectRoot: string): string {
	return path.join(memoryDir(projectRoot), HANDOFF_SETTINGS_FILE);
}

export async function stageHandoffSessionSettings(projectRoot: string, settings: HandoffSessionSettings): Promise<void> {
	const file = handoffSettingsFile(projectRoot);
	// Transient, private (it carries an absolute session path): keep it out of the user's commits.
	await ensureMemoryGitignore(path.dirname(file));
	await writeAtomic(file, `${JSON.stringify(settings)}\n`);
}

export async function clearHandoffSessionSettings(projectRoot: string): Promise<void> {
	await rm(handoffSettingsFile(projectRoot), { force: true }).catch(() => {});
}

/** Read the staged settings; a missing, torn, or foreign file reads as "nothing staged". */
export async function readHandoffSessionSettings(projectRoot: string): Promise<HandoffSessionSettings | undefined> {
	try {
		const parsed = JSON.parse(await readFile(handoffSettingsFile(projectRoot), "utf8")) as Partial<HandoffSessionSettings>;
		if (typeof parsed?.previousSessionFile !== "string" || typeof parsed.at !== "number") return undefined;
		const model = parsed.model;
		return {
			previousSessionFile: parsed.previousSessionFile,
			model: model && typeof model.provider === "string" && typeof model.id === "string" ? { provider: model.provider, id: model.id } : undefined,
			thinkingLevel: typeof parsed.thinkingLevel === "string" && parsed.thinkingLevel ? parsed.thinkingLevel : undefined,
			at: parsed.at,
		};
	} catch {
		return undefined;
	}
}

/**
 * Restore the settings staged by the session we handed off from. Runs from the extension's
 * `session_start` handler: pi has already replayed the carried messages by then and the
 * continuation prompt (`withSession`) has not been sent yet, so the first turn uses them.
 * Anything already equal to the replacement session's own settings is left untouched.
 */
export async function restoreHandoffSessionSettings(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	event: { reason?: string; previousSessionFile?: string },
): Promise<void> {
	// Cheap guard first: only a handoff successor can have staged settings, and resolving the
	// project root shells out to git (cached per cwd, but still avoidable on every session start).
	if (event.reason !== "new" || !event.previousSessionFile) return;
	const projectRoot = await getProjectRoot(pi, ctx.cwd).catch(() => undefined);
	if (!projectRoot) return;
	const staged = await readHandoffSessionSettings(projectRoot);
	if (!staged) return;
	if (Date.now() - staged.at > HANDOFF_SETTINGS_TTL_MS) {
		await clearHandoffSessionSettings(projectRoot);
		return;
	}
	// Only the session that replaced the staged one may consume it: `/new`, `resume`, and `fork`
	// carry a different predecessor (or none), and a cancelled switch leaves the marker for the TTL.
	if (event.previousSessionFile !== staged.previousSessionFile) return;
	await clearHandoffSessionSettings(projectRoot);

	const wanted = staged.model;
	const sameModel = wanted !== undefined && ctx.model?.provider === wanted.provider && ctx.model?.id === wanted.id;
	if (wanted && !sameModel) {
		let model: ReturnType<ExtensionContext["modelRegistry"]["find"]> | undefined;
		try {
			model = ctx.modelRegistry.find(wanted.provider, wanted.id);
		} catch {
			model = undefined;
		}
		if (!model) {
			notify(ctx, `Auto handoff: ${wanted.provider}/${wanted.id} is not available; staying on the default model.`, "warning");
		} else {
			let failure: unknown;
			let applied = false;
			try {
				applied = await pi.setModel(model);
			} catch (error) {
				failure = error;
			}
			if (failure) {
				notify(ctx, `Auto handoff: could not switch to ${wanted.provider}/${wanted.id} (${errorText(failure)}); staying on the default model.`, "warning");
				await logError(projectRoot, "handoff:restore-model", failure).catch(() => {});
			} else if (!applied) {
				notify(ctx, `Auto handoff: no authentication for ${wanted.provider}/${wanted.id}; staying on the default model.`, "warning");
			}
		}
	}
	if (staged.thinkingLevel) {
		let current: string | undefined;
		try {
			current = pi.getThinkingLevel();
		} catch {
			current = undefined;
		}
		if (staged.thinkingLevel !== current) {
			try {
				pi.setThinkingLevel(staged.thinkingLevel as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
			} catch (error) {
				// A level this model cannot express is dropped rather than breaking session start.
				await logError(projectRoot, "handoff:restore-thinking", error).catch(() => {});
			}
		}
	}
}

/**
 * pi's session selector renders the `parentSession` chain as a tree, so chaining every handoff to
 * its immediate predecessor adds a level per handoff. Point the replacement at the oldest existing
 * ancestor instead: the lineage stays in place, the tree stays two levels deep. A missing or
 * unreadable ancestor falls back to the session we are handing off from (the old behaviour).
 */
export async function resolveHandoffParentSession(sessionFile: string | undefined): Promise<string | undefined> {
	if (!sessionFile) return sessionFile;
	let current = sessionFile;
	let root = sessionFile;
	const seen = new Set<string>([current]);
	for (let hop = 0; hop < MAX_PARENT_HOPS; hop++) {
		const header = await readSessionHeader(current);
		if (!header) break;
		root = current;
		const parent = header.parentSession;
		if (!parent || parent === current || seen.has(parent)) break;
		seen.add(parent);
		current = parent;
	}
	return root;
}

/** Session header of a session file; anything unreadable reads as "no header". */
async function readSessionHeader(file: string): Promise<{ parentSession?: string } | undefined> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(file, "r");
		const buffer = Buffer.alloc(SESSION_HEADER_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const line = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
		const parsed = JSON.parse(line) as { type?: unknown; parentSession?: unknown };
		if (parsed?.type !== "session") return undefined;
		return typeof parsed.parentSession === "string" && parsed.parentSession ? { parentSession: parsed.parentSession } : {};
	} catch {
		return undefined;
	} finally {
		await handle?.close().catch(() => {});
	}
}

/** Stay this far below a cost tier edge so streaming growth cannot cross it. */
const TIER_EDGE_MARGIN = 4_000;
const SUMMARY_TIMEOUT_MS = 180_000;
const FAILURE_BACKOFF_MS = 5 * 60_000;
const RETRIGGER_COOLDOWN_MS = 30_000;

let config: ProjectContextConfig = { ...DEFAULT_CONFIG };
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
	return !runIsDisabled() && flagEnabled && (peekConfig(configRoot)?.handoffEnabled ?? false);
}

/** Load the project's configuration into the local working copy. */
async function syncConfig(root: string | undefined): Promise<void> {
	configRoot = root;
	if (!root) return;
	config = await getConfig(root);
}

async function saveConfig(): Promise<void> {
	if (!configRoot) return;
	try {
		await updateConfig(configRoot, config);
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
	return ratio >= 0.1 && ratio <= 0.95 ? ratio : undefined;
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
 * - adaptive: give up ~handoffTargetTokens per handoff, bounded by half the usable
 *   window and by the first cost tier so a surcharge is not crossed.
 */
function resolveThreshold(ctx: ExtensionContext, usage: ContextUsage): Threshold | undefined {
	const window = usage.contextWindow;
	if (window <= 0) return undefined;
	if (!config.handoffAdaptive) {
		const tokens = Math.min(Math.round(config.handoffThresholdRatio * window), window - TIER_EDGE_MARGIN);
		return tokens > 0 ? { tokens, label: `${fmtPct(config.handoffThresholdRatio * 100)} of window` } : undefined;
	}
	const model = ctx.model;
	if (!model || usage.tokens === null) return undefined;

	const baseline = baselineTokens(ctx, usage);
	const keep = config.handoffKeepTokens;
	const floor = baseline + keep + MIN_SUMMARIZE_TOKENS;
	const usable = window - WINDOW_RESERVE_TOKENS;
	if (usable <= floor) return undefined; // window too small for this configuration

	const conversationRoom = usable - baseline - keep;
	const targetOlder = Math.max(
		MIN_SUMMARIZE_TOKENS,
		Math.min(config.handoffTargetTokens, Math.floor(conversationRoom / 2)),
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

/** Recent user messages decide `auto`; the whole session is the fallback when they are too short. */
const LANGUAGE_SAMPLE_MESSAGES = 8;
const LANGUAGE_SAMPLE_MIN_CHARS = 40;

/** User texts for the `auto` decision: injected prompts excluded, recent messages preferred. */
function languageSamples(messages: AgentMessage[]): string[] {
	const texts = messages
		.filter((message) => message.role === "user")
		.map(messageText)
		.filter((text) => text.length > 0 && text !== REPLAY_MARKER && !isHandoffPromptText(text));
	if (texts.length === 0) return [];
	const recent = texts.slice(-LANGUAGE_SAMPLE_MESSAGES);
	return recent.join("").length >= LANGUAGE_SAMPLE_MIN_CHARS ? recent : texts;
}

/**
 * Messages the `auto` language decision samples: the older part plus the raw carried slice —
 * prompts included, because `languageSamples` filters them itself and `promptLanguage` needs the
 * one sitting on the cut point. Exported so tests pin this wiring (a marker-substituted slice
 * would hide it).
 */
export function languageMessagesFor(olderMessages: AgentMessage[], carriedMessages: AgentMessage[]): AgentMessage[] {
	return [...olderMessages, ...carriedMessages];
}

/** Resolve the scaffolding language: explicit config wins, `auto` follows the user's own messages. */
export function resolveLanguage(messages: AgentMessage[], configured: ProjectContextConfig["handoffLanguage"]): HandoffLanguage {
	if (configured !== "auto") return configured;
	const samples = languageSamples(messages);
	if (detectHandoffLanguage(samples) === "zh") return "zh";
	// Substantive English wins; short replies ("ok", "1+2+3") carry the previous continuation
	// prompt's language forward so they cannot flip a Chinese session back to English.
	if (countMatches(samples, LATIN_PATTERN) >= LANGUAGE_LATIN_MIN) return "en";
	return promptLanguage(messages) ?? "en";
}

function statusText(ctx: ExtensionContext): string {
	const keep = config.handoffKeepTokens > 0 ? `~${fmtTokens(config.handoffKeepTokens)} recent kept` : "summary only";
	const usage = ctx.getContextUsage();
	let thresholdLabel = config.handoffAdaptive ? "auto" : fmtPct(config.handoffThresholdRatio * 100);
	if (usage && usage.tokens !== null) {
		const threshold = resolveThreshold(ctx, usage);
		if (threshold) thresholdLabel = threshold.label;
		else if (config.handoffAdaptive) thresholdLabel = "auto (no room at this window)";
	}
	const target = config.handoffAdaptive ? ` · target ${fmtTokens(config.handoffTargetTokens)}` : "";
	const language = config.handoffLanguage === "auto"
		? `auto (${resolveLanguage(buildContextEntries(ctx.sessionManager.getBranch(), ctx.sessionManager.getLeafId()).flatMap(sessionEntryToContextMessages), config.handoffLanguage)})`
		: config.handoffLanguage;
	return `Auto handoff ${handoffEnabled() ? "ON" : "OFF"} · threshold ${thresholdLabel}${target} · ${keep} · mode ${config.handoffMode} · guard ${config.handoffGuard} · lang ${language} · context ${usageText(ctx)}`;
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

/** Replay the carried-over messages verbatim (stale prompts replaced by a marker). Never throws. */
function replayEntries(sessionManager: SessionManager, entries: SessionEntry[]): number {
	let appended = 0;
	for (const message of replayMessagesFor(entries)) {
		try {
			sessionManager.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]);
			appended += 1;
		} catch {
			// A malformed historical message must not abort the handoff.
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

/**
 * Summarize the older context and continue in a fresh session.
 * Must run with an ExtensionCommandContext, because newSession() is command-only.
 */
async function runHandoff(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
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
		// The summary may run on the configured auxiliary route; the threshold math above
		// still uses the session model's window and pricing tier.
		const model = resolveAuxModel(ctx, config);
		if (!model) {
			notify(ctx, "Auto handoff skipped: no authenticated model available.", "warning");
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
		if (allEntries.length === 0) {
			notify(ctx, "Auto handoff skipped: this session has no messages yet.", "warning");
			return;
		}

		// Older context gets summarized; the recent tail is carried over verbatim.
		let firstKeptIndex = allEntries.length;
		if (config.handoffKeepTokens > 0) {
			// Cut where the keep budget runs out, mid-turn included: pi cuts at conversation
			// boundaries and never at a tool result, so the replay stays parseable — a result whose call
			// was summarized is folded into the summary, and a slice opening on an assistant message is
			// marked by SPLIT_TURN_MARKER. Backing the cut up to the turn start instead (the old
			// behavior) kept the whole turn, which left nothing older to summarize whenever one turn
			// exceeded the keep window and blocked the handoff entirely.
			const cut = findCutPoint(allEntries, 0, allEntries.length, config.handoffKeepTokens);
			firstKeptIndex = cut.firstKeptEntryIndex;
		}
		// Stale continuation prompts are replaced by a marker on replay: verbatim they read as a
		// fresh instruction and open the new session with an already-superseded state.
		const keptSlice = allEntries.slice(firstKeptIndex);
		const olderEntries = allEntries.slice(0, firstKeptIndex);
		// If the older span starts with a previous compaction, let the summarizer update it
		// instead of feeding the old summary in as ordinary conversation.
		const previousCompaction = [...olderEntries].reverse().find((entry) => entry.type === "compaction");
		// Language sampling sees the raw slice (prompts included; `languageSamples` filters them
		// itself), while the replay and its token budget use the marker-substituted messages.
		const carriedMessages = keptSlice.flatMap(sessionEntryToContextMessages);
		// A result whose call was summarized cannot be replayed; the summary takes it over so the
		// content is not lost. It stays in the raw carried slice for accounting (usage held it), while
		// `olderTokens` counts the prefix only, so the subtraction below never double-counts it.
		const droppedOrphans: AgentMessage[] = [];
		const keptMessages = replayMessagesFor(keptSlice, droppedOrphans);
		const olderPrefixMessages = olderEntries.filter((entry) => entry.type !== "compaction").flatMap(sessionEntryToContextMessages);
		const olderMessages = [...olderPrefixMessages, ...droppedOrphans];

		// Skip when there is nothing real to summarize (e.g. only a previous compaction summary,
		// or a session that already fits the keep window). The command path is
		// user-initiated, so say why instead of returning silently.
		if (!olderMessages.some((message) => message.role === "user" || message.role === "assistant")) {
			// Auto can land here on every settle while the session fits the keep window; back off
			// so the warning does not repeat with each turn.
			if (autoTriggered) cooldownUntil = Date.now() + RETRIGGER_COOLDOWN_MS;
			notify(ctx, "Auto handoff skipped: nothing older than the recent window to summarize.", "warning");
			return;
		}

		const olderTokens = olderPrefixMessages.reduce((sum, message) => sum + estimateTokens(message), 0);
		const sliceTokens = carriedMessages.reduce((sum, message) => sum + estimateTokens(message), 0);
		const keptTokens = keptMessages.reduce((sum, message) => sum + estimateTokens(message), 0);
		// Floor: below this the summary saves too little and drops too much detail.
		if (!force && olderTokens < MIN_SUMMARIZE_TOKENS) return;

		// Pending-question guard: only automatic handoffs consult it, so an explicit
		// /auto-handoff keeps the configured mode. "skip" leaves the session as-is
		// until the user answers; "draft" is applied further below.
		const pendingQuestion = findPendingQuestion(allEntries);
		const guardApplies = autoTriggered && pendingQuestion !== undefined;
		if (guardApplies && config.handoffGuard === "skip") {
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

		const language = resolveLanguage(languageMessagesFor(olderMessages, carriedMessages), config.handoffLanguage);
		const summary = await generateHandoffSummary(ctx, requestModel, auth, olderMessages, previousCompaction?.summary, language);

		const { readFiles, modifiedFiles } = computeFileLists(collectFileOps(olderEntries));
		const summaryWithIndex = `${summary}${formatFileOperations(readFiles, modifiedFiles)}`;
		const summaryTokens = Math.ceil(summaryWithIndex.length / 4);
		if (!force && usage && usage.tokens !== null && threshold) {
			// Baseline = system prompt, tool schemas, and injected memory/context. The stale prompts
			// replaced by markers are still part of the measured usage, so subtract the raw slice.
			const baselineNow = Math.max(0, usage.tokens - olderTokens - sliceTokens);
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
		const guardWaiting = guardApplies && config.handoffGuard !== "send";
		const guardDraft = guardWaiting && config.handoffGuard === "draft";
		const useDraft = config.handoffMode === "draft" || guardDraft;
		const percentText = usage && usage.percent !== null ? fmtPct(usage.percent) : "over threshold";
		const previousSessionId = ctx.sessionManager.getSessionId();
		const previousSessionFile = ctx.sessionManager.getSessionFile();
		const handoffPrompt = buildHandoffPrompt({
			language,
			percent: usage && usage.percent !== null ? usage.percent : null,
			keptTokens,
			guardWaiting,
			pendingQuestion,
			summaryWithIndex,
			previousSessionId,
			previousSessionFile: previousSessionFile || undefined,
		});

		// A new prompt can arrive while the handoff summary is being generated.
		// Replacing the session now would abort that run and leave its user message
		// unanswered (and the TUI stuck on "Working"), so skip and let the next
		// agent_settled retrigger once the session is idle again.
		if (!ctx.isIdle()) {
			cooldownUntil = Date.now() + RETRIGGER_COOLDOWN_MS;
			notify(ctx, "Auto handoff skipped: the agent became busy while summarizing. It will retry when idle.", "warning");
			return;
		}

		// Archive the handoff document next to the project memory (the fresh session
		// carries a copy, but the file keeps it reachable after the fact).
		const handoffRoot = await getProjectRoot(pi, ctx.cwd).catch(() => undefined);
		if (handoffRoot) {
			try {
				const logRel = path.posix.join(".agents/memory/session-logs", safeSessionId(previousSessionId), "session.md");
				const document = buildHandoffDocument({
					language,
					previousSessionId,
					projectRoot: handoffRoot,
					sessionLogRel: logRel,
					summaryWithIndex,
				});
				await writeAtomic(path.join(memoryDir(handoffRoot), "HANDOFF.md"), document);
			} catch {
				// Persisting the handoff document must never block the session switch.
			}
		}

		const parentSession = ctx.sessionManager.getSessionFile();
		const handoffParent = await resolveHandoffParentSession(parentSession);
		if (handoffRoot && parentSession) {
			// `newSession` resolves the replacement's model/thinking from pi's defaults; stage ours
			// so its `session_start` can restore them before the continuation prompt is sent.
			let thinkingLevel = ctx.thinkingLevel;
			if (thinkingLevel === undefined) {
				try {
					thinkingLevel = pi.getThinkingLevel();
				} catch {
					// Modes without a session thinking level simply restore the model.
				}
			}
			await stageHandoffSessionSettings(handoffRoot, {
				previousSessionFile: parentSession,
				model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
				thinkingLevel,
				at: Date.now(),
			}).catch((error: unknown) => logError(handoffRoot, "handoff:stage-session-settings", error));
		}
		const result = await ctx
			.newSession({
				parentSession: handoffParent,
				setup: async (sessionManager) => {
					replayEntries(sessionManager, keptSlice);
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
			})
			.catch(async (error: unknown) => {
				// A switch that threw never created a replacement, so its stage must not outlive it.
				if (handoffRoot) await clearHandoffSessionSettings(handoffRoot).catch(() => {});
				throw error;
			});
		if (result.cancelled) {
			if (handoffRoot) await clearHandoffSessionSettings(handoffRoot).catch(() => {});
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
			if (flag === "auto") config.handoffAdaptive = true;
			else if (flag === "off") flagEnabled = false;
			else {
				const ratio = parseRatio(flag);
				if (ratio !== undefined) {
					config.handoffAdaptive = false;
					config.handoffThresholdRatio = ratio;
				}
			}
		}
		if (pi.getFlag("no-auto-handoff") === true) flagEnabled = false;
	});

	pi.on("agent_settled", (_event, ctx) => {
		maybeTrigger(pi, ctx);
	});

	pi.registerCommand("auto-handoff", {
		description: "Fresh session when context hits the threshold (status|on|off|auto|<ratio>|target|keep|thinking|send|draft|guard|lang|now)",
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
					config.handoffKeepTokens = 0;
				} else {
					const tokens = parseTokenCount(value ?? "");
					if (tokens === undefined || tokens > MAX_KEEP_RECENT_TOKENS) {
						notify(ctx, "Usage: /auto-handoff keep <tokens|off> (e.g. keep 20k)", "warning");
						return;
					}
					config.handoffKeepTokens = tokens;
				}
				await saveConfig();
				notify(
					ctx,
					config.handoffKeepTokens > 0
						? `Auto handoff will keep ~${fmtTokens(config.handoffKeepTokens)} recent tokens verbatim.`
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
				config.handoffTargetTokens = tokens;
				await saveConfig();
				notify(ctx, `Auto threshold will summarize ~${fmtTokens(tokens)} per handoff.`);
				return;
			}
			if (head === "thinking") {
				if (value !== "off" && value !== "session") {
					notify(ctx, "Usage: /auto-handoff thinking off|session", "warning");
					return;
				}
				config.handoffSummaryThinking = value;
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
				config.handoffAdaptive = true;
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
				config.handoffMode = head;
				await saveConfig();
				notify(ctx, `Auto handoff mode: ${head}.`);
				return;
			}
			if (head === "guard") {
				if (value !== "wait" && value !== "draft" && value !== "send" && value !== "skip") {
					notify(ctx, "Usage: /auto-handoff guard wait|draft|send|skip", "warning");
					return;
				}
				config.handoffGuard = value;
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
			if (head === "lang" || head === "language") {
				if (value !== "auto" && value !== "zh" && value !== "en") {
					notify(ctx, "Usage: /auto-handoff lang auto|zh|en", "warning");
					return;
				}
				config.handoffLanguage = value;
				await saveConfig();
				notify(
					ctx,
					value === "auto"
						? "Handoff scaffolding language: auto (follows the conversation)."
						: `Handoff scaffolding language: ${value}.`,
				);
				return;
			}
			if (head === "now" || head === "run" || head === "force") {
				await runHandoff(pi, "force", ctx);
				return;
			}
			if (head === "force-auto") {
				await runHandoff(pi, "force-auto", ctx);
				return;
			}
			const ratio = parseRatio(head);
			if (ratio !== undefined) {
				config.handoffAdaptive = false;
				config.handoffThresholdRatio = ratio;
				await saveConfig();
				notify(ctx, `Auto handoff threshold set to ${fmtPct(ratio * 100)} of the window.`);
				return;
			}
			notify(ctx, `Unknown option "${arg}". Usage: /auto-handoff [on|off|auto|<ratio>|target <tokens>|keep <tokens>|thinking off|session|send|draft|guard <wait|draft|send|skip>|lang <auto|zh|en>|now|status]`, "warning");
		},
	});
}
