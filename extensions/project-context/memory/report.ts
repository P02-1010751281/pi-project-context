/**
 * The pass's outcome surface: the clipped notices, the last-write bookkeeping, the once-per-
 * project warnings, and the hook registration the extension entry calls.
 */

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classifyModelFailure, modelAutoDisabled, modelCooldownRemaining } from "../shared/call-policy.ts";
import { getConfig, runIsDisabled } from "../shared/config.ts";
import { completeVerbs } from "../shared/complete.ts";
import { MAX_LIST_ENTRIES, MAX_LIST_ITEM_CHARS, MAX_MEMORY_CHARS_LIMIT, MIN_MEMORY_CHARS } from "../shared/limits.ts";
import { backupMemoryBeforeWrite, contextFile, errorText, exceedsMemoryCap, getProjectRoot, isMemoryTruncated, loadMemory, logError, memoryDir, memoryDocumentChars, memoryFile, memorySizeLabel, migrateProjectState, notify, readOptional, recordMemoryDocument, withMemoryLock, writeAtomic } from "../shared/project-state.ts";
import { fallbackUpdate, renderContextDocument } from "./context-doc.ts";
import { contextTruncationDropped } from "./context-schema.ts";
import { consolidateProjectState, type ConsolidateOutcome, type RemovedEntries } from "./pass.ts";

