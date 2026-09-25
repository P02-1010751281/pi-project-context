/**
 * The memory read path and the one write transaction: adopt an external edit into the journal
 * history, append this pass's render, rotate if needed, rebuild the render; and the legacy
 * read fallbacks that keep a project without a journal working.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { clipToLineBoundary, normalizeMemoryDocument } from "./document.ts";
import { appendMemoryOp, foldMemoryJournal, readMemoryJournal, rotateMemoryJournalIfNeeded } from "./journal.ts";
import { decodePoisonedMemory, memoryComparisonKey } from "./poison.ts";
import { logError } from "../shared/error-log.ts";
import { readOptional, writeAtomic } from "../shared/files.ts";
import { ensureMemoryGitignore } from "../shared/gitignore.ts";
import { MAX_MEMORY_CHARS } from "../shared/limits.ts";
import { legacyOmpDir, legacyPiDir, memoryDir, memoryFile, memoryJournalFile } from "../shared/paths.ts";

export type LoadedMemory = { text: string; source: string; poisoned: boolean; unreadable?: boolean; damaged?: number };

/** Read one memory source, distinguishing "absent" from "exists but unreadable". */
export async function readMemorySource(file: string): Promise<{ text: string; unreadable: boolean }> {
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
