/**
 * The pass's outcome surface: the clipped notices, the last-write bookkeeping, the once-per-
 * project warnings, and the hook registration the extension entry calls.
 */

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { classifyModelFailure, modelAutoDisabled, modelCooldownRemaining } from "../shared/call-policy.ts";
import { getConfig, DEFAULT_CONFIG, runIsDisabled, setFeature, takeConfigMigrationNotice, updateConfig } from "../shared/config.ts";
import { completeValues, completeVerbs } from "../shared/complete.ts";
import { MAX_LIST_ENTRIES, MAX_LIST_ITEM_CHARS, MAX_MEMORY_CHARS_LIMIT, MIN_MEMORY_CHARS } from "../shared/limits.ts";
import { capCeilingWarning, memoryCapUnsatisfiable } from "../shared/output-budget.ts";
import { backupMemoryBeforeWrite, contextFile, errorText, exceedsMemoryCap, flushMemoryRender, getProjectRoot, loadMemory, logError, memoryDir, memoryDocumentChars, memoryFile, migrateProjectState, notify, readOptional, recordMemoryDocument, withMemoryLock, writeAtomic } from "../shared/project-state.ts";
import { fallbackUpdate, renderContextDocument } from "./context-doc.ts";
import { contextTruncationDropped } from "./context-schema.ts";
import { consolidateProjectState, type ConsolidateOutcome, type RemovedEntries } from "./pass.ts";
import { memoryStatusLevel, memoryStatusLine, contextStatusLine } from "./status.ts";
import { buildMemoryInjection } from "./injection.ts";

/**
 * Which root may take the error log when a `session_shutdown` write fails: the project root when it is
 * known, and the session cwd only when the memory layer is already there. The check names the directory
 * `logError` writes into, not its parent - `.agents` alone is not the memory layer - so an arbitrary
 * directory never gets a stray `.agents/memory/` created inside it.
 */
export function shutdownErrorRoot(projectRoot: string | undefined, cwd: string): string | undefined {
	return projectRoot ?? (existsSync(join(cwd, ".agents", "memory")) ? cwd : undefined);
}

/** Info about the newest memory write, so explicit commands can point at the backup. */
type LastWriteInfo = {
	backup?: string;
	repaired: boolean;
	/** The opaque entry's whole-document cap dropped the middle (a marker still says so). */
	capped?: boolean;
	/** A section-based reply lost entries, or had one cut to its per-item cap, because the cap was reached. */
	sectionsCapped?: boolean;
	/** The composed section-cap sentence, so the log and the command reply read the same. */
	capNote?: string;
	/** Whole entries went, not just a per-item cut: the difference between a cap event and a trimmed line. */
	entriesDropped?: boolean;
	/** The reply was not written for this reason, so the stored memory was kept. */
	memoryKept?: boolean;
	/** Which reason that was: nothing to store, too short to be a change, or a newer memory on disk. */
	keepReason?: "empty" | "short" | "stale";
	/** Whether CONTEXT.md was written this pass. Only the stale refusal reads it: a kept memory must
	 * not claim a context update it did not make. */
	contextWritten?: boolean;
	/** Invariants/Pitfalls entries the previous memory had and this one does not. */
	removed?: RemovedEntries;
};

const lastWrite = new Map<string, LastWriteInfo>();

/** Projects already told that the model answers the context section in an unusable shape. */
const contextShapeWarned = new Set<string>();

/** Projects already told that the memory render hit its character cap (the opaque entry). */
const memoryCapWarned = new Set<string>();

/** Projects already told that a section gave up entries. Separate from the cap above: the two are
 * different events, and one shared set let whichever fired first silence the other's log entry. */
const memorySectionCapWarned = new Set<string>();

/** Projects already told that a consolidation dropped Invariants/Pitfalls entries. */
const memoryRemovalWarned = new Set<string>();

/**
 * Keep a local, gitignored copy of a reply the cap is about to clip.
 *
 * The sectioned and parseable entries drop whole entries through the renderer and report what went,
 * and the opaque entry keeps both ends of the text — but the middle it drops is gone for good. This
 * is best-effort on purpose: the capped write and its warning must still happen if the copy fails.
 */
