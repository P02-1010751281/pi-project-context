/**
 * Reading the model's reply into a proposal.
 */

import { parseJsonObject } from "../shared/llm.ts";
import { type ProposedSkill } from "./skill.ts";

type Decision = { skill: ProposedSkill | null; inspect: string[] };

export function parseDecision(text: string): Decision | undefined {
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
