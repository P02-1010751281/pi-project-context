/**
 * The skill shapes and their rendering: the proposed skill, the `SKILL.md` document it becomes,
 * and the body/description safety checks every write goes through.
 */

export const MIN_SKILL_BODY_CHARS = 160;

export const MAX_SKILL_DESCRIPTION_CHARS = 1024;

export type SkillInfo = { name: string; description: string; scope: "project" | "global"; autolearn: boolean; body?: string };

export type ProposedSkill = { name: string; description: string; body: string; evidence: string[]; candidate: boolean; reason: string };

/**
 * The provenance marker every skill this pipeline writes carries in its body.
 *
 * It is what makes "autolearn may only supersede its own output" checkable on the artifact itself
 * instead of booked in a side file: a marker dies with the skill, so a name freed by a deletion and
 * later taken by a hand-written skill can never be mistaken for one of ours. It sits in the body and
 * not the frontmatter because pi injects only name/description/path at session start and unknown
 * frontmatter keys are undefined behavior.
 */
const PROVENANCE_PATTERN = /<!--\s*autolearn-generated[^>]*-->/g;

const PROVENANCE_COMMENT = "<!-- autolearn-generated: this skill may be superseded by a later autolearn pass -->";

/** True when this `SKILL.md` (frontmatter or body) carries the pipeline's provenance marker. */
export function autolearnProvenance(raw: string): boolean {
	return new RegExp(PROVENANCE_PATTERN.source).test(raw);
}

/** The body with the marker stripped, so a merge prompt never carries pipeline metadata. */
export function withoutAutolearnProvenance(body: string): string {
	return body.replace(PROVENANCE_PATTERN, "").replace(/^\s+/, "").trimEnd();
}

/** Everything after the `SKILL.md` frontmatter, marker included. */
export function skillBody(raw: string): string {
	const match = /^---\n[\s\S]*?\n---\n/.exec(raw);
	return (match ? raw.slice(match[0].length) : raw).trim();
}

/** The `SKILL.md` a promoted skill becomes: frontmatter, provenance marker, then the body. */
export function promotedDocument(name: string, description: string, body: string): string {
	return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${PROVENANCE_COMMENT}\n\n${withoutAutolearnProvenance(body)}\n`;
}

export function skillDescription(raw: string, limit = 200): string {
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

export function skillBodyUnsafe(body: string): boolean {
	return UNSAFE_SKILL_PATTERNS.some((pattern) => pattern.test(body));
}

export function skillDocument(skill: ProposedSkill, candidate: boolean): string {
	if (!candidate) return promotedDocument(skill.name, skill.description, skill.body);
	const evidence = [...new Set(skill.evidence)].join(", ");
	const header = `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\ncandidate: true\n---\n\n<!-- evidence: ${evidence}${skill.reason ? ` — ${skill.reason}` : ""} -->\n\n`;
	return `${header}${skill.body}\n`;
}
