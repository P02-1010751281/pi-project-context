/**
 * The pass itself and its registration: one throttled distillation per project.
 */

import path from "node:path";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getConfig, runIsDisabled, setFeature, updateConfig } from "../shared/config.ts";
import { REPLY_OUTPUT_MARGIN_TOKENS, adaptiveOutputTokens, reasoningReserveTokens } from "../shared/output-budget.ts";
import { completeText, resolveAuxModel } from "../shared/llm.ts";
import { MAX_SKILL_BODY_CHARS, contextFile, errorText, fileMtimeMs, getProjectRoot, globalSkillsDir, loadMemory, logError, memoryFile, notify, readOptional, sessionIndexFile, skillsDir, writeAtomic } from "../shared/project-state.ts";
import { approveCandidate, candidateFile, candidateNames, rejectCandidate, rejectionReason } from "./candidate.ts";
import { AUTOLEARN_CONTEXT_CHARS, AUTOLEARN_INDEX_LINES, AUTOLEARN_MEMORY_CHARS, archivedSessionIds, collectEvidence, countUserTurns, indexedSessions, parseSessionIndex } from "./evidence.ts";
import { collectSkills } from "./inventory.ts";
import { parseDecision } from "./parse.ts";
import { buildPrompt } from "./prompt.ts";
import { skillDocument } from "./skill.ts";

