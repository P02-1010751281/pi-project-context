import { appendFile, mkdtemp, mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadDefault, loadNamespace, makeCtx, makePi, makeSessionManager, messageEntry, PC, rmTemp, runHandlers } from "./harness.mjs";

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
	await rmTemp(tmp);
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
	await rmTemp(tmp);
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
	await rmTemp(tmp);
}

console.log("\n=== migration keeps a divergent legacy skill directory, and names a superseded file ===");
{
	// The import used to delete `<legacy>/skills/<name>/` as soon as the destination `SKILL.md`
	// existed: a newer hand-edited body and every sibling asset went with it, silently and without a
	// conflict. A legacy directory is now consumed only when it is an exact duplicate.
	const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-sync-skills-"));
	const live = '---\nname: release-checklist\ndescription: "live"\n---\n\nlive body\n';
	const legacy = '---\nname: release-checklist\ndescription: "hand edited"\n---\n\nhand-edited body\n';
	await mkdir(path.join(tmp, ".agents/memory"), { recursive: true });
	await mkdir(path.join(tmp, ".agents/skills/release-checklist"), { recursive: true });
	await writeFile(path.join(tmp, ".agents/skills/release-checklist/SKILL.md"), live);
	await mkdir(path.join(tmp, ".pi/skills/release-checklist"), { recursive: true });
	await writeFile(path.join(tmp, ".pi/skills/release-checklist/SKILL.md"), legacy);
	await writeFile(path.join(tmp, ".pi/skills/release-checklist/reference.md"), "only in the legacy copy");

	const result = await migrateProjectState(tmp);
	check("the divergent legacy body survives", (await readFile(path.join(tmp, ".pi/skills/release-checklist/SKILL.md"), "utf8").catch(() => "")) === legacy);
	check("the legacy-only sibling survives", await exists(path.join(tmp, ".pi/skills/release-checklist/reference.md")));
	check("the kept legacy directory is reported", result.conflicts.includes(".agents/skills/release-checklist"));
	check("the live skill is untouched", (await readFile(path.join(tmp, ".agents/skills/release-checklist/SKILL.md"), "utf8")) === live);
	await rmTemp(tmp);

	// The other outcome: a colliding file whose legacy copy is older. The bytes are dropped, and the
	// migration must not call that "moved".
	const older = await mkdtemp(path.join(os.tmpdir(), "pi-sync-superseded-"));
	await mkdir(path.join(older, ".agents/memory"), { recursive: true });
	await writeFile(path.join(older, ".agents/memory/MEMORY.md"), "# new\n");
	await mkdir(path.join(older, ".pi"), { recursive: true });
	await writeFile(path.join(older, ".pi/MEMORY.md"), "# legacy\n");
	const past = new Date(Date.now() - 60_000);
	await utimes(path.join(older, ".pi/MEMORY.md"), past, past);
	const superseded = await migrateProjectState(older);
	check("a newer destination is reported as superseded, not moved", superseded.moved.length === 0 && superseded.superseded.includes(".agents/memory/MEMORY.md"));
	check("the discarded legacy file is gone", !(await exists(path.join(older, ".pi/MEMORY.md"))));
	await rmTemp(older);
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
		await rmTemp(tmp);
		await rmTemp(legacy);
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
	await rmTemp(tmp);
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
	await rmTemp(tmp);
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
	check("a flush with no new bytes writes nothing", before.size === after.size && before.mtimeMs === after.mtimeMs && before.ino === after.ino);

	// An external rewrite must force a rebuild instead of a bad append.
	await writeFile(source, `${JSON.stringify({ type: "message", id: "m3" })}\n`);
	await writeSessionArtifacts(tmp, ctx, { markdown: false });
	const rebuilt = await readFile(artifacts, "utf8");
	check("external rewrite rebuilds", rebuilt.includes('"m3"') && !rebuilt.includes('"m1"'));
	await rmTemp(tmp);
}

