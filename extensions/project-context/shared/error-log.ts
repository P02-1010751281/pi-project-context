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
		await appendFile(file, `${new Date().toISOString()} [${scope}] ${detail}\n`, { encoding: "utf8", mode: 0o600 });
	} catch {
		// Diagnostics must never throw.
	}
}
