import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadDefault, loadNamespace, makeCtx, makePi, makeSessionManager, messageEntry, PC, runHandlers } from "./harness.mjs";

/**
 * Archive-layer index tests:
 *  - session_start adopts the pre-move `<memory>/session-index.md` into
 *    `<memory>/session-logs/INDEX.md`, converting its links
 *  - the current session line is deduped and titled without an LLM call
 *  - CONTEXT.md no longer embeds the session index
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
		path.join(tmp, ".agents/memory/session-index.md"),
		[
			"# Session Index",
			"",
			"- [old-one](session-logs/old-one/session.md) — 2026-09-01 — old one",
			"- [old-two](session-logs/old-two/session.md) — 2026-09-02 — old two",
			"",
		].join("\n"),
	);

	const factory = await loadDefault(`${PC}/index.ts`);
	const pi = makePi({ cwd: tmp });
	await factory(pi);

	const entries = [messageEntry("m1", "user", "Build the session index for the archive layer, please.", "2026-09-12T10:00:00.000Z")];
	const ctx = makeCtx(tmp, { sessionManager: makeSessionManager(entries, "cur-sess") });

	console.log("=== session_start adopts the legacy index into session-logs/INDEX.md ===");
	await runHandlers(pi, "session_start", ctx);
	const indexFile = path.join(tmp, ".agents/memory/session-logs/INDEX.md");
	const document = await readFile(indexFile, "utf8").catch(() => "");
	check("index file written next to the logs", document.length > 0);
	check("legacy lines kept", document.includes("[old-one]") && document.includes("[old-two]"));
	check("legacy links converted", document.includes("(old-one/session.md)") && !document.includes("](session-logs/"));
	check("current line with no-LLM title", document.includes("[cur-sess]") && document.includes("Build the session index for the archive layer"));
	check("legacy index removed", !(await readFile(path.join(tmp, ".agents/memory/session-index.md"), "utf8").catch(() => "")));

	await runHandlers(pi, "session_start", ctx);
	const again = await readFile(indexFile, "utf8");
	check("no duplicates after second run", again.split("\n").filter((line) => line.includes("[cur-sess]")).length === 1 && again.split("\n").filter((line) => line.includes("[old-one]")).length === 1);

	console.log("\n=== CONTEXT.md keeps the index out ===");
	const { renderContextDocument } = await loadNamespace(`${PC}/memory/context-doc.ts`);
	console.log("\n=== the index read-modify-write takes the cross-process lock ===");
	// `writeQueue` only serializes writers inside this process, and the index write is a
	// read-modify-write: two hosts doing it at once lose whole session lines. A stale lock left behind
	// by a dead host must be stolen and released by the writer; an unlocked writer would ignore the
	// file entirely and leave it in place.
	const lockFile = path.join(tmp, ".agents/memory/session-index.lock");
	await writeFile(lockFile, "stale");
	const longAgo = new Date(Date.now() - 60_000);
	await utimes(lockFile, longAgo, longAgo);
	// `session_shutdown` awaits its write (agent_settled fires and forgets), so the lock is released
	// before this returns.
	await runHandlers(pi, "session_shutdown", ctx);
	check("the index was still written with a stale lock present", (await readFile(indexFile, "utf8")).includes("[cur-sess]"));
	check("the writer consumed and released the stale lock", await stat(lockFile).then(() => false).catch(() => true));

	const { renderIndexDocument } = await loadNamespace(`${PC}/archive/session-index.ts`);
	const contextDoc = renderContextDocument({
		title: "Index test session",
		summary: "render check",
		key_points: [],
		open_tasks: [],
	}, { updatedAt: "2026-09-12T00:00:00.000Z" });
	check("CONTEXT.md has no session index section", !contextDoc.includes("## Session index"));
	const indexDoc = renderIndexDocument(again, "- [cur-sess](cur-sess/session.md) — 2026-09-12 — Index test session");
	check("INDEX.md keeps one line per session", indexDoc.split("\n").filter((line) => line.includes("[cur-sess]")).length === 1);
} finally {
	await rm(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL OK" : `\nFAILURES: ${failures}`);
if (failures > 0) process.exitCode = 1;