async function saveOverflowReply(projectRoot: string, text: string): Promise<string | undefined> {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const file = `${memoryDir(projectRoot)}/memory-overflow-${stamp}.md`;
	try {
		await writeAtomic(file, `${text}\n`);
		return file;
	} catch (error) {
		await logError(projectRoot, "memory", `an over-cap reply was clipped and could not be kept locally: ${errorText(error)}`);
		return undefined;
	}
}

/**
 * The cap sentence a person reads: what the cap cost, with the dropped entries inlined.
 *
 * The samples are here rather than behind a pointer because the errors.log line is written once per project per
 * process: a later pass cannot promise its own entries are in that file, and naming them inline is true every
 * time (review R5).
 */
function capSentenceFor(outcome: ConsolidateOutcome): string {
	const sentence = sectionCapSentence(outcome);
	if (outcome.droppedItems === 0 || outcome.droppedSamples.length === 0) return sentence;
	return `${sentence}. Dropped, e.g. ${outcome.droppedSamples.join(" | ")}`;
}

/** The cap sentence for a section-based reply, naming only the components that triggered it. */
function sectionCapSentence(outcome: ConsolidateOutcome): string {
	const parts: string[] = [];
	if (outcome.sectionDropped > 0) {
		// The per-section shares are targets, so entries only go when the document itself is full; saying
		// "a section exceeded its budget" would point the reader at a number that is not a limit any more.
		// The cause stays out of this clause: the log line and the notices already name it, and repeating it
		// reads as two different reasons (review R3).
		parts.push(`${outcome.droppedItems} whole entry(ies) were dropped from ${outcome.sectionDropped} section(s)`);
	}
	if (outcome.itemTruncated > 0) {
		// An entry can be truncated and then dropped, so both counts appearing is not a contradiction —
		// and a truncation on its own is not a document-cap event, so the sentence says only what happened.
		parts.push(`${outcome.itemTruncated} entry(ies) were cut to their section's per-item cap (a cut entry may also be dropped)`);
	}
	return parts.join("; ");
}

/** Projects already told that the CONTEXT.md render clipped an over-budget section. */
const contextCapWarned = new Set<string>();

/** Projects already told that repeated auxiliary-model failures parked the automatic pass. */
const disablesAnnounced = new Set<string>();

/**
 * Register the consolidation hooks and commands. Registered after the archive hooks so the
 * settle-time archive write is queued before a pass starts.
 */
