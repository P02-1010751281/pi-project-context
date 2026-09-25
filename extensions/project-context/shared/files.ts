/**
 * Filesystem primitives: the atomic write, optional reads, existence and mtime probes,
 * move/merge with rollback, and stale-temp cleanup.
 */

import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

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
export async function mergePath(source: string, destination: string): Promise<"merged" | "absent" | "conflict"> {
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
export async function cleanStaleTemps(directory: string): Promise<void> {
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
