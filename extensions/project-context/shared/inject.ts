/**
 * Progressive disclosure for the two documents injected into every turn's system prompt.
 *
 * The kept sections are the ones where a wrong answer is a violation or a repeat of a lesson; each of the
 * rest costs one line naming the file instead of its whole body, and the pointer block ends with a
 * read-first instruction. The preamble and any document-level note stay inline regardless of the split.
 * The split is by section, never by meaning: the headings come from the render
 * schema, so no classification step can be silently wrong. Anything the spec does not name stays inline,
 * and a document without usable headings is injected whole, so a schema change degrades to the previous
 * behaviour instead of dropping content.
 */

import { join } from "node:path";

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

/** A fenced code block: a `## …` line inside one is content, not a heading. */
const FENCE_RE = /^(`{3,}|~{3,})/;

/**
 * A document-level note (`_[...]_`) belongs to no section: the render appends the truncation marker after
 * the last section's body, so without this it would be indexed away with the section it landed in. Only a
 * trailing line can be that marker, so the shape is only honoured in the last section and a `_[x]_` line
 * in the middle of a document stays where it was written.
 */
const DOCUMENT_NOTE_RE = /^_\[[^\]]+\]_$/;

/** Split a rendered document into sections; text before the first heading belongs to no section. */
export function splitSections(text: string): InjectionSection[] {
	const sections: InjectionSection[] = [];
	let fence: string | undefined;
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		const fenceMatch = FENCE_RE.exec(trimmed);
		if (fenceMatch) {
			if (fence === undefined) fence = fenceMatch[1][0];
			else if (trimmed.startsWith(fence)) fence = undefined;
		}
		const match = fence === undefined ? HEADING_RE.exec(line) : null;
		if (match) sections.push({ heading: match[1], body: "" });
		else if (sections.length > 0) sections[sections.length - 1].body += `${line}\n`;
	}
	return sections.map((section) => ({ heading: section.heading, body: section.body.trim() }));
}

/**
 * The body for one injected document: the preamble and every document-level note stay inline, the kept
 * sections follow in document order, and the sections with a pointer are reduced to one line each. The
 * pointer text is bound to its section in the same lookup, so a section is either rendered whole or
 * replaced by its own line and can never take the other's slot. `path` resolves against `root` when the
 * caller knows the project root: the reader's `read` tool resolves relative paths against its own cwd, not
 * against the directory the injected prompt was built in. Returns the text unchanged when no section has a
 * pointer.
 */
export function renderProgressiveBody(
	text: string,
	spec: InjectionSpec,
	language: DocumentLanguage,
	root?: string,
): string {
	const lines = text.split("\n");
	const firstHeading = lines.findIndex((line) => HEADING_RE.test(line));
	const preamble = (firstHeading > 0 ? lines.slice(0, firstHeading) : []).join("\n").trim();
	const dash = language === "zh" ? "——" : "—";
	const inline: string[] = [];
	const notes: string[] = [];
	const pointerLines: string[] = [];
	const sections = splitSections(text);
	for (const [index, section] of sections.entries()) {
		const isLast = index === sections.length - 1;
		const bodyLines = section.body.split("\n");
		const noteLines = isLast ? bodyLines.filter((line) => DOCUMENT_NOTE_RE.test(line.trim())) : [];
		for (const line of noteLines) notes.push(line.trim());
		const body = bodyLines.filter((line) => !noteLines.includes(line)).join("\n").trim();
		const pointer = spec.pointers[section.heading];
		if (pointer) pointerLines.push(`- \`## ${section.heading}\` ${dash} ${pointer[language]}`);
		else inline.push(`## ${section.heading}\n\n${body}`);
	}
	if (pointerLines.length === 0) return text;
	const path = root ? join(root, spec.path) : spec.path;
	return [
		preamble,
		...inline,
		notes.join("\n"),
		`${spec.heading[language].replace("{path}", path)}\n${pointerLines.join("\n")}\n${spec.instruction[language]}`,
	]
		.filter(Boolean)
		.join("\n\n");
}