export function registerConsolidation(pi: ExtensionAPI): void {
	/** Last consolidation-pass version each project's artifacts were written from. */
	const written = new Map<string, number>();

	async function memoryEnabled(ctx: ExtensionContext): Promise<{ enabled: boolean; root?: string }> {
		if (runIsDisabled()) return { enabled: false };
		try {
			const projectRoot = await getProjectRoot(pi, ctx.cwd);
			return { enabled: (await getConfig(projectRoot)).memoryEnabled, root: projectRoot };
		} catch {
			return { enabled: false };
		}
	}

	async function consolidate(ctx: ExtensionContext, force: boolean, silent = false): Promise<ConsolidateReport> {
		// Resolving the project root reads ctx.cwd, which throws if the session was
		// replaced or reloaded while this pass was pending. Never let that reject:
		// agent_settled calls this without awaiting.
		let projectRoot: string | undefined;
		let claimed = false;
		let wroteMemory = false;
		try {
			projectRoot = await getProjectRoot(pi, ctx.cwd);
			// A new pass must not let an explicit command quote the previous pass's backup or repair.
			lastWrite.delete(projectRoot);
			if (!force) {
				const { enabled } = await memoryEnabled(ctx);
				if (!enabled) return "unchanged";
			}
			const outcome = await consolidateProjectState(pi, ctx, { force });
			if (!outcome || (written.get(projectRoot) ?? 0) >= outcome.version) return "deduped";
			// Claim the version before any await so a concurrent pass cannot write the same pass twice.
			written.set(projectRoot, outcome.version);
			claimed = true;
			// The cap the write path renders with; the pass itself resolved the same config just now.
			const maxMemoryChars = (await getConfig(projectRoot)).maxMemoryChars;
			const memoryText = outcome.result.memory.trim();
			// A reply with no content is not a change on either entry: for the sectioned path that is a bare
			// four-heading skeleton, for the opaque path a document that is nothing but headings. The opaque
			// path additionally keeps its length rule, because there the text is normally the memory re-emitted.
			const sectioned = outcome.kind !== "fallback-opaque";
			const memoryChanged = !outcome.semanticEmpty && (sectioned || memoryText.length >= 40);
			const existingContext = await readOptional(contextFile(projectRoot));
			const update = outcome.result.context ?? (existingContext.trim() ? undefined : fallbackUpdate(ctx));
			if (outcome.result.contextUnusable && !contextShapeWarned.has(projectRoot)) {
				// A model that answers in another shape would otherwise leave CONTEXT.md stale for
				// days without a trace: nothing failed, so nothing was logged anywhere.
				contextShapeWarned.add(projectRoot);
				const kept = existingContext.trim() ? "the previous CONTEXT.md is kept" : "only a placeholder context was written";
				await logError(projectRoot, "memory", `the consolidation reply carried a context section that could not be used (expected an object with title/summary/key_points/open_tasks); ${kept}`);
			} else if (!outcome.result.context && existingContext.trim() && !contextShapeWarned.has(projectRoot)) {
				// Same failure class, one step further back: no context member at all. The reply was either
				// cut off at the output cap (the memory alone filled it) or simply left the section out;
				// either way the kept CONTEXT.md ages silently, which is how it stayed a day behind.
				contextShapeWarned.add(projectRoot);
				await logError(
					projectRoot,
					"memory",
					`the consolidation reply carried no context section${outcome.result.recovered ? " (its object never closed, so only memory_markdown could be recovered)" : ""}; the previous CONTEXT.md is kept and stays stale until a pass returns one`,
				);
			}
			let backup: string | undefined;
			let storedPoisoned = false;
			let cappedMemory = false;
			let cappedSections = false;
			// The reply was built from a memory that has since changed, so it was not published: nothing
			// below may describe a write that did not happen.
			let memoryRefused = false;
			// Declared at this scope: the non-silent toast below needs it, and the write is conditional.
			let neededChars = 0;
			let overflowPath: string | undefined;
			if (memoryChanged) {
				// Always keep the bytes that are on disk right now, whatever this pass believed
				// earlier; the lock keeps another process from replacing them mid-write. The journal
				// is the source of truth: this pass appends its document, then MEMORY.md is rendered.
				const snapshot = await withMemoryLock(memoryFile(projectRoot), async () => {
					const kept = await backupMemoryBeforeWrite(memoryFile(projectRoot));
					const result = await recordMemoryDocument(projectRoot, memoryText, maxMemoryChars, { basisKey: outcome.basisKey });
					return { ...kept, written: result.written };
				});
				backup = snapshot.path;
				storedPoisoned = snapshot.poisoned;
				// The claim is released only when this pass did not land a new MEMORY.md.
				wroteMemory = snapshot.written;
				memoryRefused = !snapshot.written;
				if (!memoryRefused) {
					// Before anything is clipped: on the opaque entry the cap keeps both ends and drops the
					// middle, and those bytes are otherwise unrecoverable. The other two entries drop whole
					// entries through the renderer, which reports them, so only this one needs the copy — and
					// only once the document it belongs to actually landed.
					if (!sectioned && exceedsMemoryCap(memoryText, maxMemoryChars)) {
						overflowPath = await saveOverflowReply(projectRoot, memoryText);
					}
					// The section counts are the durable trace of what the cap gave up: the renderer writes no
					// marker (the write path would strip it), so these counts are all there is.
					cappedSections = outcome.sectionDropped > 0 || outcome.itemTruncated > 0;
					cappedMemory = !sectioned && exceedsMemoryCap(memoryText, maxMemoryChars);
					// Only the opaque entry still needs a number: under section shares the smallest workable cap is
					// not an integer (4009.33 for one probe), and `/memory max-memory` only rounds, so a
					// suggested value would simply be clipped again.
					if (cappedMemory) neededChars = Math.max(MIN_MEMORY_CHARS, Math.min(memoryDocumentChars(memoryText), MAX_MEMORY_CHARS_LIMIT));
					if (storedPoisoned) {
						await logError(projectRoot, "memory", `replaced a stored JSON reply with markdown; original kept at ${backup ?? "(none)"}`);
					}
					// The line is once per project per process, so a later pass in the same process must not
					// claim its own dropped entries reached the log. Whether this pass wrote them is the fact the
					// notices branch on (review R4).
					if (cappedSections && !memorySectionCapWarned.has(projectRoot)) {
						memorySectionCapWarned.add(projectRoot);
						// Only a drop means the document hit its cap; a lone per-item cut is a bounded line, so it
						// must not be told as a cap event or point at a drop list that does not exist.
						await logError(
							projectRoot,
							"memory",
							outcome.droppedItems > 0
								? `memory document reached its cap: ${sectionCapSentence(outcome)}; dropped entries (first ${outcome.droppedSamples.length}): ${outcome.droppedSamples.join(" | ") || "(none recorded)"}`
								: `memory: ${sectionCapSentence(outcome)}`,
						);
					} else if (cappedMemory && !memoryCapWarned.has(projectRoot)) {
						// A marker nobody reads is still a silent loss: say it once per project per process,
						// and point at the knob that lifts the cap.
						memoryCapWarned.add(projectRoot);
						await logError(
							projectRoot,
							"memory",
							`memory exceeded maxMemoryChars (${maxMemoryChars}): both ends were kept and the middle dropped on a line boundary; the reply needed about ${neededChars} characters — raise it with /memory max-memory ${neededChars} (or trim MEMORY.md)${overflowPath ? `; the unclipped reply is kept at ${overflowPath}` : ""}`,
						);
					}
				}
			}
			// Set even when the memory was kept: a command words its reply from this, and "no memory write"
			// must not read as "nothing happened" when the context was rewritten.
			lastWrite.set(projectRoot, {
				backup,
				repaired: !memoryRefused && storedPoisoned,
				capped: cappedMemory,
				sectionsCapped: cappedSections,
				...(cappedSections ? { capNote: capSentenceFor(outcome), entriesDropped: outcome.droppedItems > 0 } : {}),
				contextWritten: Boolean(update),
				// The reply was not written for whatever reason — kept because it was empty, because it was
				// too short to be a change, or because the memory moved on while it was being built. Either
				// way the reply must not claim a write, and it must not claim the wrong reason either: a
				// short reply did carry text, and a refused one carried a stale document.
				memoryKept: !memoryChanged || memoryRefused,
				...(memoryRefused
					? { keepReason: "stale" as const }
					: !memoryChanged
						? { keepReason: outcome.semanticEmpty ? ("empty" as const) : ("short" as const) }
						: {}),
				// Entries only disappeared if the document that dropped them was published.
				...(memoryRefused ? {} : outcome.removed ? { removed: outcome.removed } : {}),
			});
			if (update) {
				const contextDocument = renderContextDocument(update, { updatedAt: new Date().toISOString() });
				await writeAtomic(contextFile(projectRoot), contextDocument);
				const dropped = contextTruncationDropped(contextDocument);
				if (dropped !== undefined && !contextCapWarned.has(projectRoot)) {
					// The marker is the durable trace; say it once per project per process, like the memory cap.
					contextCapWarned.add(projectRoot);
					await logError(projectRoot, "memory", `CONTEXT.md was clipped (a section budget, the ${MAX_LIST_ITEM_CHARS}-character item cap, or the ${MAX_LIST_ENTRIES}-entry list cap); ${dropped} characters were dropped`);
				}
			}
			const report: ConsolidateReport = memoryChanged || update ? (outcome.clipped ? "clipped" : "updated") : "unchanged";
			if (outcome.clipped && !memoryRefused && (memoryChanged || update)) {
				// Always leave a trace: the UI warning below is a no-op headless, and commands report separately.
				await logError(projectRoot, "memory", "consolidation shortened the existing memory or context to fit the model output budget");
			}
			if (!silent && (memoryChanged || update)) {
				const clippedNote = report === "clipped" ? " The rewrite also shortened the content to fit the model output budget." : "";
				if (memoryRefused) {
					// Nothing was published, so nothing here may claim it was. The command reply carries the
					// same sentence, so the two can never drift.
					notify(ctx, staleKeepSentence(Boolean(update)), "warning");
				} else if (!memoryChanged) {
					// The memory was not written, so nothing here may claim it was — not even the clipped notice,
					// which describes a rewrite that did not happen. This is decision 6's wording rule.
					notify(ctx, `Memory: context updated; memory was kept unchanged.${clippedNote}`);
				} else if (storedPoisoned) {
					const capNote = cappedMemory
						? ` It also hit its ${maxMemoryChars}-character cap; both ends were kept and the middle was dropped on a line boundary.`
						: cappedSections
							? outcome.droppedItems > 0
								? ` It also reached the memory document's character cap: ${sectionCapSentence(outcome)}.`
								: ` It also had entries cut: ${sectionCapSentence(outcome)}.`
							: "";
					notify(ctx, `Memory: was raw JSON from the old bug, and is now Markdown${backup ? ` (backup: ${backup})` : ""}.${capNote}${clippedNote}`, "warning");
				} else if (cappedSections) {
					notify(
						ctx,
						// A lone per-item cut is not a cap event, and pointing at a drop list that does not exist
						// would send the reader to nothing.
						outcome.droppedItems > 0
							? `Memory: updated, but the document reached its character cap: ${capSentenceFor(outcome)}.${clippedNote}`
							: `Memory: updated; ${sectionCapSentence(outcome)}.${clippedNote}`,
						"warning",
					);
				} else if (cappedMemory) {
					notify(
						ctx,
						`Memory: hit its ${maxMemoryChars}-character cap: both ends were kept, the middle was dropped on a line boundary, and MEMORY.md ends with a truncation marker (the reply needed about ${neededChars} chars). Raise it with /memory max-memory ${neededChars} or trim it.${overflowPath ? ` The unclipped reply is kept at ${overflowPath}.` : ""}`,
						"warning",
					);
				} else if (report === "clipped") {
					notify(ctx, backup ? `${CLIPPED_NOTICE} Previous file: ${backup}.` : CLIPPED_NOTICE_NO_WRITE, "warning");
				} else notify(ctx, `Memory: updated ${memoryFile(projectRoot)}`);
			}
			if (!silent && !memoryRefused && outcome.removed && outcome.removed.count > 0 && !memoryRemovalWarned.has(projectRoot)) {
				// The guard cannot tell a deliberate rewrite from a silent loss, so it reports and never blocks;
				// once per project per process, with the durable list in errors.log.
				memoryRemovalWarned.add(projectRoot);
				notify(
					ctx,
					`Memory: no longer carries ${outcome.removed.count} Invariants/Pitfalls entry(ies), e.g. ${outcome.removed.samples.join(" | ")}. Review .agents/memory/errors.log if that was not intended.`,
					"warning",
				);
			}
			return report;
		} catch (error) {
			// Release the claim only when this pass did not land a new MEMORY.md: a failure after
			// that write must not let a cached outcome replay over newer memory content.
			if (claimed && !wroteMemory && projectRoot) written.delete(projectRoot);
			if (projectRoot) await logError(projectRoot, "memory", error);
			if (!silent) {
				// The message may carry a raw-reply dump for errors.log; the toast shows the headline only.
				const headline = errorText(error).split("\n", 1)[0];
				// The class-specific wording fits a provider failure while the route policy is armed; a
				// local failure (a lock timeout, an unreadable path) leaves it unarmed.
				const armed = projectRoot !== undefined && (modelCooldownRemaining("memory", projectRoot) > 0 || modelAutoDisabled("memory", projectRoot));
				notify(ctx, armed ? memoryFailureNotice(headline) : `Memory: update failed — ${headline}`, "warning");
				if (projectRoot && modelAutoDisabled("memory", projectRoot) && !disablesAnnounced.has(projectRoot)) {
					disablesAnnounced.add(projectRoot);
					notify(ctx, MEMORY_PAUSED_NOTICE, "warning");
				}
			}
			return "failed";
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		const projectRoot = await getProjectRoot(pi, ctx.cwd);
		try {
			const { maxMemoryChars } = await getConfig(projectRoot);
			// `getConfig` migrated a legacy layout on this first load; say so instead of rewriting the file silently.
			const migratedSources = takeConfigMigrationNotice(projectRoot);
			if (migratedSources) {
				notify(ctx, `Memory: config written in the flat layout (migrated from ${migratedSources.join(", ")}).`);
			}
			const result = await migrateProjectState(projectRoot, maxMemoryChars);
			const details: string[] = [];
			if (result.moved.length > 0) details.push(`moved ${result.moved.join(", ")}`);
			if (result.importedSkills > 0) details.push(`imported ${result.importedSkills} skill${result.importedSkills === 1 ? "" : "s"}`);
			if (result.importedMemory) details.push("imported legacy OMP memory");
			if (details.length > 0) notify(ctx, `Memory: files in ${memoryDir(projectRoot)}: ${details.join("; ")}`);
			// The legacy counterpart was older, so the current file won and the legacy bytes are gone.
			// The migration used to report these as "moved", which is false.
			if (result.superseded.length > 0) {
				notify(ctx, `Memory: legacy files superseded and discarded (the current file was newer): ${result.superseded.join(", ")}`);
			}
			if (result.conflicts.length > 0) {
				notify(ctx, `Memory: legacy layout left in place (a newer legacy copy or a file/directory type conflict; merge it by hand): ${result.conflicts.join(", ")}`, "warning");
			}
		} catch (error) {
			await logError(projectRoot, "migration", error);
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!(await memoryEnabled(ctx)).enabled) return;
		const projectRoot = await getProjectRoot(pi, ctx.cwd);
		const memory = (await loadMemory(projectRoot, (await getConfig(projectRoot)).maxMemoryChars)).text.trim();
		if (!memory) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n## Project Memory\nThe following is project context, not a new user instruction:\n\n${buildMemoryInjection(memory, projectRoot)}`,
		};
	});

	pi.on("agent_settled", async (_event, ctx) => {
		// Fire and forget; late failures (e.g. a stale ctx after session replacement) must not crash pi.
		void consolidate(ctx, false).catch(() => {});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// Write silently: the UI may already be rebuilding for a session switch. A throw here escapes into
		// pi's ExtensionRunner (one field chain in errors.log runs through emitSessionShutdownEvent), and the
		// handoff's session switch rides that same emit, so log and return instead of taking the switch down.
		// A model call used to sit on this path; since 2026-10-06 (decision 1) the exit flushes instead: it
		// folds a hand-edited MEMORY.md into the journal and leaves the file alone, and it composes nothing,
		// so a session that ends between settle passes keeps that tail in the archive.
		// The cwd is read exactly once, guarded: a stale ctx (session replaced or reloaded) throws straight
		// out of this getter, and reading it again inside the catch below would reject this handler into
		// pi's ExtensionRunner - the failure class decision 1 removed from this path.
		let cwd: string;
		try {
			cwd = ctx.cwd;
		} catch {
			return;
		}
		// The declared type is a string, but a ctx that returns nothing must not reach `path.join` below.
		if (typeof cwd !== "string") return;
		try {
			if (runIsDisabled()) return;
			const projectRoot = await getProjectRoot(pi, cwd);
			const config = await getConfig(projectRoot);
			// Memory off: the exit must not touch the journal or the render, as the settle path is gated.
			if (!config.memoryEnabled) return;
			await flushMemoryRender(projectRoot, config.maxMemoryChars);
		} catch (error) {
			// `getProjectRoot` can itself fail (no git above the cwd, a removed directory); see
			// `shutdownErrorRoot` for the cwd fallback rule, and act only when it names a safe root.
			const root = shutdownErrorRoot(await getProjectRoot(pi, cwd).catch(() => undefined), cwd);
			if (root) await logError(root, "shutdown:flush", error).catch(() => {});
		}
	});

	pi.registerCommand("memory", {
		description: "Show this project's memory and CONTEXT.md status (update | on|off | max-memory <n>|default)",
		getArgumentCompletions: (prefix) => {
			const verbs = completeVerbs(prefix, MEMORY_VERBS);
			if (verbs) return verbs;
			return completeValues(prefix, "max-memory", [{ value: "default" }]);
		},
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const verb = (parts[0] ?? "").toLowerCase();
			const projectRoot = await getProjectRoot(pi, ctx.cwd);
			if (verb === "update") {
				const report = await consolidate(ctx, true, true);
				notify(ctx, consolidateReply(report, lastWrite.get(projectRoot)), report === "failed" || report === "clipped" ? "warning" : "info");
				return;
			}
			if (verb === "on" || verb === "off") {
				await setFeature(projectRoot, "memory", verb === "on");
				notify(ctx, `Memory: automatic consolidation ${verb}.`);
				return;
			}
			if (verb === "max-memory") {
				// The cap sizes what this layer writes, so the verb lives here; the umbrella only keeps
				// what two or more layers share (its route and the feature batch).
				const value = (parts[1] ?? "").trim();
				const usage = `Usage: /memory max-memory <${MIN_MEMORY_CHARS}–${MAX_MEMORY_CHARS_LIMIT}> | default`;
				if (!value) {
					notify(ctx, usage, "warning");
					return;
				}
				if (value === "default") {
					await updateConfig(projectRoot, { maxMemoryChars: DEFAULT_CONFIG.maxMemoryChars });
				} else {
					const chars = Number(value);
					if (!Number.isFinite(chars) || chars < MIN_MEMORY_CHARS || chars > MAX_MEMORY_CHARS_LIMIT) {
						notify(ctx, usage, "warning");
						return;
					}
					await updateConfig(projectRoot, { maxMemoryChars: Math.round(chars) });
				}
				const config = await getConfig(projectRoot);
				if (memoryCapUnsatisfiable(config.maxMemoryChars, config.maxTokens, config.maxOutputTokens)) {
					notify(
						ctx,
						`Memory cap set to ${config.maxMemoryChars} characters, but ${capCeilingWarning(config)}; raise maxTokens/maxOutputTokens too or replies can be truncated.`,
						"warning",
					);
				} else {
					notify(ctx, `Memory: cap ${config.maxMemoryChars} characters.`);
				}
				return;
			}
			if (verb) {
				notify(ctx, `Unknown option "${verb}". Usage: /memory | update | on|off | max-memory <n>|default`, "warning");
				return;
			}
			const { maxMemoryChars } = await getConfig(projectRoot);
			const memory = await loadMemory(projectRoot, maxMemoryChars);
			// The CONTEXT.md line goes through the same helper the umbrella status uses, so the two
			// entry points print one wording; the memory line having been split off `/context` is why
			// this command now owns both lines.
			notify(
				ctx,
				`Memory: ${memoryStatusLine(memory, maxMemoryChars)}\nContext file: ${await contextStatusLine(projectRoot)}`,
				memoryStatusLevel(memory),
			);
		},
	});
}

