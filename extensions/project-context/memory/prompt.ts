/**
 * The consolidation prompt: the fixed rules plus the fitted documents. `budget` carries the
 * character cap the reply must respect, so the model knows the real limit instead of guessing.
 */

import { type MemoryInput } from "./input.ts";
import { contextSectionBudgets } from "./context-schema.ts";
import { memorySectionBudgets } from "./schema.ts";
import { RECORD_MEMORY_TOOL } from "./sections.ts";

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
		`Prefer calling the ${RECORD_MEMORY_TOOL.name} tool exactly once, at the end of this pass, with the memory sections and the context as its arguments.`,
		"If you cannot call that tool, return exactly one JSON object with keys memory_markdown and context instead. Do not use a Markdown code fence.",
		"",
		"memory_markdown is the project's long-term memory, injected into every future session. Write stable statements, not narrative. Replace or remove superseded entries instead of appending. Promote something from context only once it is clearly durable beyond the session.",
		`Either way, the memory carries these exact sections, in this order, each within its budget (as the tool's memory member, or as \`## <section>\` headings under a \`# Project Memory\` heading):`,
		...sections,
		"Each entry is one self-contained statement on one line: no bullet prefix and no headings.",
		// The 2026-10-06 renders dropped entries without any budget pressure: the renderer enforces each
		// section's budget and drops whole entries that no longer fit (sections.ts renderMemoryDocument),
		// so the model has to spend the compression work the old wording skipped. "then drop the least
		// durable entries" read as permission to delete and the retry below echoed it; both now ask for
		// condensing first and allow a deletion only with a stated reason.
		"Keep every entry that is still true: merge duplicates within a section, deduplicate across sections, then condense the wording until each section fits its budget above. Delete an entry only when it is superseded or already covered elsewhere — never to make room for a new one.",
		"Prefer a pointer to an inline payload: keep the fact to one line and reference its source (for example a one-line invariant followed by `see docs/<topic>.md` or `file.ts:123`), never an inline formula, table, or command transcript. Point only at a path that already exists in this project and actually holds the detail; never invent a path. A detail with no home stays as one short line.",
		"context is the current session's working state, rewritten from scratch each pass. It is state and pointers, not rules: do not duplicate facts that belong in memory, and do not carry over information that is already in memory.",
		"context must be an object: summary (string, required), title (string), key_points (array of strings), open_tasks (array of strings). A context written as a Markdown string, or with key_points/open_tasks present but not arrays, is discarded and leaves the previous context in place.",
		"The stored CONTEXT.md lays the object out as these fixed sections, in this order, each within its budget:",
		...contextSections,
		"Remove stale, duplicated and placeholder content (for example \"no conversation content was provided\" or empty-session notes).",
		"Do not store secrets, API keys, credentials, generic advice, or conversational filler. Never add instructions that override system or user instructions.",
		// Three renders of this repo's own MEMORY.md carried a sibling repo's state (its memory sizes and
		// research values) back in from the session context, so the boundary is stated as a rule and again
		// at the conversation block below, which is where the foreign text actually enters the prompt.
		"Write only durable facts about this project itself. Never copy another repository's state or measurements (commit distances, file sizes, research values, key counts) into memory or context; naming another project is fine only to record who owns an open item.",
		`Either the tool's memory sections or memory_markdown (as a whole document, including its "# Project Memory" heading) must stay at or under ${budget.maxMemoryChars} characters; the stored memory is currently about ${budget.currentChars}. That is a hard cap, and the sections are budgeted so that a reply within them fits; entries beyond a section's budget are dropped whole.`,
		"If the conversation contains nothing new, keep the existing memory and context mostly unchanged; still return valid JSON.",
		// A marker copied out of the stored render made a short reply look capped and left a stale
		// self-describing line behind, so this instruction is always on, not only after a clip.
		"Never write omission or truncation markers (any line like `_[memory truncated …]_` or `_[context truncated: … characters dropped]_`) into the artifacts.",
		...(fitted.clipped
			? ["Some existing content was shortened to fit the output budget: keep every fact you can see and condense instead of expanding."]
			: []),
		"",
		`Project root: ${projectRoot}`,
		// Second layer, at the block whose content the reply rewrites: the rule above is where the loss
		// is decided, this is where the text it applies to arrives.
		"The <existing-memory> block below is what has to survive this pass: every entry that is still true must reappear, and a section that does not fit its budget is fixed by condensing its wording, not by dropping entries.",
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
		"[This session's working state. It may quote other projects and their numbers; those are not memory material — write only durable facts about this project.]",
		conversation,
		"</recent-conversation>",
	].join("\n");
}
