/**
 * What the project already knows: the skill inventory injected into the prompt.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import { readOptional, validSkillName } from "../shared/project-state.ts";
import { type SkillInfo, skillDescription } from "./skill.ts";

const AUTOLEARN_INVENTORY_CHARS = 8000;

export async function collectSkills(dir: string, scope: "project" | "global"): Promise<SkillInfo[]> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	const skills: SkillInfo[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !validSkillName(entry.name)) continue;
		const raw = await readOptional(path.join(dir, entry.name, "SKILL.md"));
		skills.push({ name: entry.name, description: skillDescription(raw), scope });
	}
	return skills;
}

export function inventoryText(skills: SkillInfo[]): string {
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
