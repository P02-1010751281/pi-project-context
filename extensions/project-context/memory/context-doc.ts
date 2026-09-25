import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ContextUpdate } from "./consolidate.ts";
import { MAX_CONTEXT_CHARS, MAX_LIST_ITEM_CHARS, MAX_SUMMARY_CHARS } from "../shared/project-state.ts";

/**
 * Rendering for CONTEXT.md (summary / key points / open tasks).
 *
 * CONTEXT.md is working state and pointers only, injected read-only by the archive
 * layer; durable facts belong in MEMORY.md. The session index lives next to it in
 * `session-logs/INDEX.md` (see session-index.ts).
 */

/** Cap list sections before budgeting so a runaway model cannot force thousands of renders. */
const MAX_LIST_ENTRIES = 50;

function trimLine(value: string, limit = MAX_LIST_ITEM_CHARS): string {
	return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

function listMarkdown(items: string[]): string {
	if (items.length === 0) return "- None recorded";
	return items.map((item) => `- ${trimLine(item)}`).join("\n");
}

export function renderContextDocument(update: ContextUpdate, options: { updatedAt: string }): string {
	const title = trimLine(update.title, 160) || "Untitled session";
	const keyPoints = update.key_points.slice(0, MAX_LIST_ENTRIES);
	const openTasks = update.open_tasks.slice(0, MAX_LIST_ENTRIES);
	const build = (points: string[], tasks: string[]): string => [
		"# Project Context",
		"",
		`Last updated: ${options.updatedAt}`,
		"",
		"## Summary",
		"",
		trimLine(update.summary, MAX_SUMMARY_CHARS) || "No summary recorded yet.",
		"",
		"## Key points",
		"",
		listMarkdown(points),
		"",
		"## Open tasks",
		"",
		listMarkdown(tasks),
		"",
		`<!-- latest-session-title: ${title} -->`,
		"",
	].join("\n");

	// Shed list items until the document fits; the summary is already capped.
	let points = keyPoints;
	let tasks = openTasks;
	let document = build(points, tasks);
	while (document.length > MAX_CONTEXT_CHARS && (points.length > 0 || tasks.length > 0)) {
		if (points.length > tasks.length) points = points.slice(0, -1);
		else tasks = tasks.slice(0, -1);
		document = build(points, tasks);
	}
	return document.length > MAX_CONTEXT_CHARS ? document.slice(0, MAX_CONTEXT_CHARS) : document;
}

export function fallbackUpdate(ctx: ExtensionContext): ContextUpdate {
	const firstUser = ctx.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user");
	const text = firstUser?.type === "message" ? JSON.stringify(firstUser.message.content) : "Session recorded without a model summary.";
	return {
		title: "Session recorded",
		summary: trimLine(text, MAX_SUMMARY_CHARS),
		key_points: [],
		open_tasks: [],
	};
}
