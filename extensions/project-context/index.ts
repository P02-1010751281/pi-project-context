import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stat } from "node:fs/promises";
import { registerArchive } from "./archive/archive.ts";
import { registerAutolearn } from "./autolearn/autolearn.ts";
import { configFile, DEFAULT_CONFIG, FEATURE_FIELDS, FEATURE_NAMES, getConfig, MIN_AUX_MAX_TOKENS, runIsDisabled, setFeature, setRunDisabled, updateConfig } from "./shared/config.ts";
import { registerConsolidation } from "./memory/report.ts";
import { registerHandoff } from "./handoff/run.ts";
import { restoreHandoffSessionSettings } from "./handoff/session-settings.ts";
import { contextFile, getProjectRoot, isMemoryTruncated, loadMemory, notify, type LoadedMemory } from "./shared/project-state.ts";

/**
 * project-context — project memory, session archive, skill learning and the window valve.
 *
 * The four features work on one project-scoped data flow:
 *
 *   session.jsonl (source of truth)
 *    ├─ archive      (no LLM)  writes session.jsonl/session.md, maintains session-logs/INDEX.md,
 *    │                         injects CONTEXT.md read-only
 *    ├─ memory       (1 LLM)   consolidation pass → MEMORY.md + CONTEXT.md, both injected
 *    ├─ autolearn    (1 LLM, ≥6h) reads memory/context/index, backtracks for evidence,
 *    │                         writes .agents/skills/<name>/SKILL.md or a candidate
 *    └─ handoff      (1 LLM)   context-window valve: summarize the old span, replay recent
 *                              messages verbatim, continue in a fresh session
 *
 * Every feature has a switch in `<project>/.agents/memory/project-context.json`
 * (`/project-context on|off <feature|all>`); `--no-project-context` disables the whole
 * extension for one run. Switches gate the automatic behavior (and, for `memory`, the
 * injection); explicit commands keep working.
 *
 * All of this lives in one extension on purpose: pi loads each extension in its own
 * module registry (jiti with `moduleCache: false`), so shared throttle/single-flight
 * state is only safe inside a single extension.
 */
