import { randomUUID } from "node:crypto";
import { appendFile, cp, lstat, mkdir, open, readFile, readdir, rename, rmdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Shared project-state infrastructure for the global memory extensions.
 *
 * Storage layout (nothing is written to `~/.pi` or a project `.pi`):
 *
 *   <project>/.agents/skills/<name>/SKILL.md              learned project skills (standard location)
 *   <project>/.agents/memory/MEMORY.md                    durable project memory
 *   <project>/.agents/memory/CONTEXT.md                   recent session summary + session index
 *   <project>/.agents/memory/session-logs/INDEX.md        archive-layer session index (no LLM)
 *   <project>/.agents/memory/HANDOFF.md                   last handoff summary (written by handoff)
 *   <project>/.agents/memory/autolearn.json               autolearn throttle/enabled state
 *   <project>/.agents/memory/session-logs/<session-id>/   session.jsonl (raw) + session.md (rendered)
 *
 * Legacy data is migrated on session start:
 *   <project>/.pi/{MEMORY.md,CONTEXT.md,session-logs,skills}
 *   <project>/.agents/memory/skills          (short-lived intermediate layout)
 *   ~/.omp/agent/memories/<encoded-project>/ (read-only import, OMP keeps its copy)
 */

export const AGENTS_DIR = ".agents";
export const LEGACY_DIR = ".pi";
export const MEMORY_SUBDIR = "memory";
export const SKILLS_SUBDIR = "skills";
export const SESSION_LOGS_SUBDIR = "session-logs";

/** Default cap on the rendered memory document; the project's `maxMemoryChars` overrides it. */
export const MAX_MEMORY_CHARS = 32_000;
/** Accepted bounds for `maxMemoryChars`: below this a memory is useless, above it cannot be re-emitted. */
export const MIN_MEMORY_CHARS = 4_000;
export const MAX_MEMORY_CHARS_LIMIT = 200_000;
export const MAX_CONTEXT_CHARS = 32000;
export const MAX_CONVERSATION_CHARS = 50000;
export const MAX_SKILL_BODY_CHARS = 20000;
export const MAX_SUMMARY_CHARS = 6000;
export const MAX_LIST_ITEM_CHARS = 800;

const projectRootCache = new Map<string, string>();

export async function getProjectRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
	const key = path.resolve(cwd);
	const cached = projectRootCache.get(key);
	if (cached) return cached;

	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: key, timeout: 3000 }).catch(() => undefined);
	const root = result && result.code === 0 && result.stdout.trim() ? path.resolve(result.stdout.trim()) : key;
	projectRootCache.set(key, root);
	return root;
}

export function memoryDir(projectRoot: string): string {
	return path.join(projectRoot, AGENTS_DIR, MEMORY_SUBDIR);
}

/** Standard project skills directory, discovered natively by pi and other harnesses. */
export function skillsDir(projectRoot: string): string {
	return path.join(projectRoot, AGENTS_DIR, SKILLS_SUBDIR);
}

/** User-level skills directory (shared with other harnesses), used for autolearn dedupe. */
export function globalSkillsDir(): string {
	return path.join(homedir(), AGENTS_DIR, SKILLS_SUBDIR);
}

export function memoryFile(projectRoot: string): string {
	return path.join(memoryDir(projectRoot), "MEMORY.md");
}

/** Append-only source of truth for the consolidated memory; `MEMORY.md` is its derived render. */
export function memoryJournalFile(projectRoot: string): string {
	return path.join(memoryDir(projectRoot), "memory.jsonl");
}

export function contextFile(projectRoot: string): string {
	return path.join(memoryDir(projectRoot), "CONTEXT.md");
}

/** Mechanical session index maintained by the archive layer, next to the logs it points at. */
export function sessionIndexFile(projectRoot: string): string {
	return path.join(logsDir(projectRoot), "INDEX.md");
}

/** Older index location (`<memory>/session-index.md`); read once during migration. */
export function legacySessionIndexFile(projectRoot: string): string {
	return path.join(memoryDir(projectRoot), "session-index.md");
}

export function logsDir(projectRoot: string): string {
	return path.join(memoryDir(projectRoot), SESSION_LOGS_SUBDIR);
}

export function legacyPiDir(projectRoot: string): string {
	return path.join(projectRoot, LEGACY_DIR);
}

export function legacyOmpDir(projectRoot: string): string {
	const encoded = `--${projectRoot.replaceAll(path.sep, "-")}--`;
	return path.join(homedir(), ".omp", "agent", "memories", encoded);
}

export function safeSessionId(sessionId: string): string {
	return sessionId.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 128) || "ephemeral";
}

export function validSkillName(name: string): boolean {
	return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name);
}

export function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	try {
		if (ctx.hasUI) ctx.ui.notify(message, type);
	} catch {
		// Notifications must never break a handler; the UI may already be tearing down.
	}
}

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

