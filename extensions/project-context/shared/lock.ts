/**
 * The cross-process write lock for one target path: `<target>.lock`, stolen after a staleness
 * horizon with a `<target>.lock.steal` claim so two waiters cannot both take it over.
 */

import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureMemoryGitignore } from "./gitignore.ts";

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
