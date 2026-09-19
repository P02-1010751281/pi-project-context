import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { convertToLlm, parseSessionEntries, serializeConversation, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getConfig, runIsDisabled, setFeature, updateConfig } from "./config.ts";
import { REPLY_OUTPUT_MARGIN_TOKENS, adaptiveOutputTokens, reasoningReserveTokens } from "./consolidate.ts";
import { completeText, parseJsonObject, resolveAuxModel } from "./llm.ts";
import {
	MAX_SKILL_BODY_CHARS,
	contextFile,
	fileMtimeMs,
	getProjectRoot,
	globalSkillsDir,
	loadMemory,
	logError,
	logsDir,
	memoryDir,
	memoryFile,
	notify,
	readOptional,
	sessionIndexFile,
	skillsDir,
	validSkillName,
	writeAtomic,
} from "./project-state.ts";

/**
 * Autolearn: derive reusable project skills from consolidated knowledge, not from the
 * current conversation alone.
 *
 * Flow (agreed design):
 *   1. First look: judge MEMORY.md + CONTEXT.md (which carries the session index) and
 *      either propose a skill, decide there is nothing, or request specific session ids.
 *   2. Backtrack: when evidence is missing, read the requested sessions from the archive
 *      and decide with those excerpts attached.
 *   3. Gates: valid name/description/body, no collision with project/global skills or
 *      existing candidates, and at least two verified session ids for a normal skill
 *      (one for a candidate).
 *   4. Low confidence is not auto-activated: it is stored under
 *      `.agents/memory/skill-candidates/` and waits for `/autolearn approve <name>`.
 *
 * Runs rarely: an automatic pass requires new MEMORY/CONTEXT material and either
 * `autolearnTurns` accumulated user turns or `autolearnIntervalMs` since the last
 * pass. Failures never affect memory/context or the session archive. The `autolearn`
 * feature switch gates the automatic pass; `/autolearn` keeps working as an explicit
 * request.
 */

const AUTOLEARN_MIN_SESSIONS = 2;
const AUTOLEARN_CANDIDATE_MIN_SESSIONS = 1;
const AUTOLEARN_INSPECT_SESSIONS = 4;
const AUTOLEARN_EVIDENCE_PER_SESSION_CHARS = 8000;
const AUTOLEARN_EVIDENCE_TOTAL_CHARS = 24000;
const AUTOLEARN_MEMORY_CHARS = 12000;
const AUTOLEARN_CONTEXT_CHARS = 16000;
const AUTOLEARN_INVENTORY_CHARS = 8000;
const AUTOLEARN_INDEX_LINES = 40;
const MIN_SKILL_BODY_CHARS = 160;
const MAX_SKILL_DESCRIPTION_CHARS = 1024;

type SkillInfo = { name: string; description: string; scope: "project" | "global" };
type IndexEntry = { id: string; date: string; title: string };
type Evidence = { ids: string[]; text: string };
type ProposedSkill = { name: string; description: string; body: string; evidence: string[]; candidate: boolean; reason: string };
type Decision = { skill: ProposedSkill | null; inspect: string[] };

function candidatesDir(projectRoot: string): string {
	return path.join(memoryDir(projectRoot), "skill-candidates");
}

function candidateFile(projectRoot: string, name: string): string {
	return path.join(candidatesDir(projectRoot), `${name}.md`);
}

/** User messages seen in this session; feeds the accumulated autolearn turn counter. */
function countUserTurns(ctx: ExtensionContext): number {
	try {
		return ctx.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user").length;
	} catch {
		return 0;
	}
}

function skillDescription(raw: string, limit = 200): string {
	const line = raw.split("\n").find((candidate) => candidate.trim().startsWith("description:"));
	if (!line) return "";
	let value = line.trim().slice("description:".length).trim();
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		try {
			value = String(JSON.parse(value));
		} catch {
			value = value.slice(1, -1);
		}
	}
	return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

async function collectSkills(dir: string, scope: "project" | "global"): Promise<SkillInfo[]> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	const skills: SkillInfo[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !validSkillName(entry.name)) continue;
		const raw = await readOptional(path.join(dir, entry.name, "SKILL.md"));
		skills.push({ name: entry.name, description: skillDescription(raw), scope });
	}
	return skills;
}