/** Mask credential-looking substrings before anything lands in the project's log file. */
export function redactSecrets(text: string): string {
	return text
		.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted-jwt]")
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi, "Bearer [redacted]")
		.replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/g, "[redacted-key]")
		.replace(/\b(gh[pousr]|github_pat)_[A-Za-z0-9_]{8,}\b/g, "[redacted-token]")
		.replace(/\bAKIA[0-9A-Z]{12,}\b/g, "[redacted-key]")
		.replace(/(\b(?:api[_-]?key|token|secret|password|passwd|authorization)\b\s*[:=]\s*)["']?[^\s"',}\]]{6,}/gi, "$1[redacted]");
}

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

export async function readOptional(file: string): Promise<string> {
	try {
		return await readFile(file, "utf8");
	} catch {
		return "";
	}
}

/** Last-modification time in epoch ms; 0 when the file is missing (used by the autolearn gate). */
export async function fileMtimeMs(file: string): Promise<number> {
	try {
		return (await stat(file)).mtimeMs;
	} catch {
		return 0;
	}
}

export async function pathExists(target: string): Promise<boolean> {
	try {
		await stat(target);
		return true;
	} catch {
		return false;
	}
}

export async function writeAtomic(file: string, content: string | Uint8Array): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	// The UUID keeps two concurrent writers of the same file from sharing a temp path.
	const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
		await rename(temporary, file);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

/** How long a write may hold the memory lock before another process may steal it. */
const MEMORY_LOCK_STALE_MS = 30_000;
/** How long a writer waits for the lock before failing the pass. */
const MEMORY_LOCK_WAIT_MS = 5_000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryLock(lockPath: string): Promise<string | undefined> {
	const token = `${process.pid}-${randomUUID()}`;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const handle = await open(lockPath, "wx", 0o600);
			// The open handle identifies the exact file this attempt created; a write failure may
			// only remove that file, never a successor's lock created after a long suspension.
			const created = await handle.stat().catch(() => undefined);
			let writeFailure: unknown;
			try {
				await handle.writeFile(`${token}\n`);
			} catch (error) {
				writeFailure = error;
			} finally {
				await handle.close().catch(() => undefined);
			}
			if (writeFailure) {
				const current = await lstat(lockPath).catch(() => undefined);
				if (current && created && current.ino === created.ino && current.dev === created.dev) {
					await rm(lockPath, { force: true }).catch(() => undefined);
				}
				throw writeFailure;
			}
			return token;
		} catch (error) {
			if ((error as { code?: string }).code !== "EEXIST") throw error;
			let info: Awaited<ReturnType<typeof lstat>>;
			try {
				info = await lstat(lockPath);
			} catch {
				return undefined; // Vanished; the next attempt can win it.
			}
			if (!info.isFile()) {
				// A directory, FIFO or symlink (even a dangling one) can never age into a lock: move
				// it aside. `lstat` is essential here: `stat` follows the link and reports ENOENT.
				await rename(lockPath, `${lockPath}.broken-${randomUUID().slice(0, 8)}`).catch(() => undefined);
				continue;
			}
			return undefined;
		}
	}
	return undefined;
}

/** Lock mtime where a missing file counts as 0 and an unreadable one as fresh (never stolen). */
async function lockMtimeMs(file: string): Promise<number> {
	try {
		return (await stat(file)).mtimeMs;
	} catch (error) {
		return (error as { code?: string }).code === "ENOENT" ? 0 : Number.POSITIVE_INFINITY;
	}
}

/** Take the short-lived steal claim with `wx`; only one writer wins it. */
async function acquireClaim(claimPath: string): Promise<string | undefined> {
	const token = `${process.pid}-${randomUUID()}`;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const handle = await open(claimPath, "wx", 0o600);
			const created = await handle.stat().catch(() => undefined);
			try {
				await handle.writeFile(`${token}\n`);
			} catch {
				// A claim we cannot fill is not ours to hold; remove only the exact file we created.
				const current = await lstat(claimPath).catch(() => undefined);
				if (current && created && current.ino === created.ino && current.dev === created.dev) {
					await rm(claimPath, { force: true }).catch(() => undefined);
				}
				return undefined;
			} finally {
				await handle.close().catch(() => undefined);
			}
			return token;
		} catch (error) {
			if ((error as { code?: string }).code !== "EEXIST") throw error;
			let info: Awaited<ReturnType<typeof lstat>>;
			try {
				info = await lstat(claimPath);
			} catch {
				return undefined; // Vanished between open and stat; the next attempt can win it.
			}
			if (!info.isFile()) {
				// A directory, FIFO or symlink (even a dangling one) can never age into staleness.
				await rename(claimPath, `${claimPath}.broken-${randomUUID().slice(0, 8)}`).catch(() => undefined);
				continue;
			}
			// A claim left by a crashed stealer must not block stealing forever, but only the exact
			// inode and bytes inspected may be removed; a claim that replaced them belongs to someone else.
			if (Date.now() - info.mtimeMs > MEMORY_LOCK_STALE_MS) {
				const observed = await readFile(claimPath, "utf8").catch(() => undefined);
				if (observed === undefined) continue;
				const after = await lstat(claimPath).catch(() => undefined);
				if (!after || !after.isFile() || after.ino !== info.ino || after.dev !== info.dev) continue;
				const current = await readFile(claimPath, "utf8").catch(() => undefined);
				if (current === observed) await rm(claimPath, { force: true }).catch(() => undefined);
				continue;
			}
			return undefined;
		}
	}
	return undefined;
}

/** True while the claim file still carries this writer's token. */
async function claimStillOurs(claimPath: string, token: string): Promise<boolean> {
	return (await readFile(claimPath, "utf8").catch(() => "")).trim() === token;
}

/** Release a claim only while it is still ours; a reclaimed claim belongs to its new holder. */
async function releaseClaim(claimPath: string, token: string): Promise<void> {
	if (await claimStillOurs(claimPath, token)) await rm(claimPath, { force: true }).catch(() => undefined);
}

/**
 * Remove a stale lock with a single winner: every stealer first takes `<lock>.steal` with its own
 * token, so two writers cannot both pass the age check and then delete each other's lock. Every
 * destructive step re-checks that we still own the claim, which closes the race for cooperating
 * writers except for a suspension between that final check and the unlink; no kernel-atomic
 * alternative is available through node:fs.
 */
async function stealStaleLock(lockPath: string, claimPath: string, claimToken: string): Promise<void> {
	const before = await lstat(lockPath).catch(() => undefined);
	if (!before || !before.isFile()) return; // Non-regular paths heal in tryLock.
	if (Date.now() - before.mtimeMs <= MEMORY_LOCK_STALE_MS) return;
	// Only the exact inode and bytes inspected may be removed; a lock replaced meanwhile is not ours.
	const observed = await readFile(lockPath, "utf8").catch(() => undefined);
	if (observed === undefined) return;
	const after = await lstat(lockPath).catch(() => undefined);
	if (!after || !after.isFile() || after.ino !== before.ino || after.dev !== before.dev) return;
	const current = await readFile(lockPath, "utf8").catch(() => undefined);
	if (current !== observed) return;
	if (!(await claimStillOurs(claimPath, claimToken))) return;
	await rm(lockPath, { force: true }).catch(() => undefined);
}

