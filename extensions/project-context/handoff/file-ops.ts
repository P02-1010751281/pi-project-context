/**
 * File operations tracked from the conversation, and their rendering into the continuation prompt.
 */

import path from "node:path";
import { type AgentMessage } from "@earendil-works/pi-agent-core";
import { parseSkillBlock, type SessionEntry, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { isHandoffPromptText } from "./language.ts";
import { messageText } from "./text.ts";

interface FileOps {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

/** A skill the previous session loaded; the continuation names it so a mode survives the cut. */
export interface ActiveSkill {
	name: string;
	file: string;
}

/** Bound on the active-skill list: each explicit source keeps its recency order within itself; index-sourced entries fill the rest. */
const MAX_ACTIVE_SKILLS = 8;

/**
 * Evidence strength, highest first. A user's `/skill:` invocation is the most explicit evidence;
 * then a real `read` (the skill being used); a continuation prompt's read-files block and a
 * compaction's readFiles are file indexes (pi sorts them), so they only fill the slots the explicit
 * sources leave, rendered in reverse block order. This is what keeps an alphabetically early active
 * skill from being evicted by the 8-cap at the second handoff.
 */
const SKILL_COMMAND_SOURCE = 4;
const READ_SOURCE = 3;
const PROMPT_SOURCE = 2;
const COMPACTION_SOURCE = 1;

/** A SKILL.md path's skill name: its parent directory, or the path itself for a standalone file. */
function skillName(file: string): string {
	const parent = path.basename(path.dirname(file));
	return parent && parent !== "." && parent !== path.sep ? parent : file;
}

/** True when the path is a skill's SKILL.md (the portable directory form pi advertises). */
function isSkillFile(file: string): boolean {
	return path.basename(file) === "SKILL.md";
}

/**
 * Skill files a generated continuation prompt already lists in its read-files block. The predecessor's
 * read call may have been dropped by that handoff, so the prompt text is the only surviving evidence;
 * the block is how a second handoff keeps a mode alive.
 */
function promptSkillFiles(text: string): string[] {
	const files: string[] = [];
	for (const match of text.matchAll(/<read-files>\n([\s\S]*?)<\/read-files>/g)) {
		for (const line of (match[1] ?? "").split("\n")) {
			// The generator writes bare paths; strip a list marker a draft-mode editor may have added.
			const file = line.trim().replace(/^[-*]\s+/, "");
			if (isSkillFile(file)) files.push(file);
		}
	}
	return files;
}

/** Mirror pi's compaction file tracking so the continuation carries the same file index. */
function createFileOps(): FileOps {
	return { read: new Set(), written: new Set(), edited: new Set() };
}

function addFileOp(ops: FileOps, name: unknown, args: unknown): void {
	if (name !== "read" && name !== "write" && name !== "edit") return;
	if (!args || typeof args !== "object" || !("path" in args)) return;
	const file = (args as { path?: unknown }).path;
	if (typeof file !== "string") return;
	if (name === "read") ops.read.add(file);
	else if (name === "write") ops.written.add(file);
	else ops.edited.add(file);
}

function extractFileOpsFromMessage(message: AgentMessage, ops: FileOps): void {
	// A tool result can carry calls made by extension tools (codemode scripts are one); pi's own
	// extractFileOpsFromMessage includes them in the file index, so the continuation must too.
	if (message.role === "toolResult") {
		const nestedCalls = (message as { nestedCalls?: { calls?: unknown } }).nestedCalls;
		if (nestedCalls && Array.isArray(nestedCalls.calls)) {
			for (const call of nestedCalls.calls) {
				if (!call || typeof call !== "object" || !("name" in call) || !("arguments" in call)) continue;
				addFileOp(ops, call.name, (call as { arguments?: unknown }).arguments);
			}
		}
		return;
	}
	if (message.role !== "assistant" || !Array.isArray(message.content)) return;
	for (const block of message.content) {
		if (!block || typeof block !== "object" || !("type" in block) || block.type !== "toolCall") continue;
		if (!("name" in block) || !("arguments" in block)) continue;
		addFileOp(ops, block.name, block.arguments);
	}
}

/**
 * Skills the previous session loaded. A user's `/skill:` invocation is the strongest evidence; then
 * a real read (the skill being used), in read order; a continuation prompt's read-files block and a
 * compaction's readFiles are pi-sorted indexes with no activity order, so they follow and only fill
 * the slots the explicit sources leave. The continuation names the file so the successor can re-read
 * it when its instructions were dropped by the cut.
 */
export function collectActiveSkills(entries: SessionEntry[]): ActiveSkill[] {
	const seen = new Map<string, { priority: number; order: number; name?: string }>();
	let order = 0;
	const remember = (file: string, priority: number, name?: string): void => {
		const previous = seen.get(file);
		if (!previous || priority > previous.priority) seen.set(file, { priority, order: order++, ...(name ? { name } : {}) });
		else if (priority === previous.priority) {
			previous.order = order++;
			if (name) previous.name = name;
		} else order += 1;
	};
	for (const entry of entries) {
		if (entry.type === "compaction") {
			const details = entry.fromHook ? undefined : (entry.details as { readFiles?: unknown } | undefined);
			if (details && Array.isArray(details.readFiles)) {
				for (const file of details.readFiles) {
					if (typeof file === "string" && isSkillFile(file)) remember(file, COMPACTION_SOURCE);
				}
			}
			continue;
		}
		for (const message of sessionEntryToContextMessages(entry)) {
			if (message.role === "toolResult") {
				// A tool result can carry nested calls made by extension tools (codemode scripts are one).
				// pi's extractFileOpsFromMessage counts them in its file index, so treat a nested read the same way.
				const nestedCalls = (message as { nestedCalls?: { calls?: unknown } }).nestedCalls;
				if (nestedCalls && Array.isArray(nestedCalls.calls)) {
					for (const call of nestedCalls.calls) {
						if (!call || typeof call !== "object" || !("name" in call) || call.name !== "read" || !("arguments" in call)) continue;
						const args = (call as { arguments?: { path?: unknown } }).arguments;
						if (args && typeof args.path === "string" && isSkillFile(args.path)) remember(args.path, READ_SOURCE);
					}
				}
				continue;
			}
			if (message.role === "user") {
				const text = messageText(message);
				// `/skill:name` stores a `<skill name location>` block in a user message; that is the
				// user explicitly loading a skill, even when no `read` call follows.
				const skill = parseSkillBlock(text);
				// A `/skill:` block names the skill even when it is a standalone `.md` file, so accept
				// any file location here; the block itself is the explicit evidence.
				if (skill && typeof skill.location === "string" && path.extname(skill.location).toLowerCase() === ".md") {
					remember(skill.location, SKILL_COMMAND_SOURCE, skill.name);
				}
				if (isHandoffPromptText(text)) {
					for (const file of promptSkillFiles(text)) remember(file, PROMPT_SOURCE);
				}
				continue;
			}
			if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
			for (const block of message.content) {
				if (!block || typeof block !== "object" || !("type" in block) || block.type !== "toolCall") continue;
				if (!("name" in block) || block.name !== "read" || !("arguments" in block)) continue;
				const args = block.arguments as { path?: unknown } | undefined;
				if (!args || typeof args.path !== "string" || !isSkillFile(args.path)) continue;
				remember(args.path, READ_SOURCE);
			}
		}
	}
	return [...seen.entries()]
		.sort((left, right) => right[1].priority - left[1].priority || right[1].order - left[1].order)
		.slice(0, MAX_ACTIVE_SKILLS)
		.map(([file, meta]) => ({ name: meta.name || skillName(file), file }));
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