export function registerAutolearn(pi: ExtensionAPI): void {
	/** Single-flight guard: session_start and agent_settled can both schedule a pass. */
	let active: Promise<void> | undefined;
	/** dsh-compatible throttle: accumulated turns since the last pass, per project. */
	const throttle = new Map<string, { session: string; sessionTurns: number; turns: number }>();

	async function run(ctx: ExtensionContext, options: { force?: boolean; silent?: boolean } = {}): Promise<void> {
		const force = options.force ?? false;
		let projectRoot: string | undefined;
		try {
			projectRoot = await getProjectRoot(pi, ctx.cwd);
			const config = await getConfig(projectRoot);
			if (runIsDisabled() && !force) return;
			if (!config.autoLearn && !force) return;

			const sessionId = ctx.sessionManager.getSessionId();
			const turns = countUserTurns(ctx);
			const previous = throttle.get(projectRoot);
			const baseline = previous?.session === sessionId ? previous.sessionTurns : 0;
			const totalTurns = (previous?.turns ?? 0) + Math.max(0, turns - baseline);
			if (!force) {
				// Same gate as the dsh plugin: new material is required, then either the
				// accumulated turn count or the interval makes the pass due. `at` is
				// persisted, so a restart does not re-run on material already distilled.
				const stamp = Math.max(await fileMtimeMs(memoryFile(projectRoot)), await fileMtimeMs(contextFile(projectRoot)));
				const changed = stamp > config.autolearnAt;
				const due = totalTurns >= config.autolearnTurns || Date.now() - config.autolearnAt >= config.autolearnIntervalMs;
				if (!changed || !due) {
					throttle.set(projectRoot, { session: sessionId, sessionTurns: turns, turns: totalTurns });
					return;
				}
			}

			const archived = await archivedSessionIds(projectRoot);
			if (archived.size === 0 && !force) return;
			const context = (await readOptional(contextFile(projectRoot))).slice(0, AUTOLEARN_CONTEXT_CHARS);
			// The archive-layer index lives next to the logs it points at (`.agents/memory/session-logs/INDEX.md`).
			const sessions = indexedSessions(parseSessionIndex(await readOptional(sessionIndexFile(projectRoot))), archived, AUTOLEARN_INDEX_LINES);
			const auxModel = resolveAuxModel(ctx, config);
			if (!auxModel) {
				if (force) notify(ctx, "Autolearn skipped: no authenticated model available", "warning");
				return;
			}

			const loadedMemory = await loadMemory(projectRoot, config.maxMemoryChars);
			if (loadedMemory.unreadable) {
				await logError(projectRoot, "autolearn", "MEMORY.md exists but cannot be read; continuing with an empty memory.");
			}
			const memory = loadedMemory.text.slice(0, AUTOLEARN_MEMORY_CHARS);
			const skills = [
				...(await collectSkills(skillsDir(projectRoot), "project")),
				...(await collectSkills(globalSkillsDir(), "global")),
			];

			// A skill body can be as large as MAX_SKILL_BODY_CHARS; ask for enough output room (1
			// token per char worst case) plus the model's hidden reasoning share, bounded by its own
			// limit and the configured ceiling.
			const maxTokens = adaptiveOutputTokens(
				config.maxTokens,
				MAX_SKILL_BODY_CHARS + REPLY_OUTPUT_MARGIN_TOKENS + reasoningReserveTokens(MAX_SKILL_BODY_CHARS, auxModel),
				auxModel,
				config.maxOutputTokens,
			);

			// First look: consolidated artifacts + session index decide whether there is something to learn.
			let decision = parseDecision(await completeText(ctx, buildPrompt(projectRoot, memory, context, skills, sessions), {
				model: auxModel,
				maxTokens,
			}));
			await updateConfig(projectRoot, { autolearnAt: Date.now() });
			throttle.set(projectRoot, { session: sessionId, sessionTurns: turns, turns: 0 });
			if (!decision) {
				if (force) notify(ctx, "Autolearn: the model did not return the expected JSON; nothing written", "warning");
				return;
			}

			// Backtrack: fetch the raw evidence the first look asked for, then decide.
			if (!decision.skill && decision.inspect.length > 0) {
				const evidence = await collectEvidence(projectRoot, decision.inspect);
				decision = parseDecision(await completeText(ctx, buildPrompt(projectRoot, memory, context, skills, sessions, { evidence }), {
					model: auxModel,
					maxTokens,
				}));
				if (!decision) {
					if (force) notify(ctx, "Autolearn: the model did not return the expected JSON; nothing written", "warning");
					return;
				}
			}

			if (!decision.skill) {
				if (force) notify(ctx, "Autolearn: no new reusable workflow found");
				return;
			}
			const skill = decision.skill;
			const candidateExists = !!(await readOptional(candidateFile(projectRoot, skill.name)));
			const reason = rejectionReason(skill, archived, skills, candidateExists);
			if (reason) {
				if (force) notify(ctx, `Autolearn: rejected "${skill.name}" (${reason})`, "warning");
				return;
			}
			if (skill.candidate) {
				await writeAtomic(candidateFile(projectRoot, skill.name), skillDocument(skill, true));
				notify(ctx, `Autolearn: candidate skill "${skill.name}" saved for review — /autolearn approve ${skill.name}`);
				return;
			}
			const destination = path.join(skillsDir(projectRoot), skill.name, "SKILL.md");
			if (await readOptional(destination)) {
				if (force) notify(ctx, `Autolearn: rejected "${skill.name}" (already exists)`, "warning");
				return;
			}
			await writeAtomic(destination, skillDocument(skill, false));
			notify(ctx, `Learned project skill: ${skill.name} → ${destination}`);
		} catch (error) {
			if (projectRoot) await logError(projectRoot, "autolearn", error);
			if (!options.silent) notify(ctx, `Autolearn failed: ${errorText(error)}`, "warning");
		}
	}

	function schedule(ctx: ExtensionContext): void {
		if (active) return;
		active = run(ctx, { silent: true }).finally(() => {
			active = undefined;
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		schedule(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		schedule(ctx);
	});

	pi.registerCommand("autolearn", {
		description: "Learn a project skill now; also: list | approve <name> | reject <name> | on | off",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const verb = (parts[0] ?? "").toLowerCase();
			if (verb === "on" || verb === "off") {
				const projectRoot = await getProjectRoot(pi, ctx.cwd);
				await setFeature(projectRoot, "autolearn", verb === "on");
				notify(ctx, `Autolearn ${verb === "on" ? "enabled" : "disabled"} for ${projectRoot}`);
				return;
			}
			if (verb === "list") {
				const projectRoot = await getProjectRoot(pi, ctx.cwd);
				const names = await candidateNames(projectRoot);
				notify(ctx, names.length > 0
					? `Skill candidates: ${names.join(", ")} (/autolearn approve <name>)`
					: "No skill candidates.");
				return;
			}
			if (verb === "approve") {
				await approveCandidate(pi, ctx, parts[1]);
				return;
			}
			if (verb === "reject") {
				await rejectCandidate(pi, ctx, parts[1]);
				return;
			}
			await run(ctx, { force: true });
		},
	});
}
