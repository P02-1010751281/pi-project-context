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
/** The comparison key of a rendered memory document: what "the same memory" means across writers. */
export function renderKeyOf(raw: string, limit: number): string {
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
/**
 * Fold an edit made outside the extension into the journal, and report whether one was folded. Exported
 * because the borrowed-key path is otherwise only reachable through a race or through a whole write pass.
 */
export async function adoptExternalEdit(
	projectRoot: string,
	limit: number = MAX_MEMORY_CHARS,
	preRead: { journal?: Awaited<ReturnType<typeof readMemoryJournal>>; renderKey?: string } = {},
): Promise<boolean> {
	const file = memoryJournalFile(projectRoot);
	const base = preRead.journal ?? (await readMemoryJournal(file));
	if (base.unreadable) throw new Error(`memory journal exists but cannot be read: ${file}`);
	if (base.entries.length === 0) return false;
	// Every key this function journals is checked against the file's bytes twice, and the second check is the
	// one that guards the append:
	//  - a caller's key (the write path's, read before the model call) may be stale by now, so it decides
	//    against this call's own consistent read rather than against a fresh stat of the path;
	//  - a key read here may be stale by the time the append runs, so nothing is appended that the file no
	//    longer holds. A stale key would push the journal's mtime past the newer edit and shadow it forever.
	// The residual window (the last read to the append) is the one every write path in this module has.
	const read = await readRenderWithMtime(memoryFile(projectRoot));
	const renderKey = preRead.renderKey ?? renderKeyOf(read.text, limit);
	if (!renderKey) return false;
	if (renderKey === foldMemoryJournal(base.entries, limit)) return false;
	const journalInfo = await stat(file).catch(() => undefined);
	if (!renderIsNewerThanJournal(read.mtimeMs, journalInfo?.mtimeMs)) return false;
	const verify = await readRenderWithMtime(memoryFile(projectRoot));
	if (verify.changed || renderKeyOf(verify.text, limit) !== renderKey) {
		await logError(projectRoot, "memory", "a newer external edit arrived before the memory journal could record one; both were left for the next pass");
		return false;
	}
	await appendMemoryOp(file, "replace", renderKey);
	// Keep a trace of which pass folded in an edit that was made outside the extension.
	await logError(projectRoot, "memory", "adopted an externally edited MEMORY.md into the memory journal");
	return true;
}

/** What a model-free flush did: folded an external edit in, and/or rewrote a drifted render. */
export type FlushResult = { adopted: boolean; written: boolean };

/** Whether the render's time is strictly ahead of the journal's: bytes the journal has not absorbed yet. */
function renderIsNewerThanJournal(renderMtimeMs: number | undefined, journalMtimeMs: number | undefined): boolean {
	return renderMtimeMs !== undefined && journalMtimeMs !== undefined && renderMtimeMs > journalMtimeMs;
}

/**
 * Read the render with mtimes taken around the read, so its bytes and its time describe one version.
 * Exported for the race that no ordinary fixture can produce: a replacement landing inside the read.
 */
export async function readRenderWithMtime(file: string): Promise<{ text: string; mtimeMs?: number; changed: boolean }> {
	const before = await stat(file).catch(() => undefined);
	const text = await readOptional(file);
	const after = await stat(file).catch(() => undefined);
	// A file replaced under the read would give the key of one version and the time of another, so the
	// caller must journal neither and overwrite neither. The test is mtime + size: a replacement that keeps
	// both (a same-size edit inside the filesystem's timestamp granularity) stays invisible here, which is
	// the accepted residual. It is the caller's decision from there, and the two write paths differ: the
	// journal append is guarded by the append-time recheck in adoptExternalEdit, the publish side by this flag.
	const changed = Boolean(after) && (before?.mtimeMs !== after.mtimeMs || before?.size !== after.size);
	return { text, mtimeMs: after?.mtimeMs, changed };
}

/**
 * What the exit flush does with the render it just read. A pure decision so a test can drive every
 * ordering without a concurrent writer: `recheck` when the file changed under the read (neither the
 * journal nor the file may be touched), `none` when the file already carries the fold, `keep` when the
 * render is newer than the journal (journal the edit, leave the bytes alone), and `publish` when the
 * render is missing or the journal is at least as new as it (write the fold).
 */
export function flushActionFor(
	renderKey: string,
	renderMtimeMs: number | undefined,
	journalMtimeMs: number | undefined,
	foldKey: string,
	changed: boolean,
): "none" | "keep" | "publish" | "recheck" {
	if (changed) return "recheck";
	// No render at all: there is nothing to keep, and the fold is what belongs on disk.
	if (!renderKey) return "publish";
	if (renderKey === foldKey) return "none";
	return renderIsNewerThanJournal(renderMtimeMs, journalMtimeMs) ? "keep" : "publish";
}

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
 * when the file is missing or the journal is at least as new as it; a render the journal has not yet
 * absorbed is journaled and left on disk exactly as it was found (an over-cap hand edit keeps its own
 * bytes, the journal holding the clipped key). A clean exit writes nothing.
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
		const [render, journalInfo] = await Promise.all([readRenderWithMtime(file), stat(journal).catch(() => undefined)]);
		const renderNow = renderKeyOf(render.text, limit);
		const action = flushActionFor(renderNow, render.mtimeMs, journalInfo?.mtimeMs, memoryComparisonKey(folded, limit), render.changed);
		if (action === "recheck") {
			await logError(projectRoot, "memory", "the memory render changed while the exit flush was reading it; it was left for the next pass").catch(() => {});
			return { adopted, written: false };
		}
		if (action === "none") return { adopted, written: false };
		if (action === "keep") {
			// An edit that outran the adopt loop: journal it, and never publish a fold over it.
			await appendMemoryOp(journal, "replace", renderNow);
			await logError(projectRoot, "memory", "adopted an externally edited MEMORY.md into the memory journal");
			return { adopted: true, written: false };
		}
		// The render is missing, or the journal is at least as new as it: republish the fold. Every other
		// memory write backs the file up first; this one is no exception.
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
		// One consistent read: the render's bytes and its time describe one version, so an edit that lands
		// under the read cannot be adopted as the older bytes carrying the newer file's mtime (residual R-L1).
		// A read that spans a replacement (`changed`) decides nothing here - the journal's fold stands - because
		// this path must not pick a version it cannot vouch for; the next write re-reads and adopts then.
		const renderRead = await readRenderWithMtime(target);
		if (renderRead.text.trim() && !renderRead.changed) {
			// Both sides are compared in normalized form: `foldMemoryJournal` returns a normalized
			// document, so a raw trimmed render would never compare equal and the mtime would
			// silently become the only rule (adopting our own output as if it were an edit).
			const external = memoryComparisonKey(renderRead.text, limit);
			const journalInfo = await stat(journal).catch(() => undefined);
			// An empty key means the render was cleared by hand; the journal stays authoritative.
			if (external && external !== view && renderRead.mtimeMs !== undefined && journalInfo && renderRead.mtimeMs > journalInfo.mtimeMs) {
				return { text: external, source: target, poisoned: Boolean(decodePoisonedMemory(renderRead.text.trim(), limit)), damaged: journalState.damaged };
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
