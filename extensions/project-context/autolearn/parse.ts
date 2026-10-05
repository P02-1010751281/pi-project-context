/**
 * Reading the model's reply into a proposal.
 *
 * The reply arrives as the `record_skill` tool arguments (an already-parsed object) or as text JSON
 * from the fallback entry, so both are accepted here.
 */

import { parseJsonObject } from "../shared/llm.ts";
import { type ProposedSkill } from "./skill.ts";

export type Decision = { skill: ProposedSkill | null; inspect: string[]; inspectSkill: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function parseDecision(reply: unknown): Decision | undefined {
	const parsed = typeof reply === "string" ? parseJsonObject(reply) : reply;
	if (!isRecord(parsed)) return undefined;
	const inspect = stringList(parsed.inspect);
	// A route without tools answers with text JSON, so the same parser reads both paths; a reply that leaves the
	// new list out parses as "asked for no body".
	const inspectSkill = stringList(parsed.inspectSkill);
	const value = parsed.skill;
	// The current shape is always an object whose empty name means "nothing to propose"; `null` and a
	// missing member are the older shape, which a model may still return out of habit.
	if (value === null || value === undefined) return { skill: null, inspect, inspectSkill };
	if (!isRecord(value)) return undefined;
	if (typeof value.name !== "string") return undefined;
	const name = value.name.trim();
	// "Nothing to propose" ignores the other fields, so a reply that leaves them out still parses.
	if (name === "") return { skill: null, inspect, inspectSkill };
	if (typeof value.description !== "string" || typeof value.body !== "string") return undefined;
	return {
		skill: {
			name,
			description: value.description.replace(/\s+/g, " ").trim(),
			body: value.body.trim(),
			evidence: stringList(value.evidence),
			candidate: value.candidate === true,
			reason: typeof value.reason === "string" ? value.reason.replace(/\s+/g, " ").trim().slice(0, 500) : "",
		},
		// A proposal decides the pass; there is nothing left to inspect.
		inspect: [],
		inspectSkill: [],
	};
}
