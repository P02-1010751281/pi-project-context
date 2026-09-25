import { appendFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadDefault, loadNamespace, makeCtx, makePi, makeSessionManager, messageEntry, PC, runHandlers } from "./harness.mjs";

/**
 * Regression tests for the behaviors synced from dsh-project-context:
 *  - errors.log is bounded (rotation + per-record cap)
 *  - writeAtomic uses a unique temp path and always cleans it up
 *  - migration keeps an unmergeable legacy path instead of destroying it
 *  - the session-logs directory gets a `.gitignore`
 *  - CONTEXT.md caps the key-point / open-task lists
 *  - the consolidation turn throttle is session-local
 */

let failures = 0;
function check(label, value) {
	console.log(`${value ? "OK  " : "FAIL"} ${label}`);
	if (!value) failures += 1;
}
async function exists(file) {
	return stat(file).then(() => true).catch(() => false);
}

const { legacyOmpDir, logError, migrateProjectState, writeAtomic } = await loadNamespace(`${PC}/shared/project-state.ts`);

console.log("=== errors.log is bounded ===");
{
	const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-sync-errors-"));
	await mkdir(path.join(tmp, ".agents/memory"), { recursive: true });
	const file = path.join(tmp, ".agents/memory/errors.log");
	// A file past the 1 MB cap with no line breaks; rotation keeps the newest tail only.
	await writeFile(file, "x".repeat(1_100_000));
	await logError(tmp, "rotation", new Error("rotation-boom"));
	const rotated = await readFile(file, "utf8");
	const size = (await stat(file)).size;
	check("rotated below the cap", size < 80_000);
	check("rotation marker kept", rotated.includes("newest entries kept"));
	check("new record kept", rotated.includes("rotation-boom"));
	check("scope kept", rotated.includes("[rotation]"));

	// A single huge record is capped so one stack cannot dominate the file.
	const big = new Error("detail-boom");
	big.stack = `detail-boom\n${"y".repeat(20_000)}`;
	await logError(tmp, "detail", big);
	const capped = await readFile(file, "utf8");
	check("single record truncated", capped.includes("[...detail truncated...]"));
	await rm(tmp, { recursive: true, force: true });
}

console.log("\n=== writeAtomic temp hygiene ===");
{
	const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-sync-atomic-"));
	const file = path.join(tmp, "nested/artifact.json");
	await Promise.all([writeAtomic(file, "alpha"), writeAtomic(file, "beta")]);
	const content = await readFile(file, "utf8");
	const leftovers = (await import("node:fs/promises")).readdir(path.join(tmp, "nested")).then((entries) => entries.filter((name) => name.endsWith(".tmp")));
	check("one call wins cleanly", content === "alpha" || content === "beta");
	check("no temp files left", (await leftovers).length === 0);
	await rm(tmp, { recursive: true, force: true });
}

console.log("\n=== migration keeps an unmergeable legacy path ===");
{
	const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-sync-migrate-"));
	// Legacy MEMORY.md is a directory; the new location is a file: a type conflict.
	await mkdir(path.join(tmp, ".pi/MEMORY.md"), { recursive: true });
	await writeFile(path.join(tmp, ".pi/MEMORY.md/inside.md"), "legacy");
	await mkdir(path.join(tmp, ".agents/memory"), { recursive: true });
	await writeFile(path.join(tmp, ".agents/memory/MEMORY.md"), "current");

	const result = await migrateProjectState(tmp);
	check("conflict reported", result.conflicts.includes(".agents/memory/MEMORY.md"));
	check("legacy side left in place", await exists(path.join(tmp, ".pi/MEMORY.md/inside.md")));
	check("new side left in place", (await readFile(path.join(tmp, ".agents/memory/MEMORY.md"), "utf8")) === "current");
	await rm(tmp, { recursive: true, force: true });
}

