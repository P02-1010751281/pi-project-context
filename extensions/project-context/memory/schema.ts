/**
 * The memory document's fixed top-level schema. A memory that follows it can be budgeted per
 * section; the consolidation prompt builds its structure and per-section character budgets from
 * this one table instead of restating them in prose. Free-form memories still load and render —
 * the schema is what the pass asks for, not a gate on what is stored.
 */

export type MemorySectionSpec = {
	/** The `##` heading the section carries. */
	heading: string;
	/** Share of the memory cap this section should stay within; the shares sum to the whole cap. */
	share: number;
};

/** Ordered top to bottom; the shares sum to 1 so the per-section budgets cover the cap exactly. */
export const MEMORY_SECTIONS: readonly MemorySectionSpec[] = [
	{ heading: "Project", share: 0.2 },
	{ heading: "Invariants", share: 0.4 },
	{ heading: "Pitfalls", share: 0.25 },
	{ heading: "Index", share: 0.15 },
] as const;

export type MemorySectionBudget = { heading: string; chars: number };

/** Per-section character budgets for a document cap, floored so the shares never overshoot it. */
export function memorySectionBudgets(cap: number): MemorySectionBudget[] {
	return MEMORY_SECTIONS.map(({ heading, share }) => ({ heading, chars: Math.floor(cap * share) }));
}
