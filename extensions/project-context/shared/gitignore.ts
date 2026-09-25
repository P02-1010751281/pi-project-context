/**
 * The managed `.agents/.gitignore` block, written at most once per process per directory.
 */

import path from "node:path";
import { readOptional, writeAtomic } from "./files.ts";

/** Lines every project's memory dir ignores locally, written next to its first local artifact. */
const MEMORY_GITIGNORE_HEADER = "# project-context: local artifacts, do not commit";

const MEMORY_GITIGNORE_LINES = ["*.memory-backup-*", "errors.log", "*.lock", "*.steal", "*.broken-*", "memory.jsonl", "memory-log-*.jsonl", "memory.jsonl.*.tmp", "handoff-session-settings.json"];

const gitignoreEnsured = new Set<string>();

/** Keep backups and the error log out of the project's commits, once per process (best effort;
 * a failure is not retried in this process so a write is never blocked by housekeeping). The header
 * is written only when it is absent, so a later version that adds a line appends that line alone.
 * The header is a comment, so it is recognised case-insensitively; the ignore patterns themselves
 * stay case-sensitive because git matches them that way. */
export async function ensureMemoryGitignore(memoryDirectory: string): Promise<void> {
	const file = path.join(memoryDirectory, ".gitignore");
	if (gitignoreEnsured.has(file)) return;
	gitignoreEnsured.add(file);
	try {
		const existing = await readOptional(file);
		const lines = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
		const missing = MEMORY_GITIGNORE_LINES.filter((line) => !lines.has(line));
		if (missing.length === 0) return;
		const head = existing && !existing.endsWith("\n") ? `${existing}\n` : existing;
		const wired = MEMORY_GITIGNORE_HEADER.toLowerCase();
		const header = [...lines].some((line) => line.toLowerCase() === wired) ? "" : `${MEMORY_GITIGNORE_HEADER}\n`;
		await writeAtomic(file, `${head}${header}${missing.join("\n")}\n`);
	} catch {
		// Ignoring local artifacts is best-effort; a failure must not block the write.
	}
}