console.log("\n=== migration honors maxMemoryChars ===");
{
	const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-sync-migrate-cap-"));
	const legacy = legacyOmpDir(tmp);
	try {
		await mkdir(path.join(tmp, ".agents/memory"), { recursive: true });
		await writeFile(path.join(tmp, ".agents/memory/project-context.json"), JSON.stringify({ maxMemoryChars: 5_000 }));
		await mkdir(legacy, { recursive: true });
		const imported = `# Project Memory\n\n## Project\n${Array.from({ length: 300 }, (_, index) => `- legacy ${index}: ${"detail ".repeat(20)}`).join("\n")}`;
		await writeFile(path.join(legacy, "MEMORY.md"), imported);
		const factory = await loadDefault(`${PC}/index.ts`);
		const pi = makePi({ cwd: tmp });
		await factory(pi);
		await runHandlers(pi, "session_start", makeCtx(tmp));
		const migrated = await readFile(path.join(tmp, ".agents/memory/MEMORY.md"), "utf8");
		check("legacy OMP import uses the project's memory cap", migrated.includes("at 5000 characters") && migrated.length < 5_500);
		check("legacy OMP import enters the journal", (await readFile(path.join(tmp, ".agents/memory/memory.jsonl"), "utf8")).includes('"replace"'));
	} finally {
		await rm(tmp, { recursive: true, force: true });
		await rm(legacy, { recursive: true, force: true });
	}
}

console.log("\n=== session-logs gets a .gitignore ===");
{
	const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-sync-ignore-"));
	const factory = await loadDefault(`${PC}/index.ts`);
	const pi = makePi({ cwd: tmp });
	await factory(pi);
	const entries = [messageEntry("m1", "user", "archive me", "2026-09-12T10:00:00.000Z")];
	const ctx = makeCtx(tmp, { sessionManager: makeSessionManager(entries, "ignore-session") });
	await runHandlers(pi, "session_shutdown", ctx);
	const ignore = await readFile(path.join(tmp, ".agents/memory/session-logs/.gitignore"), "utf8").catch(() => "");
	check("ignore file written", ignore.includes("*"));
	await rm(tmp, { recursive: true, force: true });
}

console.log("\n=== CONTEXT.md caps the list sections ===");
{
	const { renderContextDocument } = await loadNamespace(`${PC}/memory/context-doc.ts`);
	const document = renderContextDocument({
		title: "cap test",
		summary: "summary",
		key_points: Array.from({ length: 60 }, (_, index) => `key point ${index}`),
		open_tasks: Array.from({ length: 60 }, (_, index) => `task ${index}`),
	}, { updatedAt: "2026-09-12T00:00:00.000Z" });
	check("no session index in CONTEXT.md", !document.includes("## Session index"));
	check("capped at 50 key points", document.includes("key point 49") && !document.includes("key point 55"));
	check("capped at 50 open tasks", document.includes("task 49") && !document.includes("task 55"));
}

console.log("\n=== consolidation throttle is session-local ===");
{
	const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-sync-throttle-"));
	const factory = await loadDefault(`${PC}/index.ts`);
	const pi = makePi({ cwd: tmp });
	await factory(pi);
	const { consolidateProjectState } = await loadNamespace(`${PC}/memory/pass.ts`);

	const turns = (id) => Array.from({ length: 6 }, (_, index) => [
		messageEntry(`${id}-u${index}`, "user", `turn ${index}`, `2026-09-12T10:0${index}:00.000Z`),
		messageEntry(`${id}-a${index}`, "assistant", `answer ${index}`, `2026-09-12T10:0${index}:01.000Z`),
	]).flat();

	let calls = 0;
	const makeCtxFor = (id) => makeCtx(tmp, {
		sessionManager: makeSessionManager(turns(id), id),
		modelRegistry: {
			hasConfiguredAuth: () => true,
			complete: async () => {
				calls += 1;
				return { content: [{ type: "text", text: JSON.stringify({ memory_markdown: "# Project Memory\n\n## Project\n- synced.", context: { title: id, summary: "ran", key_points: [], open_tasks: [] } }) }] };
			},
		},
	});

	const first = await consolidateProjectState(pi, makeCtxFor("session-a"), { force: false });
	check("first session consolidates", first !== undefined && calls === 1);

	// Six minutes later a fresh session with six turns must not inherit the old
	// session's turn counter (the old code subtracted it and throttled forever).
	const realNow = Date.now;
	Date.now = () => realNow() + 6 * 60 * 1000;
	try {
		const second = await consolidateProjectState(pi, makeCtxFor("session-b"), { force: false });
		check("fresh session consolidates after the interval", second !== undefined && calls === 2);
	} finally {
		Date.now = realNow;
	}
	await rm(tmp, { recursive: true, force: true });
}

