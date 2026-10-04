/**
 * One wording for the memory status line, shared by `/project-context status` and `/memory`, plus the
 * CONTEXT.md line those two print.
 *
 * The two entry points used to format it separately and the branches had already drifted: the
 * umbrella line never reported a journal with no usable record, and every branch but the normal one
 * was worded twice. The body below is written to read after either prefix (`Memory: ` or
 * `Project memory: `), so the commands only differ by that prefix.
 */

import { stat } from "node:fs/promises";
import { contextFile } from "../shared/project-state.ts";
import { isMemoryTruncated, memoryDocumentChars, memorySizeLabel } from "./document.ts";
import { type LoadedMemory } from "./store.ts";

/** The status body both entry points print; identical for every branch. */
export function memoryStatusMessage(memory: LoadedMemory, cap: number): string {
	const size = memorySizeLabel(memoryDocumentChars(memory.text), cap);
	// A journal that exists but yields nothing usable is the recovery case: say what rebuilds it.
	if (memory.unreadable && memory.source.endsWith("memory.jsonl")) {
		return `${memory.source} — the journal exists but has no usable record; delete it to rebuild from MEMORY.md, or restore from memory-log-*.jsonl (see .agents/memory/errors.log)`;
	}
	if (memory.unreadable) return `${memory.source} — exists but cannot be read; check its permissions (see .agents/memory/errors.log)`;
	if (memory.damaged) return `${memory.source} (${size}) — ${memory.damaged} unusable line(s) skipped; see .agents/memory/errors.log`;
	if (memory.poisoned) return `${memory.source} (${size}) — stored as raw JSON from the old bug; the next consolidation backs it up and rewrites it as Markdown`;
	// A capped document ends with its own marker; surface it next to the knob that lifts it.
	if (isMemoryTruncated(memory.text)) return `${memory.source} (${size}) — at the cap, so both ends were kept and the middle dropped; raise it with /memory max-memory <n>`;
	return `${memory.source} (${size})`;
}

/** The `notify` level for the branch `memoryStatusMessage` selects. */
export function memoryStatusLevel(memory: LoadedMemory): "warning" | "info" {
	if (memory.unreadable || memory.damaged || memory.poisoned) return "warning";
	return isMemoryTruncated(memory.text) ? "warning" : "info";
}

/**
 * The CONTEXT.md line, printed by `/project-context status` and by the bare `/memory`; `/context`
 * used to own a bare-path variant of it. A pass only writes the file when it returns one, so its age
 * is the signal worth showing, and both callers go through here so the two lines cannot drift.
 */
export async function contextStatusLine(projectRoot: string): Promise<string> {
	const file = contextFile(projectRoot);
	try {
		const info = await stat(file);
		const updated = new Date(info.mtimeMs).toISOString().replace(/\.\d+Z$/, "Z");
		return `${file} — updated ${updated} (${humanAge(Date.now() - info.mtimeMs)} ago)`;
	} catch {
		return "none yet (a consolidation pass that returns one writes it)";
	}
}

function humanAge(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "less than a minute";
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}
