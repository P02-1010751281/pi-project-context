/**
 * Rendering a session's entries as conversation text, and counting its user turns for the
 * consolidation cadence.
 */

import { type SessionEntry, convertToLlm, serializeConversation, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { MAX_CONVERSATION_CHARS } from "./project-state.ts";

/**
 * Render the active conversation for the prompt. `convertToLlm` expects AgentMessage[]
 * (plain `{role, content}` records), not SessionEntry[] wrappers, so entries are projected
 * first; passing them directly silently produced an empty conversation.
 */
export function conversationText(entries: SessionEntry[]): string {
	const messages = entries.flatMap((entry) => sessionEntryToContextMessages(entry));
	const serialized = serializeConversation(convertToLlm(messages));
	if (serialized.length <= MAX_CONVERSATION_CHARS) return serialized;
	const head = Math.floor(MAX_CONVERSATION_CHARS * 0.35);
	return `${serialized.slice(0, head)}\n\n[...middle of conversation omitted...]\n\n${serialized.slice(-(MAX_CONVERSATION_CHARS - head))}`;
}

export function userTurnCount(branch: SessionEntry[]): number {
	return branch.filter((entry) => entry.type === "message" && entry.message.role === "user").length;
}