console.log("\n=== session.jsonl appends incrementally ===");
{
	const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-sync-append-"));
	const { writeSessionArtifacts } = await loadNamespace(`${PC}/archive/session-log.ts`);
	const source = path.join(tmp, "harness.jsonl");
	await writeFile(source, `${JSON.stringify({ type: "message", id: "m1" })}\n`);
	const entries = [messageEntry("m1", "user", "first", "2026-09-12T10:00:00.000Z")];
	const sessionManager = {
		getSessionId: () => "append-session",
		getSessionFile: () => source,
		getHeader: () => ({ type: "session", id: "append-session", timestamp: "2026-09-12T10:00:00.000Z", cwd: tmp }),
		getEntries: () => entries,
		getBranch: () => entries,
		buildContextEntries: () => entries,
		getLeafId: () => entries.at(-1)?.id ?? null,
	};
	const ctx = makeCtx(tmp, { sessionManager });
	const artifacts = path.join(tmp, ".agents/memory/session-logs/append-session/session.jsonl");

	await writeSessionArtifacts(tmp, ctx, { markdown: false });
	check("first write copies the source", (await readFile(artifacts, "utf8")).split("\n").filter(Boolean).length === 1);

	await appendFile(source, `${JSON.stringify({ type: "message", id: "m2" })}\n`);
	entries.push(messageEntry("m2", "assistant", "second", "2026-09-12T10:01:00.000Z"));
	await writeSessionArtifacts(tmp, ctx, { markdown: false });
	const grown = await readFile(artifacts, "utf8");
	check("append keeps the first line", grown.includes('"m1"') && grown.includes('"m2"'));

	const before = await stat(artifacts);
	await writeSessionArtifacts(tmp, ctx, { markdown: false });
	const after = await stat(artifacts);
	check("a flush with no new bytes writes nothing", before.size === after.size && before.mtimeMs === after.mtimeMs);

	// An external rewrite must force a rebuild instead of a bad append.
	await writeFile(source, `${JSON.stringify({ type: "message", id: "m3" })}\n`);
	await writeSessionArtifacts(tmp, ctx, { markdown: false });
	const rebuilt = await readFile(artifacts, "utf8");
	check("external rewrite rebuilds", rebuilt.includes('"m3"') && !rebuilt.includes('"m1"'));
	await rm(tmp, { recursive: true, force: true });
}

console.log("\n=== archive backfill import ===");
{
	const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-sync-import-"));
	const { importArchiveFiles, importSessionFile, resolveImportTargets } = await loadNamespace(`${PC}/archive/import-archive.ts`);
	const dir = path.join(tmp, "exports");
	await mkdir(dir, { recursive: true });
	const file = path.join(dir, "session-old.jsonl");
	await writeFile(file, [
		JSON.stringify({ type: "session", version: 3, id: "old-session-1", timestamp: "2026-08-01T00:00:00.000Z", cwd: tmp }),
		JSON.stringify(messageEntry("u1", "user", "an old session about backfill", "2026-08-01T00:00:01.000Z")),
		JSON.stringify(messageEntry("a1", "assistant", "done", "2026-08-01T00:00:02.000Z")),
	].join("\n") + "\n");

	const first = await importSessionFile(file, { projectRoot: tmp });
	check("imported", first.status === "created" && first.id === "old-session-1");
	const rawCopy = await readFile(path.join(tmp, ".agents/memory/session-logs/old-session-1/session.jsonl"), "utf8");
	check("raw copied verbatim", rawCopy.includes("backfill"));
	const markdown = await readFile(path.join(tmp, ".agents/memory/session-logs/old-session-1/session.md"), "utf8");
	check("markdown rendered", markdown.includes("# Pi Session old-session-1") && markdown.includes("- Entries: 2"));
	const index = await readFile(path.join(tmp, ".agents/memory/session-logs/INDEX.md"), "utf8");
	check("index line added", index.includes("[old-session-1]") && index.includes("an old session about backfill"));
	check("idempotent", (await importSessionFile(file, { projectRoot: tmp })).status === "skipped");

	const second = path.join(dir, "session-two.jsonl");
	await writeFile(second, [
		JSON.stringify({ type: "session", id: "old-session-2", timestamp: "2026-08-02T00:00:00.000Z", cwd: tmp }),
		JSON.stringify(messageEntry("u2", "user", "second", "2026-08-02T00:00:01.000Z")),
	].join("\n") + "\n");
	const targets = await resolveImportTargets(dir, tmp);
	check("directory expands to both files", targets.length === 2);
	const outcomes = await importArchiveFiles(targets, { projectRoot: tmp });
	check("bulk import creates one and skips one", outcomes.filter((o) => o.status === "created").length === 1 && outcomes.filter((o) => o.status === "skipped").length === 1);
	await rm(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL OK" : `\nFAILURES: ${failures}`);
if (failures > 0) process.exitCode = 1;
