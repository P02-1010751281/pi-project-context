import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerArchive } from "./archive/archive.ts";
import { registerAutolearn } from "./autolearn/pass.ts";
import { configFile, DEFAULT_CONFIG, FEATURE_FIELDS, FEATURE_NAMES, getConfig, MIN_AUX_MAX_TOKENS, runIsDisabled, setFeature, setRunDisabled, updateConfig } from "./shared/config.ts";
import { completeValues, completeVerbs } from "./shared/complete.ts";
import { capCeilingWarning, memoryCapUnsatisfiable } from "./shared/output-budget.ts";
import { peekAuxModel } from "./shared/llm.ts";
import { registerConsolidation } from "./memory/report.ts";
import { contextStatusLine, memoryStatusLine } from "./memory/status.ts";
import { registerHandoff } from "./handoff/run.ts";
import { restoreHandoffSessionSettings } from "./handoff/session-settings.ts";
import { getProjectRoot, loadMemory, notify } from "./shared/project-state.ts";

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
 *    └─ handoff      (no LLM)  context-window valve: drop the old span, replay recent messages
 *                              verbatim, point at the session log, continue in a fresh session
 *
 * Every feature has a switch in `<project>/.agents/memory/project-context.json`. Each layer command owns
 * its own (`/memory on|off`, `/session-log on|off`, `/handoff on|off`, `/autolearn on|off`) and the bare
 * `/project-context on|off` sets all four at once — a batch, not an extension switch: only the
 * `--no-project-context` flag disables the whole extension, and only for one run. Switches gate the
 * automatic behavior (and, for `memory`, the injection); explicit commands keep working.
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

	pi.registerCommand("project-context", {
		description: "Show or change cross-layer settings: status | on|off (all four features) | model <provider>/<id>|off | max-tokens <n>|default",
		getArgumentCompletions: (prefix) => {
			const verbs = completeVerbs(prefix, PROJECT_CONTEXT_VERBS);
			if (verbs) return verbs;
			for (const { head, values } of PROJECT_CONTEXT_VALUE_COMPLETIONS) {
				const items = completeValues(prefix, head, values);
				if (items) return items;
			}
			return null;
		},
		handler: async (args, ctx) => {
			const projectRoot = await getProjectRoot(pi, ctx.cwd);
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const verb = (parts[0] ?? "").toLowerCase();

			if (!verb || verb === "status") {
				const config = await getConfig(projectRoot);
				const lines = [
					`Features: ${featuresText(config)}`,
					`Auxiliary calls: ${auxText(config)}`,
					`Config: ${configFile(projectRoot)}`,
					`Memory: ${memoryStatusLine(await loadMemory(projectRoot, config.maxMemoryChars), config.maxMemoryChars)}`,
					`Context file: ${await contextStatusLine(projectRoot)}`,
				];
				// The `reasoning` flag must come from the route the auxiliary call actually uses: a configured
				// `provider`/`model` override decides that, not the session model (independent review round 15,
				// I-A). `peekAuxModel` resolves it without the dead-route warning `resolveAuxModel` sends,
				// which a status read must not do.
				const reasoningRoute = peekAuxModel(ctx, config)?.reasoning === true;
				if (memoryCapUnsatisfiable(config.maxMemoryChars, config.maxTokens, config.maxOutputTokens, reasoningRoute)) {
					lines.push(`Memory cap warning: ${capCeilingWarning(config, reasoningRoute)}; lower it with /memory max-memory <n> or raise maxTokens/maxOutputTokens.`);
				}
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
				notify(ctx, "Usage: /project-context status | on|off | model <provider>/<id>|off | max-tokens <n>|default", "warning");
				return;
			}

			// The bare form is the batch over the four feature switches. A per-feature toggle lives in that
			// feature's own command, so there is no target here and no `all` token either: one name, one path.
			if (parts.length > 1) {
				notify(ctx, `The batch form takes no target; /project-context ${verb} sets all four features.`, "warning");
				return;
			}
			for (const name of FEATURE_NAMES) await setFeature(projectRoot, name, verb === "on");
			notify(ctx, `Features: ${featuresText(await getConfig(projectRoot))}`);
		},
	});
}

/** Verbs the `project-context` command accepts, for argument completion (mirrors the handler). */
const PROJECT_CONTEXT_VERBS = [
	{ value: "status" },
	{ value: "on", description: "enable all four features at once" },
	{ value: "off", description: "disable all four features at once" },
	{ value: "model", description: "auxiliary model route" },
	{ value: "max-tokens", description: "output budget for auxiliary calls" },
];

/** Second-argument completions, keyed by the verb that takes them. */
const PROJECT_CONTEXT_VALUE_COMPLETIONS = [
	{ head: "model", values: [{ value: "off", description: "use the session model" }, { value: "session" }] },
	{ head: "max-tokens", values: [{ value: "default" }] },
];
