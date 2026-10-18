/**
 * Message rendering and replay: the role filter, the replay marker pair, and the entry list a
 * continuation is allowed to carry (verbatim unless the opt-in tool-result text cap is set).
 */

import { type AgentMessage } from "@earendil-works/pi-agent-core";
import { type SessionEntry, type SessionManager, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { isHandoffPromptText } from "./language.ts";

/**
 * Stand-in for a dropped continuation prompt. It keeps the replay block's user-first shape (a
 * block that opens with an assistant message is rejected by Anthropic/Gemini routes) and is
 * ignored by language sampling.
 */
export const REPLAY_MARKER = "[handoff prompt omitted]";

/**
 * Stand-in for the dropped prefix of a split turn. The keep-budget cut can land inside a turn,
 * and the replay block must open with a user message for Anthropic/Gemini routes to accept it.
 */
export const SPLIT_TURN_MARKER = "[turn prefix dropped during handoff]";

/**
 * Stand-in for a tool result's text when the opt-in per-result cap is enabled. The call/result
 * pairing and non-text blocks are kept, so the replay stays parseable; the full output is still in
 * the predecessor's session log.
 */
export function toolResultTrimmedMarker(chars: number): string {
	return `[tool result trimmed during handoff: ${chars} characters; full output in the previous session log]`;
}

/**
 * Roles a provider renders as a user message: a replay block may open with one of these.
 * `custom`/`bashExecution` are turn starts that conversation conversion maps to the user role.
 */
const USER_FACING_ROLES = new Set(["user", "custom", "bashExecution"]);

/**
 * True for a message pi's `convertToLlm` drops before the request: interactive `!!cmd` output is persisted as a
 * `bashExecution` message carrying a truthy `excludeFromContext` (pi tests it for truthiness, so a hand-edited
 * `1` counts too), and the provider never sees it. Such a message is not user-facing either: a replay slice
 * opening with one still needs {@link SPLIT_TURN_MARKER}, or the successor's first sent message is an assistant
 * one and user-first routes (Anthropic / Gemini) reject the continuation request - the reason the marker exists.
 */
export function excludedFromContext(message: { role: string; excludeFromContext?: unknown }): boolean {
	return message.role === "bashExecution" && Boolean(message.excludeFromContext);
}

/** Whether a provider renders this message as a user message. */
function isUserFacing(message: AgentMessage): boolean {
	return !excludedFromContext(message) && USER_FACING_ROLES.has(message.role);
}

/** Tool-call ids an assistant message issued. */
function toolCallIds(message: AgentMessage): string[] {
	if (!Array.isArray(message.content)) return [];
	const ids: string[] = [];
	for (const block of message.content) {
		if (block && typeof block === "object" && "type" in block && block.type === "toolCall" && "id" in block && typeof block.id === "string") ids.push(block.id);
	}
	return ids;
}

/**
 * Messages carried into the replacement session: stale continuation prompts become
 * {@link REPLAY_MARKER}, and a slice that opens mid-turn gets a {@link SPLIT_TURN_MARKER}
 * stand-in. Replayed verbatim a prompt reads as a fresh instruction and opens the new session
 * with an already-superseded state; dropping it entirely would let the block start
 * with an assistant message, which some providers reject.
 *
 * Tool results whose call is not part of the slice (a mid-turn cut can separate them) cannot be
 * replayed — providers reject a result without its call. They are handed back through
 * `droppedOrphans` so the caller can tell them apart from the replay itself.
 */
export function replayMessagesFor(entries: SessionEntry[], droppedOrphans?: AgentMessage[]): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (const entry of entries) {
		for (const message of sessionEntryToContextMessages(entry)) {
			if (!isReplayableRole(message.role)) continue;
			messages.push(
				message.role === "user" && isHandoffPromptText(messageText(message))
					? ({ ...message, content: [{ type: "text", text: REPLAY_MARKER }] } as AgentMessage)
					: message,
			);
		}
	}
	const keptCallIds = new Set(messages.flatMap(toolCallIds));
	const replayable: AgentMessage[] = [];
	for (const message of messages) {
		if (message.role !== "toolResult") {
			replayable.push(message);
			continue;
		}
		const toolCallId = (message as { toolCallId?: string }).toolCallId;
		if (typeof toolCallId === "string" && keptCallIds.has(toolCallId)) replayable.push(message);
		else droppedOrphans?.push(message);
	}
	// A mid-turn cut leaves the slice opening on an assistant message, so the dropped prefix is
	// marked with a user-facing stand-in.
	if (replayable[0] && !isUserFacing(replayable[0])) {
		replayable.unshift({ role: "user", content: [{ type: "text", text: SPLIT_TURN_MARKER }], timestamp: replayable[0].timestamp } as AgentMessage);
	}
	return replayable;
}

/** Roles appendMessage() accepts as raw conversation messages. */
function isReplayableRole(role: string): boolean {
	return role === "user" || role === "assistant" || role === "toolResult" || role === "custom" || role === "bashExecution";
}

/** Append already-rendered replay messages; used when the caller trimmed them before replay. Never throws. */
export function replayMessageList(sessionManager: SessionManager, messages: AgentMessage[]): number {
	let appended = 0;
	for (const message of messages) {
		try {
			sessionManager.appendMessage(message as Parameters<SessionManager["appendMessage"]>[0]);
			appended += 1;
		} catch {
			// A malformed historical message must not abort the handoff.
		}
	}
	return appended;
}

/** Replay the carried-over messages verbatim (stale prompts replaced by a marker). Never throws. */
export function replayEntries(sessionManager: SessionManager, entries: SessionEntry[]): number {
	return replayMessageList(sessionManager, replayMessagesFor(entries));
}

/**
 * Replace a tool result's text blocks with the trim marker when they exceed `maxChars`. Images and
 * other non-text blocks stay, as does the toolCallId, so the carried call/result pair remains valid.
 * Returns undefined when there is nothing to trim (no text, or already within the cap).
 */
export function trimToolResultText(message: AgentMessage, maxChars: number): AgentMessage | undefined {
	const text = messageText(message);
	if (!text || text.length <= maxChars) return undefined;
	const marker = toolResultTrimmedMarker(text.length);
	// A tiny result would grow: never replace it with a longer marker.
	if (marker.length >= text.length) return undefined;
	const content = Array.isArray(message.content) ? message.content : [];
	let replaced = false;
	const next: unknown[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && "type" in block && block.type === "text") {
			if (!replaced) {
				next.push({ type: "text", text: marker });
				replaced = true;
			}
			continue;
		}
		next.push(block);
	}
	if (!replaced) return undefined;
	return { ...message, content: next } as AgentMessage;
}

/** Plain text of a message, ignoring tool calls and non-text blocks. */
export function messageText(message: AgentMessage): string {
	if (!Array.isArray(message.content)) return "";
	const parts: string[] = [];
	for (const block of message.content) {
		if (!block || typeof block !== "object" || !("type" in block)) continue;
		if (block.type === "text" && "text" in block && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n").trim();
}
