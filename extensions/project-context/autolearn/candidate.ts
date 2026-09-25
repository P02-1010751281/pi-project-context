/**
 * Candidate skills on disk: the pending files, the admission rules a proposal must pass, and the
 * approve/reject transitions the command drives.
 */

import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAX_SKILL_BODY_CHARS, getProjectRoot, memoryDir, notify, readOptional, skillsDir, validSkillName, writeAtomic } from "../shared/project-state.ts";
import { MAX_SKILL_DESCRIPTION_CHARS, MIN_SKILL_BODY_CHARS, type ProposedSkill, type SkillInfo, skillBodyUnsafe, skillDescription } from "./skill.ts";

const AUTOLEARN_MIN_SESSIONS = 2;

const AUTOLEARN_CANDIDATE_MIN_SESSIONS = 1;

function candidatesDir(projectRoot: string): string {
	return path.join(memoryDir(projectRoot), "skill-candidates");
}

export function candidateFile(projectRoot: string, name: string): string {
	return path.join(candidatesDir(projectRoot), `${name}.md`);
}

export function rejectionReason(skill: ProposedSkill, verified: Set<string>, skills: SkillInfo[], candidateExists: boolean): string | undefined {
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

function candidateBody(raw: string): string {
	const match = /^---\n[\s\S]*?\n---\n/.exec(raw);
	const rest = match ? raw.slice(match[0].length) : raw;
	return rest.replace(/^\s*<!--[\s\S]*?-->\s*/, "").trim();
}

export async function candidateNames(projectRoot: string): Promise<string[]> {
	const entries = await readdir(candidatesDir(projectRoot), { withFileTypes: true }).catch(() => []);
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.map((entry) => entry.name.slice(0, -3))
		.sort();
}

export async function approveCandidate(pi: ExtensionAPI, ctx: ExtensionContext, name: string | undefined): Promise<void> {
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

export async function rejectCandidate(pi: ExtensionAPI, ctx: ExtensionContext, name: string | undefined): Promise<void> {
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
