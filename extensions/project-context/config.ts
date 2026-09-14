import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { memoryDir, readOptional, writeAtomic } from "./project-state.ts";

/**
 * Project-scoped configuration for the project-context extension.
 *
 * One file holds everything: the four feature switches, the autolearn throttle
 * timestamp and the handoff settings. The file lives next to the artifacts it
 * controls (`<project>/.agents/memory/project-context.json`) so a project can be
 * paused or tuned without touching global config.
 *
 * Backward compatibility: the previous layout stored the autolearn switch in
 * `<project>/.agents/memory/autolearn.json` and the handoff settings in the global
 * agent dir (`~/.pi/agent/auto-handoff.json`). Both are read once as defaults;
 * nothing is written back to them.
 */

export type FeatureName = "archive" | "memory" | "autolearn" | "handoff";
export const FEATURE_NAMES: FeatureName[] = ["archive", "memory", "autolearn", "handoff"];

export type Features = Record<FeatureName, boolean>;

export type HandoffSettings = {
	/** Fixed fraction of the context window, or "auto" for the derived threshold. */
	threshold: number | "auto";
	/** Auto mode: conversation tokens to summarize per handoff. */
	autoTargetTokens: number;
	/** Recent raw tokens replayed into the new session; 0 = summary only. */
	keepRecentTokens: number;
	/** Thinking for the summary call: "off" (fast) or the session level. */
	summaryThinking: "off" | "session";
	mode: "send" | "draft";
	/** Behavior when the last assistant message asks the user a question. */
	guard: "wait" | "draft" | "send" | "skip";
};

export type AutolearnSettings = {
	/** Last completed automatic pass (epoch ms); persisted so a restart does not re-run on old material. */
	at: number;
	/** Accumulated user turns before an automatic pass. */
	turns: number;
	/** Minimum wall-clock gap between automatic passes. */
	intervalMs: number;
};

export type ProjectContextConfig = {
	features: Features;
	autolearn: AutolearnSettings;
	handoff: HandoffSettings;
};

export const DEFAULT_FEATURES: Features = { archive: true, memory: true, autolearn: true, handoff: true };
export const DEFAULT_AUTOLEARN: AutolearnSettings = { at: 0, turns: 20, intervalMs: 30 * 60 * 1000 };

export const DEFAULT_HANDOFF: HandoffSettings = {
	threshold: "auto",
	autoTargetTokens: 64_000,
	keepRecentTokens: 20_000,
	summaryThinking: "off",
	mode: "send",
	guard: "wait",
};

/** Don't hand off unless at least this much context is actually replaced by the summary. */
export const MIN_SUMMARIZE_TOKENS = 8_000;
export const MAX_KEEP_RECENT_TOKENS = 200_000;

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
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function bool(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function positive(value: unknown, fallback: number, min: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= min ? Math.round(value) : fallback;
}

function normalizeHandoff(raw: unknown): HandoffSettings | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const parsed = raw as Record<string, unknown>;
	// "ratio" is the pre-auto config key; keep reading it for compatibility.
	const rawThreshold = parsed.threshold ?? parsed.ratio;
	const target = typeof parsed.autoTargetTokens === "number" ? parsed.autoTargetTokens : Number.NaN;
	const keep = typeof parsed.keepRecentTokens === "number" ? parsed.keepRecentTokens : Number.NaN;
	return {
		threshold: rawThreshold === "auto"
			? "auto"
			: typeof rawThreshold === "number" && rawThreshold > 0.05 && rawThreshold < 0.98
				? rawThreshold
				: DEFAULT_HANDOFF.threshold,
		autoTargetTokens: Number.isFinite(target) && target >= MIN_SUMMARIZE_TOKENS && target <= MAX_KEEP_RECENT_TOKENS
			? Math.round(target)
			: DEFAULT_HANDOFF.autoTargetTokens,
		keepRecentTokens: Number.isFinite(keep) && keep >= 0 && keep <= MAX_KEEP_RECENT_TOKENS
			? Math.round(keep)
			: DEFAULT_HANDOFF.keepRecentTokens,
		summaryThinking: parsed.summaryThinking === "session" ? "session" : "off",
		mode: parsed.mode === "draft" ? "draft" : "send",
		guard: parsed.guard === "draft" || parsed.guard === "send" || parsed.guard === "skip" ? parsed.guard : DEFAULT_HANDOFF.guard,
	};
}

/** Defaults from the previous, split configuration files. */
async function legacyDefaults(projectRoot: string): Promise<{
	autolearnEnabled?: boolean;
	autolearnAt?: number;
	handoff?: HandoffSettings;
	handoffEnabled?: boolean;
}> {
	const autolearn = await readJson(join(memoryDir(projectRoot), "autolearn.json"));
	const globalHandoff = await readJson(join(getAgentDir(), "auto-handoff.json"));
	return {
		autolearnEnabled: autolearn ? bool(autolearn.enabled) : undefined,
		autolearnAt: autolearn && typeof autolearn.at === "number" ? autolearn.at : undefined,
		handoff: normalizeHandoff(globalHandoff),
		handoffEnabled: globalHandoff ? bool(globalHandoff.enabled) : undefined,
	};
}

/** Load (once per project) and cache the project's configuration. */
export async function getConfig(projectRoot: string): Promise<ProjectContextConfig> {
	const cached = cache.get(projectRoot);
	if (cached) return cached;

	const raw = (await readJson(configFile(projectRoot))) ?? {};
	const legacy = await legacyDefaults(projectRoot);
	const rawFeatures = (raw.features && typeof raw.features === "object" ? raw.features : {}) as Record<string, unknown>;
	const rawAutolearn = (raw.autolearn && typeof raw.autolearn === "object" ? raw.autolearn : {}) as Record<string, unknown>;

	const config: ProjectContextConfig = {
		features: {
			archive: bool(rawFeatures.archive) ?? DEFAULT_FEATURES.archive,
			memory: bool(rawFeatures.memory) ?? DEFAULT_FEATURES.memory,
			autolearn: bool(rawFeatures.autolearn) ?? legacy.autolearnEnabled ?? DEFAULT_FEATURES.autolearn,
			handoff: bool(rawFeatures.handoff) ?? legacy.handoffEnabled ?? DEFAULT_FEATURES.handoff,
		},
		autolearn: {
			at: typeof rawAutolearn.at === "number" ? rawAutolearn.at : (legacy.autolearnAt ?? 0),
			turns: positive(rawAutolearn.turns, DEFAULT_AUTOLEARN.turns, 1),
			intervalMs: positive(rawAutolearn.intervalMs, DEFAULT_AUTOLEARN.intervalMs, 1000),
		},
		handoff: normalizeHandoff(raw.handoff) ?? legacy.handoff ?? { ...DEFAULT_HANDOFF },
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

export async function setFeature(projectRoot: string, feature: FeatureName, enabled: boolean): Promise<ProjectContextConfig> {
	const config = await getConfig(projectRoot);
	config.features = { ...config.features, [feature]: enabled };
	return saveConfig(projectRoot, config);
}

export async function updateHandoff(projectRoot: string, patch: Partial<HandoffSettings>): Promise<ProjectContextConfig> {
	const config = await getConfig(projectRoot);
	config.handoff = { ...config.handoff, ...patch };
	return saveConfig(projectRoot, config);
}

export async function setAutolearnAt(projectRoot: string, at: number): Promise<ProjectContextConfig> {
	const config = await getConfig(projectRoot);
	config.autolearn = { ...config.autolearn, at };
	return saveConfig(projectRoot, config);
}
