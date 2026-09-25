import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { renderIndexDocument, sessionIndexLineFrom, titleFromEntries } from "./session-index.ts";
import { errorText, logsDir, pathExists, readOptional, safeSessionId, sessionIndexFile, writeAtomic } from "../shared/project-state.ts";
import { renderSessionMarkdown } from "./session-log.ts";

/**
 * Backfill ended pi sessions into the project archive (the ①補 path): a pi session
 * JSONL file (as written by the harness under `~/.pi/agent/sessions/…`) is copied
 * byte-for-byte into `<memory>/session-logs/<id>/session.jsonl`, rendered to
 * `session.md` with the same renderer the live path uses, and added to the
 * mechanical `INDEX.md`. No model calls; already-archived sessions are skipped
 * unless `replace` is set.
 */

export type ImportStatus = "created" | "skipped" | "failed";

export interface ImportOutcome {
	source: string;
	id?: string;
	status: ImportStatus;
	error?: string;
}

interface ParsedSession {
	id: string;
	timestamp?: string;
	entries: Array<{ type?: unknown; timestamp?: unknown }>;
	raw: string;
}

function parseSessionFile(raw: string): ParsedSession | undefined {
	const lines = raw.split("\n").filter((line) => line.trim().length > 0);
	if (lines.length === 0) return undefined;
	let header: Record<string, unknown> | undefined;
	try {
		const parsed: unknown = JSON.parse(lines[0]);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as { type?: unknown }).type === "session") {
			header = parsed as Record<string, unknown>;
		}
	} catch {
		// Not a session header; the file is not a pi export.
	}
	if (!header || typeof header.id !== "string") return undefined;

	const entries: Array<{ type?: unknown; timestamp?: unknown }> = [];
	for (const line of lines.slice(1)) {
		try {
			const parsed: unknown = JSON.parse(line);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) entries.push(parsed as { type?: unknown; timestamp?: unknown });
		} catch {
			// Skip a malformed line rather than failing the whole import.
		}
	}
	return {
		id: header.id,
		timestamp: typeof header.timestamp === "string" ? header.timestamp : undefined,
		entries,
		raw: raw.endsWith("\n") ? raw : `${raw}\n`,
	};
}

/** Expand `/session-log import` arguments: directories contribute their `*.jsonl` entries. */
export async function resolveImportTargets(args: string, cwd: string): Promise<string[]> {
	const files: string[] = [];
	for (const token of args.split(/\s+/).filter(Boolean)) {
		const target = path.resolve(cwd, token);
		let info;
		try {
			info = await stat(target);
		} catch {
			continue;
		}
		if (info.isDirectory()) {
			const entries = await readdir(target).catch(() => []);
			for (const entry of entries) {
				if (/\.jsonl$/i.test(entry)) files.push(path.join(target, entry));
			}
		} else {
			files.push(target);
		}
	}
	return files.sort();
}

/**
 * Import one pi session JSONL into the archive. Idempotent: an existing session
 * directory is skipped unless `replace` is set.
 */
export async function importSessionFile(
	file: string,
	options: { projectRoot: string; replace?: boolean; markdown?: boolean },
): Promise<ImportOutcome> {
	try {
		const raw = await readOptional(file);
		const parsed = parseSessionFile(raw);
		if (!parsed) return { source: file, status: "failed", error: "not a pi session JSONL (no session header)" };

		const id = safeSessionId(parsed.id);
		const dir = path.join(logsDir(options.projectRoot), id);
		if (!options.replace && await pathExists(path.join(dir, "session.jsonl"))) {
			return { source: file, id, status: "skipped" };
		}

		await writeAtomic(path.join(dir, "session.jsonl"), parsed.raw);
		if (options.markdown ?? true) {
			await writeAtomic(path.join(dir, "session.md"), renderSessionMarkdown(id, parsed.timestamp === undefined ? undefined : { timestamp: parsed.timestamp }, parsed.entries, parsed.raw));
		}

		// Refresh the mechanical index (one line per session, idempotent).
		const existing = await readOptional(sessionIndexFile(options.projectRoot));
		const line = sessionIndexLineFrom(id, parsed.timestamp, titleFromEntries(parsed.entries, parsed.timestamp));
		await writeAtomic(sessionIndexFile(options.projectRoot), renderIndexDocument(existing, line));
		return { source: file, id, status: "created" };
	} catch (error) {
		return { source: file, status: "failed", error: errorText(error) };
	}
}

/** Import a list of files/directories, reporting one outcome per file. */
export async function importArchiveFiles(
	files: readonly string[],
	options: { projectRoot: string; replace?: boolean; markdown?: boolean },
): Promise<ImportOutcome[]> {
	const outcomes: ImportOutcome[] = [];
	for (const file of files) outcomes.push(await importSessionFile(file, options));
	return outcomes;
}
