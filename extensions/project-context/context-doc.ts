import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ContextUpdate } from "./consolidate.ts";
import { MAX_CONTEXT_CHARS, MAX_LIST_ITEM_CHARS, MAX_SUMMARY_CHARS, safeSessionId } from "./project-state.ts";

/**
 * Rendering for the session index and CONTEXT.md.
 *
 * The index is produced by the archive layer (`session-context`, no LLM) and stored in
 * `session-index.md`; the consolidation pass (`memory`) embeds it into CONTEXT.md, which
 * `session-context` injects read-only. Durable facts belong in MEMORY.md; CONTEXT.md is
 * working state and pointers.
 */

const MAX_INDEX_LINES = 200;

function trimLine(value: string, limit = MAX_LIST_ITEM_CHARS): string {
	return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

function listMarkdown(items: string[]): string {
	if (items.length === 0) return "- None recorded";
	return items.map((item) => `- ${trimLine(item)}`).join("\n");
}

/** Index lines (`- [id](path) — date — title`) from a document. */
export function parseIndexLines(document: string): string[] {
	return document
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("- ["));
}

function lineId(line: string): string {
	return /^- \[([^\]]+)\]/.exec(line)?.[1] ?? line;
}

/** Newest line per session id, oldest first, capped; `sessionLine` replaces its id's line. */
function dedupeIndexLines(lines: string[], sessionLine: string | undefined, limit: number): string[] {
	const replaceId = sessionLine ? lineId(sessionLine) : undefined;
	const seen = new Set<string>();
	const result: string[] = [];
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const id = lineId(lines[index]);
		if (id === replaceId || seen.has(id)) continue;
		seen.add(id);
		result.unshift(lines[index]);
	}
	if (sessionLine) result.push(sessionLine);
	return result.slice(-limit);
}

export function sessionIndexLine(ctx: ExtensionContext, title: string): string {
	const id = safeSessionId(ctx.sessionManager.getSessionId());
	const relativeLog = path.posix.join("session-logs", id, "session.md");
	const timestamp = ctx.sessionManager.getHeader()?.timestamp ?? new Date().toISOString();
	return `- [${id}](${relativeLog}) — ${timestamp.slice(0, 10)} — ${trimLine(title, 160)}`;
}

/** No-LLM title for the archive layer: first user message, else the session date. */
export function sessionTitle(ctx: ExtensionContext): string {
	try {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "user") continue;
			const content = entry.message.content;
			const text = typeof content === "string"
				? content
				: content.map((part) => (part.type === "text" ? (part as { text?: string }).text ?? "" : "")).join(" ");
			if (text.trim()) return trimLine(text, 120);
		}
	} catch {
		// Fall through to the date fallback.
	}
	const timestamp = ctx.sessionManager.getHeader()?.timestamp ?? new Date().toISOString();
	return `Session ${timestamp.slice(0, 10)}`;
}

/** The archive layer's index document; rewritten (deduped, capped) on each settle/shutdown. */
export function renderIndexDocument(existing: string, sessionLine: string): string {
	const lines = dedupeIndexLines(parseIndexLines(existing), sessionLine, MAX_INDEX_LINES);
	return ["# Session Index", "", ...lines, ""].join("\n");
}

export function renderContextDocument(
	existing: string,
	update: ContextUpdate,
	options: { indexLines?: string[]; sessionLine: string; updatedAt: string },
): string {
	const source = options.indexLines && options.indexLines.length > 0 ? options.indexLines : parseIndexLines(existing);
	const indexLines = dedupeIndexLines(source, options.sessionLine, MAX_INDEX_LINES);
	const title = trimLine(update.title, 160) || "Untitled session";
	const build = (lines: string[]): string => [
		"# Project Context",
		"",
		`Last updated: ${options.updatedAt}`,
		"",
		"## Summary",
		"",
		trimLine(update.summary, MAX_SUMMARY_CHARS) || "No summary recorded yet.",
		"",
		"## Key points",
		"",
		listMarkdown(update.key_points),
		"",
		"## Open tasks",
		"",
		listMarkdown(update.open_tasks),
		"",
		"## Session index",
		"",
		...lines,
		"",
		`<!-- latest-session-title: ${title} -->`,
		"",
	].join("\n");

	// Drop the oldest index lines first: a plain slice() would cut the newest entries.
	let kept = indexLines;
	let document = build(kept);
	while (document.length > MAX_CONTEXT_CHARS && kept.length > 0) {
		kept = kept.slice(1);
		document = build(kept);
	}
	return document.length > MAX_CONTEXT_CHARS ? document.slice(0, MAX_CONTEXT_CHARS) : document;
}

export function fallbackUpdate(ctx: ExtensionContext): ContextUpdate {
	const firstUser = ctx.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user");
	const text = firstUser?.type === "message" ? JSON.stringify(firstUser.message.content) : "Session recorded without a model summary.";
	return {
		title: "Session recorded",
		summary: trimLine(text, MAX_SUMMARY_CHARS),
		key_points: [],
		open_tasks: [],
	};
}
