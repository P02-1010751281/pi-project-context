import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerArchive } from "./archive.ts";
import { registerAutolearn } from "./autolearn.ts";
import { configFile, FEATURE_NAMES, getConfig, runIsDisabled, setFeature, setRunDisabled } from "./config.ts";
import { registerConsolidation } from "./consolidate.ts";
import { registerHandoff } from "./handoff.ts";
import { getProjectRoot, notify } from "./project-state.ts";

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
	pi.on("session_start", async (_event, ctx) => {
		const disabled = pi.getFlag("no-project-context") === true;
		setRunDisabled(disabled);
		if (disabled) notify(ctx, "project-context: disabled for this run (--no-project-context)");
	});

	// Order matters for agent_settled: archive first, then the passes, then the valve.
	registerArchive(pi);
	registerConsolidation(pi);
	registerAutolearn(pi);
	registerHandoff(pi);

	function featuresText(config: Awaited<ReturnType<typeof getConfig>>): string {
		return FEATURE_NAMES.map((name) => `${name}=${config.features[name] ? "on" : "off"}`).join("  ");
	}

	pi.registerCommand("project-context", {
		description: "Show or toggle project-context features: status | on|off archive|memory|autolearn|handoff|all",
		handler: async (args, ctx) => {
			const projectRoot = await getProjectRoot(pi, ctx.cwd);
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const verb = (parts[0] ?? "").toLowerCase();

			if (!verb || verb === "status") {
				const config = await getConfig(projectRoot);
				const lines = [`Project context: ${featuresText(config)}`, `Config: ${configFile(projectRoot)}`];
				if (runIsDisabled()) lines.push("This run is disabled by --no-project-context.");
				notify(ctx, lines.join("\n"));
				return;
			}
			if (verb !== "on" && verb !== "off") {
				notify(ctx, `Usage: /project-context status | on|off <${FEATURE_NAMES.join("|")}|all>`, "warning");
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
