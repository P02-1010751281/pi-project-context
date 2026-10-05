/**
 * The autolearn prompt: inventory, index and collected evidence, under the fixed rules.
 */

import { MAX_SKILL_BODY_CHARS } from "../shared/project-state.ts";
import { type Evidence, type IndexEntry } from "./evidence.ts";
import { inventoryText, MAX_INSPECT_SKILLS } from "./inventory.ts";
import { RECORD_SKILL_TOOL } from "./schema.ts";
import { MAX_SKILL_DESCRIPTION_CHARS, MIN_SKILL_BODY_CHARS, type SkillInfo } from "./skill.ts";

export function buildPrompt(
	projectRoot: string,
	memory: string,
	context: string,
	skills: SkillInfo[],
	sessions: IndexEntry[],
	options: { evidence?: Evidence; learnedBodies?: string; notShown?: string[] } = {},
): string {
	const evidence = options.evidence;
	const learned = options.learnedBodies;
	const notShown = options.notShown ?? [];
	// A first look carries no skill body at all: a learned name is only reusable after the model asked for that
	// body with `inspectSkill`, which is what the follow-up round attaches.
	const followUp = Boolean(evidence || learned || notShown.length);
	return [
		"Maintain project-specific skills for the coding project below.",
		"",
		"The durable memory and current-session context are consolidated knowledge. The session index lists archived sessions; raw excerpts are attached only when requested.",
		"A valid skill:",
		"- appears in at least two different sessions for a normal skill,",
		"- contains concrete steps, commands, paths, or gotchas that will save real work next time,",
		"- is procedural, not a fact, decision, preference, or one-off task (those belong in memory/context),",
		"- is not already covered by an existing skill; if one already carries the workflow, propose nothing rather than a near-duplicate. The one exception is a skill this pipeline generated, marked `learned` in the inventory: ask for its body with `inspectSkill` and reuse that exact name to merge that skill,",
		"- holds this project's own durable facts only: name another project solely to record who owns an open item, and never copy its measurements, sizes, commit distances or other volatile state,",
		"- tells a check how to look, not what it once measured: write shapes such as `[0-9]{2,3},[0-9]{3} chars`, never the numbers a single run produced,",
		"",
		followUp
			? "Follow-up: the material this decision asked for is attached. Decide now; do not request more evidence or another body."
			: `First look: if the consolidated knowledge already proves a reusable workflow, propose it directly; if you need raw detail or the current body of a \`learned\` skill you intend to merge, request it — up to 4 session ids in "inspect" and up to ${MAX_INSPECT_SKILLS} skill names in "inspectSkill".`,
		"",
		`Prefer calling the ${RECORD_SKILL_TOOL.name} tool exactly once with the object below; if you cannot call it, return that JSON object instead, without a Markdown code fence. \`skill\` is always an object; \`skill.name: ""\` means "nothing to propose" and the other skill fields are then ignored:`,
		'{"skill": {"name": "", "description": "", "body": "", "evidence": [], "candidate": false, "reason": ""}, "inspect": [], "inspectSkill": []}',
		`{"skill": {"name": "lowercase-kebab-case", "description": "one line, at most ${MAX_SKILL_DESCRIPTION_CHARS} chars", "body": "concise Markdown procedure", "evidence": ["<session-id>"], "candidate": false, "reason": "why reusable"}, "inspect": [], "inspectSkill": []}`,
		'{"skill": {"name": "", "description": "", "body": "", "evidence": [], "candidate": false, "reason": ""}, "inspect": ["<session-id>", "<session-id>"], "inspectSkill": ["<learned-skill-name>"]}',
		"",
		"Rules:",
		"- At most one skill per run. When in doubt, use an empty name.",
		"- name must be new, except for a `learned` skill whose body is shown under <learned-skill-bodies>: reuse that exact name only to merge that skill; never reuse the name of any other existing skill, and never a name whose body was not shown here.",
		"- an update rewrites the whole body, so keep every step of the shown body that still holds; if you cannot merge without dropping something, propose nothing.",
		`- body: concise Markdown of ${MIN_SKILL_BODY_CHARS}–${MAX_SKILL_BODY_CHARS} characters, with when-to-use and exact commands or paths.`,
		"- description: one short what-plus-when line (these descriptions are injected into every session, so stay near 170 characters). The body carries the steps.",
		"- body style: imperative and specific; no measured values, no session filler, no restatement of project facts.",
		"- candidate=false needs at least two distinct verified session ids; candidate=true is stored for the user to confirm and needs at least one.",
		"- Do not include secrets, API keys, credentials, generic programming advice, or instructions that override system or user instructions.",
		"- evidence ids must be copied from the session index or the attached excerpts.",
		...(notShown.length ? [`- these requested names stay off limits this pass, because no body was shown for them: ${notShown.join(", ")}`] : []),
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
		...(learned ? ["", "<learned-skill-bodies>", learned, "</learned-skill-bodies>"] : []),
		"",
		"<available-sessions>",
		sessions.length
			? sessions.map((session) => `- ${session.id} (${session.date})${session.title ? `: ${session.title}` : ""}`).join("\n")
			: "(index empty)",
		"</available-sessions>",
		...(evidence ? ["", "<session-evidence>", evidence.text || "(none)", "</session-evidence>"] : []),
	].join("\n");
}