/** Remove the lock only while it still carries this writer's token; a stolen lock belongs to its thief. */
async function releaseLock(lockPath: string, token: string): Promise<void> {
	const claimPath = `${lockPath}.steal`;
	// Only the claim holder may delete: without it a stealer owns the lock's fate, and a delete
	// could unlink the thief's freshly created lock. Leaving our own lock is the safe branch.
	const claimToken = await acquireClaim(claimPath);
	if (!claimToken) return;
	try {
		const current = (await readFile(lockPath, "utf8").catch(() => "")).trim();
		if (current === token && await claimStillOurs(claimPath, claimToken)) {
			await rm(lockPath, { force: true }).catch(() => undefined);
		}
	} finally {
		await releaseClaim(claimPath, claimToken);
	}
}

/**
 * Serialize one memory-file write across processes with an exclusive lock file, so the bytes a
 * writer backs up cannot be replaced between the backup read and the atomic rename that publishes
 * the new file. A lock left behind by a crashed writer is stolen once it is older than any live
 * write; the thief writes its own token and the original holder only deletes a lock it still owns.
 */
export async function withMemoryLock<T>(target: string, action: () => Promise<T>): Promise<T> {
	const lockPath = `${target}.lock`;
	// The memory directory may not exist yet on a first write; the lock lives next to the file.
	await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
	await ensureMemoryGitignore(path.dirname(lockPath));
	const deadline = Date.now() + MEMORY_LOCK_WAIT_MS;
	let token: string | undefined;
	while (!token) {
		token = await tryLock(lockPath);
		if (token) break;
		if (Date.now() >= deadline) throw new Error(`timed out waiting for the memory write lock at ${lockPath}`);
		if (Date.now() - (await lockMtimeMs(lockPath)) > MEMORY_LOCK_STALE_MS) {
			const claimPath = `${lockPath}.steal`;
			const claimToken = await acquireClaim(claimPath);
			if (claimToken) {
				try {
					await stealStaleLock(lockPath, claimPath, claimToken);
				} finally {
					await releaseClaim(claimPath, claimToken);
				}
			}
		}
		// Always back off: a stale lock whose claim is held must not spin a core to the deadline.
		await sleep(40 + Math.floor(Math.random() * 60));
	}
	try {
		return await action();
	} finally {
		await releaseLock(lockPath, token);
	}
}

async function movePath(source: string, destination: string): Promise<void> {
	await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
	try {
		await rename(source, destination);
	} catch {
		await cp(source, destination, { recursive: true, force: false, errorOnExist: false });
		await rm(source, { recursive: true, force: true });
	}
}

/**
 * Merge one legacy artifact into the new location; newest content wins, then the
 * legacy path is removed.
 *
 * A file/directory type conflict cannot be merged automatically. Deleting the
 * legacy side would destroy the user's data, and `cp` would throw
 * `ERR_FS_CP_NON_DIR_TO_DIR` and abort the whole migration, so both sides stay
 * where they are and the caller reports the conflict.
 *
 * @param source - the legacy path to consume.
 * @param destination - the new location.
 * @returns `absent` when there is nothing to move, `conflict` when the two paths
 *   have incompatible types, `merged` when the source was consumed.
 */
async function mergePath(source: string, destination: string): Promise<"merged" | "absent" | "conflict"> {
	if (!await pathExists(source)) return "absent";
	if (!await pathExists(destination)) {
		await movePath(source, destination);
		return "merged";
	}

	const sourceStat = await stat(source);
	const destinationStat = await stat(destination);
	if (sourceStat.isDirectory() && destinationStat.isDirectory()) {
		let conflicted = false;
		for (const entry of await readdir(source, { withFileTypes: true })) {
			if (await mergePath(path.join(source, entry.name), path.join(destination, entry.name)) === "conflict") conflicted = true;
		}
		// Keep the source directory when it still holds an unmergeable child.
		if (conflicted) return "conflict";
		await rm(source, { recursive: true, force: true });
		return "merged";
	}

	if (sourceStat.isDirectory() || destinationStat.isDirectory()) return "conflict";

	if (sourceStat.mtimeMs > destinationStat.mtimeMs) {
		await cp(source, destination, { force: true });
	}
	await rm(source, { force: true });
	return "merged";
}

/** Remove leftover `<name>.<pid>.tmp` files from interrupted atomic writes. */
async function cleanStaleTemps(directory: string): Promise<void> {
	let entries: Awaited<ReturnType<typeof readdir>>;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return;
	}
	const cutoff = Date.now() - 60 * 60 * 1000;
	for (const entry of entries) {
		const file = path.join(directory, entry.name);
		if (/\.broken-[0-9a-f]{8}$/.test(entry.name)) {
			// A broken artifact is a renamed-aside conflict, so it is never a regular file. Only an
			// empty directory is ours to drop; anything with content may be the user's data.
			try {
				if (entry.isDirectory() && (await stat(file)).mtimeMs < cutoff) await rmdir(file);
			} catch {
				// Non-empty or busy: leave it for the user.
			}
			continue;
		}
		if (!entry.isFile() || !/\.\d+(?:\.[0-9a-f-]{36})?\.tmp$/.test(entry.name)) continue;
		try {
			if ((await stat(file)).mtimeMs < cutoff) await rm(file, { force: true });
		} catch {
			// Best effort.
		}
	}
}