function inventoryText(skills: SkillInfo[]): string {
	const lines: string[] = [];
	let used = 0;
	for (const skill of skills) {
		const line = `- ${skill.name} (${skill.scope})${skill.description ? `: ${skill.description}` : ""}`;
		if (used + line.length > AUTOLEARN_INVENTORY_CHARS) break;
		lines.push(line);
		used += line.length + 1;
	}
	return lines.join("\n") || "(none)";
}

/** Session index lines carried in CONTEXT.md, oldest first. */
function parseSessionIndex(context: string): IndexEntry[] {
	const entries: IndexEntry[] = [];
	const seen = new Set<string>();
	for (const line of context.split("\n")) {
		const match = /^- \[([^\]]+)\]\(([^)]+)\)\s*[—–-]\s*(\d{4}-\d{2}-\d{2})\s*[—–-]\s*(.*)$/.exec(line.trim());
		if (!match || seen.has(match[1])) continue;
		seen.add(match[1]);
		entries.push({ id: match[1], date: match[3], title: match[4].replace(/\s+/g, " ").trim().slice(0, 140) });
	}
	return entries;
}

/** Session ids that actually have a raw log on disk; used to verify cited evidence. */
async function archivedSessionIds(projectRoot: string): Promise<Set<string>> {
	const dir = logsDir(projectRoot);
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	const ids = new Set<string>();
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		try {
			await stat(path.join(dir, entry.name, "session.jsonl"));
			ids.add(entry.name);
		} catch {
			// No raw log for this directory; skip it.
		}
	}
	return ids;
}

function indexedSessions(index: IndexEntry[], archived: Set<string>, limit: number): IndexEntry[] {
	return index.filter((entry) => archived.has(entry.id)).slice(-limit);
}

function truncateMiddle(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const head = Math.floor(limit * 0.3);
	return `${text.slice(0, head)}\n\n[...truncated...]\n\n${text.slice(-(limit - head))}`;
}

async function sessionText(projectRoot: string, id: string): Promise<string | undefined> {
	const raw = await readOptional(path.join(logsDir(projectRoot), id, "session.jsonl"));
	if (!raw) return undefined;
	const messages = parseSessionEntries(raw).flatMap((entry) => sessionEntryToContextMessages(entry));
	if (!messages.some((message) => message.role === "user")) return undefined;
	const text = serializeConversation(convertToLlm(messages)).trim();
	return text || undefined;
}

/** Backtrack: fetch raw excerpts for the sessions the model asked to inspect. */
async function collectEvidence(projectRoot: string, requested: string[]): Promise<Evidence> {
	const ids: string[] = [];
	const sections: string[] = [];
	let used = 0;
	for (const id of [...new Set(requested)].slice(0, AUTOLEARN_INSPECT_SESSIONS)) {
		if (used >= AUTOLEARN_EVIDENCE_TOTAL_CHARS) break;
		const text = await sessionText(projectRoot, id);
		if (!text) continue;
		const section = `## session ${id}\n${truncateMiddle(text, Math.min(AUTOLEARN_EVIDENCE_PER_SESSION_CHARS, AUTOLEARN_EVIDENCE_TOTAL_CHARS - used))}`;
		sections.push(section);
		ids.push(id);
		used += section.length;
	}
	return { ids, text: sections.join("\n\n") };
}