export default function projectContext(pi: ExtensionAPI): void {
	pi.registerFlag("no-project-context", {
		type: "boolean",
		default: false,
		description: "Disable every project-context feature for this run (archive, memory, autolearn, handoff)",
	});

	// Registered before the feature hooks so the run-level switch is set first.
	pi.on("session_start", async (event, ctx) => {
		const disabled = pi.getFlag("no-project-context") === true;
		setRunDisabled(disabled);
		if (disabled) notify(ctx, "project-context: disabled for this run (--no-project-context)");
		// A handoff stages its model/thinking before `newSession()`; restore them here, the only
		// point after the switch where pi still lets an extension set them (the old `pi` is stale).
		if (!disabled) await restoreHandoffSessionSettings(pi, ctx, event).catch(() => {});
	});

	// Order matters for agent_settled: archive first, then the passes, then the valve.
	registerArchive(pi);
	registerConsolidation(pi);
	registerAutolearn(pi);
	registerHandoff(pi);

	function featuresText(config: Awaited<ReturnType<typeof getConfig>>): string {
		return FEATURE_NAMES.map((name) => `${name}=${config[FEATURE_FIELDS[name]] ? "on" : "off"}`).join("  ");
	}

	function auxText(config: Awaited<ReturnType<typeof getConfig>>): string {
		const route = config.provider && config.model ? `${config.provider}/${config.model}` : "session model";
		return `${route}, max ${config.maxTokens} tokens`;
	}

	/** What the memory injection currently uses, including how it is stored (the fix for the old bug). */
	function memoryStatusLine(memory: LoadedMemory): string {
		const chars = memory.text.length;
		const size = chars === 0 ? "empty" : `${chars} chars`;
		if (memory.unreadable) return `${memory.source} — exists but cannot be read; see .agents/memory/errors.log`;
		if (memory.poisoned) return `${memory.source} (${size}) — stored as raw JSON from the old bug; the next consolidation backs it up and rewrites it`;
		if (memory.damaged) return `${memory.source} (${size}) — ${memory.damaged} unusable line(s) skipped; see .agents/memory/errors.log`;
		// A capped document ends with its own marker; surface it here too, next to the knob that lifts it.
		if (isMemoryTruncated(memory.text)) return `${memory.source} (${size}) — at the maxMemoryChars cap, the tail was dropped (whole lines only); raise maxMemoryChars in project-context.json`;
		return `${memory.source} (${size})`;
	}

	/** CONTEXT.md is only rewritten when a pass returns one, so its age is the useful signal here. */
	async function contextStatusLine(projectRoot: string): Promise<string> {
		const file = contextFile(projectRoot);
		try {
			const info = await stat(file);
			const updated = new Date(info.mtimeMs).toISOString().replace(/\.\d+Z$/, "Z");
			return `${file} — updated ${updated} (${humanAge(Date.now() - info.mtimeMs)} ago)`;
		} catch {
			return "none yet (a consolidation pass that returns one writes it)";
		}
	}

	function humanAge(ms: number): string {
		const minutes = Math.floor(ms / 60_000);
		if (minutes < 1) return "less than a minute";
		if (minutes < 60) return `${minutes} min`;
		const hours = Math.floor(minutes / 60);
		return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
	}

	pi.registerCommand("project-context", {
		description: "Show or change project-context settings: status | on|off <feature|all> | model <provider>/<id>|off | max-tokens <n>|default",
		handler: async (args, ctx) => {
			const projectRoot = await getProjectRoot(pi, ctx.cwd);
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const verb = (parts[0] ?? "").toLowerCase();

			if (!verb || verb === "status") {
				const config = await getConfig(projectRoot);
				const lines = [
					`Project context: ${featuresText(config)}`,
					`Auxiliary calls: ${auxText(config)}`,
					`Config: ${configFile(projectRoot)}`,
					`Memory: ${memoryStatusLine(await loadMemory(projectRoot, config.maxMemoryChars))}`,
					`Context: ${await contextStatusLine(projectRoot)}`,
				];
				if (runIsDisabled()) lines.push("This run is disabled by --no-project-context.");
				notify(ctx, lines.join("\n"));
				return;
			}
			if (verb === "model" || verb === "max-tokens") {
				const value = (parts[1] ?? "").trim();
				const usage = verb === "max-tokens"
					? `Usage: /project-context max-tokens <n ≥ ${MIN_AUX_MAX_TOKENS}> | default`
					: "Usage: /project-context model <provider>/<model-id> | off";
				if (!value) {
					notify(ctx, usage, "warning");
					return;
				}
				if (verb === "max-tokens") {
					if (value === "default") {
						await updateConfig(projectRoot, { maxTokens: DEFAULT_CONFIG.maxTokens });
					} else {
						const tokens = Number(value);
						if (!Number.isFinite(tokens) || tokens < MIN_AUX_MAX_TOKENS) {
							notify(ctx, usage, "warning");
							return;
						}
						await updateConfig(projectRoot, { maxTokens: Math.round(tokens) });
					}
				} else if (value === "off" || value === "default" || value === "session") {
					await updateConfig(projectRoot, { provider: "", model: "" });
				} else {
					const slash = value.indexOf("/");
					if (slash <= 0 || slash === value.length - 1) {
						notify(ctx, usage, "warning");
						return;
					}
					await updateConfig(projectRoot, { provider: value.slice(0, slash), model: value.slice(slash + 1) });
				}
				notify(ctx, `Auxiliary calls: ${auxText(await getConfig(projectRoot))}`);
				return;
			}
			if (verb !== "on" && verb !== "off") {
				notify(ctx, `Usage: /project-context status | on|off <${FEATURE_NAMES.join("|")}|all> | model <provider>/<id>|off | max-tokens <n>|default`, "warning");
				return;
			}

			const target = (parts[1] ?? "").toLowerCase();
			const names = target === "all" ? FEATURE_NAMES : FEATURE_NAMES.filter((name) => name === target);
			if (names.length === 0) {
				notify(ctx, `Unknown feature "${target}". Use ${FEATURE_NAMES.join("|")}|all.`, "warning");
				return;
			}
			for (const name of names) await setFeature(projectRoot, name, verb === "on");
			const config = await getConfig(projectRoot);
			notify(ctx, `Project context: ${featuresText(config)}`);
		},
	});
}