function normalizeSkillDocument(name: string, raw: string): string {
	if (raw.startsWith("---")) return `${raw.trimEnd()}\n`;
	const description = raw.split("\n")[0].trim().slice(0, 1024);
	return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${raw.trim()}\n`;
}

async function importSkillDirs(sourceDir: string, targetDir: string, options: { remove?: boolean } = {}): Promise<number> {
	let entries: Awaited<ReturnType<typeof readdir>>;
	try {
		entries = await readdir(sourceDir, { withFileTypes: true });
	} catch {
		return 0;
	}

	let imported = 0;
	for (const entry of entries) {
		if (!entry.isDirectory() || !validSkillName(entry.name)) continue;
		const source = path.join(sourceDir, entry.name);
		const raw = (await readOptional(path.join(source, "SKILL.md"))).trim();
		if (!raw) continue;
		const destination = path.join(targetDir, entry.name, "SKILL.md");
		if (await readOptional(destination)) {
			if (options.remove) await rm(source, { recursive: true, force: true });
			continue;
		}
		await writeAtomic(destination, normalizeSkillDocument(entry.name, raw));
		if (options.remove) await rm(source, { recursive: true, force: true });
		imported += 1;
	}
	if (options.remove) await rmdir(sourceDir).catch(() => undefined);
	return imported;
}

export type MigrationResult = {
	moved: string[];
	importedSkills: number;
	importedMemory: boolean;
	/** Destination paths whose legacy counterpart could not be merged and was left in place. */
	conflicts: string[];
};

/** Consolidate legacy memory, context, logs and skills into the `.agents/` layout. */
export async function migrateProjectState(projectRoot: string, limit: number = MAX_MEMORY_CHARS): Promise<MigrationResult> {
	const moved: string[] = [];
	const conflicts: string[] = [];
	const legacyPi = legacyPiDir(projectRoot);
	const moves: Array<[string, string]> = [
		[path.join(legacyPi, "MEMORY.md"), memoryFile(projectRoot)],
		[path.join(legacyPi, "CONTEXT.md"), contextFile(projectRoot)],
		[path.join(legacyPi, SESSION_LOGS_SUBDIR), logsDir(projectRoot)],
	];
	for (const [source, destination] of moves) {
		const label = path.relative(projectRoot, destination) || destination;
		const outcome = await mergePath(source, destination);
		if (outcome === "merged") moved.push(label);
		if (outcome === "conflict") conflicts.push(label);
	}

	const importedSkills =
		await importSkillDirs(path.join(legacyPi, SKILLS_SUBDIR), skillsDir(projectRoot), { remove: true }) +
		await importSkillDirs(path.join(memoryDir(projectRoot), SKILLS_SUBDIR), skillsDir(projectRoot), { remove: true }) +
		await importSkillDirs(path.join(legacyOmpDir(projectRoot), SKILLS_SUBDIR), skillsDir(projectRoot));

	let importedMemory = false;
	if (!await pathExists(memoryFile(projectRoot))) {
		for (const name of ["MEMORY.md", "memory_summary.md", "learned.md"]) {
			const source = path.join(legacyOmpDir(projectRoot), name);
			const loaded = await readMemorySource(source);
			if (loaded.unreadable) {
				// Skipping silently would hide a legacy memory that exists but cannot be imported.
				await logError(projectRoot, "migration", `legacy OMP memory at ${source} exists but cannot be read`);
				continue;
			}
			const raw = loaded.text.trim();
			if (!raw) continue;
			// Lock and re-check, so a concurrent writer's state is never replaced unbacked. The
			// import enters through the journal, which is what readers trust once it exists.
			await withMemoryLock(memoryFile(projectRoot), async () => {
				if (await pathExists(memoryFile(projectRoot))) return;
				if ((await readMemoryJournal(memoryJournalFile(projectRoot))).entries.length > 0) return;
				const decoded = decodePoisonedMemory(raw, limit);
				const text = decoded ? decoded.trim() : raw;
				await recordMemoryDocument(projectRoot, text, limit);
				importedMemory = true;
			});
			break;
		}
	}

	await cleanStaleTemps(legacyPi);
	await cleanStaleTemps(memoryDir(projectRoot));
	// Drop the legacy directory when migration emptied it; pi recreates it if ever needed.
	await rmdir(legacyPi).catch(() => undefined);

	return { moved, importedSkills, importedMemory, conflicts };
}

type JsonStringField = { value: string; complete: boolean; end: number };

/** Read a quoted string starting at `at` (skipping whitespace); tolerates an unterminated value. */
function readJsonStringAt(text: string, at: number): JsonStringField | undefined {
	let index = at;
	while (index < text.length && /\s/.test(text[index])) index += 1;
	if (text[index] !== '"') return undefined;
	index += 1;
	let out = "";
	while (index < text.length) {
		const char = text[index];
		if (char === "\\") {
			const escaped = text[index + 1];
			if (escaped === undefined) return { value: out, complete: false, end: text.length };
			if (escaped === "u") {
				const hex = text.slice(index + 2, index + 6);
				if (!/^[0-9a-f]{4}$/i.test(hex)) return { value: out, complete: false, end: text.length };
				out += String.fromCharCode(Number.parseInt(hex, 16));
				index += 6;
				continue;
			}
			out += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped === "r" ? "\r" : escaped === "b" ? "\b" : escaped === "f" ? "\f" : escaped;
			index += 2;
			continue;
		}
		if (char === '"') return { value: out, complete: true, end: index };
		out += char;
		index += 1;
	}
	return { value: out, complete: false, end: text.length };
}

/**
 * Read a `"key": "..."` string out of JSON-looking text. Unlike `JSON.parse` this tolerates an
 * unterminated value, which is how a reply truncated by the output cap arrives; `complete`
 * reports whether the closing quote was found.
 */
export function readJsonStringField(text: string, key: string): JsonStringField | undefined {
	const match = new RegExp(`"${key}"\\s*:\\s*"`).exec(text);
	if (!match) return undefined;
	return readJsonStringAt(text, match.index + match[0].length - 1);
}

