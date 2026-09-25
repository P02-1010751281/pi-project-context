/**
 * The handoff's language: detection from the conversation, the prompt-text recognizer (so a stale
 * prompt is not read as a fresh instruction), and the locale scaffolding lookup.
 */

import { type AgentMessage } from "@earendil-works/pi-agent-core";
import { type ProjectContextConfig } from "../shared/config.ts";
import { SCAFFOLDING } from "./prompt.ts";
import { REPLAY_MARKER, messageText } from "./text.ts";

const SUMMARY_FOCUS =
	"This summary covers the older part of the previous session; its most recent messages are carried over separately. " +
	"Preserve exact file paths, function names, commands, error messages, and unfinished work. Keep it concise.";

/** Languages the handoff scaffolding can be rendered in; `auto` resolves from the conversation. */
export type HandoffLanguage = "zh" | "en";

/** CJK ideographs; user messages are the most reliable signal of the conversation language. */
const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

/** CJK characters needed in the user messages before auto-detection picks Chinese. */
const LANGUAGE_CJK_MIN = 2;

/** Latin letters that make a sample set count as substantial English. */
const LANGUAGE_LATIN_MIN = 20;

const LATIN_PATTERN = /[A-Za-z]/g;

function countMatches(samples: string[], pattern: RegExp): number {
	let count = 0;
	for (const sample of samples) count += sample.match(pattern)?.length ?? 0;
	return count;
}

/** `auto` language rule: enough Chinese in the user's own messages means Chinese scaffolding. */
export function detectHandoffLanguage(samples: string[]): HandoffLanguage {
	return countMatches(samples, CJK_PATTERN) >= LANGUAGE_CJK_MIN ? "zh" : "en";
}

/** Language of the newest recognized continuation prompt, if the conversation has one. */
function promptLanguage(messages: AgentMessage[]): HandoffLanguage | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "user") continue;
		const text = messageText(message);
		if (!isHandoffPromptText(text)) continue;
		if (text.startsWith(HANDOFF_PROMPT_PREFIXES[1])) return "zh";
		if (text.startsWith(HANDOFF_PROMPT_PREFIXES[0])) return "en";
	}
	return undefined;
}

/** The summary focus passed to pi's compaction summarizer, in the resolved language. */
export function summaryFocus(language: HandoffLanguage): string {
	return language === "zh"
		? `${SUMMARY_FOCUS} Write the whole summary in Simplified Chinese, including the section headings.`
		: `${SUMMARY_FOCUS} Write the whole summary in English, including the section headings.`;
}

/** Preamble prefixes of generated continuation prompts (one per scaffolding language). */
const HANDOFF_PROMPT_PREFIXES = [
	"This session continues work handed off from a previous session (",
	"本会话接手上一会话（",
];

/** Section headings that only generated continuation prompts contain. */
const HANDOFF_PROMPT_HEADINGS = ["## Handoff Summary", "## Previous session details", "## 交接摘要", "## 上一会话信息"];

/** Closing lines every generated prompt ends with. */
const HANDOFF_PROMPT_CLOSINGS = [
	SCAFFOLDING.en.closingContinue,
	SCAFFOLDING.en.closingPaused,
	SCAFFOLDING.zh.closingContinue,
	SCAFFOLDING.zh.closingPaused,
];

/**
 * True for a message the handoff itself generated. The preamble, a section heading and the
 * closing line must all match, so a user message quoting the prompt (or quoting it and adding
 * their own text) is not mistaken for one and stays in the carried-over conversation.
 */
export function isHandoffPromptText(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;
	if (!HANDOFF_PROMPT_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return false;
	if (!HANDOFF_PROMPT_HEADINGS.some((heading) => trimmed.includes(heading))) return false;
	return HANDOFF_PROMPT_CLOSINGS.some((closing) => trimmed.endsWith(closing));
}

/** Recent user messages decide `auto`; the whole session is the fallback when they are too short. */
const LANGUAGE_SAMPLE_MESSAGES = 8;

const LANGUAGE_SAMPLE_MIN_CHARS = 40;

/** User texts for the `auto` decision: injected prompts excluded, recent messages preferred. */
function languageSamples(messages: AgentMessage[]): string[] {
	const texts = messages
		.filter((message) => message.role === "user")
		.map(messageText)
		.filter((text) => text.length > 0 && text !== REPLAY_MARKER && !isHandoffPromptText(text));
	if (texts.length === 0) return [];
	const recent = texts.slice(-LANGUAGE_SAMPLE_MESSAGES);
	return recent.join("").length >= LANGUAGE_SAMPLE_MIN_CHARS ? recent : texts;
}

/**
 * Messages the `auto` language decision samples: the older part plus the raw carried slice —
 * prompts included, because `languageSamples` filters them itself and `promptLanguage` needs the
 * one sitting on the cut point. Exported so tests pin this wiring (a marker-substituted slice
 * would hide it).
 */
export function languageMessagesFor(olderMessages: AgentMessage[], carriedMessages: AgentMessage[]): AgentMessage[] {
	return [...olderMessages, ...carriedMessages];
}

/** Resolve the scaffolding language: explicit config wins, `auto` follows the user's own messages. */
export function resolveLanguage(messages: AgentMessage[], configured: ProjectContextConfig["handoffLanguage"]): HandoffLanguage {
	if (configured !== "auto") return configured;
	const samples = languageSamples(messages);
	if (detectHandoffLanguage(samples) === "zh") return "zh";
	// Substantive English wins; short replies ("ok", "1+2+3") carry the previous continuation
	// prompt's language forward so they cannot flip a Chinese session back to English.
	if (countMatches(samples, LATIN_PATTERN) >= LANGUAGE_LATIN_MIN) return "en";
	return promptLanguage(messages) ?? "en";
}
