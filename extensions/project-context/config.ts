import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { memoryDir, readOptional, writeAtomic } from "./project-state.ts";

/**
 * Project-scoped configuration for the project-context extension.
 *
 * One file holds everything, next to the artifacts it controls
 * (`<project>/.agents/memory/project-context.json`), so a project can be paused or
 * tuned without touching global config.
 *
 * Field names are shared with the dsh plugin (the two repos keep the same config
 * surface; only the storage and the pi-only `handoffMode`/`handoffGuard` differ).
 *
 * Backward compatibility, read-only until the next save:
 *   - the pre-unification nested layout (`features.*`, `autolearn.*`, `handoff.*`)
 *   - `<project>/.agents/memory/autolearn.json` (enabled/at)
 *   - the global handoff settings (`~/.pi/agent/auto-handoff.json`)
 * The file is rewritten in the flat layout on the next save.
 */

export type FeatureName = "archive" | "memory" | "autolearn" | "handoff";
export const FEATURE_NAMES: FeatureName[] = ["archive", "memory", "autolearn", "handoff"];

/** Command verb → config field. The verbs are pi-side copy; the fields are shared with dsh. */
export const FEATURE_FIELDS: Record<FeatureName, "archiveEnabled" | "autoConsolidate" | "autoLearn" | "handoffEnabled"> = {
	archive: "archiveEnabled",
	memory: "autoConsolidate",
	autolearn: "autoLearn",
	handoff: "handoffEnabled",
};

export type HandoffSettings = {
	/** Adaptive threshold (dsh `handoffAdaptive`); false uses `handoffThresholdRatio`. */
	handoffAdaptive: boolean;
	/** Context-window fraction (0.1–0.95) used when `handoffAdaptive` is false. */
	handoffThresholdRatio: number;
	/** Adaptive mode: conversation tokens to summarize per handoff. */
	handoffTargetTokens: number;
	/** Recent raw tokens replayed into the new session; 0 = summary only. */
	handoffKeepTokens: number;
	/** Thinking for the summary call: "off" (fast) or the session level. */
	handoffSummaryThinking: "off" | "session";
	/** pi-only: "send" dismisses the handoff into a new session, "draft" leaves it in the editor. */
	handoffMode: "send" | "draft";
	/** pi-only: behavior when the last assistant message asks the user a question. */
	handoffGuard: "wait" | "draft" | "send" | "skip";
};

export type ProjectContextConfig = HandoffSettings & {
	archiveEnabled: boolean;
	autoConsolidate: boolean;
	autoLearn: boolean;
	handoffEnabled: boolean;
	/** Last completed automatic autolearn pass (epoch ms); persisted so a restart does not re-run. */
	autolearnAt: number;
	/** Accumulated user turns before an automatic autolearn pass. */
	autolearnTurns: number;
	/** Minimum wall-clock gap between automatic autolearn passes. */
	autolearnIntervalMs: number;
	/** User turns accumulated before an automatic consolidation pass. */
	consolidateTurns: number;
	/** Minimum wall-clock gap between automatic consolidation passes. */
	consolidateIntervalMs: number;
	/** Suppress an almost-immediate duplicate forced pass. */
	forceDedupeMs: number;
	/** Output cap for the auxiliary model calls (`llm.ts`); the handoff summary keeps its own reserve math. */
	maxTokens: number;
	/** Optional auxiliary-call route override; must be set together with `model`. Empty = session model. */
	provider: string;
	/** Optional auxiliary-call route override; must be set together with `provider`. Empty = session model. */
	model: string;
};

/** Defaults match the dsh plugin's `DEFAULT_CONFIG`. */
export const DEFAULT_CONFIG: ProjectContextConfig = {
	archiveEnabled: true,
	autoConsolidate: true,
	autoLearn: true,
	handoffEnabled: true,
	autolearnAt: 0,
	autolearnTurns: 20,
	autolearnIntervalMs: 30 * 60 * 1000,
	consolidateTurns: 6,
	consolidateIntervalMs: 5 * 60 * 1000,
	forceDedupeMs: 15 * 1000,
	maxTokens: 8192,
	provider: "",
	model: "",
	handoffAdaptive: true,
	handoffThresholdRatio: 0.4,
	handoffTargetTokens: 64_000,
	handoffKeepTokens: 20_000,
	handoffSummaryThinking: "off",
	handoffMode: "send",
	handoffGuard: "wait",
};

