/**
 * The memory document's fixed top-level schema. A memory that follows it can be budgeted per
 * section; the consolidation prompt builds its structure and per-section character budgets from
 * this one table instead of restating them in prose. Free-form memories still load and render —
 * the schema is what the pass asks for, not a gate on what is stored.
 */

export type MemorySectionSpec = {
	/** The `##` heading the section carries. */
	heading: string;
	/** What belongs in the section, rendered next to its heading in the prompt. */
	description: string;
	/** Share of the budgeted body this section should stay within; the shares sum to 1. */
	share: number;
};

/** Ordered top to bottom; the shares sum to 1 so the section budgets divide the body budget. */
export const MEMORY_SECTIONS: readonly MemorySectionSpec[] = [
	{ heading: "Project", description: "purpose, stack, structure", share: 0.2 },
	{ heading: "Invariants", description: "standing decisions, conventions, hard constraints, user preferences", share: 0.4 },
	{ heading: "Pitfalls", description: "operational traps and the lessons behind them", share: 0.25 },
	{ heading: "Index", description: "pointers to docs, source files, and commands", share: 0.15 },
];

export type MemorySectionBudget = { heading: string; description: string; chars: number };

/**
 * Characters the document header and the fixed section headings spend before any body text. The
 * per-section budgets are shares of the remainder: shares of the whole cap would let a document
 * that exactly fills every budget exceed the cap once the header and headings are added.
 */
export function memorySchemaOverheadChars(sections: readonly MemorySectionSpec[] = MEMORY_SECTIONS): number {
	return "# Project Memory\n\n".length + sections.reduce((sum, section) => sum + `## ${section.heading}\n\n`.length, 0);
}

/** Per-section body budgets for a document cap, floored so they plus the overhead never exceed it. */
export function memorySectionBudgets(cap: number): MemorySectionBudget[] {
	const body = Math.max(0, cap - memorySchemaOverheadChars());
	return MEMORY_SECTIONS.map(({ heading, description, share }) => ({ heading, description, chars: Math.floor(body * share) }));
}
