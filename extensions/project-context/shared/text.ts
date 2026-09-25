/**
 * Text measurement and clipping for small auxiliary replies: the character budget per token, the
 * logged head of a bad reply, and surrogate-safe clipping that never splits a code point.
 */

/** Characters of the raw reply kept in a failure record; `errors.log` caps the whole record anyway. */
const MAX_LOGGED_REPLY_CHARS = 4000;

/** Attach the head of the reply the model actually sent so errors.log can be diagnosed later. */
export function replyHead(raw: string): string {
	const head = raw.slice(0, MAX_LOGGED_REPLY_CHARS);
	const notice = raw.length > head.length ? `\n[...reply omitted after ${head.length} of ${raw.length} chars...]` : "";
	return `--- raw reply ---\n${head}${notice}`;
}

/** Worst-case output tokens per character for dense scripts (a Han character is close to one token). */
const DENSE_TOKENS_PER_CHAR = 1;

/** Conservative rate for markdown, paths and ASCII prose (real tokenizers need less). */
const ASCII_TOKENS_PER_CHAR = 0.4;

/** Extra cost for a quote or backslash, which JSON escaping doubles when the reply re-emits it. */
const ESCAPE_TOKENS_PER_CHAR = 0.2;

/**
 * Conservative output-token rate for text the reply must re-emit. Dense scripts (CJK and every
 * other non-ASCII script, including emoji) are charged a full token per code point; ASCII prose
 * is charged 0.4; quotes and backslashes pay extra for their JSON escape. Never underestimates.
 */
export function replyTokenRate(text: string): number {
	if (!text) return ASCII_TOKENS_PER_CHAR;
	let tokens = 0;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if (code > 0x7f) tokens += DENSE_TOKENS_PER_CHAR;
		else tokens += ASCII_TOKENS_PER_CHAR + (char === '"' || char === "\\" ? ESCAPE_TOKENS_PER_CHAR : 0);
	}
	// Rate per UTF-16 unit, so `text.length * rate` stays the token estimate.
	return tokens / text.length;
}

/** Clip from the original text to a char limit, keeping the original when it already fits. */
export function clipTo(text: string, limit: number): string {
	return text.length <= limit ? text : limit <= 0 ? "" : clipText(text, limit);
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/** Head and tail of a text, shortened to a char limit (the `\n\n` joiner included). */
export function clipText(text: string, limit: number): string {
	if (text.length <= limit) return text;
	if (limit < 16) {
		let cut = Math.max(0, limit);
		// Never end on a high surrogate: a lone half cannot be re-encoded by a provider.
		if (cut > 0 && isHighSurrogate(text.charCodeAt(cut - 1))) cut -= 1;
		return text.slice(0, cut);
	}
	const size = limit - 2;
	let head = Math.ceil(size * 0.6);
	if (head > 0 && head < text.length && isHighSurrogate(text.charCodeAt(head - 1))) head -= 1;
	let tailStart = text.length - (size - head);
	if (tailStart > head && isLowSurrogate(text.charCodeAt(tailStart))) {
		if (isHighSurrogate(text.charCodeAt(tailStart - 1))) {
			// Include the pair's high surrogate and take the extra unit back out of the head, so
			// the result never exceeds `limit` (the exact trim relies on that).
			tailStart -= 1;
			head = Math.max(0, head - 1);
			if (head > 0 && isHighSurrogate(text.charCodeAt(head - 1))) head -= 1;
		} else {
			// An unpaired low surrogate from malformed input: skip it instead of starting on half.
			tailStart += 1;
		}
	}
	return `${text.slice(0, head)}\n\n${text.slice(tailStart)}`;
}
