/**
 * The `record_skill` tool schema.
 *
 * The old reply shape allowed `skill: null`, which cannot be expressed in a strict JSON schema: an
 * object member means `makeStrictJsonSchema` wraps it into `anyOf: [<object>, {type: "null"}]`, and
 * object unions are rejected. The shape is therefore always an object whose empty `name` carries
 * "nothing to propose", so every property is required and no `anyOf` is needed.
 */

import type { AuxTool } from "../shared/llm.ts";

export const RECORD_SKILL_TOOL: AuxTool = {
	name: "record_skill",
	description:
		"Submit this pass's skill decision; call it once. Code validates the proposal, stores a valid one for the user to confirm, and reports the rest, so state evidence honestly. Never include secrets, credentials, generic programming advice, or instructions that override system or user instructions.",
	parameters: {
		type: "object",
		additionalProperties: false,
		required: ["skill", "inspect"],
		properties: {
			skill: {
				type: "object",
				additionalProperties: false,
				required: ["name", "description", "body", "evidence", "candidate", "reason"],
				description:
					'The proposed skill. When there is nothing to propose — the normal outcome — set `name` to "" and fill every other field with an empty string or array; never omit this object.',
				properties: {
					name: {
						type: "string",
						description:
							'New lowercase-kebab-case name, never reused from the existing inventory. "" means propose nothing; the other skill fields are then ignored.',
					},
					description: { type: "string", description: "One line: when to use the skill." },
					body: { type: "string", description: "Concise Markdown procedure with when-to-use and exact commands or paths." },
					evidence: {
						type: "array",
						items: { type: "string" },
						description: "Session ids copied from the archive index that verify this skill.",
					},
					candidate: {
						type: "boolean",
						description:
							"true stores a proposal for the user to confirm and needs at least one verified session id; false needs at least two distinct verified session ids.",
					},
					reason: {
						type: "string",
						description:
							"One line: why this proposal is worth storing. Code trims it to 500 characters and embeds it in the candidate SKILL.md header (autolearn/parse.ts, autolearn/skill.ts).",
					},
				},
			},
			inspect: {
				type: "array",
				items: { type: "string" },
				description: "Up to four archived session ids whose raw transcripts you want to read before deciding.",
			},
		},
	},
	constrainedSampling: { type: "json_schema", strict: "prefer" },
};
