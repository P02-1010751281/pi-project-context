/**
 * The memory read path and the write transactions: adopt an external edit into the journal history,
 * append this pass's render, rotate if needed, rebuild the render; the model-free flush a session
 * teardown runs; and the legacy read fallbacks that keep a project without a journal working.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { backupMemoryBeforeWrite } from "./backup.ts";
import { clipToLineBoundary, normalizeMemoryDocument, normalizeMemoryReply } from "./document.ts";
import { appendMemoryOp, foldMemoryJournal, newestMemoryArchive, readMemoryJournal, rotateMemoryJournalIfNeeded } from "./journal.ts";
import { decodePoisonedMemory, memoryComparisonKey } from "./poison.ts";
import { logError } from "../shared/error-log.ts";
import { readOptional, writeAtomic } from "../shared/files.ts";
import { ensureMemoryGitignore } from "../shared/gitignore.ts";
import { withMemoryLock } from "../shared/lock.ts";
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
 * True when what is on disk now is a different, non-empty document than the one this pass read, so
 * publishing the reply would overwrite a newer edit. Bytes that already equal the reply about to be
 * published (`publishKey`) are that reply's own document, not a competing edit, so they supersede
 * nothing. Exported because the pre-publish check is otherwise only reachable through a race.
 */
export function nextRenderSupersedes(renderKey: string, nowKey: string, publishKey: string): boolean {
	return nowKey !== "" && nowKey !== renderKey && nowKey !== publishKey;
}

/** The comparison key of a render; an empty or missing document collapses to no key at all. */
function renderKeyOf(raw: string, limit: number): string {
	return raw.trim() ? memoryComparisonKey(raw, limit) : "";
}

/** What one write of the memory document did: published the reply, or kept newer stored bytes. */
type MemoryWriteResult = { written: true } | { written: false; kept: string };

/**
 * Fold an external edit (a hand edit, or a render left behind by an older build) into the journal, so
 * its bytes enter the journal's history instead of being overwritten by the next pass. A render that
 * merely equals the fold is our own output, and one that is older and differs is a torn write window
 * (the journal is already ahead), so neither is adopted. Returns whether anything was adopted.
 *
 * Callers hold the memory lock. `preRead` lets the write path hand over what it has already read.
 */
async function adoptExternalEdit(
	projectRoot: string,
	limit: number = MAX_MEMORY_CHARS,
	preRead: { journal?: Awaited<ReturnType<typeof readMemoryJournal>>; renderKey?: string } = {},
): Promise<boolean> {
	const file = memoryJournalFile(projectRoot);
	const base = preRead.journal ?? (await readMemoryJournal(file));
	if (base.unreadable) throw new Error(`memory journal exists but cannot be read: ${file}`);
	if (base.entries.length === 0) return false;
	const renderKey = preRead.renderKey ?? renderKeyOf(await readOptional(memoryFile(projectRoot)), limit);
	if (!renderKey) return false;
	const foldedView = foldMemoryJournal(base.entries, limit);
	const renderInfo = await stat(memoryFile(projectRoot)).catch(() => undefined);
	const journalInfo = await stat(file).catch(() => undefined);
	if (renderKey === foldedView || !renderInfo || !journalInfo || renderInfo.mtimeMs <= journalInfo.mtimeMs) return false;
	await appendMemoryOp(file, "replace", renderKey);
	// Keep a trace of which pass folded in an edit that was made outside the extension.
	await logError(projectRoot, "memory", "adopted an externally edited MEMORY.md into the memory journal");
	return true;
}

/** What a model-free flush did: folded an external edit in, and/or rewrote a drifted render. */
export type FlushResult = { adopted: boolean; written: boolean };

/**
 * Publish what is already stored, without calling a model. A session teardown runs this instead of a
 * consolidation pass (2026-10-06, decision 1): the exit still folds a hand-edited `MEMORY.md` into the
 * journal, but no auxiliary call sits on a path that once let a provider error escape into pi's session
 * switch, and nothing here composes memory - a session that ends between settle passes keeps that tail
 * in the archive.
 *
 * A project with no journal has nothing to flush, and this flush must not create a memory directory or
 * take the cross-process lock for it, so that case returns before the lock (the archive layer takes its
 * own lock and directory independently). The render is rewritten only
 * when the file is missing or stale/torn against the journal; an edit that is merely different is folded
 * in and left on disk exactly as it was found (an over-cap hand edit keeps its own bytes, the journal
 * holding the clipped key). A clean exit writes nothing.
 */
