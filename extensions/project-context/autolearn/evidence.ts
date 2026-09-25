/**
 * The evidence trail: the session index, the archived sessions it names, and the text collected
 * from them under a character budget.
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { type ExtensionContext, convertToLlm, parseSessionEntries, serializeConversation, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { logsDir, readOptional } from "../shared/project-state.ts";

const AUTOLEARN_INSPECT_SESSIONS = 4;

const AUTOLEARN_EVIDENCE_PER_SESSION_CHARS = 8000;

const AUTOLEARN_EVIDENCE_TOTAL_CHARS = 24000;

export const AUTOLEARN_MEMORY_CHARS = 12000;

export const AUTOLEARN_CONTEXT_CHARS = 16000;

export const AUTOLEARN_INDEX_LINES = 40;

export type IndexEntry = { id: string; date: string; title: string };

export type Evidence = { ids: string[]; text: string };

/** User messages seen in this session; feeds the accumulated autolearn turn counter. */
export function countUserTurns(ctx: ExtensionContext): number {
	try {
		return ctx.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user").length;
	} catch {
		return 0;
	}
}

/** Session index lines carried in CONTEXT.md, oldest first. */
export function parseSessionIndex(context: string): IndexEntry[] {
	const entries: IndexEntry[] = [];
	const seen = new Set<string>();
	for (const line of context.split("\n")) {
		const match = /^- \[([^\]]+)\]\(([^)]+)\)\s*[—–-]\s*(\d{4}-\d{2}-\d{2})\s*[—–-]\s*(.*)$/.exec(line.trim());
		if (!match || seen.has(match[1])) continue;
		seen.add(match[1]);
		entries.push({ id: match[1], date: match[3], title: match[4].replace(/\s+/g, " ").trim().slice(0, 140) });
	}
	return entries;
}

/** Session ids that actually have a raw log on disk; used to verify cited evidence. */
export async function archivedSessionIds(projectRoot: string): Promise<Set<string>> {
	const dir = logsDir(projectRoot);
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	const ids = new Set<string>();
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		try {
			await stat(path.join(dir, entry.name, "session.jsonl"));
			ids.add(entry.name);
		} catch {
			// No raw log for this directory; skip it.
		}
	}
	return ids;
}

export function indexedSessions(index: IndexEntry[], archived: Set<string>, limit: number): IndexEntry[] {
	return index.filter((entry) => archived.has(entry.id)).slice(-limit);
}

function truncateMiddle(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const head = Math.floor(limit * 0.3);
	return `${text.slice(0, head)}\n\n[...truncated...]\n\n${text.slice(-(limit - head))}`;
}

async function sessionText(projectRoot: string, id: string): Promise<string | undefined> {
	const raw = await readOptional(path.join(logsDir(projectRoot), id, "session.jsonl"));
	if (!raw) return undefined;
	const messages = parseSessionEntries(raw).flatMap((entry) => sessionEntryToContextMessages(entry));
	if (!messages.some((message) => message.role === "user")) return undefined;
	const text = serializeConversation(convertToLlm(messages)).trim();
	return text || undefined;
}

/** Backtrack: fetch raw excerpts for the sessions the model asked to inspect. */
export async function collectEvidence(projectRoot: string, requested: string[]): Promise<Evidence> {
	const ids: string[] = [];
	const sections: string[] = [];
	let used = 0;
	for (const id of [...new Set(requested)].slice(0, AUTOLEARN_INSPECT_SESSIONS)) {
		if (used >= AUTOLEARN_EVIDENCE_TOTAL_CHARS) break;
		const text = await sessionText(projectRoot, id);
		if (!text) continue;
		const section = `## session ${id}\n${truncateMiddle(text, Math.min(AUTOLEARN_EVIDENCE_PER_SESSION_CHARS, AUTOLEARN_EVIDENCE_TOTAL_CHARS - used))}`;
		sections.push(section);
		ids.push(id);
		used += section.length;
	}
	return { ids, text: sections.join("\n\n") };
}
