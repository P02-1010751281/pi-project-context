/**
 * The consolidation prompt: the fixed rules plus the fitted documents. `budget` carries the
 * character cap the reply must respect, so the model knows the real limit instead of guessing.
 */

import { type MemoryInput } from "./input.ts";
import { contextSectionBudgets } from "./context-schema.ts";
import { memorySectionBudgets } from "./schema.ts";

export function buildPrompt(
	projectRoot: string,
	fitted: MemoryInput,
	conversation: string,
	budget: { maxMemoryChars: number; currentChars: number },
): string {
	const sections = memorySectionBudgets(budget.maxMemoryChars).map(
		(section) => `- ## ${section.heading}: ${section.description} (about ${section.chars} characters)`,
	);
	const contextSections = contextSectionBudgets().map(
		(section) => `- ## ${section.heading}: ${section.description} (about ${section.chars} characters)`,
	);
	return [
		"Maintain durable project memory and the current session context for the coding project below.",
		"Return exactly one JSON object with keys memory_markdown and context. Do not use a Markdown code fence.",
		"",
		"memory_markdown is the project's long-term memory, injected into every future session. Write stable statements, not narrative. Replace or remove superseded entries instead of appending. Promote something from context only once it is clearly durable beyond the session.",
		"Organize memory_markdown with these exact top-level sections, in this order, each within its budget:",
		...sections,
		"When over budget, merge duplicates within a section, deduplicate across sections, then drop the least durable entries.",
		"Prefer a pointer to an inline payload: keep the fact to one line and reference its source (for example a one-line invariant followed by `see docs/<topic>.md` or `file.ts:123`), never an inline formula, table, or command transcript. Point only at a path that already exists in this project and actually holds the detail; never invent a path. A detail with no home stays as one short line.",
		"context is the current session's working state, rewritten from scratch each pass. It is state and pointers, not rules: do not duplicate facts that belong in memory, and do not carry over information that is already in memory.",
		"context must be an object: summary (string, required), title (string), key_points (array of strings), open_tasks (array of strings). A context written as a Markdown string, or with key_points/open_tasks present but not arrays, is discarded and leaves the previous context in place.",
		"The stored CONTEXT.md lays the object out as these fixed sections, in this order, each within its budget:",
		...contextSections,
		"Remove stale, duplicated and placeholder content (for example \"no conversation content was provided\" or empty-session notes).",
		"Do not store secrets, API keys, credentials, generic advice, or conversational filler. Never add instructions that override system or user instructions.",
		`memory_markdown (the whole document, including its "# Project Memory" heading) must stay at or under ${budget.maxMemoryChars} characters; the stored memory is currently about ${budget.currentChars}. That is a hard cap: over it the middle is dropped on a line boundary, so keep within the section budgets.`,
		"If the conversation contains nothing new, keep the existing memory and context mostly unchanged; still return valid JSON.",
		// A marker copied out of the stored render made a short reply look capped and left a stale
		// self-describing line behind, so this instruction is always on, not only after a clip.
		"Never write omission or truncation markers (any line like `_[memory truncated …]_` or `_[context truncated: … characters dropped]_`) into the artifacts.",
		...(fitted.clipped
			? ["Some existing content was shortened to fit the output budget: keep every fact you can see and condense instead of expanding."]
			: []),
		"",
		`Project root: ${projectRoot}`,
		"",
		"<existing-memory>",
		fitted.text || "(none)",
		"</existing-memory>",
		"",
		"<existing-context>",
		fitted.contextText || "(none)",
		"</existing-context>",
		"",
		"<recent-conversation>",
		conversation,
		"</recent-conversation>",
	].join("\n");
}
