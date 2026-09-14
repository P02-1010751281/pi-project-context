import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAX_LIST_ITEM_CHARS, safeSessionId } from "./project-state.ts";

/**
 * Mechanical session index: `<memory>/session-logs/INDEX.md`.
 *
 * One line per archived session, written without any model call — the archive
 * layer owns it. Later passes (autolearn backtracking, handoff pointers) read the
 * index to navigate the raw archive, and the archive backfill shares the same
 * renderer so imported sessions are indistinguishable from live ones.
 */

/** Newest sessions kept; older lines drop off the top on each rewrite. */
const MAX_INDEX_LINES = 200;

function trimLine(value: string, limit = MAX_LIST_ITEM_CHARS): string {
	return value.replace(/\s+/g, " ").trim().slice(0, limit);
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

/** Convert pre-move index links (`session-logs/<id>/session.md`) to the new relative form. */
export function normalizeLegacyIndex(document: string): string {
	return document
		.split("\n")
		.map((line) => line.replace(/\]\(session-logs\//, "]("))
		.join("\n");
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
	return sessionIndexLineFrom(ctx.sessionManager.getSessionId(), ctx.sessionManager.getHeader()?.timestamp, title);
}

/** One index line from raw parts (also used by the archive backfill). */
export function sessionIndexLineFrom(id: string, timestamp: string | undefined, title: string): string {
	const safe = safeSessionId(id);
	return `- [${safe}](${safe}/session.md) — ${(timestamp ?? new Date().toISOString()).slice(0, 10)} — ${trimLine(title, 160)}`;
}

type EntryLike = { type?: unknown; message?: { role?: unknown; content?: unknown } };

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : "")
		.join(" ");
}

/** No-LLM title from a bare entry list: first user message, else a date fallback. */
export function titleFromEntries(entries: readonly EntryLike[], timestamp?: string): string {
	for (const entry of entries) {
		if (entry?.type !== "message" || entry.message?.role !== "user") continue;
		const text = contentText(entry.message.content);
		if (text.trim()) return trimLine(text, 120);
	}
	return `Session ${(timestamp ?? new Date().toISOString()).slice(0, 10)}`;
}

/** No-LLM title for the archive layer: first user message, else the session date. */
export function sessionTitle(ctx: ExtensionContext): string {
	try {
		return titleFromEntries(ctx.sessionManager.getBranch() as readonly EntryLike[], ctx.sessionManager.getHeader()?.timestamp);
	} catch {
		return `Session ${(ctx.sessionManager.getHeader()?.timestamp ?? new Date().toISOString()).slice(0, 10)}`;
	}
}

/** The archive layer's index document; rewritten (deduped, capped) on each settle/shutdown. */
export function renderIndexDocument(existing: string, sessionLine: string): string {
	const lines = dedupeIndexLines(parseIndexLines(existing), sessionLine, MAX_INDEX_LINES);
	return ["# Session Index", "", ...lines, ""].join("\n");
}