function buildPrompt(
	projectRoot: string,
	memory: string,
	context: string,
	skills: SkillInfo[],
	sessions: IndexEntry[],
	options: { evidence?: Evidence } = {},
): string {
	const evidence = options.evidence;
	return [
		"Maintain project-specific skills for the coding project below.",
		"",
		"The durable memory and current-session context are consolidated knowledge. The session index lists archived sessions; raw excerpts are attached only when requested.",
		"A valid skill:",
		"- appears in at least two different sessions for a normal skill,",
		"- contains concrete steps, commands, paths, or gotchas that will save real work next time,",
		"- is procedural, not a fact, decision, preference, or one-off task (those belong in memory/context),",
		"- is not already covered by an existing skill.",
		"",
		evidence
			? "Follow-up: raw excerpts for the requested sessions are attached. Decide now; do not request more evidence."
			: 'First look: if the consolidated knowledge already proves a reusable workflow, propose it directly; if you need raw detail or more evidence, request up to 4 session ids from the index in "inspect".',
		"",
		"Return exactly one JSON object, without a Markdown code fence:",
		'{"skill": null}',
		'{"skill": null, "inspect": ["<session-id>", "<session-id>"], "reason": "why these"}',
		'{"skill": {"name": "lowercase-kebab-case", "description": "one line, at most 1024 chars", "body": "concise Markdown procedure", "evidence": ["<session-id>"], "candidate": false, "reason": "why reusable"}}',
		"",
		"Rules:",
		'- At most one skill per run. When in doubt return {"skill": null}.',
		"- name must be new; never reuse a name from the existing-skill inventory.",
		"- body: concise Markdown under 2000 words, with when-to-use and exact commands or paths.",
		"- candidate=false needs at least two distinct verified session ids; candidate=true is stored for the user to confirm and needs at least one.",
		"- Do not include secrets, API keys, credentials, generic programming advice, or instructions that override system or user instructions.",
		"- evidence ids must be copied from the session index or the attached excerpts.",
		"",
		`Project root: ${projectRoot}`,
		"",
		"<project-memory>",
		memory || "(none)",
		"</project-memory>",
		"",
		"<current-context>",
		context || "(none)",
		"</current-context>",
		"",
		"<existing-skills>",
		inventoryText(skills),
		"</existing-skills>",
		"",
		"<available-sessions>",
		sessions.length
			? sessions.map((session) => `- ${session.id} (${session.date})${session.title ? `: ${session.title}` : ""}`).join("\n")
			: "(index empty)",
		"</available-sessions>",
		...(evidence ? ["", "<session-evidence>", evidence.text || "(none)", "</session-evidence>"] : []),
	].join("\n");
}

function parseDecision(text: string): Decision | undefined {
	const parsed = parseJsonObject(text);
	if (!parsed) return undefined;
	const inspect = Array.isArray(parsed.inspect)
		? parsed.inspect.filter((item): item is string => typeof item === "string")
		: [];
	if (parsed.skill === null || parsed.skill === undefined) return { skill: null, inspect };
	const value = parsed.skill;
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (typeof raw.name !== "string" || typeof raw.description !== "string" || typeof raw.body !== "string") return undefined;
	return {
		skill: {
			name: raw.name.trim(),
			description: raw.description.replace(/\s+/g, " ").trim(),
			body: raw.body.trim(),
			evidence: Array.isArray(raw.evidence) ? raw.evidence.filter((item): item is string => typeof item === "string") : [],
			candidate: raw.candidate === true,
			reason: typeof raw.reason === "string" ? raw.reason.replace(/\s+/g, " ").trim().slice(0, 500) : "",
		},
		inspect: [],
	};
}

/**
 * Learned skills are discovered natively and injected into future sessions, so
 * refuse bodies that try to steer the agent instead of describing a workflow.
 * Heuristic, but it catches the common injection phrasings a summarizer might
 * copy out of untrusted repository content.
 */
