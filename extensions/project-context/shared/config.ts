import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { withMemoryLock } from "./lock.ts";
import { MAX_MEMORY_CHARS_LIMIT, MIN_MEMORY_CHARS, memoryDir, readOptional, writeAtomic } from "./project-state.ts";

/**
 * Project-scoped configuration for the project-context extension.
 *
 * One file holds everything, next to the artifacts it controls
 * (`<project>/.agents/memory/project-context.json`), so a project can be paused or
 * tuned without touching global config.
 *
 * Field names are shared with the dsh plugin (the two repos keep the same config
 * surface; only the storage and the pi-only `handoffMode`/`handoffGuard`/`handoffLanguage` differ).
 *
 * Backward compatibility is a **one-time migration**, not a permanent read path: the pre-unification
 * nested layout (`features.*`, `autolearn.*`, `handoff.*`), the split `<project>/.agents/memory/
 * autolearn.json` and the global `~/.pi/agent/auto-handoff.json` are read once by
 * `migrateLegacyConfig`, folded into the flat keys and written back as a flat document; nothing on the
 * read path consults them again. Only `legacyConfigPatch` knows those layouts, so a new key cannot
 * pick up a legacy fallback term by accident — the eight keys added after the unification never had one.
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
	/** pi-only: language of the handoff prompt scaffolding; "auto" follows the conversation language. */
	handoffLanguage: "auto" | "zh" | "en";
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
	/** Hard ceiling for the adaptive output cap when the model reports no limit of its own. */
	maxOutputTokens: number;
	/** Cap on the rendered `MEMORY.md`; over it the document is cut on a line boundary with a marker. */
	maxMemoryChars: number;
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
	maxOutputTokens: 32_768,
	maxMemoryChars: 32_000,
	provider: "",
	model: "",
	handoffAdaptive: true,
	handoffThresholdRatio: 0.4,
	handoffTargetTokens: 64_000,
	handoffKeepTokens: 20_000,
	handoffSummaryThinking: "off",
	handoffMode: "send",
	handoffGuard: "wait",
	handoffLanguage: "auto",
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

function languageOf(value: unknown): HandoffSettings["handoffLanguage"] | undefined {
	return value === "auto" || value === "zh" || value === "en" ? value : undefined;
}

function thinkingOf(value: unknown): HandoffSettings["handoffSummaryThinking"] | undefined {
	return value === "session" || value === "off" ? value : undefined;
}

/**
 * The pre-unification layouts, folded into flat keys: the nested `features.*`/`autolearn.*`/`handoff.*`
 * records in the same file, the split `<memory>/autolearn.json`, and the global `auto-handoff.json`.
 * A flat key already on disk always wins, so this can never override current settings.
 */