/** Don't hand off unless at least this much context is actually replaced by the summary. */
export const MIN_SUMMARIZE_TOKENS = 8_000;
export const MAX_KEEP_RECENT_TOKENS = 200_000;
/** dsh's accepted range for `handoffThresholdRatio`. */
const MIN_RATIO = 0.1;
const MAX_RATIO = 0.95;

export function configFile(projectRoot: string): string {
	return join(memoryDir(projectRoot), "project-context.json");
}

// Run-level master switch: --no-project-context disables every feature for this run
// without touching the persisted per-project configuration.
let runDisabled = false;

export function setRunDisabled(value: boolean): void {
	runDisabled = value;
}

export function runIsDisabled(): boolean {
	return runDisabled;
}

const cache = new Map<string, ProjectContextConfig>();

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
	const raw = (await readOptional(file)).trim();
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function bool(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function positive(value: unknown, min: number): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= min ? Math.round(value) : undefined;
}

function bounded(value: unknown, min: number, max: number): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? Math.round(value) : undefined;
}

function ratio(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= MIN_RATIO && value <= MAX_RATIO ? value : undefined;
}

/** dsh's accepted floor for `maxTokens`; also enforced by the `/project-context max-tokens` verb. */
export const MIN_AUX_MAX_TOKENS = 256;

/** `provider`/`model` only take effect as a pair; a half-configured route is ignored. */
function auxRoute(rawProvider: unknown, rawModel: unknown): { provider: string; model: string } {
	const provider = typeof rawProvider === "string" ? rawProvider.trim() : "";
	const model = typeof rawModel === "string" ? rawModel.trim() : "";
	return provider && model ? { provider, model } : { provider: "", model: "" };
}

/** "auto" → adaptive, number → fixed ratio; anything else → undefined. */
function adaptiveOf(threshold: unknown): boolean | undefined {
	if (threshold === "auto") return true;
	if (typeof threshold === "number" && Number.isFinite(threshold)) return false;
	return undefined;
}

function modeOf(value: unknown): HandoffSettings["handoffMode"] | undefined {
	return value === "draft" || value === "send" ? value : undefined;
}

function guardOf(value: unknown): HandoffSettings["handoffGuard"] | undefined {
	return value === "wait" || value === "draft" || value === "send" || value === "skip" ? value : undefined;
}

/** Defaults from the previous, split configuration files (read once, never written back). */
async function legacyDefaults(projectRoot: string): Promise<{
	autolearnEnabled?: boolean;
	autolearnAt?: number;
	handoff?: Record<string, unknown>;
	handoffEnabled?: boolean;
}> {
	const autolearn = await readJson(join(memoryDir(projectRoot), "autolearn.json"));
	const globalHandoff = await readJson(join(getAgentDir(), "auto-handoff.json"));
	return {
		autolearnEnabled: autolearn ? bool(autolearn.enabled) : undefined,
		autolearnAt: autolearn && typeof autolearn.at === "number" ? autolearn.at : undefined,
		handoff: globalHandoff,
		handoffEnabled: globalHandoff ? bool(globalHandoff.enabled) : undefined,
	};
}