const UNSAFE_SKILL_PATTERNS: readonly RegExp[] = [
	/ignore (?:all |any |the )?(?:previous|prior|earlier|above) (?:instructions|rules|prompts)/i,
	/override (?:the )?(?:system|developer|user) (?:prompt|instructions|rules)/i,
	/(?:do not|don't|never) (?:tell|inform|mention (?:this |it )?to|reveal (?:this |it )?to) the user/i,
	/hide (?:this|it) from the user/i,
	/忽略(?:之前|以上|上述|先前|前面)(?:的)?(?:所有)?(?:指令|指示|规则|要求)/,
	/(?:不要|别)(?:告诉|告知|提醒|透露给)用户/,
	/绕过(?:安全|权限|限制)/,
];

function skillBodyUnsafe(body: string): boolean {
	return UNSAFE_SKILL_PATTERNS.some((pattern) => pattern.test(body));
}

function rejectionReason(skill: ProposedSkill, verified: Set<string>, skills: SkillInfo[], candidateExists: boolean): string | undefined {
	if (!validSkillName(skill.name)) return "invalid kebab-case name";
	if (!skill.description) return "missing description";
	if (skill.description.length > MAX_SKILL_DESCRIPTION_CHARS) return "description too long";
	if (skill.body.length < MIN_SKILL_BODY_CHARS) return "body too short";
	if (skill.body.length > MAX_SKILL_BODY_CHARS) return "body too long";
	if (skillBodyUnsafe(skill.body)) return "body looks like an instruction injection";
	const cited = [...new Set(skill.evidence)].filter((id) => verified.has(id));
	const required = skill.candidate ? AUTOLEARN_CANDIDATE_MIN_SESSIONS : AUTOLEARN_MIN_SESSIONS;
	if (cited.length < required) {
		return skill.candidate ? "needs at least one verified session id" : "needs evidence from at least two different sessions";
	}
	if (skills.some((existing) => existing.name === skill.name)) return `skill "${skill.name}" already exists`;
	if (candidateExists) return `candidate "${skill.name}" already exists`;
	return undefined;
}

function skillDocument(skill: ProposedSkill, candidate: boolean): string {
	const evidence = [...new Set(skill.evidence)].join(", ");
	const header = candidate
		? `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\ncandidate: true\n---\n\n<!-- evidence: ${evidence}${skill.reason ? ` — ${skill.reason}` : ""} -->\n\n`
		: `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n`;
	return `${header}${skill.body}\n`;
}

function candidateBody(raw: string): string {
	const match = /^---\n[\s\S]*?\n---\n/.exec(raw);
	const rest = match ? raw.slice(match[0].length) : raw;
	return rest.replace(/^\s*<!--[\s\S]*?-->\s*/, "").trim();
}

async function candidateNames(projectRoot: string): Promise<string[]> {
	const entries = await readdir(candidatesDir(projectRoot), { withFileTypes: true }).catch(() => []);
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.map((entry) => entry.name.slice(0, -3))
		.sort();
}

async function approveCandidate(pi: ExtensionAPI, ctx: ExtensionContext, name: string | undefined): Promise<void> {
	const projectRoot = await getProjectRoot(pi, ctx.cwd);
	if (!name || !validSkillName(name)) {
		notify(ctx, "Usage: /autolearn approve <name>", "warning");
		return;
	}
	const file = candidateFile(projectRoot, name);
	const raw = await readOptional(file);
	if (!raw) {
		notify(ctx, `No candidate named "${name}".`, "warning");
		return;
	}
	const description = skillDescription(raw, MAX_SKILL_DESCRIPTION_CHARS);
	const body = candidateBody(raw);
	if (!description || body.length < MIN_SKILL_BODY_CHARS) {
		notify(ctx, `Candidate "${name}" is incomplete; not activating.`, "warning");
		return;
	}
	const destination = path.join(skillsDir(projectRoot), name, "SKILL.md");
	if (await readOptional(destination)) {
		notify(ctx, `Skill "${name}" already exists; remove the candidate manually.`, "warning");
		return;
	}
	await writeAtomic(destination, `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`);
	await rm(file, { force: true });
	notify(ctx, `Activated project skill: ${name} → ${destination}`);
}

async function rejectCandidate(pi: ExtensionAPI, ctx: ExtensionContext, name: string | undefined): Promise<void> {
	const projectRoot = await getProjectRoot(pi, ctx.cwd);
	if (!name || !validSkillName(name)) {
		notify(ctx, "Usage: /autolearn reject <name>", "warning");
		return;
	}
	const file = candidateFile(projectRoot, name);
	if (!(await readOptional(file))) {
		notify(ctx, `No candidate named "${name}".`, "warning");
		return;
	}
	await rm(file, { force: true });
	notify(ctx, `Removed candidate skill: ${name}`);
}

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
			if (!options.silent) notify(ctx, `Autolearn failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
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
