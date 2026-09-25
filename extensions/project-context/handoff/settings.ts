/**
 * The persisted per-project switch and its in-process mirror the pass reads.
 */

import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, type ProjectContextConfig, getConfig, peekConfig, runIsDisabled, updateConfig } from "../shared/config.ts";
import { fmtPct, fmtTokens } from "./format.ts";

export let config: ProjectContextConfig = { ...DEFAULT_CONFIG };

/** Project whose project-context.json supplied the current settings. */
let configRoot: string | undefined;

/** Per-run override from --no-auto-handoff / --handoff-ratio off. */
let flagEnabled = true;

/** The project whose configuration is loaded, once one was resolved. */
export function getConfigRoot(): string | undefined {
	return configRoot;
}

/** Remember the project the current settings came from. */
export function setConfigRoot(root: string | undefined): void {
	configRoot = root;
}

/** Turn the run-level override on or off (`--no-auto-handoff`, `--handoff-ratio off`). */
export function setFlagEnabled(value: boolean): void {
	flagEnabled = value;
}

/** Feature switch (`/project-context off handoff`) plus run-level overrides. */
export function handoffEnabled(): boolean {
	return !runIsDisabled() && flagEnabled && (peekConfig(configRoot)?.handoffEnabled ?? false);
}

/**
 * Load the project's configuration into the local working copy.
 *
 * Mutate the mirror **in place**, never reassign it: reassigning this exported `let` did not reach
 * the command handler under the host's interop (measured — `run.ts` kept writing the previous
 * object while this module read the new one), which is how a command could persist values nobody
 * had set. Keeping one stable object is the same reason the split exposes `setFlagEnabled` /
 * `setConfigRoot` instead of reassigning.
 */
export async function syncConfig(root: string | undefined): Promise<void> {
	configRoot = root;
	if (!root) return;
	Object.assign(config, await getConfig(root));
}

/**
 * Persist the handoff settings.
 *
 * `updateConfig` merges into the cached configuration and publishes a **new** object, so this
 * module's mirror goes stale the moment another writer saves — `/project-context off memory` calls
 * `setFeature` and does exactly that. Writing the whole mirror back then silently reverted whatever
 * the other writer had just set (and any other host's or hand edit's changes). A command that means
 * to change one handoff key must send only the handoff keys, and then adopt the merged result so the
 * mirror cannot drift again.
 */
export async function saveConfig(): Promise<void> {
	if (!configRoot) return;
	const patch: Partial<ProjectContextConfig> = {
		handoffAdaptive: config.handoffAdaptive,
		handoffThresholdRatio: config.handoffThresholdRatio,
		handoffTargetTokens: config.handoffTargetTokens,
		handoffKeepTokens: config.handoffKeepTokens,
		handoffSummaryThinking: config.handoffSummaryThinking,
		handoffMode: config.handoffMode,
		handoffGuard: config.handoffGuard,
		handoffLanguage: config.handoffLanguage,
	};
	try {
		// Adopt the merged result **in place**. Reassigning this exported `let` did not reach the
		// command handler under the host's module interop — measured: after `/auto-handoff lang zh`
		// every later command persisted `zh` again, because `run.ts` was still mutating the previous
		// object while this module read the new one. This is the same reason the split exposes
		// `setFlagEnabled`/`setConfigRoot` instead of reassigning.
		Object.assign(config, await updateConfig(configRoot, patch));
	} catch {
		// Best effort; a read-only project dir must not break the session.
	}
}

/** Accepts "0.5", "50%", or "50". */
export function parseRatio(input: string): number | undefined {
	const text = input.trim().toLowerCase().replace(/%$/, "");
	const value = Number(text);
	if (!Number.isFinite(value)) return undefined;
	const ratio = value > 1 ? value / 100 : value;
	return ratio >= 0.1 && ratio <= 0.95 ? ratio : undefined;
}

/** Accepts "12k", "12000", "1.5k". */
export function parseTokenCount(input: string): number | undefined {
	const match = /^(\d+(?:\.\d+)?)(k)?$/.exec(input.trim().toLowerCase());
	if (!match) return undefined;
	const value = Number(match[1]) * (match[2] ? 1_000 : 1);
	return Number.isFinite(value) ? Math.round(value) : undefined;
}

export function usageText(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	if (!usage || usage.tokens === null) return "unknown";
	return `${fmtTokens(usage.tokens)}/${fmtTokens(usage.contextWindow)} (${fmtPct(usage.percent ?? 0)})`;
}
