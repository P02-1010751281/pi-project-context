/**
 * The pass's outcome surface: the clipped notices, the last-write bookkeeping, the once-per-
 * project warnings, and the hook registration the extension entry calls.
 */

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { configFile, getConfig, runIsDisabled } from "../shared/config.ts";
import { backupMemoryBeforeWrite, contextFile, errorText, getProjectRoot, isMemoryTruncated, loadMemory, logError, memoryDir, memoryFile, migrateProjectState, normalizeMemoryDocument, notify, readOptional, recordMemoryDocument, withMemoryLock, writeAtomic } from "../shared/project-state.ts";
import { fallbackUpdate, renderContextDocument } from "./context-doc.ts";
import { consolidateProjectState } from "./pass.ts";

/** Run the consolidation pass. Callers own persisting the returned artifacts. */
/** Info about the newest memory write, so explicit commands can point at the backup. */
type LastWriteInfo = { backup?: string; repaired: boolean; capped?: boolean };

const lastWrite = new Map<string, LastWriteInfo>();

/** Projects already told that the model answers the context section in an unusable shape. */
const contextShapeWarned = new Set<string>();

/** Projects already told that the memory render hit its character cap. */
const memoryCapWarned = new Set<string>();

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
			const memoryChanged = memoryText.length >= 40;
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
			if (memoryChanged) {
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
				// The marker is the durable trace; the log entry and the reply are the loud ones.
				cappedMemory = isMemoryTruncated(normalizeMemoryDocument(memoryText, maxMemoryChars));
				lastWrite.set(projectRoot, { backup, repaired: storedPoisoned, capped: cappedMemory });
				if (storedPoisoned) {
					await logError(projectRoot, "memory", `replaced a stored JSON reply with markdown; original kept at ${backup ?? "(none)"}`);
				}
				if (cappedMemory && !memoryCapWarned.has(projectRoot)) {
					// A marker nobody reads is still a silent loss: say it once per project per process,
					// and point at the knob that lifts the cap.
					memoryCapWarned.add(projectRoot);
					await logError(
						projectRoot,
						"memory",
						`memory exceeded maxMemoryChars (${maxMemoryChars}): the tail was dropped on a line boundary, whole lines only — raise maxMemoryChars in project-context.json or trim MEMORY.md`,
					);
				}
			}
			if (update) {
				await writeAtomic(contextFile(projectRoot), renderContextDocument(update, { updatedAt: new Date().toISOString() }));
			}
			const report: ConsolidateReport = memoryChanged || update ? (outcome.clipped ? "clipped" : "updated") : "unchanged";
			if (outcome.clipped && (memoryChanged || update)) {
				// Always leave a trace: the UI warning below is a no-op headless, and commands report separately.
				await logError(projectRoot, "memory", "consolidation shortened the existing memory or context to fit the model output budget");
			}
			if (!silent && (memoryChanged || update)) {
				const clippedNote = report === "clipped" ? " The rewrite also shortened the content to fit the model output budget." : "";
				if (storedPoisoned && memoryChanged) {
					const capNote = cappedMemory
						? ` It also hit its ${maxMemoryChars}-character cap; the tail was dropped on a line boundary.`
						: "";
					notify(ctx, `Project memory was raw JSON from the old bug and is now Markdown${backup ? ` (backup: ${backup})` : ""}.${capNote}${clippedNote}`, "warning");
				} else if (cappedMemory) {
					notify(
						ctx,
						`Project memory hit its ${maxMemoryChars}-character cap: the tail was dropped on a line boundary (whole lines only) and MEMORY.md ends with a truncation marker. Raise maxMemoryChars in ${configFile(projectRoot)} or trim it.`,
						"warning",
					);
				} else if (report === "clipped") {
					notify(ctx, backup ? `${CLIPPED_NOTICE} Previous file: ${backup}.` : CLIPPED_NOTICE_NO_WRITE, "warning");
				} else notify(ctx, `Project memory updated: ${memoryFile(projectRoot)}`);
			}
			return report;
		} catch (error) {
			// Release the claim only when this pass did not land a new MEMORY.md: a failure after
			// that write must not let a cached outcome replay over newer memory content.
			if (claimed && !wroteMemory && projectRoot) written.delete(projectRoot);
			if (projectRoot) await logError(projectRoot, "memory", error);
			if (!silent) {
				// The message may carry a raw-reply dump for errors.log; the toast shows the headline only.
				const message = errorText(error);
				notify(ctx, `Project memory update failed: ${message.split("\n", 1)[0]}`, "warning");
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
			if (result.conflicts.length > 0) {
				notify(ctx, `Legacy layout left in place (file/directory type conflict, merge it by hand): ${result.conflicts.join(", ")}`, "warning");
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
		description: "Show this project's memory location and status",
		handler: async (_args, ctx) => {
			const projectRoot = await getProjectRoot(pi, ctx.cwd);
			const memory = await loadMemory(projectRoot, (await getConfig(projectRoot)).maxMemoryChars);
			if (memory.unreadable && memory.source.endsWith("memory.jsonl")) {
				notify(ctx, `Memory journal exists but has no usable record: ${memory.source}. Delete it to rebuild from MEMORY.md, or restore from memory-log-*.jsonl (see .agents/memory/errors.log).`, "warning");
			} else if (memory.unreadable) notify(ctx, `Project memory exists but cannot be read: ${memory.source}; check its permissions (see .agents/memory/errors.log).`, "warning");
			else if (!memory.text) notify(ctx, `No project memory yet: ${memory.source}`);
			else if (memory.damaged) notify(ctx, `Project memory: ${memory.source} (${memory.damaged} unusable line(s) skipped; see .agents/memory/errors.log).`, "warning");
			else if (memory.poisoned) notify(ctx, `Project memory: ${memory.source} (stored as raw JSON from the old bug; the next consolidation backs it up and rewrites it as Markdown).`, "warning");
			else notify(ctx, `Project memory: ${memory.source}`);
		},
	});

	pi.registerCommand("memory-learn", {
		description: "Consolidate durable facts and the session context from this project session",
		handler: async (_args, ctx) => {
			const projectRoot = await getProjectRoot(pi, ctx.cwd);
			const report = await consolidate(ctx, true, true);
			notify(ctx, consolidateReply(report, lastWrite.get(projectRoot)), report === "failed" || report === "clipped" ? "warning" : "info");
		},
	});

	pi.registerCommand("context-update", {
		description: "Alias for /memory-learn: rewrite project memory and context now",
		handler: async (_args, ctx) => {
			const projectRoot = await getProjectRoot(pi, ctx.cwd);
			const report = await consolidate(ctx, true, true);
			notify(ctx, consolidateReply(report, lastWrite.get(projectRoot)), report === "failed" || report === "clipped" ? "warning" : "info");
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

/** Human-readable reply for one pass result; the pass also logs failures to errors.log. */
export function consolidateReply(report: ConsolidateReport, info?: LastWriteInfo): string {
	if (report === "failed") return "Project memory update failed; see .agents/memory/errors.log.";
	if (report === "clipped") return info?.backup ? `${CLIPPED_NOTICE} Previous file: ${info.backup}.` : CLIPPED_NOTICE_NO_WRITE;
	if (report === "deduped") return "Project memory and context are already up to date (deduped recently); nothing was rewritten.";
	if (report === "unchanged") return "Consolidation ran but produced no new memory or context.";
	if (info?.repaired && info.backup) {
		const capNote = info.capped ? " It also hit its maxMemoryChars cap and its tail was dropped on a line boundary." : "";
		return `Project memory and context updated; the stored raw JSON reply was replaced (backup: ${info.backup}).${capNote}`;
	}
	if (info?.capped) return `Project memory updated, but it is at its maxMemoryChars cap and its tail was dropped (whole lines only); raise maxMemoryChars in project-context.json or trim MEMORY.md.`;
	return "Project memory and context updated.";
}