type TopLevelField = { key: string; valueAt: number };

/** Top-level `"key": value` fields of an object text, in order, with the value's start index. */
function topLevelFields(object: string): TopLevelField[] {
	const fields: TopLevelField[] = [];
	let depth = 0;
	let index = 0;
	while (index < object.length) {
		const char = object[index];
		if (char === '"') {
			const field = readJsonStringAt(object, index);
			if (!field) break;
			let look = field.end + 1;
			while (look < object.length && /\s/.test(object[look])) look += 1;
			if (depth === 1 && object[look] === ":") fields.push({ key: field.value, valueAt: look + 1 });
			index = field.end + 1;
			continue;
		}
		if (char === "{") depth += 1;
		else if (char === "}") depth -= 1;
		index += 1;
	}
	return fields;
}

/** How long a single non-JSON wrapper line may be before it stops looking like a stored reply. */
const POISON_PREFIX_LIMIT = 40;
/** Minimum decoded length before a header-less value counts as a memory document. */
const MIN_DECODED_MEMORY_CHARS = 120;

/** Wrapper text a stored reply may carry before its object: nothing, `json`/`[`, a fence, or one short introducer line. */
function isPoisonPrefix(prefix: string): boolean {
	const trimmed = prefix.trim();
	if (!trimmed) return true;
	if (/^(?:json|JSON|\[|```(?:json|JSON|markdown)?)$/.test(trimmed)) return true;
	// Exactly one short plain line ending in a colon, e.g. "Consolidation reply:". Markdown
	// structure (list, heading, code, quote, emphasis) or a multi-line preamble is never a reply
	// wrapper; the caller additionally requires the object to be the whole remainder, to lead
	// with a reply field, and the decoded value to be a full memory document.
	if (trimmed.includes("\n") || trimmed.length > POISON_PREFIX_LIMIT) return false;
	if (!/[:：]$/.test(trimmed)) return false;
	return !/[*_#`>|\-[\]]/.test(trimmed.replace(/[:：]\s*$/, ""));
}

/** Index just after the object opened at `start`, or -1 when the braces never close. */
function jsonObjectEnd(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	for (let index = start; index < text.length; index += 1) {
		const char = text[index];
		if (inString) {
			if (char === "\\") index += 1;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) return index + 1;
		}
	}
	return -1;
}

/**
 * Older builds stored an unparseable reply verbatim, which left raw JSON in MEMORY.md. Decode it
 * back into markdown for readers (injection, consolidation, autolearn); the stored file is only
 * replaced by the normal consolidation write path, so a mis-detection can never destroy it.
 */
function decodePoisonedMemory(current: string, limit: number = MAX_MEMORY_CHARS): string | undefined {
	const body = current.replace(/^#\s*Project Memory\s*/i, "").trim();
	const objectAt = body.indexOf("{");
	if (objectAt < 0) return undefined;
	// Both sides of the object are part of the shape: a stored reply has nothing but wrapper text
	// before it, and nothing but a closing fence after it.
	const prefix = body.slice(0, objectAt);
	if (!isPoisonPrefix(prefix)) return undefined;
	const prosePrefix = Boolean(prefix.trim());
	const objectEnd = jsonObjectEnd(body, objectAt);
	if (objectEnd >= 0) {
		const after = body.slice(objectEnd).trim();
		if (after && after !== "```" && after !== "]") return undefined;
	}
	const scope = objectEnd >= 0 ? body.slice(objectAt, objectEnd) : body.slice(objectAt);
	// A stored reply leads with one of its two fields, in either order; a nested or later
	// occurrence is a documented example, not the reply itself.
	const fields = topLevelFields(scope);
	if (fields[0]?.key !== "memory_markdown" && fields[0]?.key !== "context") return undefined;
	const memoryField = fields.find((field) => field.key === "memory_markdown");
	if (!memoryField) return undefined;
	const field = readJsonStringAt(scope, memoryField.valueAt);
	if (!field || !field.value.trim()) return undefined;
	// The value must be the memory document itself, not a documented reply sample.
	const decoded = field.value.trim().replace(/^```(?:markdown)?\s*/i, "").trim();
	const hasHeader = /^#\s*Project Memory/i.test(decoded);
	// A header-less value is accepted only for the canonical wrappers and only when it clearly is
	// a document; an introducer line carries more false-positive risk, so it needs the header.
	if (!hasHeader && (prosePrefix || decoded.length < MIN_DECODED_MEMORY_CHARS || !decoded.includes("\n"))) return undefined;
	return normalizeMemoryDocument(field.value, limit);
}

/** Number of newest memory backups kept per project. */
const MEMORY_BACKUPS_KEPT = 5;
/** Backups younger than this are never pruned, so a backup named in a notice stays reviewable
 * until roughly MEMORY_BACKUPS_MAX further writes have pushed it past the hard ceiling. */
const MEMORY_BACKUP_MIN_AGE_MS = 60 * 60 * 1000;
/** Hard ceiling on backups, so a sustained burst cannot grow the directory without bound. */
const MEMORY_BACKUPS_MAX = Math.max(MEMORY_BACKUPS_KEPT, 20);

/** Collapse the journal once it grows past this; the previous file is archived, never deleted. */
const MEMORY_JOURNAL_ROTATE_BYTES = 512 * 1024;
/** Archived journals kept as evidence; the same age floor as backups protects the newest. */
const MEMORY_JOURNAL_ARCHIVES_KEPT = 5;

/** Escape a literal string for use inside a RegExp. */
function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Keep the current bytes of a memory file next to it before the writer replaces it, and report
 * whether the bytes on disk are a stored reply. Reads the disk at write time, so a concurrent
 * writer's file is what gets backed up. Older backups beyond the newest few are pruned.
 */
export async function backupMemoryBeforeWrite(target: string): Promise<{ path?: string; poisoned: boolean }> {
	// Fail closed: a missing file has nothing to keep, but an unreadable one must stop the write.
	let raw: Buffer;
	try {
		raw = await readFile(target);
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return { poisoned: false };
		throw error;
	}
	if (raw.length === 0) return { poisoned: false };
	await ensureMemoryGitignore(path.dirname(target));
	const poisoned = Boolean(decodePoisonedMemory(raw.toString("utf8").trim()));
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const directory = path.dirname(target);
	const prefix = `${path.basename(target)}.memory-backup-`;
	const keep = `${prefix}${stamp}-${randomUUID().slice(0, 8)}`;
	const backup = path.join(directory, keep);
	await writeAtomic(backup, raw);
	// Match only names this generator writes, from the start of the name. A user file that merely
	// carries a similar suffix must survive the prune.
	const generated = new RegExp(`^${escapeRegExp(prefix)}\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z-[0-9a-f]{8}$`);
	try {
		// Prune only files this extension generated, by mtime, never the backup just written.
		const candidates: Array<{ name: string; mtime: number }> = [];
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (entry.name === keep || !entry.isFile()) continue;
			if (!generated.test(entry.name)) continue;
			try {
				candidates.push({ name: entry.name, mtime: (await stat(path.join(directory, entry.name))).mtimeMs });
			} catch {
				// A backup whose time cannot be read must never be deleted on a guess.
			}
		}
		candidates.sort((left, right) => (right.mtime - left.mtime) || right.name.localeCompare(left.name));
		const pruneBefore = Date.now() - MEMORY_BACKUP_MIN_AGE_MS;
		for (const [index, stale] of candidates.slice(MEMORY_BACKUPS_KEPT - 1).entries()) {
			// Recent backups survive the count limit, up to the hard ceiling; beyond that even the
			// recent excess is rotated, so a burst cannot grow the directory without bound.
			if (stale.mtime > pruneBefore && index < MEMORY_BACKUPS_MAX - MEMORY_BACKUPS_KEPT) continue;
			try {
				await rm(path.join(directory, stale.name), { force: true });
			} catch {
				// One unremovable backup must not stop the others.
			}
		}
	} catch {
		// Pruning is best-effort; a stale backup is harmless.
	}
	return { path: backup, poisoned };
}

/** Leading text of the marker line a capped memory carries; the full shape is matched below. */
const MEMORY_TRUNCATION_PREFIX = "_[memory truncated";
/** The marker line in full: `_[memory truncated at <limit> characters: <dropped> dropped]_`. */
const MEMORY_TRUNCATION_LINE = /^_\[memory truncated at \d+ characters: \d+ dropped\]_$/;

/** The line a capped document ends with: a cut memory must never look like a complete one. */
export function memoryTruncationMarker(dropped: number, limit: number): string {
	return `${MEMORY_TRUNCATION_PREFIX} at ${limit} characters: ${dropped} dropped]_`;
}

/** True when a memory document reports that the cap dropped part of it. */
export function isMemoryTruncated(text: string): boolean {
	return text.split("\n").some((line) => MEMORY_TRUNCATION_LINE.test(line.trim()));
}

/** Largest whole-line prefix of `text` within `limit`; only a single over-long line is cut inside. */
function clipToLineBoundary(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const head = text.slice(0, Math.max(0, limit));
	const cut = head.lastIndexOf("\n");
	return cut > 0 ? head.slice(0, cut) : head;
}

/**
 * Rebuild the `# Project Memory` document from a model or recovered value.
 *
 * Over the cap the document is cut on a line boundary and gets an explicit marker: the previous
 * plain `.slice()` cut the last line in half, so a fact lost its tail with nothing to show for it,
 * and every later pass re-emitted the already-shortened document (the loss compounded silently).
 * A marker left by an earlier cap is preserved verbatim, so normalizing twice is idempotent.
 */
export function normalizeMemoryDocument(value: string, limit: number = MAX_MEMORY_CHARS): string {
	const cleaned = value
		.replace(/^```(?:markdown)?\s*/i, "")
		.replace(/\s*```$/, "")
		.trim()
		.replace(/^#\s*Project Memory\s*/i, "")
		.trim();
	const lines = cleaned.split("\n");
	// Only the exact marker shape is stripped; a regular memory line that merely starts with the
	// same words must not be moved to the end (and reported as a cap that never happened).
	const previous = lines.find((line) => MEMORY_TRUNCATION_LINE.test(line.trim()))?.trim();
	const body = lines.filter((line) => !MEMORY_TRUNCATION_LINE.test(line.trim())).join("\n").trim();
	const document = `# Project Memory\n\n${body}`;
	if (document.length <= limit) return `${document}${previous ? `\n\n${previous}` : ""}`.trimEnd() + "\n";
	const kept = clipToLineBoundary(document, limit).trimEnd();
	return `${kept}\n\n${memoryTruncationMarker(document.length - kept.length, limit)}\n`;
}

export type LoadedMemory = { text: string; source: string; poisoned: boolean; unreadable?: boolean; damaged?: number };

/** Read one memory source, distinguishing "absent" from "exists but unreadable". */
async function readMemorySource(file: string): Promise<{ text: string; unreadable: boolean }> {
	try {
		return { text: await readFile(file, "utf8"), unreadable: false };
	} catch (error) {
		return { text: "", unreadable: (error as { code?: string }).code !== "ENOENT" };
	}
}

/** Decode a stored reply found outside the `.agents/` layout (legacy `.pi`, OMP import). */
function legacyMemory(text: string, source: string, limit: number): LoadedMemory {
	const decoded = decodePoisonedMemory(text, limit);
	if (decoded) return { text: clipToLineBoundary(decoded.trim(), limit), source, poisoned: true };
	return { text: clipToLineBoundary(text, limit), source, poisoned: false };
}

/** One journal record: a whole-document replacement or an appended fragment. */
export type MemoryJournalEntry = { op: "replace" | "append"; text: string };

/** Comparison key for "does this render still equal what the journal folds to?" — both normalized. */
function memoryComparisonKey(render: string, limit: number = MAX_MEMORY_CHARS): string {
	return normalizeMemoryDocument(decodePoisonedMemory(render.trim(), limit) ?? render, limit);
}

/** Append one record with a single `write` call; the file is append-only by construction. */
export async function appendMemoryOp(file: string, op: MemoryJournalEntry["op"], text: string): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	const entry = `${JSON.stringify({ ts: new Date().toISOString(), op, text })}\n`;
	// A crash or a full disk can leave a torn last line; terminate it first, or the new record
	// would be glued onto it and parsed as damage instead of being recorded.
	let torn = false;
	try {
		const info = await stat(file);
		if (info.size > 0) {
			const reader = await open(file, "r");
			try {
				const tail = Buffer.alloc(1);
				await reader.read(tail, 0, 1, info.size - 1);
				torn = tail[0] !== 0x0a;
			} finally {
				await reader.close();
			}
		}
	} catch {
		// No file yet (or it vanished): there is no torn tail to repair.
	}
	const handle = await open(file, "a", 0o600);
	try {
		await handle.write(torn ? `\n${entry}` : entry);
	} finally {
		await handle.close();
	}
}

/** Read the journal in file order, tolerating a torn or hand-edited line without losing the rest. */
export async function readMemoryJournal(file: string): Promise<{ entries: MemoryJournalEntry[]; damaged: number; unreadable: boolean }> {
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return { entries: [], damaged: 0, unreadable: false };
		return { entries: [], damaged: 0, unreadable: true };
	}
	const entries: MemoryJournalEntry[] = [];
	let damaged = 0;
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as { op?: unknown; text?: unknown };
			if ((parsed.op === "replace" || parsed.op === "append") && typeof parsed.text === "string") {
				entries.push({ op: parsed.op, text: parsed.text });
			} else {
				damaged += 1;
			}
		} catch {
			damaged += 1; // A partially written last line from a crash is skipped, not fatal.
		}
	}
	return { entries, damaged, unreadable: false };
}

