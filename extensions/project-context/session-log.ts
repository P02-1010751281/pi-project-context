import { appendFile, open, stat } from "node:fs/promises";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { logsDir, pathExists, readOptional, safeSessionId, writeAtomic } from "./project-state.ts";

/**
 * Session archive: the raw JSONL is canonical, the Markdown rendering preserves every
 * entry. The summarized CONTEXT.md is rendered by context-doc.ts and written by the
 * consolidation pass; the archive layer only injects it read-only.
 *
 * The raw copy is append-only within a process run: after the initial full copy of the
 * harness session file, each refresh appends only the new tail instead of rewriting the
 * whole log, so a long session does not rewrite itself on every turn. A stamp
 * (size + inode + mtime) guards that append: if the file on disk is no longer the one
 * this process wrote — an external truncation or replacement — the copy is rebuilt.
 */

/** Keep local transcripts out of version control without touching project ignore files. */
const logsIgnored = new Set<string>();
async function ensureLogsIgnored(projectRoot: string): Promise<void> {
	if (logsIgnored.has(projectRoot)) return;
	logsIgnored.add(projectRoot);
	try {
		const file = path.join(logsDir(projectRoot), ".gitignore");
		if (!await pathExists(file)) {
			await writeAtomic(file, "# Local session transcripts; not meant for version control.\n*\n");
		}
	} catch {
		// Best effort: a failed ignore file must not break the log write.
	}
}

/** Identity of an artifact right after this process wrote it. */
interface ArtifactStamp {
	readonly size: number;
	readonly ino: number;
	readonly mtimeMs: number;
}

async function stampOf(file: string): Promise<ArtifactStamp | undefined> {
	try {
		const info = await stat(file);
		return { size: info.size, ino: info.ino, mtimeMs: info.mtimeMs };
	} catch {
		return undefined;
	}
}

function sameStamp(a: ArtifactStamp | undefined, b: ArtifactStamp | undefined): boolean {
	return a !== undefined && b !== undefined && a.size === b.size && a.ino === b.ino && a.mtimeMs === b.mtimeMs;
}

/** Read a file's `[start, end)` bytes as UTF-8. */
async function readRange(file: string, start: number): Promise<string> {
	const handle = await open(file, "r");
	try {
		const { size } = await handle.stat();
		const length = Math.max(0, size - start);
		const buffer = Buffer.alloc(length);
		if (length > 0) await handle.read(buffer, 0, length, start);
		return buffer.toString("utf8");
	} finally {
		await handle.close();
	}
}

/** How much of the harness session file (or of the entry list) is already in the archive. */
interface RawCursor {
	source: string;
	sourceIno: number;
	sourceSize: number;
	dest: ArtifactStamp;
}

const rawCursors = new Map<string, RawCursor>();

function jsonBlock(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

/**
 * Render a session's Markdown from bare parts so the live writer and the archive
 * backfill (`import-archive.ts`) produce the same document.
 */
export function renderSessionMarkdown(
	sessionId: string,
	header: { timestamp?: unknown; cwd?: unknown } | undefined,
	entries: readonly { type?: unknown; timestamp?: unknown }[],
	raw: string,
): string {
	const started = typeof header?.timestamp === "string" ? header.timestamp : "unknown time";
	const project = typeof header?.cwd === "string" ? header.cwd : "unknown";
	const sections = entries.map((entry, index) => {
		const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "unknown time";
		return `### ${index + 1}. ${String(entry.type ?? "entry")} — ${timestamp}\n\n~~~~json\n${jsonBlock(entry)}\n~~~~`;
	});

	return [
		`# Pi Session ${sessionId}`,
		"",
		`- Started: ${started}`,
		`- Project: ${project}`,
		`- Raw log: [session.jsonl](./session.jsonl)`,
		`- Entries: ${entries.length}`,
		"",
		"The JSONL file is canonical. This Markdown rendering intentionally preserves every session entry, including tool calls, tool results, thinking blocks, compaction records, model changes, and extension entries.",
		"",
		...sections,
		"",
		"<!-- raw-log-bytes: " + Buffer.byteLength(raw, "utf8") + " -->",
		"",
	].join("\n");
}

function sessionMarkdown(ctx: ExtensionContext, raw: string): string {
	return renderSessionMarkdown(
		ctx.sessionManager.getSessionId(),
		ctx.sessionManager.getHeader() as { timestamp?: unknown; cwd?: unknown } | undefined,
		ctx.sessionManager.getEntries(),
		raw,
	);
}

export async function writeSessionArtifacts(
	projectRoot: string,
	ctx: ExtensionContext,
	options: { markdown?: boolean } = {},
): Promise<{ dir: string }> {
	const id = safeSessionId(ctx.sessionManager.getSessionId());
	const dir = path.join(logsDir(projectRoot), id);
	await ensureLogsIgnored(projectRoot);
	const rawPath = path.join(dir, "session.jsonl");
	const key = `${projectRoot}\u0000${id}`;
	const source = ctx.sessionManager.getSessionFile() ?? "";
	const entries = ctx.sessionManager.getEntries();
	const header = ctx.sessionManager.getHeader() ?? {
		type: "session",
		id: ctx.sessionManager.getSessionId(),
		timestamp: new Date().toISOString(),
		cwd: ctx.cwd,
	};

	let raw: string | undefined;
	let appended = false;
	if (source) {
		const sourceStat = await stat(source).catch(() => undefined);
		const cursor = rawCursors.get(key);
		if (
			sourceStat
			&& cursor
			&& cursor.source === source
			&& cursor.sourceIno === sourceStat.ino
			&& cursor.sourceSize <= sourceStat.size
			&& sameStamp(await stampOf(rawPath), cursor.dest)
		) {
			if (sourceStat.size > cursor.sourceSize) {
				await appendFile(rawPath, await readRange(source, cursor.sourceSize), "utf8");
				const dest = await stampOf(rawPath);
				if (dest) rawCursors.set(key, { source, sourceIno: sourceStat.ino, sourceSize: sourceStat.size, dest });
			}
			// A refresh that adds no bytes writes nothing at all.
			appended = true;
		}
	}

	if (!appended) {
		const existingRaw = source ? await readOptional(source) : "";
		raw = existingRaw.trim()
			? (existingRaw.endsWith("\n") ? existingRaw : `${existingRaw}\n`)
			: [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
		await writeAtomic(rawPath, raw);
		const dest = await stampOf(rawPath);
		if (dest && source) {
			const sourceStat = await stat(source).catch(() => undefined);
			if (sourceStat) rawCursors.set(key, { source, sourceIno: sourceStat.ino, sourceSize: sourceStat.size, dest });
		}
	}

	if (options.markdown ?? true) {
		if (raw === undefined) raw = await readOptional(rawPath);
		await writeAtomic(path.join(dir, "session.md"), sessionMarkdown(ctx, raw));
	}
	return { dir };
}
