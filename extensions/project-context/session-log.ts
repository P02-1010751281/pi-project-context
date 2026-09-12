import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { logsDir, readOptional, safeSessionId, writeAtomic } from "./project-state.ts";

/**
 * Session archive: the raw JSONL is canonical, the Markdown rendering preserves every
 * entry. The summarized CONTEXT.md is rendered by context-doc.ts and written by the
 * consolidation pass; the archive layer only injects it read-only.
 */

function jsonBlock(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

function sessionMarkdown(ctx: ExtensionContext, raw: string): string {
	const header = ctx.sessionManager.getHeader() ?? {
		type: "session",
		id: ctx.sessionManager.getSessionId(),
		timestamp: new Date().toISOString(),
		cwd: ctx.cwd,
	};
	const entries = ctx.sessionManager.getEntries();
	const sections = entries.map((entry, index) => {
		const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "unknown time";
		return `### ${index + 1}. ${entry.type} — ${timestamp}\n\n~~~~json\n${jsonBlock(entry)}\n~~~~`;
	});

	return [
		`# Pi Session ${ctx.sessionManager.getSessionId()}`,
		"",
		`- Started: ${header.timestamp}`,
		`- Project: ${header.cwd}`,
		`- Raw log: [session.jsonl](./session.jsonl)`,
		`- Entries: ${entries.length}`,
		"",
		"The JSONL file is canonical. This Markdown rendering intentionally preserves every session entry, including tool calls, tool results, thinking blocks, compaction records, model changes, and extension entries.",
		"",
		...sections,
		"",
		"<!-- raw-log-bytes: " + Buffer.byteLength(raw, "utf8") + " -->",
		"",
	].join("\n");
}

export async function writeSessionArtifacts(
	projectRoot: string,
	ctx: ExtensionContext,
	options: { markdown?: boolean } = {},
): Promise<{ dir: string }> {
	const id = safeSessionId(ctx.sessionManager.getSessionId());
	const dir = path.join(logsDir(projectRoot), id);
	const existingRaw = await readOptional(ctx.sessionManager.getSessionFile() ?? "");
	const entries = ctx.sessionManager.getEntries();
	const header = ctx.sessionManager.getHeader() ?? {
		type: "session",
		id: ctx.sessionManager.getSessionId(),
		timestamp: new Date().toISOString(),
		cwd: ctx.cwd,
	};
	const raw = existingRaw.trim()
		? (existingRaw.endsWith("\n") ? existingRaw : `${existingRaw}\n`)
		: [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";

	await writeAtomic(path.join(dir, "session.jsonl"), raw);
	if (options.markdown ?? true) await writeAtomic(path.join(dir, "session.md"), sessionMarkdown(ctx, raw));
	return { dir };
}