/** Apply journal records in order: a replacement supersedes the document, an append extends it. */
export function foldMemoryJournal(entries: readonly MemoryJournalEntry[], limit: number = MAX_MEMORY_CHARS): string {
	let document = "";
	for (const entry of entries) {
		const text = entry.text.trim();
		if (!text) continue;
		document = entry.op === "replace" ? text : document ? `${document}\n\n${text}` : text;
	}
	return document ? normalizeMemoryDocument(document, limit) : "";
}

/** Collapse an oversized journal into one replacement, archiving the previous bytes first. */
async function rotateMemoryJournalIfNeeded(projectRoot: string): Promise<void> {
	const file = memoryJournalFile(projectRoot);
	let size: number;
	try {
		size = (await stat(file)).size;
	} catch {
		return;
	}
	if (size <= MEMORY_JOURNAL_ROTATE_BYTES) return;
	const state = await readMemoryJournal(file);
	if (state.unreadable || state.entries.length === 0) return;
	const folded = foldMemoryJournal(state.entries);
	if (!folded) return;
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const archive = path.join(memoryDir(projectRoot), `memory-log-${stamp}-${randomUUID().slice(0, 8)}.jsonl`);
	// The `.tmp` suffix keeps an orphaned rotation file inside the reclamation rules (the name
	// matches `cleanStaleTemps` and the memory-dir gitignore).
	const collapsed = path.join(memoryDir(projectRoot), `memory.jsonl.${Date.now()}.${randomUUID()}.tmp`);
	const record = `${JSON.stringify({ ts: new Date().toISOString(), op: "replace", text: folded })}\n`;
	try {
		// Prepare the replacement first: a failure here leaves the journal exactly as it was.
		await writeAtomic(collapsed, record);
	} catch {
		return;
	}
	try {
		await rename(file, archive);
	} catch {
		await rm(collapsed, { force: true }).catch(() => undefined);
		return;
	}
	try {
		await rename(collapsed, file);
	} catch {
		// Put the original back rather than leaving the journal path empty.
		await rename(archive, file).catch(() => undefined);
		await rm(collapsed, { force: true }).catch(() => undefined);
		return;
	}
	await pruneMemoryJournalArchives(projectRoot);
}

