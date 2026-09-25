/**
 * File operations tracked from the conversation, and their rendering into the summarizer prompt.
 */

import path from "node:path";
import { type AgentMessage } from "@earendil-works/pi-agent-core";
import { type SessionEntry, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";

interface FileOps {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

/** Mirror pi's compaction file tracking so the handoff summary carries the same file index. */
function createFileOps(): FileOps {
	return { read: new Set(), written: new Set(), edited: new Set() };
}

function extractFileOpsFromMessage(message: AgentMessage, ops: FileOps): void {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return;
	for (const block of message.content) {
		if (!block || typeof block !== "object" || !("type" in block) || block.type !== "toolCall") continue;
		if (!("name" in block) || !("arguments" in block)) continue;
		const args = block.arguments as { path?: unknown } | undefined;
		if (!args || typeof args.path !== "string") continue;
		if (block.name === "read") ops.read.add(args.path);
		else if (block.name === "write") ops.written.add(args.path);
		else if (block.name === "edit") ops.edited.add(args.path);
	}
}

/** Cumulative across pi-generated compactions, like pi's own compaction. */
export function collectFileOps(entries: SessionEntry[]): FileOps {
	const ops = createFileOps();
	for (const entry of entries) {
		if (entry.type === "compaction") {
			const details = entry.fromHook ? undefined : (entry.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined);
			if (details) {
				if (Array.isArray(details.readFiles)) {
					for (const file of details.readFiles) if (typeof file === "string") ops.read.add(file);
				}
				if (Array.isArray(details.modifiedFiles)) {
					for (const file of details.modifiedFiles) if (typeof file === "string") ops.edited.add(file);
				}
			}
			continue;
		}
		for (const message of sessionEntryToContextMessages(entry)) extractFileOpsFromMessage(message, ops);
	}
	return ops;
}

export function computeFileLists(ops: FileOps): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...ops.edited, ...ops.written]);
	return {
		readFiles: [...ops.read].filter((file) => !modified.has(file)).sort(),
		modifiedFiles: [...modified].sort(),
	};
}

export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}
