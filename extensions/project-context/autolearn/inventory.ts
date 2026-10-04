/**
 * What the project already knows: the skill inventory injected into the prompt.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import { MAX_SKILL_BODY_CHARS, readOptional, validSkillName } from "../shared/project-state.ts";
import { type SkillInfo, autolearnProvenance, skillBody, skillDescription, withoutAutolearnProvenance } from "./skill.ts";

const AUTOLEARN_INVENTORY_CHARS = 8000;

/**
 * How much of a learned skill's own body the merge prompt may carry. Whole bodies only: a truncated
 * body invites a lossy "merge", so a skill that does not fit is left out entirely (and then the
 * prompt's rule forbids reusing its name this pass).
 */
const AUTOLEARN_LEARNED_BODY_CHARS = MAX_SKILL_BODY_CHARS;

export async function collectSkills(dir: string, scope: "project" | "global"): Promise<SkillInfo[]> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	const skills: SkillInfo[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !validSkillName(entry.name)) continue;
		const raw = await readOptional(path.join(dir, entry.name, "SKILL.md"));
		const autolearn = autolearnProvenance(raw);
		skills.push({
			name: entry.name,
			description: skillDescription(raw),
			scope,
			autolearn,
			// Only a skill this pipeline wrote may be superseded, and only a project skill may be written,
			// so a global skill's body is never carried.
			...(autolearn && scope === "project" ? { body: withoutAutolearnProvenance(skillBody(raw)) } : {}),
		});
	}
	return skills;
}

export function inventoryText(skills: SkillInfo[]): string {
	const lines: string[] = [];
	let used = 0;
	for (const skill of skills) {
		const line = `- ${skill.name} (${skill.scope}${skill.autolearn ? ", learned" : ""})${skill.description ? `: ${skill.description}` : ""}`;
		if (used + line.length > AUTOLEARN_INVENTORY_CHARS) break;
		lines.push(line);
		used += line.length + 1;
	}
	return lines.join("\n") || "(none)";
}

/** The learned project skills' own bodies, so an update can merge instead of rewriting blind. */
export function learnedBodiesText(skills: SkillInfo[]): string {
	const sections: string[] = [];
	let used = 0;
	for (const skill of skills) {
		if (!skill.autolearn || skill.scope !== "project" || !skill.body) continue;
		const section = `### ${skill.name}\n\n${skill.body}`;
		if (used + section.length > AUTOLEARN_LEARNED_BODY_CHARS) continue;
		sections.push(section);
		used += section.length + 1;
	}
	return sections.join("\n\n");
}