/** Keep the newest archived journals; anything younger than an hour is never pruned. */
async function pruneMemoryJournalArchives(projectRoot: string): Promise<void> {
	const generated = /^memory-log-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}\.jsonl$/;
	try {
		const directory = memoryDir(projectRoot);
		const candidates: Array<{ name: string; mtime: number }> = [];
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (!entry.isFile() || !generated.test(entry.name)) continue;
			try {
				candidates.push({ name: entry.name, mtime: (await stat(path.join(directory, entry.name))).mtimeMs });
			} catch {
				// An unreadable archive must never be deleted on a guess.
			}
		}
		candidates.sort((left, right) => (right.mtime - left.mtime) || right.name.localeCompare(left.name));
		const pruneBefore = Date.now() - MEMORY_BACKUP_MIN_AGE_MS;
		for (const stale of candidates.slice(MEMORY_JOURNAL_ARCHIVES_KEPT)) {
			if (stale.mtime > pruneBefore) continue;
			try {
				await rm(path.join(directory, stale.name), { force: true });
			} catch {
				// One unremovable archive must not stop the others.
			}
		}
	} catch {
		// Pruning is best effort; an extra archive is harmless.
	}
}

/**
 * Record one consolidated document: keep a pre-journal project's current memory as the journal's
 * base, append the new replacement, collapse the journal when it grew too large and render
 * `MEMORY.md`. Callers hold the memory lock and have already backed up the current render.
 */