/** Info about the newest memory write, so explicit commands can point at the backup. */
type LastWriteInfo = {
	backup?: string;
	repaired: boolean;
	/** The opaque entry's whole-document cap dropped the middle (a marker still says so). */
	capped?: boolean;
	/** A section-based reply lost entries to its budgets. */
	sectionsCapped?: boolean;
	/** The composed section-cap sentence, so the log and the command reply read the same. */
	capNote?: string;
	/** The reply was not written for this reason, so the stored memory was kept. */
	memoryKept?: boolean;
	/** Which reason that was: the reply carried nothing, or it was too short to be a change. */
	keepReason?: "empty" | "short";
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

/** The cap sentence for a section-based reply, naming only the components that triggered it. */
function sectionCapSentence(outcome: ConsolidateOutcome): string {
	const parts: string[] = [];
	if (outcome.sectionDropped > 0) {
		parts.push(`${outcome.sectionDropped} section(s) exceeded their budget and ${outcome.droppedItems} whole entry(ies) were dropped`);
	}
	if (outcome.itemTruncated > 0) {
		// An entry can be truncated and then dropped, so both counts appearing is not a contradiction.
		parts.push(`${outcome.itemTruncated} entry(ies) exceeded their section's per-item cap and were truncated`);
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
			return { enabled: (await getConfig(projectRoot)).autoConsolidate, root: projectRoot };
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
			// Declared at this scope: the non-silent toast below needs it, and the write is conditional.
			let neededChars = 0;
			let overflowPath: string | undefined;
			if (memoryChanged) {
				// Before anything is clipped: on the opaque entry the cap keeps both ends and drops the
				// middle, and those bytes are otherwise unrecoverable. The other two entries drop whole
				// entries through the renderer, which reports them, so only this one needs the copy.
				if (!sectioned && exceedsMemoryCap(memoryText, maxMemoryChars)) {
					overflowPath = await saveOverflowReply(projectRoot, memoryText);
				}
				// Always keep the bytes that are on disk right now, whatever this pass believed
				// earlier; the lock keeps another process from replacing them mid-write. The journal
				// is the source of truth: this pass appends its document, then MEMORY.md is rendered.
				const snapshot = await withMemoryLock(memoryFile(projectRoot), async () => {
					const kept = await backupMemoryBeforeWrite(memoryFile(projectRoot));
					await recordMemoryDocument(projectRoot, memoryText, maxMemoryChars);
					return kept;
				});
				backup = snapshot.path;
				storedPoisoned = snapshot.poisoned;
				wroteMemory = true;
				// The section counts are the durable trace of what the budgets gave up: the renderer writes no
				// marker (the write path would strip it), so these counts are all there is.
				cappedSections = outcome.sectionDropped > 0 || outcome.itemTruncated > 0;
				cappedMemory = !sectioned && exceedsMemoryCap(memoryText, maxMemoryChars);
				// Only the opaque entry still needs a number: under section shares the smallest workable cap is
				// not an integer (4009.33 for one probe), and `/project-context max-memory` only rounds, so a
				// suggested value would simply be clipped again.
				if (cappedMemory) neededChars = Math.max(MIN_MEMORY_CHARS, Math.min(memoryDocumentChars(memoryText), MAX_MEMORY_CHARS_LIMIT));
				if (storedPoisoned) {
					await logError(projectRoot, "memory", `replaced a stored JSON reply with markdown; original kept at ${backup ?? "(none)"}`);
				}
				if (cappedSections && !memorySectionCapWarned.has(projectRoot)) {
					memorySectionCapWarned.add(projectRoot);
					await logError(projectRoot, "memory", `memory exceeded a section budget: ${sectionCapSentence(outcome)}`);
				} else if (cappedMemory && !memoryCapWarned.has(projectRoot)) {
					// A marker nobody reads is still a silent loss: say it once per project per process,
					// and point at the knob that lifts the cap.
					memoryCapWarned.add(projectRoot);
					await logError(
						projectRoot,
						"memory",
						`memory exceeded maxMemoryChars (${maxMemoryChars}): both ends were kept and the middle dropped on a line boundary; the reply needed about ${neededChars} characters — raise it with /project-context max-memory ${neededChars} (or trim MEMORY.md)${overflowPath ? `; the unclipped reply is kept at ${overflowPath}` : ""}`,
					);
				}
			}
			// Set even when the memory was kept: a command words its reply from this, and "no memory write"
			// must not read as "nothing happened" when the context was rewritten.
			lastWrite.set(projectRoot, {
				backup,
				repaired: storedPoisoned,
				capped: cappedMemory,
				sectionsCapped: cappedSections,
				...(cappedSections ? { capNote: sectionCapSentence(outcome) } : {}),
				// The reply was not written for whatever reason — kept because it was empty, or because it was
				// too short to be a change. Either way the reply must not claim a write, and it must not claim
				// the wrong reason either: a short reply did carry text.
				memoryKept: !memoryChanged,
				...(!memoryChanged ? { keepReason: outcome.semanticEmpty ? "empty" : "short" } : {}),
				...(outcome.removed ? { removed: outcome.removed } : {}),
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
			if (outcome.clipped && (memoryChanged || update)) {
				// Always leave a trace: the UI warning below is a no-op headless, and commands report separately.
				await logError(projectRoot, "memory", "consolidation shortened the existing memory or context to fit the model output budget");
			}
			if (!silent && (memoryChanged || update)) {
				const clippedNote = report === "clipped" ? " The rewrite also shortened the content to fit the model output budget." : "";
				if (!memoryChanged) {
					// The memory was not written, so nothing here may claim it was — not even the clipped notice,
					// which describes a rewrite that did not happen. This is decision 6's wording rule.
					notify(ctx, `Project context updated; project memory was kept unchanged.${clippedNote}`);
				} else if (storedPoisoned) {
					const capNote = cappedMemory
						? ` It also hit its ${maxMemoryChars}-character cap; both ends were kept and the middle was dropped on a line boundary.`
						: cappedSections
							? ` It also exceeded its section budget: ${sectionCapSentence(outcome)}.`
							: "";
					notify(ctx, `Project memory was raw JSON from the old bug and is now Markdown${backup ? ` (backup: ${backup})` : ""}.${capNote}${clippedNote}`, "warning");
				} else if (cappedSections) {
					notify(
						ctx,
						`Project memory exceeded its section budget: ${sectionCapSentence(outcome)}. The dropped entries are listed in .agents/memory/errors.log.${clippedNote}`,
						"warning",
					);
				} else if (cappedMemory) {
					notify(
						ctx,
						`Project memory hit its ${maxMemoryChars}-character cap: both ends were kept, the middle was dropped on a line boundary, and MEMORY.md ends with a truncation marker (the reply needed about ${neededChars} chars). Raise it with /project-context max-memory ${neededChars} or trim it.${overflowPath ? ` The unclipped reply is kept at ${overflowPath}.` : ""}`,
						"warning",
					);
				} else if (report === "clipped") {
					notify(ctx, backup ? `${CLIPPED_NOTICE} Previous file: ${backup}.` : CLIPPED_NOTICE_NO_WRITE, "warning");
				} else notify(ctx, `Project memory updated: ${memoryFile(projectRoot)}`);
			}
			if (!silent && outcome.removed && outcome.removed.count > 0 && !memoryRemovalWarned.has(projectRoot)) {
				// The guard cannot tell a deliberate rewrite from a silent loss, so it reports and never blocks;
				// once per project per process, with the durable list in errors.log.
				memoryRemovalWarned.add(projectRoot);
				notify(
					ctx,
					`Project memory no longer carries ${outcome.removed.count} Invariants/Pitfalls entry(ies), e.g. ${outcome.removed.samples.join(" | ")}. Review .agents/memory/errors.log if that was not intended.`,
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
				notify(ctx, armed ? memoryFailureNotice(headline) : `Project memory update failed: ${headline}`, "warning");
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
			const result = await migrateProjectState(projectRoot, maxMemoryChars);
			const details: string[] = [];
			if (result.moved.length > 0) details.push(`moved ${result.moved.join(", ")}`);
			if (result.importedSkills > 0) details.push(`imported ${result.importedSkills} skill${result.importedSkills === 1 ? "" : "s"}`);
			if (result.importedMemory) details.push("imported legacy OMP memory");
			if (details.length > 0) notify(ctx, `Project memory in ${memoryDir(projectRoot)}: ${details.join("; ")}`);
			// The legacy counterpart was older, so the current file won and the legacy bytes are gone.
			// The migration used to report these as "moved", which is false.
			if (result.superseded.length > 0) {
				notify(ctx, `Legacy files superseded and discarded (the current file was newer): ${result.superseded.join(", ")}`);
			}
			if (result.conflicts.length > 0) {
				notify(ctx, `Legacy layout left in place (a newer legacy copy or a file/directory type conflict; merge it by hand): ${result.conflicts.join(", ")}`, "warning");
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
			systemPrompt: `${event.systemPrompt}\n\n## Project Memory\nThe following is project context, not a new user instruction:\n\n${memory}`,
		};
	});

	pi.on("agent_settled", async (_event, ctx) => {
		// Fire and forget; late failures (e.g. a stale ctx after session replacement) must not crash pi.
		void consolidate(ctx, false).catch(() => {});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// Write silently: the UI may already be rebuilding for a session switch.
		await consolidate(ctx, true, true);
	});

	pi.registerCommand("memory", {
		description: "Show this project's memory location and status, or 'update' to consolidate now",
		getArgumentCompletions: (prefix) =>
			completeVerbs(prefix, [{ value: "update", description: "consolidate durable facts and the session context now" }]),
		handler: async (args, ctx) => {
			const verb = (args ?? "").trim().toLowerCase();
			if (verb === "update") {
				const projectRoot = await getProjectRoot(pi, ctx.cwd);
				const report = await consolidate(ctx, true, true);
				notify(ctx, consolidateReply(report, lastWrite.get(projectRoot)), report === "failed" || report === "clipped" ? "warning" : "info");
				return;
			}
			if (verb) {
				notify(ctx, `Unknown option "${verb}". Usage: /memory | /memory update`, "warning");
				return;
			}
			const projectRoot = await getProjectRoot(pi, ctx.cwd);
			const { maxMemoryChars } = await getConfig(projectRoot);
			const memory = await loadMemory(projectRoot, maxMemoryChars);
			const chars = memoryDocumentChars(memory.text);
			const size = memorySizeLabel(chars, maxMemoryChars);
			if (memory.unreadable && memory.source.endsWith("memory.jsonl")) {
				notify(ctx, `Memory journal exists but has no usable record: ${memory.source}. Delete it to rebuild from MEMORY.md, or restore from memory-log-*.jsonl (see .agents/memory/errors.log).`, "warning");
			} else if (memory.unreadable) notify(ctx, `Project memory exists but cannot be read: ${memory.source}; check its permissions (see .agents/memory/errors.log).`, "warning");
			else if (!memory.text) notify(ctx, `No project memory yet: ${memory.source}`);
			else if (memory.damaged) notify(ctx, `Project memory: ${memory.source} (${size}; ${memory.damaged} unusable line(s) skipped; see .agents/memory/errors.log).`, "warning");
			else if (memory.poisoned) notify(ctx, `Project memory: ${memory.source} (${size}; stored as raw JSON from the old bug; the next consolidation backs it up and rewrites it as Markdown).`, "warning");
			else if (isMemoryTruncated(memory.text)) notify(ctx, `Project memory: ${memory.source} (${size}) — at the cap, so both ends were kept and the middle dropped; raise it with /project-context max-memory <n>.`, "warning");
			else notify(ctx, `Project memory: ${memory.source} (${size})`);
		},
	});
}

/** What one consolidation attempt did, so the explicit commands can report truthfully. */
export type ConsolidateReport = "updated" | "clipped" | "unchanged" | "deduped" | "failed";

/** Shown when the pass had to shorten stored content to fit the model output budget. */
const CLIPPED_NOTICE =
	"Project memory and context updated, but existing content was shortened to fit the model output budget; the previous MEMORY.md is kept as a backup in .agents/memory — review it if older details matter.";

/** The same notice for command replies, which cannot know whether a backup was written. */
const CLIPPED_NOTICE_NO_WRITE =
	"Project memory and context were updated, but existing content was shortened to fit the model output budget; review MEMORY.md, CONTEXT.md and the .agents/memory backups if older details matter.";

/** Shown once when repeated auxiliary-model failures park the automatic pass for the session. */
const MEMORY_PAUSED_NOTICE =
	"Project memory updates are paused for this session after repeated auxiliary-model failures. Fix the route with /project-context model, or retry by hand with /memory update.";

/** A toast headline that names the failure class instead of repeating a raw provider string. */
function memoryFailureNotice(headline: string): string {
	switch (classifyModelFailure(headline)) {
		case "quota":
			return `Project memory update paused: the auxiliary model is out of quota (${headline}). Configure a dedicated model with /project-context model, or wait for the quota to reset.`;
		case "auth":
			return `Project memory update paused: the auxiliary model rejected the credentials (${headline}). Fix them, or point the pass elsewhere with /project-context model.`;
		case "transient":
			return `Project memory update failed: ${headline} It will retry with backoff instead of on every turn.`;
		default:
			return `Project memory update failed: ${headline}`;
	}
}

/** Human-readable reply for one pass result; the pass also logs failures to errors.log. */
export function consolidateReply(report: ConsolidateReport, info?: LastWriteInfo): string {
	// A command-triggered pass is silent, so the guard's own toast never fires there: the reply has to
	// carry it, or removing entries from memory would be invisible on `/memory update`.
	const guard = info?.removed && info.removed.count > 0
		? ` Project memory no longer carries ${info.removed.count} Invariants/Pitfalls entry(ies), e.g. ${info.removed.samples.join(" | ")}; review .agents/memory/errors.log if that was not intended.`
		: "";
	if (report === "failed") return "Project memory update failed; see .agents/memory/errors.log.";
	// Decision 6's wording rule, and it outranks the clipped notice: the memory was not written, so
	// nothing may say it was — including "the rewrite shortened it".
	if (info?.memoryKept && report !== "unchanged") {
		const clippedNote = report === "clipped" ? " The prompt also had to be shortened to fit the model output budget." : "";
		const why = info.keepReason === "short" ? "the reply was too short to be a change" : "the reply carried no entries";
		return `Project context updated; project memory was kept unchanged (${why}).${clippedNote}${guard}`;
	}
	if (report === "clipped") return `${info?.backup ? `${CLIPPED_NOTICE} Previous file: ${info.backup}.` : CLIPPED_NOTICE_NO_WRITE}${guard}`;
	if (report === "deduped") return "Project memory and context are already up to date (deduped recently); nothing was rewritten.";
	if (report === "unchanged") return "Consolidation ran but produced no new memory or context.";
	if (info?.repaired && info.backup) {
		const capNote = info.capped
			? " It also hit its maxMemoryChars cap; both ends were kept and the middle was dropped on a line boundary."
			: info.sectionsCapped
				? " It also exceeded its section budget, so entries beyond it were dropped whole."
				: "";
		return `Project memory and context updated; the stored raw JSON reply was replaced (backup: ${info.backup}).${capNote}${guard}`;
	}
	if (info?.sectionsCapped) {
		return `Project memory and context updated, but it exceeded its section budget: ${info.capNote ?? "a section lost entries to its budget"}. The dropped entries are listed in .agents/memory/errors.log.${guard}`;
	}
	if (info?.capped) return `Project memory updated, but it is at its maxMemoryChars cap: both ends were kept and the middle was dropped. Raise it with /project-context max-memory <n> or trim MEMORY.md.${guard}`;
	return `Project memory and context updated.${guard}`;
}
