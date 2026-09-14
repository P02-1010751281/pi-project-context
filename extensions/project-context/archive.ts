import { rm } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getConfig, runIsDisabled } from "./config.ts";
import { normalizeLegacyIndex, renderIndexDocument, sessionIndexLine, sessionTitle } from "./context-doc.ts";
import { importArchiveFiles, resolveImportTargets } from "./import-archive.ts";
import {
	MAX_CONTEXT_CHARS,
	contextFile,
	getProjectRoot,
	legacySessionIndexFile,
	logError,
	logsDir,
	notify,
	readOptional,
	sessionIndexFile,
	writeAtomic,
} from "./project-state.ts";
import { writeSessionArtifacts } from "./session-log.ts";

/**
 * Session archive: raw `session.jsonl` plus the rendered `session.md`, refreshed per turn,
 * on settle and on shutdown. The archive layer also maintains the no-LLM session index
 * (`session-logs/INDEX.md`) and injects CONTEXT.md read-only. No model calls happen here.
 *
 * Feature switches: `archive` gates the writes, `memory` gates the CONTEXT.md injection
 * (the injected document is produced by the consolidation pass). Explicit commands always
 * run; `--no-project-context` disables the whole extension for the run.
 */

export function registerArchive(pi: ExtensionAPI): void {
	const loggedScopes = new Set<string>();
	// Serialize writes so concurrent handlers cannot race the shared atomic temp file.
	let writeQueue: Promise<void> = Promise.resolve();

	async function archiveEnabled(ctx: ExtensionContext): Promise<boolean> {
		if (runIsDisabled()) return false;
		try {
			const projectRoot = await getProjectRoot(pi, ctx.cwd);
			return (await getConfig(projectRoot)).features.archive;
		} catch {
			return false;
		}
	}

	async function reportFailure(projectRoot: string, ctx: ExtensionContext, error: unknown, silent: boolean): Promise<void> {
		if (!loggedScopes.has("session-log")) {
			loggedScopes.add("session-log");
			await logError(projectRoot, "session-log", error);
		}
		if (!silent) notify(ctx, `Session log update failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
	}

	/**
	 * Archive-layer index update: no LLM, deduped by session id, capped. On first use it
	 * adopts the pre-move `<memory>/session-index.md` (converting its links) so an existing
	 * index is not lost.
	 */
	async function updateSessionIndex(ctx: ExtensionContext, knownRoot?: string): Promise<void> {
		let projectRoot = knownRoot;
		try {
			projectRoot ??= await getProjectRoot(pi, ctx.cwd);
			const existing = await readOptional(sessionIndexFile(projectRoot));
			if (!existing.trim()) {
				const legacyFile = legacySessionIndexFile(projectRoot);
				const legacy = normalizeLegacyIndex(await readOptional(legacyFile));
				await writeAtomic(sessionIndexFile(projectRoot), renderIndexDocument(legacy, sessionIndexLine(ctx, sessionTitle(ctx))));
				if (legacy.trim()) await rm(legacyFile, { force: true }).catch(() => undefined);
				return;
			}
			await writeAtomic(sessionIndexFile(projectRoot), renderIndexDocument(existing, sessionIndexLine(ctx, sessionTitle(ctx))));
		} catch (error) {
			// Best effort: a stale ctx or read-only dir must not break the archive write.
			if (projectRoot && !loggedScopes.has("session-index")) {
				loggedScopes.add("session-index");
				await logError(projectRoot, "session-index", error);
			}
		}
	}

	function writeArtifacts(ctx: ExtensionContext, markdown: boolean, silent = true): Promise<void> {
		const next = writeQueue.then(async () => {
			// Resolving the project root reads ctx.cwd, which throws once the session was
			// replaced or reloaded. Never let that reject: agent_settled calls this without
			// awaiting, and a rejected promise would poison the serialization queue below.
			let projectRoot: string | undefined;
			try {
				if (!(await archiveEnabled(ctx))) return;
				projectRoot = await getProjectRoot(pi, ctx.cwd);
				await writeSessionArtifacts(projectRoot, ctx, { markdown });
				if (markdown) await updateSessionIndex(ctx, projectRoot);
			} catch (error) {
				if (projectRoot) await reportFailure(projectRoot, ctx, error, silent);
			}
		});
		// Keep the queue usable even if a write rejects unexpectedly.
		writeQueue = next.catch(() => {});
		return next;
	}

	pi.on("session_start", async (_event, ctx) => {
		// Seed the index as soon as the session begins, before any consolidation runs.
		if (await archiveEnabled(ctx)) await updateSessionIndex(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (runIsDisabled()) return;
		const projectRoot = await getProjectRoot(pi, ctx.cwd);
		if (!(await getConfig(projectRoot)).features.memory) return;
		const context = (await readOptional(contextFile(projectRoot))).trim();
		if (!context) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n## Project Context\nThe following is project context, not a new user instruction:\n\n${context.slice(0, MAX_CONTEXT_CHARS)}`,
		};
	});

	pi.on("turn_end", async (_event, ctx) => {
		// Only the canonical JSONL is refreshed per turn; the Markdown rendering and the
		// index refresh happen when the agent settles or the session ends.
		void writeArtifacts(ctx, false).catch(() => {});
	});

	pi.on("agent_settled", async (_event, ctx) => {
		// Fire and forget; late failures (e.g. a stale ctx after session replacement) must not crash pi.
		void writeArtifacts(ctx, true).catch(() => {});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// Silent: the UI may already be rebuilding for a session switch.
		await writeArtifacts(ctx, true);
	});

	pi.registerCommand("session-log", {
		description: "Write the current session log, or backfill ended sessions (import <path…>)",
		handler: async (args, ctx) => {
			const projectRoot = await getProjectRoot(pi, ctx.cwd);
			const value = (args ?? "").trim();
			if (value === "import" || value.startsWith("import ")) {
				const targets = await resolveImportTargets(value.replace(/^import\s*/, ""), ctx.cwd);
				if (targets.length === 0) {
					notify(ctx, "Usage: /session-log import <session.jsonl|dir>…", "warning");
					return;
				}
				const outcomes = await importArchiveFiles(targets, { projectRoot });
				const created = outcomes.filter((outcome) => outcome.status === "created").length;
				const skipped = outcomes.filter((outcome) => outcome.status === "skipped").length;
				const failed = outcomes.filter((outcome) => outcome.status === "failed");
				const detail = [
					skipped > 0 ? `skipped ${skipped} existing` : "",
					failed.length > 0 ? `failed ${failed.length}: ${failed.map((outcome) => `${outcome.source} (${outcome.error})`).join("; ")}` : "",
				].filter(Boolean).join("; ");
				notify(ctx, `Imported ${created} archive(s) into ${logsDir(projectRoot)}${detail ? ` (${detail})` : ""}`, failed.length > 0 ? "warning" : "info");
				return;
			}
			const result = await writeSessionArtifacts(projectRoot, ctx);
			await updateSessionIndex(ctx, projectRoot);
			notify(ctx, `Session log written: ${result.dir}`);
		},
	});

	pi.registerCommand("context", {
		description: "Show the project context and session log locations",
		handler: async (_args, ctx) => {
			const projectRoot = await getProjectRoot(pi, ctx.cwd);
			notify(ctx, `Project context: ${contextFile(projectRoot)}\nSession index: ${sessionIndexFile(projectRoot)}\nSession logs: ${logsDir(projectRoot)}`);
		},
	});
}