export async function recordMemoryDocument(projectRoot: string, text: string, limit: number = MAX_MEMORY_CHARS): Promise<void> {
	const file = memoryJournalFile(projectRoot);
	const base = await readMemoryJournal(file);
	if (base.unreadable) throw new Error(`memory journal exists but cannot be read: ${file}`);
	if (base.entries.length === 0) {
		// First journal write for this project: start history from the memory it has today. The
		// legacy read path also decodes a stored reply, so the journal never stores raw JSON.
		const existing = await loadMemory(projectRoot, limit);
		if (existing.unreadable) throw new Error(`memory exists but cannot be read: ${existing.source}`);
		if (existing.text.trim()) await appendMemoryOp(file, "replace", normalizeMemoryDocument(existing.text, limit));
	} else {
		// Adopt an external edit (hand edit or an older build) before appending this pass: its bytes
		// enter the journal's history instead of being silently overwritten. A render that merely
		// equals the fold is our own output, and one that is older and differs is a torn write
		// window (journal already ahead), so neither is adopted.
		const foldedView = foldMemoryJournal(base.entries, limit);
		const renderRaw = await readOptional(memoryFile(projectRoot));
		if (renderRaw.trim()) {
			const external = memoryComparisonKey(renderRaw, limit);
			const renderInfo = await stat(memoryFile(projectRoot)).catch(() => undefined);
			const journalInfo = await stat(file).catch(() => undefined);
			if (external && external !== foldedView && renderInfo && journalInfo && renderInfo.mtimeMs > journalInfo.mtimeMs) {
				await appendMemoryOp(file, "replace", external);
				// Keep a trace of which pass folded in an edit that was made outside the extension.
				await logError(projectRoot, "memory", "adopted an externally edited MEMORY.md into the memory journal");
			}
		}
	}
	await appendMemoryOp(file, "replace", normalizeMemoryDocument(text, limit));
	await rotateMemoryJournalIfNeeded(projectRoot);
	await ensureMemoryGitignore(memoryDir(projectRoot));
	await writeAtomic(memoryFile(projectRoot), normalizeMemoryDocument(text, limit));
}

/**
 * Read the memory document. `limit` is the project's `maxMemoryChars`; every normalization on the
 * read side uses it so the fold and the render are compared under the same cap.
 */
export async function loadMemory(projectRoot: string, limit: number = MAX_MEMORY_CHARS): Promise<LoadedMemory> {
	const target = memoryFile(projectRoot);
	// The journal is the source of truth once it exists; `MEMORY.md` below is the old layout and
	// stays readable for projects that never wrote a journal.
	const journal = memoryJournalFile(projectRoot);
	const journalState = await readMemoryJournal(journal);
	if (journalState.unreadable) return { text: "", source: journal, poisoned: false, unreadable: true };
	// Content that yields no usable record means the journal cannot be reconstructed; report it
	// instead of silently showing a render that the journal has already superseded.
	if (journalState.entries.length === 0 && journalState.damaged > 0) return { text: "", source: journal, poisoned: false, unreadable: true };
	if (journalState.entries.length > 0) {
		const folded = foldMemoryJournal(journalState.entries, limit);
		if (!folded) return { text: "", source: journal, poisoned: false, unreadable: true };
		// Our own writes append to the journal and render afterwards, so a newer render proves
		// nothing by itself. The render only wins when its content differs from the fold *and* it is
		// newer than the journal: that is an external edit (a hand edit or an older build), and
		// `recordMemoryDocument` adopts those bytes into the journal on the next write.
		const view = folded;
		const renderRaw = await readOptional(target);
		if (renderRaw.trim()) {
			// Both sides are compared in normalized form: `foldMemoryJournal` returns a normalized
			// document, so a raw trimmed render would never compare equal and the mtime would
			// silently become the only rule (adopting our own output as if it were an edit).
			const external = memoryComparisonKey(renderRaw, limit);
			const renderInfo = await stat(target).catch(() => undefined);
			const journalInfo = await stat(journal).catch(() => undefined);
			// An empty key means the render was cleared by hand; the journal stays authoritative.
			if (external && external !== view && renderInfo && journalInfo && renderInfo.mtimeMs > journalInfo.mtimeMs) {
				return { text: external, source: target, poisoned: Boolean(decodePoisonedMemory(renderRaw.trim(), limit)), damaged: journalState.damaged };
			}
		}
		return { text: view, source: journal, poisoned: false, damaged: journalState.damaged };
	}
	let raw = "";
	try {
		raw = await readFile(target, "utf8");
	} catch (error) {
		if ((error as { code?: string }).code !== "ENOENT") {
			// The file exists but cannot be read: report it instead of claiming there is no memory.
			return { text: "", source: target, poisoned: false, unreadable: true };
		}
	}
	const current = raw.trim();
	if (current) {
		const decoded = decodePoisonedMemory(current, limit);
		if (decoded) return { text: clipToLineBoundary(decoded.trim(), limit), source: target, poisoned: true };
		return { text: clipToLineBoundary(current, limit), source: target, poisoned: false };
	}

	const legacyPi = path.join(legacyPiDir(projectRoot), "MEMORY.md");
	const fromPi = await readMemorySource(legacyPi);
	if (fromPi.unreadable) return { text: "", source: legacyPi, poisoned: false, unreadable: true };
	const piText = fromPi.text.trim();
	if (piText) return legacyMemory(piText, legacyPi, limit);

	for (const name of ["MEMORY.md", "memory_summary.md", "learned.md"]) {
		const fallback = path.join(legacyOmpDir(projectRoot), name);
		const source = await readMemorySource(fallback);
		if (source.unreadable) return { text: "", source: fallback, poisoned: false, unreadable: true };
		const text = source.text.trim();
		if (text) return legacyMemory(text, fallback, limit);
	}

	return { text: "", source: target, poisoned: false };
}