async function legacyConfigPatch(projectRoot: string): Promise<{ patch: Partial<ProjectContextConfig>; sources: string[] } | undefined> {
	const raw = (await readJson(configFile(projectRoot))) ?? {};
	const features = asRecord(raw.features);
	const autolearn = asRecord(raw.autolearn);
	const handoff = asRecord(raw.handoff);
	const autolearnFile = await readJson(join(memoryDir(projectRoot), "autolearn.json"));
	const globalHandoff = await readJson(join(getAgentDir(), "auto-handoff.json"));
	const global = globalHandoff ?? {};
	const sources: string[] = [];
	if (Object.keys(features).length > 0 || Object.keys(autolearn).length > 0 || Object.keys(handoff).length > 0) {
		sources.push("the nested features/autolearn/handoff layout");
	}
	if (autolearnFile) sources.push("autolearn.json");
	if (globalHandoff) sources.push("the global auto-handoff.json");
	// No legacy layout on disk: nothing to migrate and nothing to clean up.
	if (sources.length === 0) return undefined;

	const nestedThreshold = handoff.threshold ?? handoff.ratio;
	const globalThreshold = global.threshold ?? global.ratio;
	const patch: Partial<ProjectContextConfig> = {};
	const put = (key: keyof ProjectContextConfig, value: unknown) => {
		if (value === undefined || raw[key] !== undefined) return;
		(patch as Record<string, unknown>)[key] = value;
	};
	put("archiveEnabled", bool(features.archive));
	put("autoConsolidate", bool(features.memory));
	put("autoLearn", bool(features.autolearn) ?? (autolearnFile ? bool(autolearnFile.enabled) : undefined));
	put("handoffEnabled", bool(features.handoff) ?? (globalHandoff ? bool(globalHandoff.enabled) : undefined));
	put("autolearnAt", positive(autolearn.at, 0) ?? (autolearnFile ? positive(autolearnFile.at, 0) : undefined));
	put("autolearnTurns", positive(autolearn.turns, 1));
	put("autolearnIntervalMs", positive(autolearn.intervalMs, 1000));
	put("handoffAdaptive", adaptiveOf(nestedThreshold) ?? adaptiveOf(globalThreshold));
	put("handoffThresholdRatio", ratio(nestedThreshold) ?? ratio(globalThreshold));
	put("handoffTargetTokens", bounded(handoff.autoTargetTokens, MIN_SUMMARIZE_TOKENS, MAX_KEEP_RECENT_TOKENS)
		?? bounded(global.autoTargetTokens, MIN_SUMMARIZE_TOKENS, MAX_KEEP_RECENT_TOKENS));
	put("handoffKeepTokens", bounded(handoff.keepRecentTokens, 0, MAX_KEEP_RECENT_TOKENS)
		?? bounded(global.keepRecentTokens, 0, MAX_KEEP_RECENT_TOKENS));
	put("handoffSummaryThinking", thinkingOf(handoff.summaryThinking) ?? thinkingOf(global.summaryThinking));
	put("handoffMode", modeOf(handoff.mode) ?? modeOf(global.mode));
	put("handoffGuard", guardOf(handoff.guard) ?? guardOf(global.guard));
	put("handoffLanguage", languageOf(handoff.language) ?? languageOf(global.language));
	return { patch, sources };
}

/**
 * Move a project off the pre-unification layouts: fold their values into the flat keys and rewrite the
 * file (full flat document, under the cross-process lock). Idempotent — a second run finds nothing.
 * Returns the layouts that contributed, empty when there was nothing to migrate.
 */
export async function migrateLegacyConfig(projectRoot: string): Promise<string[]> {
	const legacy = await legacyConfigPatch(projectRoot);
	if (!legacy) return [];
	// An empty patch still rewrites the file, which is what drops the now-dead nested keys.
	await updateConfig(projectRoot, legacy.patch);
	return legacy.sources;
}

const migrationNotices = new Map<string, string[]>();

/**
 * The layouts a migration moved for this project, consumed once by the caller that can notify a user
 * (`getConfig` migrates, but it has no `ctx` to say so with).
 */
export function takeConfigMigrationNotice(projectRoot: string): string[] | undefined {
	const sources = migrationNotices.get(projectRoot);
	if (!sources) return undefined;
	migrationNotices.delete(projectRoot);
	return sources;
}

