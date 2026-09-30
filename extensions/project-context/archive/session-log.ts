import { appendFile, open, stat } from "node:fs/promises";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { logsDir, pathExists, readOptional, safeSessionId, writeAtomic } from "../shared/project-state.ts";

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

/** Read up to `length` bytes (or to EOF when omitted) of `file` from `start`, as UTF-8. */
async function readSlice(file: string, start: number, length?: number): Promise<string> {
	const handle = await open(file, "r");
	try {
		const { size } = await handle.stat();
		const available = Math.max(0, size - start);
		const wanted = length === undefined ? available : Math.min(length, available);
		if (wanted === 0) return "";
		const buffer = Buffer.alloc(wanted);
		// Honor `bytesRead`: a short read must not be padded into the archive as NUL bytes that the
		// cursor would then record as copied.
		const { bytesRead } = await handle.read(buffer, 0, wanted, start);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		await handle.close();
	}
}

function readRange(file: string, start: number): Promise<string> {
	return readSlice(file, start);
}

/** Bytes compared at the append boundary to catch a same-inode source rewrite. */
const BOUNDARY_PROBE_BYTES = 256;

/**
 * The archive's size is a valid append offset only while the bytes just before it still match the
 * source. A truncate+rewrite on the same inode keeps `dest.size <= sourceStat.size`, so without
 * this check the next append would extend a stale prefix into a chimera.
 */
async function appendBoundaryIntact(source: string, archiveFile: string, size: number): Promise<boolean> {
	if (size === 0) return true;
	const probe = Math.min(size, BOUNDARY_PROBE_BYTES);
	const from = size - probe;
	const [sourceTail, archiveTail] = await Promise.all([
		readSlice(source, from, probe),
		readSlice(archiveFile, from, probe),
	]);
	return sourceTail === archiveTail;
}

/**
 * How much of the harness session file is already in the archive. The archive's own size is the
 * append offset: it is exactly the bytes this process wrote, so it can never claim more coverage
 * than the file has. A source stat captured before the read can be stale and run ahead of the
 * copied bytes, and re-appending from it would duplicate entries. This serializes callers inside a
 * process; a cross-process writer on the same archive is still outside its scope.
 */
interface RawCursor {
	source: string;
	sourceIno: number;
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

/**
 * Serializes one archive's writes inside this process: `archive.ts` queues the turn/settle paths,
 * but the `/session-log` command and any direct caller can overlap, and two callers reading the
 * same cursor would then append the same tail twice.
 */
const rawFlights = new Map<string, Promise<unknown>>();

export async function writeSessionArtifacts(
	projectRoot: string,
	ctx: ExtensionContext,
	options: { markdown?: boolean } = {},
): Promise<{ dir: string }> {
	const id = safeSessionId(ctx.sessionManager.getSessionId());
	const key = `${projectRoot}\u0000${id}`;
	const previous = rawFlights.get(key) ?? Promise.resolve();
	const run = previous.catch(() => undefined).then(() => writeSessionOnce(projectRoot, ctx, options, id, key));
	const settled = run.catch(() => undefined);
	rawFlights.set(key, settled);
	void settled.then(() => {
		if (rawFlights.get(key) === settled) rawFlights.delete(key);
	});
	return run;
}

async function writeSessionOnce(
	projectRoot: string,
	ctx: ExtensionContext,
	options: { markdown?: boolean },
	id: string,
	key: string,
): Promise<{ dir: string }> {
	const dir = path.join(logsDir(projectRoot), id);
	await ensureLogsIgnored(projectRoot);
	const rawPath = path.join(dir, "session.jsonl");
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
			&& cursor.dest.size <= sourceStat.size
			&& sameStamp(await stampOf(rawPath), cursor.dest)
			&& await appendBoundaryIntact(source, rawPath, cursor.dest.size)
		) {
			if (sourceStat.size > cursor.dest.size) {
				// Read from the archive's own end, never from the source stat above: the writer can
				// append between the two, and the tail read here may then extend past that stat. The
				// archive size stays exact, so the next refresh resumes without an overlap.
				const tail = await readRange(source, cursor.dest.size);
				if (tail) {
					await appendFile(rawPath, tail, "utf8");
					const dest = await stampOf(rawPath);
					if (dest) rawCursors.set(key, { source, sourceIno: sourceStat.ino, dest });
				}
			}
			// A refresh that adds no bytes writes nothing at all.
			appended = true;
		}
	}

	if (!appended) {
		const existingRaw = source ? await readOptional(source) : "";
		// For a non-empty source, copy it verbatim: a missing trailing newline is completed by the
		// next append from the exact byte offset, so no synthetic byte can desynchronise the cursor.
		// An empty/unreadable source has no prefix to preserve and falls back to the entry list.
		raw = existingRaw.trim()
			? existingRaw
			: [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
		await writeAtomic(rawPath, raw);
		const dest = await stampOf(rawPath);
		if (dest && source) {
			const sourceStat = await stat(source).catch(() => undefined);
			if (sourceStat) rawCursors.set(key, { source, sourceIno: sourceStat.ino, dest });
		}
	}

	if (options.markdown ?? true) {
		if (raw === undefined) raw = await readOptional(rawPath);
		await writeAtomic(path.join(dir, "session.md"), sessionMarkdown(ctx, raw));
	}
	return { dir };
}
