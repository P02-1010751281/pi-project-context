/**
 * pi's session selector renders the `parentSession` chain as a tree, so chaining every handoff to
 * its immediate predecessor adds a level per handoff. Point the replacement at the oldest existing
 * ancestor instead: the lineage stays in place, the tree stays two levels deep. A missing or
 * unreadable ancestor falls back to the session we are handing off from (the old behaviour).
 */

import { open } from "node:fs/promises";

/** Session files grow to many MB; the header is the first (normally small) line, read to its
 * newline no matter how long it grew (a truncated read used to cost us the whole ancestor walk). */
const SESSION_HEADER_CHUNK_BYTES = 64 * 1024;
/** Refuse to buffer a pathological first line forever; anything larger reads as "no header". */
const SESSION_HEADER_MAX_BYTES = 1024 * 1024;
/** Bound for the ancestor walk that flattens the session tree. */
const MAX_PARENT_HOPS = 32;

export async function resolveHandoffParentSession(sessionFile: string | undefined): Promise<string | undefined> {
	if (!sessionFile) return sessionFile;
	let current = sessionFile;
	let root = sessionFile;
	const seen = new Set<string>([current]);
	for (let hop = 0; hop < MAX_PARENT_HOPS; hop++) {
		const header = await readSessionHeader(current);
		if (!header) break;
		root = current;
		const parent = header.parentSession;
		if (!parent || parent === current || seen.has(parent)) break;
		seen.add(parent);
		current = parent;
	}
	return root;
}

/** Session header of a session file; anything unreadable reads as "no header". */
async function readSessionHeader(file: string): Promise<{ parentSession?: string } | undefined> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(file, "r");
		const buffer = Buffer.alloc(SESSION_HEADER_CHUNK_BYTES);
		const chunks: Buffer[] = [];
		let read = 0;
		let newline = -1;
		while (read <= SESSION_HEADER_MAX_BYTES) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, read);
			if (bytesRead === 0) break;
			chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
			read += bytesRead;
			newline = Buffer.concat(chunks).indexOf(0x0a);
			if (newline >= 0) break;
		}
		// The cap bounds the *line*, not the read position: a first line of exactly the cap is read
		// (its newline sits one byte past it), anything longer reads as "no header". A file that ends
		// inside the cap without a newline is a single-line session and is parsed as it is.
		if ((newline < 0 ? read : newline) > SESSION_HEADER_MAX_BYTES) return undefined;
		const line = Buffer.concat(chunks).subarray(0, newline < 0 ? undefined : newline).toString("utf8");
		const parsed = JSON.parse(line) as { type?: unknown; parentSession?: unknown };
		if (parsed?.type !== "session") return undefined;
		return typeof parsed.parentSession === "string" && parsed.parentSession ? { parentSession: parsed.parentSession } : {};
	} catch {
		return undefined;
	} finally {
		await handle?.close().catch(() => {});
	}
}
