/**
 * Swallowed-failure reporting: one rotated `errors.log` per project, with the diagnostic
 * truncation and redaction every entry goes through.
 */

import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "./files.ts";
import { ensureMemoryGitignore } from "./gitignore.ts";
import { memoryDir } from "./paths.ts";
import { redactSecrets } from "./redact.ts";

/** Rotate `errors.log` once its on-disk size passes this many bytes. */
const MAX_ERROR_LOG_BYTES = 1_000_000;

/** How many characters of the newest tail survive a rotation. */
const KEEP_ERROR_LOG_CHARS = 64_000;

/** Cap one appended record so a huge stack cannot dominate the (bounded) log. */
const MAX_ERROR_DETAIL_CHARS = 8_000;

/** Identical `(scope, headline)` records inside this window collapse into one line plus a count. */
export const ERROR_DEDUPE_WINDOW_MS = 10 * 60_000;

/** Bound the dedupe state so a long-lived process cannot grow it without limit. */
const MAX_TRACKED_ERROR_KEYS = 64;
const MAX_TRACKED_ERROR_FILES = 16;

/** One repeated-failure run: the record it folds, its span, and how many copies it swallowed. */
type RecentError = { scope: string; headline: string; firstAt: number; lastAt: number; count: number };

/** Per-project dedupe state. Keyed by the log file, then by `scope\0headline`. */
const recentErrors = new Map<string, Map<string, RecentError>>();

function errorKey(scope: string, headline: string): string {
	return `${scope}\u0000${headline}`;
}

function firstLine(detail: string): string {
	return detail.split("\n", 1)[0].trim().slice(0, 200);
}

function isoTimestamp(at: number): string {
	return new Date(at).toISOString();
}

/**
 * Keep the diagnostic file bounded. It is append-only and lives inside the
 * user's repository, so an unrotated file would grow without limit there.
 * The size threshold is real bytes (from `stat`); the kept tail and the record
 * cap are character counts, which is what the rendering costs.
 */
async function rotateErrorLog(file: string): Promise<void> {
	try {
		if ((await stat(file)).size <= MAX_ERROR_LOG_BYTES) return;
		const tail = (await readFile(file, "utf8")).slice(-KEEP_ERROR_LOG_CHARS);
		// Drop the partial first line so the kept text starts on a record.
		const boundary = tail.indexOf("\n");
		await writeAtomic(file, `[...truncated; newest entries kept...]\n${boundary < 0 ? tail : tail.slice(boundary + 1)}`);
	} catch {
		// A missing file or a failed rotation must not block the append.
	}
}

/** Append a swallowed failure to `<project>/.agents/memory/errors.log` so it is diagnosable later. */
export async function logError(projectRoot: string, scope: string, error: unknown): Promise<void> {
	try {
		const file = path.join(memoryDir(projectRoot), "errors.log");
		await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
		await ensureMemoryGitignore(path.dirname(file));
		await rotateErrorLog(file);
		const full = error instanceof Error ? (error.stack ?? error.message) : String(error);
		const safe = redactSecrets(full);
		const detail = safe.length > MAX_ERROR_DETAIL_CHARS ? `${safe.slice(0, MAX_ERROR_DETAIL_CHARS)}\n[...detail truncated...]` : safe;
		// A provider outage repeats the identical message on every settle. Rewriting each one grew the
		// log (and its rotation) without adding information; the first copy is kept and the rest are
		// counted, so the file stays append-only but stops echoing the same line.
		const now = Date.now();
		const headline = firstLine(detail);
		let perFile = recentErrors.get(file);
		if (perFile) {
			// Refresh recency: eviction is least-recently-used, so a still-failing project survives.
			recentErrors.delete(file);
		} else {
			perFile = new Map();
		}
		recentErrors.set(file, perFile);
		while (recentErrors.size > MAX_TRACKED_ERROR_FILES) recentErrors.delete(recentErrors.keys().next().value!);
		const key = errorKey(scope, headline);
		const seen = perFile.get(key);
		if (seen && now - seen.lastAt < ERROR_DEDUPE_WINDOW_MS) {
			seen.count += 1;
			seen.lastAt = now;
			// Re-insert at the end so a still-failing record is evicted after idle ones.
			perFile.delete(key);
			perFile.set(key, seen);
			return;
		}
		// The same key came back after its window: fold the completed run into one line. A run whose
		// key never recurs leaves no count line (append-only logging cannot know the run ended), but
		// its first record is retained.
		if (seen && seen.count > 1) {
			await appendFile(
				file,
				`${isoTimestamp(now)} [${seen.scope}] ${seen.headline} — ${seen.count - 1} identical failure(s) suppressed between ${isoTimestamp(seen.firstAt)} and ${isoTimestamp(seen.lastAt)}\n`,
				{ encoding: "utf8", mode: 0o600 },
			);
		}
		perFile.delete(key);
		perFile.set(key, { scope, headline, firstAt: now, lastAt: now, count: 1 });
		while (perFile.size > MAX_TRACKED_ERROR_KEYS) perFile.delete(perFile.keys().next().value!);
		await appendFile(file, `${isoTimestamp(now)} [${scope}] ${detail}\n`, { encoding: "utf8", mode: 0o600 });
	} catch {
		// Diagnostics must never throw.
	}
}