export async function flushMemoryRender(projectRoot: string, limit: number = MAX_MEMORY_CHARS): Promise<FlushResult> {
	const journal = memoryJournalFile(projectRoot);
	const file = memoryFile(projectRoot);
	if (!(await stat(journal).catch(() => undefined))) return { adopted: false, written: false };
	return await withMemoryLock(file, async () => {
		// An edit can land between an adopt read and the write below; adopt repeatedly to shrink that window,
		// and see the recheck before the write for the bytes that outran this loop.
		let adopted = false;
		for (let pass = 0; pass < 3 && (await adoptExternalEdit(projectRoot, limit)); pass++) adopted = true;
		const state = await readMemoryJournal(journal);
		if (state.unreadable) throw new Error(`memory journal exists but cannot be read: ${journal}`);
		const folded = foldMemoryJournal(state.entries, limit);
		if (!folded) {
			// Every line was damaged; the read path reports that state as unreadable, so leave a trace too.
			if (state.damaged > 0) await logError(projectRoot, "memory", "the memory journal holds no readable entry; the exit flush left the render alone").catch(() => {});
			return { adopted, written: false };
		}
		const onDisk = await readOptional(file);
		const onDiskKey = renderKeyOf(onDisk, limit);
		if (onDiskKey && onDiskKey === memoryComparisonKey(folded, limit)) return { adopted, written: false };
		// Missing (nothing to keep), or a render the journal already supersedes (older, or torn). An edit
		// that outran the adopt loop is newer than the journal, so it is folded in and left alone instead of
		// being published over: the flush never replaces a render newer than the journal. The residual
		// window is the one every write path has - an edit landing after this stat and before the write.
		if (onDiskKey) {
			const [renderInfo, journalInfo] = await Promise.all([stat(file).catch(() => undefined), stat(journal).catch(() => undefined)]);
			if (renderInfo && journalInfo && renderInfo.mtimeMs > journalInfo.mtimeMs) {
				await appendMemoryOp(journal, "replace", onDiskKey);
				await logError(projectRoot, "memory", "adopted an externally edited MEMORY.md into the memory journal");
				return { adopted: true, written: false };
			}
		}
		// Every other memory write backs the file up first; this one is no exception.
		await backupMemoryBeforeWrite(file);
		await ensureMemoryGitignore(memoryDir(projectRoot));
		await writeAtomic(file, folded);
		return { adopted, written: true };
	});
}

/**
 * Record one consolidated document: keep a pre-journal project's current memory as the journal's
 * base, append the new replacement, collapse the journal when it grew too large and render
 * `MEMORY.md`. Callers hold the memory lock and have already backed up the current render.
 *
 * `options.basisKey` is the memory this pass's reply was built from. When the stored document no
 * longer matches it, the reply is not published: whatever landed meanwhile is the newer information, and
 * the next pass consolidates from it. Omitting the option keeps the previous behaviour.
 */
export async function recordMemoryDocument(
	projectRoot: string,
	text: string,
	limit: number = MAX_MEMORY_CHARS,
	options: { preserveMarker?: boolean; basisKey?: string } = {},
): Promise<MemoryWriteResult> {
	const file = memoryJournalFile(projectRoot);
	const base = await readMemoryJournal(file);
	if (base.unreadable) throw new Error(`memory journal exists but cannot be read: ${file}`);
	// Read the render once, up front: the adoption below and the pre-publish check must compare the
	// same bytes, and an empty document is not a key at all.
	const renderRaw = await readOptional(memoryFile(projectRoot));
	const renderKey = renderKeyOf(renderRaw, limit);
	if (base.entries.length > 0) await adoptExternalEdit(projectRoot, limit, { journal: base, renderKey });
	// The reply was built from this baseline. When the stored memory moved on while the model was
	// writing, publishing the reply would overwrite that newer content, so keep it instead. Both
	// sides are compared as keys: the read path returns the fold when a journal exists and the raw
	// clip when it does not, so the same bytes can wear two shapes.
	const current = await loadMemory(projectRoot, limit);
	if (options.basisKey !== undefined && current.text.trim()
		&& memoryComparisonKey(current.text, limit) !== memoryComparisonKey(options.basisKey, limit)) {
		await logError(projectRoot, "memory", "the memory changed while this pass's reply was being built; the reply was not published and the newer content stays effective");
		return { written: false, kept: current.text };
	}
	if (base.entries.length === 0) {
		// First journal write for this project: start history from the memory it has today. The
		// legacy read path also decodes a stored reply, so the journal never stores raw JSON.
		const existing = await loadMemory(projectRoot, limit);
		if (existing.unreadable) throw new Error(`memory exists but cannot be read: ${existing.source}`);
		if (existing.text.trim()) await appendMemoryOp(file, "replace", normalizeMemoryDocument(existing.text, limit));
	}
	// A fresh model reply drops a marker it copied out of the stored render (it describes an older
	// clip); a legacy import keeps its own marker, which is the only trace that the file was capped.
	const rendered = options.preserveMarker ? normalizeMemoryDocument(text, limit) : normalizeMemoryReply(text, limit);
	// The window between the check above and this append: an edit landing here is newer than the
	// reply too, so keep it in history and let the next pass consolidate from it.
	const nowKey = renderKeyOf(await readOptional(memoryFile(projectRoot)), limit);
	if (options.basisKey !== undefined && nextRenderSupersedes(renderKey, nowKey, memoryComparisonKey(rendered, limit))) {
		await appendMemoryOp(file, "replace", nowKey);
		await logError(projectRoot, "memory", "an external edit landed while this pass's memory write was being prepared; the reply was not published");
		return { written: false, kept: (await loadMemory(projectRoot, limit)).text };
	}
	await appendMemoryOp(file, "replace", rendered);
	await rotateMemoryJournalIfNeeded(projectRoot);
	await ensureMemoryGitignore(memoryDir(projectRoot));
	await writeAtomic(memoryFile(projectRoot), rendered);
	return { written: true };
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
	// No journal at all. A rotation archive is still evidence of what the document was — the previous
	// bytes are copied there — so prefer it over a render the journal had already superseded. This is
	// the recovery path for a journal deleted by hand, and the second net under the rotation window.
	const archive = await newestMemoryArchive(projectRoot);
	if (archive) {
		const archived = await readMemoryJournal(archive);
		const recovered = foldMemoryJournal(archived.entries, limit);
		if (recovered) return { text: recovered, source: archive, poisoned: false, damaged: archived.damaged };
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
