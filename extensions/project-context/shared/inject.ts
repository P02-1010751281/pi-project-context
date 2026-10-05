/**
 * Progressive disclosure for the two documents injected into every turn's system prompt.
 *
 * The kept sections are the ones where a wrong answer is a violation or a repeat of a lesson; each of the
 * rest costs one line naming the file instead of its whole body, and the pointer block ends with a
 * read-first instruction. The split is by section, never by meaning: the headings come from the render
 * schema, so no classification step can be silently wrong. Anything the spec does not name stays inline,
 * and a document without usable headings is injected whole, so a schema change degrades to the previous
 * behaviour instead of dropping content.
 */

import type { DocumentLanguage } from "./lang.ts";

/** One string per language; either can be rendered into the same slot. */
export interface BilingualText {
	zh: string;
	en: string;
}

export interface InjectionSpec {
	/**
	 * Headings declared as staying inline. The renderer does not branch on this: a heading with no pointer
	 * is inline by construction, so the list exists to state the intent and for the coverage test to check.
	 */
	keep: readonly string[];
	/** One line per indexed heading; a heading here must not also be kept. */
	pointers: Readonly<Record<string, BilingualText>>;
	/** Introduces the pointer list; `{path}` is replaced with `path`. */
	heading: BilingualText;
	/** The read-first sentence that follows the pointer list. */
	instruction: BilingualText;
	/** The path the pointers resolve to, shown to the reader. */
	path: string;
}

export interface InjectionSection {
	heading: string;
	body: string;
}

/** Level-two headings are the only ones the render schemas own. */
const HEADING_RE = /^## (.+?)\s*$/;

/** Split a rendered document into sections; text before the first heading belongs to no section. */
export function splitSections(text: string): InjectionSection[] {
	const sections: InjectionSection[] = [];
	for (const line of text.split("\n")) {
		const match = HEADING_RE.exec(line);
		if (match) sections.push({ heading: match[1], body: "" });
		else if (sections.length > 0) sections[sections.length - 1].body += `${line}\n`;
	}
	return sections.map((section) => ({ heading: section.heading, body: section.body.trim() }));
}

/**
 * The body for one injected document: the kept sections inline in document order, the sections with a
 * pointer reduced to one line each. The pointer text is bound to its section in the same lookup, so a
 * section is either rendered whole or replaced by its own line and can never take the other's slot.
 * Returns the text unchanged when no section has a pointer.
 */
export function renderProgressiveBody(text: string, spec: InjectionSpec, language: DocumentLanguage): string {
	const dash = language === "zh" ? "——" : "—";
	const inline: string[] = [];
	const pointerLines: string[] = [];
	for (const section of splitSections(text)) {
		const pointer = spec.pointers[section.heading];
		if (pointer) pointerLines.push(`- \`## ${section.heading}\` ${dash} ${pointer[language]}`);
		else inline.push(`## ${section.heading}\n\n${section.body}`);
	}
	if (pointerLines.length === 0) return text;
	inline.push(
		`${spec.heading[language].replace("{path}", spec.path)}\n${pointerLines.join("\n")}\n${spec.instruction[language]}`,
	);
	return inline.filter(Boolean).join("\n\n");
}
