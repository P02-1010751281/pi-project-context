/**
 * Settings handover across a handoff. `ctx.newSession()` has no model/thinking option, so the
 * replacement session is built from pi's configured defaults; this stages the outgoing session's
 * settings next to the memory so the replacement's `session_start` can restore them. That handler
 * is the only usable point: `setup()` only rewrites messages, `withSession()` gets a context
 * without setters, and the old `pi`/`ctx` are stale once the switch starts.
 */

import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ensureMemoryGitignore, errorText, getProjectRoot, logError, memoryDir, notify, writeAtomic } from "../shared/project-state.ts";

/** File name of the staged-settings marker inside a project memory directory. */
export const HANDOFF_SETTINGS_FILE = "handoff-session-settings.json";

/** A staged marker only has to survive the switch itself; anything older is a leftover. */
const HANDOFF_SETTINGS_TTL_MS = 10 * 60_000;

export interface HandoffSessionSettings {
	previousSessionFile: string;
	model?: { provider: string; id: string };
	thinkingLevel?: string;
	at: number;
}

/** The staged-settings path inside a project's memory directory. */
export function handoffSettingsFile(projectRoot: string): string {
	return path.join(memoryDir(projectRoot), HANDOFF_SETTINGS_FILE);
}

export async function stageHandoffSessionSettings(projectRoot: string, settings: HandoffSessionSettings): Promise<void> {
	const file = handoffSettingsFile(projectRoot);
	// Transient, private (it carries an absolute session path): keep it out of the user's commits.
	await ensureMemoryGitignore(path.dirname(file));
	await writeAtomic(file, `${JSON.stringify(settings)}\n`);
}

export async function clearHandoffSessionSettings(projectRoot: string): Promise<void> {
	await rm(handoffSettingsFile(projectRoot), { force: true }).catch(() => {});
}

/** Read the staged settings; a missing, torn, or foreign file reads as "nothing staged". */
export async function readHandoffSessionSettings(projectRoot: string): Promise<HandoffSessionSettings | undefined> {
	try {
		const parsed = JSON.parse(await readFile(handoffSettingsFile(projectRoot), "utf8")) as Partial<HandoffSessionSettings>;
		if (typeof parsed?.previousSessionFile !== "string" || typeof parsed.at !== "number") return undefined;
		const model = parsed.model;
		return {
			previousSessionFile: parsed.previousSessionFile,
			model: model && typeof model.provider === "string" && typeof model.id === "string" ? { provider: model.provider, id: model.id } : undefined,
			thinkingLevel: typeof parsed.thinkingLevel === "string" && parsed.thinkingLevel ? parsed.thinkingLevel : undefined,
			at: parsed.at,
		};
	} catch {
		return undefined;
	}
}

/**
 * Restore the settings staged by the session we handed off from. Runs from the extension's
 * `session_start` handler: pi has already replayed the carried messages by then and the
 * continuation prompt (`withSession`) has not been sent yet, so the first turn uses them.
 * Anything already equal to the replacement session's own settings is left untouched.
 */
export async function restoreHandoffSessionSettings(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	event: { reason?: string; previousSessionFile?: string },
): Promise<void> {
	// Cheap guard first: only a handoff successor can have staged settings, and resolving the
	// project root shells out to git (cached per cwd, but still avoidable on every session start).
	if (event.reason !== "new" || !event.previousSessionFile) return;
	const projectRoot = await getProjectRoot(pi, ctx.cwd).catch(() => undefined);
	if (!projectRoot) return;
	const staged = await readHandoffSessionSettings(projectRoot);
	if (!staged) return;
	if (Date.now() - staged.at > HANDOFF_SETTINGS_TTL_MS) {
		await clearHandoffSessionSettings(projectRoot);
		return;
	}
	// Only the session that replaced the staged one may consume it: `/new`, `resume`, and `fork`
	// carry a different predecessor (or none). Nothing else can ever use the marker, so an
	// unconsumable one is dropped right away — that covers a crash between staging and the switch,
	// which used to leave the file behind until the TTL expired.
	if (event.previousSessionFile !== staged.previousSessionFile) {
		await clearHandoffSessionSettings(projectRoot);
		return;
	}
	await clearHandoffSessionSettings(projectRoot);

	const wanted = staged.model;
	const sameModel = wanted !== undefined && ctx.model?.provider === wanted.provider && ctx.model?.id === wanted.id;
	if (wanted && !sameModel) {
		let model: ReturnType<ExtensionContext["modelRegistry"]["find"]> | undefined;
		try {
			model = ctx.modelRegistry.find(wanted.provider, wanted.id);
		} catch {
			model = undefined;
		}
		if (!model) {
			notify(ctx, `Auto handoff: ${wanted.provider}/${wanted.id} is not available; staying on the default model.`, "warning");
		} else {
			let failure: unknown;
			let applied = false;
			try {
				applied = await pi.setModel(model);
			} catch (error) {
				failure = error;
			}
			if (failure) {
				notify(ctx, `Auto handoff: could not switch to ${wanted.provider}/${wanted.id} (${errorText(failure)}); staying on the default model.`, "warning");
				await logError(projectRoot, "handoff:restore-model", failure).catch(() => {});
			} else if (!applied) {
				notify(ctx, `Auto handoff: no authentication for ${wanted.provider}/${wanted.id}; staying on the default model.`, "warning");
			}
		}
	}
	if (staged.thinkingLevel) {
		let current: string | undefined;
		try {
			current = pi.getThinkingLevel();
		} catch {
			current = undefined;
		}
		if (staged.thinkingLevel !== current) {
			try {
				pi.setThinkingLevel(staged.thinkingLevel as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
			} catch (error) {
				// A level this model cannot express is dropped rather than breaking session start.
				await logError(projectRoot, "handoff:restore-thinking", error).catch(() => {});
			}
		}
	}
}