console.log("\n=== session.jsonl handles a partial line and a growing rewrite ===");
{
	const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-sync-edge-"));
	const { writeSessionArtifacts } = await loadNamespace(`${PC}/archive/session-log.ts`);
	const source = path.join(tmp, "harness.jsonl");
	const sessionManager = {
		getSessionId: () => "edge-session",
		getSessionFile: () => source,
		getHeader: () => ({ type: "session", id: "edge-session", timestamp: "2026-09-12T10:00:00.000Z", cwd: tmp }),
		getEntries: () => [],
		getBranch: () => [],
		buildContextEntries: () => [],
		getLeafId: () => null,
	};
	const ctx = makeCtx(tmp, { sessionManager });
	const artifacts = path.join(tmp, ".agents/memory/session-logs/edge-session/session.jsonl");

	// A line flushed in two pieces must not gain a synthetic newline between the halves.
	await writeFile(source, '{"type":"message","id":"n1"');
	await writeSessionArtifacts(tmp, ctx, { markdown: false });
	check("a half-written line is copied without a synthetic byte", (await readFile(source, "utf8")).startsWith(await readFile(artifacts, "utf8")));
	await appendFile(source, ',"x":1}\n');
	await writeSessionArtifacts(tmp, ctx, { markdown: false });
	check("a half-written line keeps appending in place", (await readFile(artifacts, "utf8")) === (await readFile(source, "utf8")));

	// An in-place rewrite that grows past the archive must rebuild, not extend the stale prefix.
	const line = (i) => `${JSON.stringify({ type: "message", id: `x${i}`, message: { role: "user", content: `c${i}` } })}\n`;
	await writeFile(source, line(1) + line(2));
	await writeSessionArtifacts(tmp, ctx, { markdown: false });
	await writeFile(source, line(9) + line(10) + line(11));
	await writeSessionArtifacts(tmp, ctx, { markdown: false });
	check("a growing in-place rewrite at the boundary rebuilds", (await readFile(artifacts, "utf8")) === (await readFile(source, "utf8")));

	// A replacement via rename changes the inode. This one keeps the size and the 256-byte probe
	// window identical but changes the earlier lines, so only the inode check can catch it.
	const pad = `${JSON.stringify({ type: "pad", id: "z", message: { role: "user", content: "p".repeat(300) } })}\n`;
	const block = (tag) => Array.from({ length: 3 }, (_, i) => `${JSON.stringify({ type: "message", id: `${tag}${i}`, message: { role: "user", content: `${tag}${i}` } })}\n`).join("");
	await writeFile(source, block("a") + pad);
	await writeSessionArtifacts(tmp, ctx, { markdown: false });
	const replacement = path.join(tmp, "replacement.jsonl");
	await writeFile(replacement, block("b") + pad);
	await rename(replacement, source);
	await writeSessionArtifacts(tmp, ctx, { markdown: false });
	check("an inode-changing replacement rebuilds", (await readFile(artifacts, "utf8")) === (await readFile(source, "utf8")));
	await rmTemp(tmp);
}

console.log("\n=== overlapping writes for one session are serialized ===");
{
	const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-sync-concurrent-"));
	const { writeSessionArtifacts } = await loadNamespace(`${PC}/archive/session-log.ts`);
	const source = path.join(tmp, "harness.jsonl");
	const line = (i) => `${JSON.stringify({ type: "message", id: `k${i}`, message: { role: "user", content: `c${i}` } })}\n`;
	await writeFile(source, line(0));
	const sessionManager = {
		getSessionId: () => "concurrent-session",
		getSessionFile: () => source,
		getHeader: () => ({ type: "session", id: "concurrent-session", timestamp: "2026-09-12T10:00:00.000Z", cwd: tmp }),
		getEntries: () => [],
		getBranch: () => [],
		buildContextEntries: () => [],
		getLeafId: () => null,
	};
	const ctx = makeCtx(tmp, { sessionManager });
	const artifacts = path.join(tmp, ".agents/memory/session-logs/concurrent-session/session.jsonl");
	await writeSessionArtifacts(tmp, ctx, { markdown: false });
	await appendFile(source, line(1));
	await Promise.all([
		writeSessionArtifacts(tmp, ctx, { markdown: false }),
		writeSessionArtifacts(tmp, ctx, { markdown: false }),
	]);
	check("overlapping writes do not duplicate the tail", (await readFile(artifacts, "utf8")) === (await readFile(source, "utf8")));
	await rmTemp(tmp);
}

console.log("\n=== session.jsonl does not duplicate under a concurrent writer ===");
{
	// A stale source stat must never be used as the append offset: the harness can grow between the
	// stat and the read, and resuming from the stat would re-append the overlap.
	const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-sync-race-"));
	const { writeSessionArtifacts } = await loadNamespace(`${PC}/archive/session-log.ts`);
	const source = path.join(tmp, "harness.jsonl");
	const line = (i) => `${JSON.stringify({ type: "message", id: `r${i}`, message: { role: "user", content: `line ${i}` } })}\n`;
	let content = "";
	for (let i = 0; i < 4000; i += 1) content += line(i);
	await writeFile(source, content);
	const entries = [];
	const sessionManager = {
		getSessionId: () => "race-session",
		getSessionFile: () => source,
		getHeader: () => ({ type: "session", id: "race-session", timestamp: "2026-09-12T10:00:00.000Z", cwd: tmp }),
		getEntries: () => entries,
		getBranch: () => entries,
		buildContextEntries: () => entries,
		getLeafId: () => null,
	};
	const ctx = makeCtx(tmp, { sessionManager });
	await writeSessionArtifacts(tmp, ctx, { markdown: false });

	let next = 4000;
	const writer = (async () => {
		for (let i = 0; i < 400; i += 1) {
			await appendFile(source, line(next));
			next += 1;
			await new Promise((resolve) => setImmediate(resolve));
		}
	})();
	for (let i = 0; i < 400; i += 1) await writeSessionArtifacts(tmp, ctx, { markdown: false });
	await writer;
	await writeSessionArtifacts(tmp, ctx, { markdown: false });

	const archive = await readFile(path.join(tmp, ".agents/memory/session-logs/race-session/session.jsonl"), "utf8");
	const finalSource = await readFile(source, "utf8");
	check("archive matches the source after concurrent appends", archive === finalSource);
	const ids = archive.split("\n").filter(Boolean).map((entry) => JSON.parse(entry).id);
	check("no entry is duplicated by the append cursor", ids.length === new Set(ids).size);
	await rmTemp(tmp);
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
	await rmTemp(tmp);
}

console.log(failures === 0 ? "\nALL OK" : `\nFAILURES: ${failures}`);
if (failures > 0) process.exitCode = 1;
