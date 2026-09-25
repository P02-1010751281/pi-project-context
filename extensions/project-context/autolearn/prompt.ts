/**
 * The autolearn prompt: inventory, index and collected evidence, under the fixed rules.
 */

import { type Evidence, type IndexEntry } from "./evidence.ts";
import { inventoryText } from "./inventory.ts";
import { type SkillInfo } from "./skill.ts";

export function buildPrompt(
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