/** Load (once per project) and cache the project's configuration. */
export async function getConfig(projectRoot: string): Promise<ProjectContextConfig> {
	const cached = cache.get(projectRoot);
	if (cached) return cached;

	const raw = (await readJson(configFile(projectRoot))) ?? {};
	const legacy = await legacyDefaults(projectRoot);
	const features = asRecord(raw.features);
	const autolearn = asRecord(raw.autolearn);
	const handoff = asRecord(raw.handoff);
	const global = legacy.handoff ?? {};
	const route = auxRoute(raw.provider, raw.model);
	// Pre-unification threshold keys: nested `handoff.threshold`/`ratio`, then the global file.
	const nestedThreshold = handoff.threshold ?? handoff.ratio;
	const legacyThreshold = global.threshold ?? global.ratio;

	const config: ProjectContextConfig = {
		archiveEnabled: bool(raw.archiveEnabled) ?? bool(features.archive) ?? DEFAULT_CONFIG.archiveEnabled,
		autoConsolidate: bool(raw.autoConsolidate) ?? bool(features.memory) ?? DEFAULT_CONFIG.autoConsolidate,
		autoLearn: bool(raw.autoLearn) ?? bool(features.autolearn) ?? legacy.autolearnEnabled ?? DEFAULT_CONFIG.autoLearn,
		handoffEnabled: bool(raw.handoffEnabled) ?? bool(features.handoff) ?? legacy.handoffEnabled ?? DEFAULT_CONFIG.handoffEnabled,

		autolearnAt: positive(raw.autolearnAt, 0) ?? positive(autolearn.at, 0) ?? legacy.autolearnAt ?? DEFAULT_CONFIG.autolearnAt,
		autolearnTurns: positive(raw.autolearnTurns, 1) ?? positive(autolearn.turns, 1) ?? DEFAULT_CONFIG.autolearnTurns,
		autolearnIntervalMs: positive(raw.autolearnIntervalMs, 1000) ?? positive(autolearn.intervalMs, 1000) ?? DEFAULT_CONFIG.autolearnIntervalMs,
		consolidateTurns: positive(raw.consolidateTurns, 1) ?? DEFAULT_CONFIG.consolidateTurns,
		consolidateIntervalMs: positive(raw.consolidateIntervalMs, 1000) ?? DEFAULT_CONFIG.consolidateIntervalMs,
		forceDedupeMs: positive(raw.forceDedupeMs, 0) ?? DEFAULT_CONFIG.forceDedupeMs,
		maxTokens: positive(raw.maxTokens, MIN_AUX_MAX_TOKENS) ?? DEFAULT_CONFIG.maxTokens,
		provider: route.provider,
		model: route.model,

		handoffAdaptive: bool(raw.handoffAdaptive) ?? adaptiveOf(nestedThreshold) ?? adaptiveOf(legacyThreshold) ?? DEFAULT_CONFIG.handoffAdaptive,
		handoffThresholdRatio: ratio(raw.handoffThresholdRatio)
			?? ratio(nestedThreshold)
			?? ratio(legacyThreshold)
			?? DEFAULT_CONFIG.handoffThresholdRatio,
		handoffTargetTokens: bounded(raw.handoffTargetTokens, MIN_SUMMARIZE_TOKENS, MAX_KEEP_RECENT_TOKENS)
			?? bounded(handoff.autoTargetTokens, MIN_SUMMARIZE_TOKENS, MAX_KEEP_RECENT_TOKENS)
			?? bounded(global.autoTargetTokens, MIN_SUMMARIZE_TOKENS, MAX_KEEP_RECENT_TOKENS)
			?? DEFAULT_CONFIG.handoffTargetTokens,
		handoffKeepTokens: bounded(raw.handoffKeepTokens, 0, MAX_KEEP_RECENT_TOKENS)
			?? bounded(handoff.keepRecentTokens, 0, MAX_KEEP_RECENT_TOKENS)
			?? bounded(global.keepRecentTokens, 0, MAX_KEEP_RECENT_TOKENS)
			?? DEFAULT_CONFIG.handoffKeepTokens,
		handoffSummaryThinking: (raw.handoffSummaryThinking === "session" || raw.handoffSummaryThinking === "off"
			? raw.handoffSummaryThinking
			: undefined)
			?? (handoff.summaryThinking === "session" || handoff.summaryThinking === "off" ? handoff.summaryThinking : undefined)
			?? (global.summaryThinking === "session" || global.summaryThinking === "off" ? global.summaryThinking : undefined)
			?? DEFAULT_CONFIG.handoffSummaryThinking,
		handoffMode: modeOf(raw.handoffMode) ?? modeOf(handoff.mode) ?? modeOf(global.mode) ?? DEFAULT_CONFIG.handoffMode,
		handoffGuard: guardOf(raw.handoffGuard) ?? guardOf(handoff.guard) ?? guardOf(global.guard) ?? DEFAULT_CONFIG.handoffGuard,
	};
	cache.set(projectRoot, config);
	return config;
}

/** Cached configuration without touching the disk; undefined until first load. */
export function peekConfig(projectRoot: string | undefined): ProjectContextConfig | undefined {
	return projectRoot ? cache.get(projectRoot) : undefined;
}

export async function saveConfig(projectRoot: string, config: ProjectContextConfig): Promise<ProjectContextConfig> {
	cache.set(projectRoot, config);
	await writeAtomic(configFile(projectRoot), `${JSON.stringify(config, null, 2)}\n`);
	return config;
}

/** Merge a partial update into the cached config and persist it in the flat layout. */
export async function updateConfig(projectRoot: string, patch: Partial<ProjectContextConfig>): Promise<ProjectContextConfig> {
	return saveConfig(projectRoot, { ...(await getConfig(projectRoot)), ...patch });
}

export async function setFeature(projectRoot: string, feature: FeatureName, enabled: boolean): Promise<ProjectContextConfig> {
	const patch: Partial<ProjectContextConfig> = { [FEATURE_FIELDS[feature]]: enabled };
	return updateConfig(projectRoot, patch);
}