/** Verbs the `memory` command accepts, for argument completion (mirrors the handler). */
const MEMORY_VERBS = [
	{ value: "update", description: "consolidate durable facts and the session context now" },
	{ value: "on", description: "enable automatic consolidation" },
	{ value: "off", description: "disable automatic consolidation" },
	{ value: "max-memory", description: "MEMORY.md character cap" },
];

/** What one consolidation attempt did, so the explicit commands can report truthfully. */
type ConsolidateReport = "updated" | "clipped" | "unchanged" | "deduped" | "failed";

/** Shown when the pass had to shorten stored content to fit the model output budget. */
const CLIPPED_NOTICE =
	"Memory: updated, but existing content was shortened to fit the model output budget; the previous MEMORY.md is kept as a backup in .agents/memory — review it if older details matter.";

/** The same notice for command replies, which cannot know whether a backup was written. */
const CLIPPED_NOTICE_NO_WRITE =
	"Memory: were updated, but existing content was shortened to fit the model output budget; review MEMORY.md, CONTEXT.md and the .agents/memory backups if older details matter.";

/** Shown once when repeated auxiliary-model failures park the automatic pass for the session. */
const MEMORY_PAUSED_NOTICE =
	"Memory: updates are paused for this session after repeated auxiliary-model failures. Fix the route with /project-context model, or retry by hand with /memory update.";

