/**
 * The memory document's shape: line-boundary clipping, normalization, and the truncation marker
 * that makes a capped document self-describing instead of silently short.
 */

import { MAX_MEMORY_CHARS } from "../shared/limits.ts";
import { isHighSurrogate, isLowSurrogate } from "../shared/text.ts";

/** Leading text of the marker line a capped memory carries; the full shape is matched below. */
const MEMORY_TRUNCATION_PREFIX = "_[memory truncated";

/** The marker line in full: `_[memory truncated at <limit> characters: <dropped> dropped]_`. */
const MEMORY_TRUNCATION_LINE = /^_\[memory truncated at \d+ characters: \d+ dropped\]_$/;

/** The canonical heading every stored memory document carries. */
const MEMORY_HEADER = "# Project Memory\n\n";

/** The line a capped document ends with: a cut memory must never look like a complete one. */
export function memoryTruncationMarker(dropped: number, limit: number): string {
	return `${MEMORY_TRUNCATION_PREFIX} at ${limit} characters: ${dropped} dropped]_`;
}

/** True when a memory document reports that the cap dropped part of it. */
export function isMemoryTruncated(text: string): boolean {
	return text.split("\n").some((line) => MEMORY_TRUNCATION_LINE.test(line.trim()));
}

/** Split an incoming value into its body (heading and any marker removed) and the marker it carried. */
function parseMemoryValue(value: string): { body: string; previous?: string } {
	const cleaned = value
		.replace(/^```(?:markdown)?\s*/i, "")
		.replace(/\s*```$/, "")
		.trim()
		.replace(/^#\s*Project Memory[ \t]*(?:\r?\n|$)/i, "")
		.trim();
	const lines = cleaned.split("\n");
	// Only the exact marker shape is stripped; a regular memory line that merely starts with the
	// same words must not be moved to the end (and reported as a cap that never happened).
	const previous = lines.find((line) => MEMORY_TRUNCATION_LINE.test(line.trim()))?.trim();
	const body = lines.filter((line) => !MEMORY_TRUNCATION_LINE.test(line.trim())).join("\n").trim();
	return { body, previous };
}

/** Characters the cap is measured against: the heading plus the body, a carried marker excluded. */
export function memoryDocumentChars(value: string): number {
	const { body } = parseMemoryValue(value);
	// An empty body is an empty memory: counting the heading alone made the status line call a
	// fresh project non-empty.
	return body ? MEMORY_HEADER.length + body.length : 0;
}

/**
 * True when the value's own content exceeds the cap. A marker copied from the previous render does
 * not count: it describes an older trim, and letting it mark a short reply as capped produced a
 * false "hit the cap" warning and a stale self-describing line in the render.
 */
export function exceedsMemoryCap(value: string, limit: number = MAX_MEMORY_CHARS): boolean {
	return memoryDocumentChars(value) > limit;
}

/** The one label for a memory's size against its cap; `status` and `/memory` both render it. */
export function memorySizeLabel(chars: number, cap: number): string {
	return chars === 0 ? "empty" : `${chars} chars, ${Math.round((chars / cap) * 100)}% of the ${cap}-char cap`;
}

/** Largest whole-line prefix of `text` within `limit`; only a single over-long line is cut inside. */
export function clipToLineBoundary(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const head = text.slice(0, Math.max(0, limit));
	const cut = head.lastIndexOf("\n");
	const clipped = cut > 0 ? head.slice(0, cut) : head;
	// A mid-line fallback cut must not leave a lone high surrogate behind.
	return clipped.length > 0 && isHighSurrogate(clipped.charCodeAt(clipped.length - 1)) ? clipped.slice(0, -1) : clipped;
}

/** Largest whole-line suffix of `text` within `limit`; only a single over-long line is cut inside. */
export function clipTailToLineBoundary(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const tail = text.slice(text.length - Math.max(0, limit));
	const cut = tail.indexOf("\n");
	const clipped = cut >= 0 ? tail.slice(cut + 1) : tail;
	// Mirror the head clipper: the kept tail must not start on a lone low surrogate.
	return clipped.length > 0 && isLowSurrogate(clipped.charCodeAt(0)) ? clipped.slice(1) : clipped;
}

/** Share of the cap a clipped document keeps from its head; the remainder preserves the tail. */
const CLIP_HEAD_SHARE = 0.6;

/**
 * Largest head AND tail of `text` that together fit `limit`, joined by a newline.
 *
 * A position-only head clip dropped whatever sat at the end — in this project's memories the last
 * section held the durable operating lessons — while a large early section stayed. Keeping both
 * ends preserves the opening facts and the closing lessons and drops the middle instead.
 */
export function clipToLineBoundaryBothEnds(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const head = clipToLineBoundary(text, Math.max(0, Math.floor(limit * CLIP_HEAD_SHARE))).trimEnd();
	const tailBudget = limit - head.length - 1;
	if (tailBudget <= 0) return head;
	const tail = clipTailToLineBoundary(text.slice(head.length), tailBudget).trimStart();
	return tail ? `${head}\n${tail}` : head;
}

/**
 * Rebuild the `# Project Memory` document from a model or recovered value.
 *
 * Over the cap the body keeps its head and its tail, joined across the drop, and the document gets
 * an explicit marker: the previous plain `.slice()` cut the last line in half, so a fact lost its
 * tail with nothing to show for it. Clipping the body rather than the heading-prefixed document
 * keeps the result round-trippable, so normalizing twice is idempotent; a marker left by an earlier
 * cap is preserved verbatim.
 */
export function normalizeMemoryDocument(value: string, limit: number = MAX_MEMORY_CHARS): string {
	const { body, previous } = parseMemoryValue(value);
	const document = `${MEMORY_HEADER}${body}`;
	if (document.length <= limit) return `${document}${previous ? `\n\n${previous}` : ""}`.trimEnd() + "\n";
	const clippedBody = clipToLineBoundaryBothEnds(body, Math.max(0, limit - MEMORY_HEADER.length));
	// A marker-shaped line inside the body is an old marker, not content: drop it before the fresh
	// one is appended, so a pass that only re-breaks it onto a line start cannot resurrect it.
	const keptBody = stripMemoryMarker(clippedBody).trim();
	const kept = `${MEMORY_HEADER}${keptBody}`;
	return `${kept}\n\n${memoryTruncationMarker(document.length - kept.length, limit)}\n`;
}

/**
 * Normalize a fresh reply (model output or a legacy import). A marker it copied out of the stored
 * render describes an older clip, not this one, so it is dropped first; an over-cap reply still
 * gets a fresh marker from `normalizeMemoryDocument`. The read/fold path keeps using
 * `normalizeMemoryDocument`, which preserves a genuine stored marker.
 */
export function normalizeMemoryReply(value: string, limit: number = MAX_MEMORY_CHARS): string {
	return normalizeMemoryDocument(stripMemoryMarker(value), limit);
}

function stripMemoryMarker(value: string): string {
	return value.split("\n").filter((line) => !MEMORY_TRUNCATION_LINE.test(line.trim())).join("\n");
}
