/**
 * Language detection shared by the handoff scaffolding and the per-turn document injections.
 *
 * One owner for the CJK heuristic: a second copy of the range would drift, and a drift here changes
 * which prompt a session reads, not merely how a string renders.
 */

/** CJK ideographs; user messages are the most reliable signal of the conversation language. */
const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

/** CJK characters needed in the samples before detection picks Chinese. */
export const LANGUAGE_CJK_MIN = 2;

/** The two languages the injected and the generated prose are written in. */
export type DocumentLanguage = "zh" | "en";

/** CJK characters across the samples; the count both callers threshold on. */
export function countCjk(samples: string[]): number {
	let count = 0;
	for (const sample of samples) count += sample.match(CJK_PATTERN)?.length ?? 0;
	return count;
}

/**
 * Language of a document, for the pointer lines that must sit in the language of the body they point at.
 * The same threshold as the handoff auto-detection, so one heuristic decides both.
 */
export function documentLanguage(text: string): DocumentLanguage {
	return countCjk([text]) >= LANGUAGE_CJK_MIN ? "zh" : "en";
}