/** A toast headline that names the failure class instead of repeating a raw provider string. */
function memoryFailureNotice(headline: string): string {
	switch (classifyModelFailure(headline)) {
		case "quota":
			return `Memory: update paused — the auxiliary model is out of quota (${headline}). Configure a dedicated model with /project-context model, or wait for the quota to reset.`;
		case "auth":
			return `Memory: update paused — the auxiliary model rejected the credentials (${headline}). Fix them, or point the pass elsewhere with /project-context model.`;
		case "transient":
			return `Memory: update failed — ${headline} It will retry with backoff instead of on every turn.`;
		default:
			return `Memory: update failed — ${headline}`;
	}
}

/** The one sentence for a refused publish: the toast and the command reply both use it, so the two
 * cannot drift. `contextWritten` says whether CONTEXT.md was written anyway. */
function staleKeepSentence(contextWritten: boolean): string {
	return `${contextWritten ? "Memory: context updated; " : "Memory: "}kept the newer MEMORY.md you edited (this pass's reply was built from an older memory and was discarded).`;
}

/** Human-readable reply for one pass result; the pass also logs failures to errors.log. */
export function consolidateReply(report: ConsolidateReport, info?: LastWriteInfo): string {
	// A command-triggered pass is silent, so the guard's own toast never fires there: the reply has to
	// carry it, or removing entries from memory would be invisible on `/memory update`.
	const guard = info?.removed && info.removed.count > 0
		? `; no longer carries ${info.removed.count} Invariants/Pitfalls entry(ies), e.g. ${info.removed.samples.join(" | ")}; review .agents/memory/errors.log if that was not intended.`
		: "";
	if (report === "failed") return "Memory: update failed; see .agents/memory/errors.log.";
	// Decision 6's wording rule, and it outranks the clipped notice: the memory was not written, so
	// nothing may say it was — including "the rewrite shortened it".
	if (info?.memoryKept && report !== "unchanged") {
		if (info.keepReason === "stale") return `${staleKeepSentence(Boolean(info.contextWritten))}${guard}`;
		const clippedNote = report === "clipped" ? " The prompt also had to be shortened to fit the model output budget." : "";
		const why = info.keepReason === "short" ? "the reply was too short to be a change" : "the reply carried no entries";
		return `Memory: context updated; memory was kept unchanged (${why}).${clippedNote}${guard}`;
	}
	if (report === "clipped") {
		// Both events can land in one pass: the prompt was shortened for the output budget *and* the reply
		// hit the memory cap. The cap one is what the user has to act on, so it is said here too (review R3).
		const capNote = info?.capped
			? " It also hit its maxMemoryChars cap; both ends were kept and the middle was dropped."
			: info?.sectionsCapped
				? ` It also ${info.entriesDropped ? "reached the memory document's character cap" : "had entries cut"}: ${info.capNote ?? "the cap cut content"}.`
				: "";
		return `${info?.backup ? `${CLIPPED_NOTICE} Previous file: ${info.backup}.` : CLIPPED_NOTICE_NO_WRITE}${capNote}${guard}`;
	}
	if (report === "deduped") return "Memory: already up to date (deduped recently); nothing was rewritten.";
	if (report === "unchanged") return "Consolidation ran but produced no new memory or context.";
	if (info?.repaired && info.backup) {
		const capNote = info.capped
			? " It also hit its maxMemoryChars cap; both ends were kept and the middle was dropped on a line boundary."
			: info.sectionsCapped
				? info.entriesDropped
					? " It also reached the memory document's character cap, so whole entries were dropped."
					: " It also had entries cut to their per-item cap."
				: "";
		return `Memory: updated; the stored raw JSON reply was replaced (backup: ${info.backup}).${capNote}${guard}`;
	}
	if (info?.sectionsCapped) {
		// Same split as the automatic notice: only a drop is a cap event, and only then is there a drop
		// list to point at.
		return info.entriesDropped
			? `Memory: updated, but the document reached its character cap: ${info.capNote ?? "whole entries were dropped"}${guard}`
			: `Memory: updated; ${info.capNote ?? "entries were cut to their section's per-item cap"}${guard}`;
	}
	if (info?.capped) return `Memory: updated, but it is at its maxMemoryChars cap: both ends were kept and the middle was dropped. Raise it with /memory max-memory <n> or trim MEMORY.md.${guard}`;
	return `Memory: updated.${guard}`;
}
