import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadDefault, loadNamespace, makeCtx, makePi, makeSessionManager, messageEntry, PC, runHandlers } from "./harness.mjs";

/**
 * Archive-layer index tests:
 *  - session_start seeds session-index.md from an existing CONTEXT.md
 *  - the current session line is deduped and titled without an LLM call
 *  - the consolidation renderer embeds the archive index and replaces the current
 *    session's line with the model title
 */

const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-index-"));
let failures = 0;
function check(label, value) {
	console.log(`${value ? "OK  " : "FAIL"} ${label}`);
	if (!value) failures += 1;
}

try {
	await mkdir(path.join(tmp, ".agents/memory"), { recursive: true });
	await writeFile(
		path.join(tmp, ".agents/memory/CONTEXT.md"),
		[
			"# Project Context",
			"",
			"## Summary",
			"",
			"Old summary.",
			"",
			"## Session index",
			"",
			"- [old-one](session-logs/old-one/session.md) — 2026-09-01 — old one",
			"- [old-two](session-logs/old-two/session.md) — 2026-09-02 — old two",
			"",
			"<!-- latest-session-title: Old -->",
			"",
		].join("\n"),
	);

	const factory = await loadDefault(`${PC}/index.ts`);
	const pi = makePi({ cwd: tmp });
	await factory(pi);

	const entries = [messageEntry("m1", "user", "Build the session index for the archive layer, please.", "2026-09-12T10:00:00.000Z")];
	const ctx = makeCtx(tmp, { sessionManager: makeSessionManager(entries, "cur-sess") });

	console.log("=== session_start seeds session-index.md from CONTEXT.md ===");
	await runHandlers(pi, "session_start", ctx);
	const indexFile = path.join(tmp, ".agents/memory/session-index.md");
	const document = await readFile(indexFile, "utf8").catch(() => "");
	check("index file written", document.length > 0);
	check("seeded existing lines", document.includes("[old-one]") && document.includes("[old-two]"));
	check("current line with no-LLM title", document.includes("[cur-sess]") && document.includes("Build the session index for the archive layer"));

	await runHandlers(pi, "session_start", ctx);
	const again = await readFile(indexFile, "utf8");
	check("no duplicates after second run", again.split("\n").filter((line) => line.includes("[cur-sess]")).length === 1 && again.split("\n").filter((line) => line.includes("[old-one]")).length === 1);

	console.log("\n=== CONTEXT.md embeds the archive index ===");
	const { parseIndexLines, renderContextDocument } = await loadNamespace(`${PC}/context-doc.ts`);
	const indexLines = parseIndexLines(again);
	const contextDoc = renderContextDocument("# Project Context\n", {
		title: "Index test session",
		summary: "render check",
		key_points: [],
		open_tasks: [],
	}, {
		indexLines,
		sessionLine: "- [cur-sess](session-logs/cur-sess/session.md) — 2026-09-12 — Index test session",
		updatedAt: "2026-09-12T00:00:00.000Z",
	});
	const outLines = parseIndexLines(contextDoc);
	check("context index lines = 3", outLines.length === 3);
	check("contains all three sessions", ["[old-one]", "[old-two]", "[cur-sess]"].every((id) => outLines.some((line) => line.includes(id))));
	check("current line uses model title, no duplicate", outLines.filter((line) => line.includes("[cur-sess]")).length === 1 && outLines.at(-1).includes("Index test session"));

	// A failed pass must not remove the archive lines: renderContextDocument is
	// already covered above; make sure the file on disk still has them.
	check("session-index.md still deduped", (await readFile(indexFile, "utf8")).split("\n").filter((line) => line.includes("[cur-sess]")).length === 1);
} finally {
	await rm(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL OK" : `\nFAILURES: ${failures}`);
if (failures > 0) process.exitCode = 1;
