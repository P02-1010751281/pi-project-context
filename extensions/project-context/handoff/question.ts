/**
 * Detecting the open question the previous session stopped on, which the guard honours.
 */

import { type SessionEntry, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { messageText } from "./text.ts";

/** Phrasings that mark the assistant's last message as awaiting a user decision. */
const PENDING_QUESTION_PATTERNS =
	/would you like|shall i\b|should i\b|do you want|let me know|your call|which (?:one|option|approach|direction|do you)|please (?:confirm|choose|decide)|awaiting your|waiting for your|需要我|要不要|是否需要|是否要|请你(?:确认|选择|决定)|等你(?:确认|回复|决定)/i;

function textAsksQuestion(text: string): boolean {
	// Fenced code must not contribute a stray "?" to the check.
	const clean = text.replace(/```[\s\S]*?```/g, " ");
	const lines = clean.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
	const lastLine = lines.length > 0 ? lines[lines.length - 1] : "";
	const stripped = lastLine.replace(/[*_`~)\]"'）】》]+$/g, "").trimEnd();
	if (stripped.endsWith("?") || stripped.endsWith("？")) return true;
	return PENDING_QUESTION_PATTERNS.test(clean.slice(-400));
}

/**
 * The question the session is waiting on, if its last conversational message is
 * an assistant question. Auto handoff must not answer it on the user's behalf.
 */
export function findPendingQuestion(entries: SessionEntry[]): string | undefined {
	let last: { role: string; text: string } | undefined;
	for (const entry of entries) {
		for (const message of sessionEntryToContextMessages(entry)) {
			if (message.role !== "user" && message.role !== "assistant") continue;
			const text = messageText(message);
			if (text.length > 0) last = { role: message.role, text };
		}
	}
	if (!last || last.role !== "assistant") return undefined;
	return textAsksQuestion(last.text) ? last.text : undefined;
}