/** Parse a project's flat configuration from disk. */
async function parseConfig(projectRoot: string): Promise<ProjectContextConfig> {
	const raw = (await readJson(configFile(projectRoot))) ?? {};
	const route = auxRoute(raw.provider, raw.model);

	const config: ProjectContextConfig = {
		archiveEnabled: bool(raw.archiveEnabled) ?? DEFAULT_CONFIG.archiveEnabled,
		autoConsolidate: bool(raw.autoConsolidate) ?? DEFAULT_CONFIG.autoConsolidate,
		autoLearn: bool(raw.autoLearn) ?? DEFAULT_CONFIG.autoLearn,
		handoffEnabled: bool(raw.handoffEnabled) ?? DEFAULT_CONFIG.handoffEnabled,

		autolearnAt: positive(raw.autolearnAt, 0) ?? DEFAULT_CONFIG.autolearnAt,
		autolearnTurns: positive(raw.autolearnTurns, 1) ?? DEFAULT_CONFIG.autolearnTurns,
		autolearnIntervalMs: positive(raw.autolearnIntervalMs, 1000) ?? DEFAULT_CONFIG.autolearnIntervalMs,
		consolidateTurns: positive(raw.consolidateTurns, 1) ?? DEFAULT_CONFIG.consolidateTurns,
		consolidateIntervalMs: positive(raw.consolidateIntervalMs, 1000) ?? DEFAULT_CONFIG.consolidateIntervalMs,
		forceDedupeMs: positive(raw.forceDedupeMs, 0) ?? DEFAULT_CONFIG.forceDedupeMs,
		maxTokens: positive(raw.maxTokens, MIN_AUX_MAX_TOKENS) ?? DEFAULT_CONFIG.maxTokens,
		maxOutputTokens: positive(raw.maxOutputTokens, MIN_AUX_MAX_TOKENS) ?? DEFAULT_CONFIG.maxOutputTokens,
		maxMemoryChars: bounded(raw.maxMemoryChars, MIN_MEMORY_CHARS, MAX_MEMORY_CHARS_LIMIT) ?? DEFAULT_CONFIG.maxMemoryChars,
		provider: route.provider,
		model: route.model,

		handoffAdaptive: bool(raw.handoffAdaptive) ?? DEFAULT_CONFIG.handoffAdaptive,
		handoffThresholdRatio: ratio(raw.handoffThresholdRatio) ?? DEFAULT_CONFIG.handoffThresholdRatio,
		handoffTargetTokens: bounded(raw.handoffTargetTokens, MIN_SUMMARIZE_TOKENS, MAX_KEEP_RECENT_TOKENS) ?? DEFAULT_CONFIG.handoffTargetTokens,
		handoffKeepTokens: bounded(raw.handoffKeepTokens, 0, MAX_KEEP_RECENT_TOKENS) ?? DEFAULT_CONFIG.handoffKeepTokens,
		handoffSummaryThinking: thinkingOf(raw.handoffSummaryThinking) ?? DEFAULT_CONFIG.handoffSummaryThinking,
		handoffMode: modeOf(raw.handoffMode) ?? DEFAULT_CONFIG.handoffMode,
		handoffGuard: guardOf(raw.handoffGuard) ?? DEFAULT_CONFIG.handoffGuard,
		handoffLanguage: languageOf(raw.handoffLanguage) ?? DEFAULT_CONFIG.handoffLanguage,
	};
	return config;
}

/** Load (once per project) and cache the project's configuration. */
export async function getConfig(projectRoot: string): Promise<ProjectContextConfig> {
	const cached = cache.get(projectRoot);
	if (cached) return cached;
	// A legacy layout still on disk is migrated before the first read, so the read path only ever sees
	// flat keys. A failure here must not break the caller: what is already flat still parses.
	const moved = await migrateLegacyConfig(projectRoot).catch(() => []);
	const config = await parseConfig(projectRoot);
	cache.set(projectRoot, config);
	if (moved.length > 0) migrationNotices.set(projectRoot, moved);
	return config;
}

/** Cached configuration without touching the disk; undefined until first load. */
export function peekConfig(projectRoot: string | undefined): ProjectContextConfig | undefined {
	return projectRoot ? cache.get(projectRoot) : undefined;
}

/**
 * Merge a partial update into the project's configuration and persist it.
 *
 * The merge re-reads the file **under a cross-process lock**. Every process holds its own cache, so
 * merging into the cache alone publishes this process's snapshot and silently reverts whatever another
 * writer just wrote — the same class of bug the handoff mirror had (a lost `autolearnAt` is the visible
 * version of it). The lock serializes the read-modify-write; the fresh read makes the merge current.
 */
export async function updateConfig(projectRoot: string, patch: Partial<ProjectContextConfig>): Promise<ProjectContextConfig> {
	return withMemoryLock(configFile(projectRoot), async () => {
		const merged = { ...(await parseConfig(projectRoot)), ...patch };
		cache.set(projectRoot, merged);
		await writeAtomic(configFile(projectRoot), `${JSON.stringify(merged, null, 2)}\n`);
		return merged;
	});
}

export async function setFeature(projectRoot: string, feature: FeatureName, enabled: boolean): Promise<ProjectContextConfig> {
	const patch: Partial<ProjectContextConfig> = { [FEATURE_FIELDS[feature]]: enabled };
	return updateConfig(projectRoot, patch);
}
