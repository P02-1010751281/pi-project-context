import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadDefault, loadNamespace, makeCtx, makePi, makeSessionManager, messageEntry, PC, runHandlers } from "./harness.mjs";

/**
 * End-to-end test of the settle/shutdown path in one extension:
 * archive writes session.jsonl / session.md / session-index.md, then the consolidation
 * pass rewrites MEMORY.md and CONTEXT.md from the real conversation projection.
 */

const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-consolidation-"));
const marker = "MARKER-consolidation-4217";
let failures = 0;
function check(label, value) {
	console.log(`${value ? "OK  " : "FAIL"} ${label}`);
	if (!value) failures += 1;
}

try {
	await mkdir(path.join(tmp, ".agents/memory"), { recursive: true });
	await writeFile(path.join(tmp, ".agents/memory/MEMORY.md"), "# Project Memory\n\n## Project\n- Old memory.\n");
	await writeFile(
		path.join(tmp, ".agents/memory/CONTEXT.md"),
		"# Project Context\n\n## Summary\nOld summary.\n\n## Session index\n\n- [old](session-logs/old/session.md) — 2026-09-01 — old\n",
	);

	const entries = [
		messageEntry("m1", "user", `please keep ${marker} in the summary`, "2026-09-12T10:00:00.000Z"),
		messageEntry("m2", "assistant", "noted", "2026-09-12T10:00:01.000Z"),
	];
	const factory = await loadDefault(`${PC}/index.ts`);
	const pi = makePi({ cwd: tmp });
	await factory(pi);
	const ctx = makeCtx(tmp, { sessionManager: makeSessionManager(entries, "e2e-session") });

	let prompt = "";
	ctx.modelRegistry.complete = async (_model, context) => {
		prompt = context.messages[0].content[0].text;
		return {
			content: [{
				type: "text",
				text: JSON.stringify({
					memory_markdown: "# Project Memory\n\n## Project\n- Consolidation e2e project.",
					context: { title: "Consolidation test session", summary: "Consolidation e2e ran.", key_points: ["one"], open_tasks: ["two"] },
				}),
			}],
		};
	};

	await runHandlers(pi, "session_shutdown", ctx);

	console.log("=== archive ===");
	const rawLog = await readFile(path.join(tmp, ".agents/memory/session-logs/e2e-session/session.jsonl"), "utf8").catch(() => "");
	check("session.jsonl written with the marker", rawLog.includes(marker));
	const markdown = await readFile(path.join(tmp, ".agents/memory/session-logs/e2e-session/session.md"), "utf8").catch(() => "");
	check("session.md rendered with the entry count", markdown.includes("# Pi Session e2e-session") && markdown.includes("- Entries: 2"));
	const index = await readFile(path.join(tmp, ".agents/memory/session-logs/INDEX.md"), "utf8").catch(() => "");
	check("session index has the current session", index.includes("[e2e-session]"));

	console.log("\n=== consolidation ===");
	const memory = await readFile(path.join(tmp, ".agents/memory/MEMORY.md"), "utf8");
	const context = await readFile(path.join(tmp, ".agents/memory/CONTEXT.md"), "utf8");
	check("MEMORY.md rewritten", memory.includes("Consolidation e2e project."));
	check("CONTEXT.md has the new summary", context.includes("Consolidation e2e ran."));
	check("CONTEXT.md has no session index", !context.includes("## Session index"));
	check("prompt had the real conversation", prompt.includes(marker));
	check("prompt has boundary rules", prompt.includes("long-term memory"));
	check("prompt has both artifacts", prompt.includes("<existing-memory>") && prompt.includes("<existing-context>"));

	console.log("\nnotifications:", JSON.stringify(ctx.notifications.map(([message]) => message)));

	console.log("\n=== malformed consolidation replies ===");
	{
		const { parseConsolidated } = await loadNamespace(`${PC}/consolidate.ts`);
		// The reply that used to poison MEMORY.md: a stray member made JSON.parse fail and the
		// raw object was stored as memory.
		const corrupted = '{"memory_markdown":"# Project Memory\\n\\n## Project\\n- kept.","context":"# Project Context","stray\\n\\n- tail"}';
		check("malformed JSON: the memory field is recovered", parseConsolidated(corrupted)?.memory === "# Project Memory\n\n## Project\n- kept.");
		check("truncated JSON: no memory is invented", parseConsolidated('{"memory_markdown":"# Project Memory\\n\\n- cut') === undefined);
		check("unusable JSON: the pass fails instead of storing raw JSON", parseConsolidated('{"memory_markdown": 17, "context": {') === undefined);
		check("plain markdown still becomes memory", parseConsolidated("still plain markdown")?.memory === "still plain markdown");
	}

	console.log("\n=== a reply that cannot be read never reaches MEMORY.md ===");
	{
		const jsonTmp = await mkdtemp(path.join(os.tmpdir(), "pi-consolidation-json-"));
		try {
			await mkdir(path.join(jsonTmp, ".agents/memory"), { recursive: true });
			const previous = "# Project Memory\n\n## Project\n- Previous memory.\n";
			await writeFile(path.join(jsonTmp, ".agents/memory/MEMORY.md"), previous);
			let reply = '{"memory_markdown":"# Project Memory\\n\\n## Project\\n- recovered.","context":"# Project Context","stray\\n\\n- tail"}';
			const factory = await loadDefault(`${PC}/index.ts`);
			const pi = makePi({ cwd: jsonTmp });
			await factory(pi);
			const ctx = makeCtx(jsonTmp, {
				sessionManager: makeSessionManager([messageEntry("m1", "user", "hello", "2026-09-12T10:00:00.000Z")], "json-session"),
				modelRegistry: { hasConfiguredAuth: () => true, complete: async () => ({ content: [{ type: "text", text: reply }] }) },
			});
			await runHandlers(pi, "session_shutdown", ctx);
			const recovered = await readFile(path.join(jsonTmp, ".agents/memory/MEMORY.md"), "utf8");
			check("a malformed reply stores the recovered memory", recovered.includes("- recovered.") && !recovered.includes("memory_markdown"));

			// Second pass: nothing readable at all; the file must stay exactly as it is.
			reply = '{"memory_markdown": 17, "context": {';
			const realNow = Date.now;
			Date.now = () => realNow() + 60 * 1000;
			try {
				await runHandlers(pi, "session_shutdown", ctx);
			} finally {
				Date.now = realNow;
			}
			const untouched = await readFile(path.join(jsonTmp, ".agents/memory/MEMORY.md"), "utf8");
			const errors = await readFile(path.join(jsonTmp, ".agents/memory/errors.log"), "utf8").catch(() => "");
			check("an unusable reply leaves MEMORY.md untouched", untouched === recovered);
			check("the failed pass is logged to errors.log", errors.includes("consolidation reply was not a usable JSON object") && errors.includes('"memory_markdown": 17'));
		} finally {
			await rm(jsonTmp, { recursive: true, force: true });
		}
	}

	console.log("\n=== a stored JSON reply is decoded on read and repaired on write ===");
	{
		const { loadMemory, backupMemoryBeforeWrite } = await loadNamespace(`${PC}/project-state.ts`);
		const healTmp = await mkdtemp(path.join(os.tmpdir(), "pi-memory-heal-"));
		const healMemory = path.join(healTmp, ".agents/memory/MEMORY.md");
		const backupCount = async () => (await readdir(path.dirname(healMemory))).filter((name) => name.includes(".memory-backup-")).length;
		try {
			await mkdir(path.dirname(healMemory), { recursive: true });
			const poison = '# Project Memory\n\n{\n  "memory_markdown": "# Project Memory\\n\\n## Project\\n- decoded fact.\\n\\n## Tail\\n- 已确认的事实。截断的尾巴\n';
			await writeFile(healMemory, poison);
			const first = await loadMemory(healTmp);
			check("a stored reply is decoded to markdown on read", first.poisoned === true && first.text.startsWith("# Project Memory") && first.text.includes("- decoded fact.") && !first.text.includes("memory_markdown"));
			check("every recovered line is kept", first.text.includes("已确认的事实。") && first.text.includes("截断的尾巴"));
			check("reading never rewrites the stored file", (await readFile(healMemory, "utf8")) === poison && (await backupCount()) === 0);
			const second = await loadMemory(healTmp);
			check("decoding is stable across reads", second.text === first.text && second.poisoned === true && (await readFile(healMemory, "utf8")) === poison);

			// A value cut at a line boundary, or ending with a complete Latin line, keeps its last line too.
			await writeFile(healMemory, '# Project Memory\n\n{"memory_markdown": "# Project Memory\\n\\n## Project\\n- complete English line.\\n", "context": {}}\n');
			const latin = await loadMemory(healTmp);
			check("a complete Latin tail survives decoding", latin.poisoned === true && latin.text.includes("- complete English line."));
			await writeFile(healMemory, '# Project Memory\n\n{"memory_markdown": "# Project Memory\\n\\n## Project\\n- boundary line\\n", "context": {}}\n');
			const boundary = await loadMemory(healTmp);
			check("a value cut at a line boundary survives decoding", boundary.poisoned === true && boundary.text.includes("- boundary line"));

			const healthy = '# Project Memory\n\n## Project\n- layout note: `{"memory_markdown": ...}` is what an old bug wrote.\n';
			await writeFile(healMemory, healthy);
			const kept = await loadMemory(healTmp);
			check("a healthy memory mentioning the field is not decoded", kept.poisoned === false && kept.text.includes("is what an old bug wrote.") && (await readFile(healMemory, "utf8")) === healthy);

			// A JSON-shaped healthy file whose field value is not the memory document must stay.
			const sample = '# Project Memory\n\n{\n  "endpoint": "local",\n  "memory_markdown": "legacy poison sample: see issue",\n  "note": "kept"\n}\n\n## Real notes\n- keep me\n';
			await writeFile(healMemory, sample);
			const held = await loadMemory(healTmp);
			check("a JSON-shaped healthy memory is not decoded", held.poisoned === false && held.text.includes("## Real notes") && (await readFile(healMemory, "utf8")) === sample);

			// A mention that actually matches the field regex (open quote) must still stay untouched.
			const mention = '# Project Memory\n\n## Project\n- the old bug wrote {"memory_markdown": " and cut the rest\n- keep this fact\n';
			await writeFile(healMemory, mention);
			const mentioned = await loadMemory(healTmp);
			check("a regex-matching mention is not decoded", mentioned.poisoned === false && mentioned.text.includes("keep this fact") && (await readFile(healMemory, "utf8")) === mention);

			// A documented reply sample followed by real content must not be treated as stored poison.
			const example = '# Project Memory\n\n```json\n{"memory_markdown": "# Project Memory\\n\\n## Example\\n- documented reply format", "context": {}}\n```\n\n## Real notes\n- keep me\n';
			await writeFile(healMemory, example);
			const exemplified = await loadMemory(healTmp);
			check("a documented JSON example is not decoded", exemplified.poisoned === false && exemplified.text.includes("## Real notes") && (await readFile(healMemory, "utf8")) === example);

			// A trailing JSON snippet after the example must not unlock a decode.
			const trailed = `${example}{"a":1}\n`;
			await writeFile(healMemory, trailed);
			const trailer = await loadMemory(healTmp);
			check("a trailing JSON snippet does not unlock a decode", trailer.poisoned === false && trailer.text.includes("## Real notes") && (await readFile(healMemory, "utf8")) === trailed);

			// An unrelated brace near the top plus a documented example later must stay untouched.
			const unrelated = '# Project Memory\n\nUse `{}` for empty maps.\n\n```json\n{"memory_markdown": "# Project Memory\\n\\n## Example\\n- documented reply format", "context": {}}\n```\n\n## Real notes\n- keep me\n{"a":1}\n';
			await writeFile(healMemory, unrelated);
			const unrelatedRead = await loadMemory(healTmp);
			check("an unrelated brace does not unlock a decode", unrelatedRead.poisoned === false && unrelatedRead.text.includes("## Real notes") && (await readFile(healMemory, "utf8")) === unrelated);

			// Real content before a documented reply example must stay untouched too.
			const notesFirst = '# Project Memory\n\n## Notes\n- keep me (durable fact)\n{"memory_markdown": "# Project Memory\\n\\n## Sample\\n- documented reply format", "context": {}}\n';
			await writeFile(healMemory, notesFirst);
			const notesRead = await loadMemory(healTmp);
			check("real notes before an example are not decoded", notesRead.poisoned === false && notesRead.text.includes("keep me (durable fact)") && (await readFile(healMemory, "utf8")) === notesFirst);

			// The same shape with an unterminated example at the end.
			const notesFirstCut = '# Project Memory\n\n## Notes\n- keep me (durable fact)\n{"memory_markdown": "# Project Memory\\n\\n## Sample\\n- documented reply cut';
			await writeFile(healMemory, notesFirstCut);
			const notesCut = await loadMemory(healTmp);
			check("an unterminated trailing example is not decoded", notesCut.poisoned === false && notesCut.text.includes("keep me (durable fact)") && (await readFile(healMemory, "utf8")) === notesFirstCut);

			// A single-line bullet before an example must not pass for a wrapper either.
			const bulletFirst = '# Project Memory\n\n- keep me (durable fact)\n{"memory_markdown": "# Project Memory\\n\\n## Sample\\n- documented reply format", "context": {}}\n';
			await writeFile(healMemory, bulletFirst);
			const bulletRead = await loadMemory(healTmp);
			check("a single-line bullet prefix is not decoded", bulletRead.poisoned === false && bulletRead.text.includes("keep me (durable fact)") && (await readFile(healMemory, "utf8")) === bulletFirst);

			// A nested field is an example, not a stored reply.
			const nested = '# Project Memory\n\n{"real_fact": "KEEP", "inner": {"memory_markdown": "# Project Memory\\n\\n## Nested\\n- inner"}}\n';
			await writeFile(healMemory, nested);
			const nestedRead = await loadMemory(healTmp);
			check("a nested field is not decoded", nestedRead.poisoned === false && nestedRead.text.includes("KEEP") && (await readFile(healMemory, "utf8")) === nested);

			// A fence-wrapped stored value still heals (the value is normalized before the shape check).
			await writeFile(healMemory, '# Project Memory\n\n{"memory_markdown": "```markdown\\n# Project Memory\\n\\n## Project\\n- fenced value。\\n", "context": {}}\n');
			const fencedValue = await loadMemory(healTmp);
			check("a fence-wrapped stored value is decoded", fencedValue.poisoned === true && fencedValue.text.includes("fenced value。"));

			// Historical storage shapes: fenced-json leftovers and array wrappers.
			const shapes = [
				["fenced json", 'json\n{"memory_markdown": "# Project Memory\\n\\n## Project\\n- fenced json leftover。'],
				["array wrap", '[{"memory_markdown": "# Project Memory\\n\\n## Project\\n- array wrap leftover。'],
			];
			for (const [label, shape] of shapes) {
				await writeFile(healMemory, `# Project Memory\n\n${shape}`);
				const decoded = await loadMemory(healTmp);
				check(`a stored ${label} reply is decoded`, decoded.poisoned === true && decoded.text.includes(`${label} leftover`) && !decoded.text.includes("memory_markdown"));
			}

			const prose = '# Project Memory\n\nHere is the JSON:\n{"memory_markdown": "# Project Memory\\n\\n## Project\\n- prose prefix leftover。';
			await writeFile(healMemory, prose);
			const proseRead = await loadMemory(healTmp);
			check("a prose-prefixed stored reply is decoded", proseRead.poisoned === true && proseRead.text.includes("prose prefix leftover") && (await readFile(healMemory, "utf8")) === prose);

			// The same wrapper with a value that is not a memory document stays untouched (fail-safe).
			const proseValue = '# Project Memory\n\nHere is the JSON:\n{"memory_markdown": "not a document"}';
			await writeFile(healMemory, proseValue);
			const proseValueRead = await loadMemory(healTmp);
			check("a prose prefix without a document value is left alone", proseValueRead.poisoned === false && (await readFile(healMemory, "utf8")) === proseValue);

			// The normal consolidation write path repairs the stored file and keeps the raw bytes.
			const factory = await loadDefault(`${PC}/index.ts`);
			const pi = makePi({ cwd: healTmp });
			await factory(pi);
			await writeFile(healMemory, poison);
			const ctx = makeCtx(healTmp, {
				model: { provider: "test", id: "heal-repair", maxTokens: 32768 },
				sessionManager: makeSessionManager([messageEntry("m1", "user", "hello", "2026-09-12T10:00:00.000Z")], "heal-repair"),
			});
			ctx.modelRegistry.complete = async () => ({
				content: [{ type: "text", text: JSON.stringify({ memory_markdown: "# Project Memory\n\n## Project\n- repaired memory.", context: { title: "t", summary: "s", key_points: [], open_tasks: [] } }) }],
			});
			await pi.commands.get("memory-learn").handler("", ctx);
			const repaired = await readFile(healMemory, "utf8");
			check("the writer replaces the stored reply with markdown", repaired.startsWith("# Project Memory") && repaired.includes("- repaired memory.") && !repaired.includes("memory_markdown"));
			const repairBackups = (await readdir(path.dirname(healMemory))).filter((name) => name.includes(".memory-backup-"));
			check("the writer keeps the raw bytes as a backup", repairBackups.length === 1 && (await readFile(path.join(path.dirname(healMemory), repairBackups[0]), "utf8")) === poison);
			const repairLog = await readFile(path.join(healTmp, ".agents/memory/errors.log"), "utf8").catch(() => "");
			check("the repair is recorded in errors.log", repairLog.includes("replaced a stored JSON reply"));

			// Two concurrent passes must not write the same memory twice (fresh instance: no dedupe cache).
			const factory2 = await loadDefault(`${PC}/index.ts`);
			const pi2 = makePi({ cwd: healTmp });
			await factory2(pi2);
			await writeFile(healMemory, poison);
			for (const name of (await readdir(path.dirname(healMemory))).filter((n) => n.includes(".memory-backup-"))) {
				await rm(path.join(path.dirname(healMemory), name), { force: true });
			}
			await rm(path.join(healTmp, ".agents/memory/errors.log"), { force: true });
			const ctx2 = makeCtx(healTmp, {
				model: { provider: "test", id: "heal-repair-2", maxTokens: 32768 },
				sessionManager: makeSessionManager([messageEntry("m1", "user", "hello", "2026-09-12T10:00:00.000Z")], "heal-repair-2"),
			});
			ctx2.modelRegistry.complete = async () => ({
				content: [{ type: "text", text: JSON.stringify({ memory_markdown: "# Project Memory\n\n## Project\n- concurrent repair.", context: { title: "t", summary: "s", key_points: [], open_tasks: [] } }) }],
			});
			await Promise.all([
				pi2.commands.get("memory-learn").handler("", ctx2),
				pi2.commands.get("memory-learn").handler("", ctx2),
			]);
			const concurrentBackups = (await readdir(path.dirname(healMemory))).filter((name) => name.includes(".memory-backup-"));
			const concurrentLog = await readFile(path.join(healTmp, ".agents/memory/errors.log"), "utf8").catch(() => "");
			check(`concurrent passes rewrite the memory once (backups=${concurrentBackups.length}, logs=${concurrentLog.split("replaced a stored JSON reply").length - 1})`, concurrentBackups.length === 1 && concurrentLog.split("replaced a stored JSON reply").length - 1 === 1);

			// A writer landing during the model call is the content the backup must capture.
			const factory3 = await loadDefault(`${PC}/index.ts`);
			const pi3 = makePi({ cwd: healTmp });
			await factory3(pi3);
			await writeFile(healMemory, "# Project Memory\n\n## Project\n- old memory.\n");
			for (const name of (await readdir(path.dirname(healMemory))).filter((n) => n.includes(".memory-backup-"))) {
				await rm(path.join(path.dirname(healMemory), name), { force: true });
			}
			await rm(path.join(healTmp, ".agents/memory/errors.log"), { force: true });
			const arrived = '# Project Memory\n\n{\n  "memory_markdown": "# Project Memory\\n\\n## Project\\n- arrived during the pass。\\n", "context": {}}\n';
			const ctx3 = makeCtx(healTmp, {
				model: { provider: "test", id: "heal-race", maxTokens: 32768 },
				sessionManager: makeSessionManager([messageEntry("m1", "user", "hello", "2026-09-12T10:00:00.000Z")], "heal-race"),
			});
			ctx3.modelRegistry.complete = async () => {
				await writeFile(healMemory, arrived);
				return {
					content: [{ type: "text", text: JSON.stringify({ memory_markdown: "# Project Memory\n\n## Project\n- post-race memory.", context: { title: "t", summary: "s", key_points: [], open_tasks: [] } }) }],
				};
			};
			await pi3.commands.get("memory-learn").handler("", ctx3);
			const raceBackups = (await readdir(path.dirname(healMemory))).filter((n) => n.includes(".memory-backup-"));
			const raceLog = await readFile(path.join(healTmp, ".agents/memory/errors.log"), "utf8").catch(() => "");
			check("a mid-call writer is backed up", raceBackups.length === 1 && (await readFile(path.join(path.dirname(healMemory), raceBackups[0]), "utf8")) === arrived && raceLog.includes("replaced a stored JSON reply"));

			// The backup helper fails closed when the target exists but cannot be read.
			const unreadable = path.join(healTmp, ".agents/memory/UNREADABLE.md");
			await mkdir(unreadable, { recursive: true });
			let failedClosed = false;
			try {
				await backupMemoryBeforeWrite(unreadable);
			} catch {
				failedClosed = true;
			}
			check("an unreadable memory target fails closed", failedClosed);

			// A burst of writes keeps the recent backups, so a backup named in a notice stays reviewable.
			const countBackups = async () => (await readdir(path.dirname(healMemory), { withFileTypes: true })).filter((entry) => entry.isFile() && /^MEMORY\.md\.memory-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/.test(entry.name)).length;
			const backupNames = async () => (await readdir(path.dirname(healMemory), { withFileTypes: true }))
				.filter((entry) => entry.isFile() && /^MEMORY\.md\.memory-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/.test(entry.name))
				.map((entry) => path.join(path.dirname(healMemory), entry.name));
			const beforeBurst = await countBackups();
			for (let round = 0; round < 7; round += 1) {
				await backupMemoryBeforeWrite(healMemory);
			}
			const burst = await countBackups();
			check(`a burst of writes keeps recent backups (have ${burst})`, burst === beforeBurst + 7);
			// Once they age past the floor, the prune keeps the newest five and never the one just written.
			const aged = new Date(Date.now() - 2 * 60 * 60 * 1000);
			for (const file of await backupNames()) await utimes(file, aged, aged);
			const agedWrite = await backupMemoryBeforeWrite(healMemory);
			const pruned = await countBackups();
			check(`aged backups prune down to five (have ${pruned})`, pruned === 5 && agedWrite.path !== undefined);
			for (let skew = 0; skew < 6; skew += 1) {
				const skewName = path.join(path.dirname(healMemory), `MEMORY.md.memory-backup-2099-01-0${skew + 1}T00-00-00-000Z-dead000${skew}`);
				await writeFile(skewName, "future");
				// Future-looking names with old mtimes: pruning must trust mtime, not the name.
				await utimes(skewName, new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z"));
			}
			const skewed = await backupMemoryBeforeWrite(healMemory);
			const afterSkew = await countBackups();
			check(`a skewed clock never prunes the new backup (have ${afterSkew})`, skewed.path !== undefined && (await readFile(skewed.path, "utf8").catch(() => undefined)) !== undefined && afterSkew === 5);

			// Pruning must leave files it did not generate alone, and a directory must not stop it.
			const keepMe = path.join(path.dirname(healMemory), "MEMORY.md.memory-backup-2026-01-01T00-00-00-000Z-KEEP-ME.md");
			await writeFile(keepMe, "user copy");
			const nestedName = path.join(path.dirname(healMemory), "MEMORY.md.memory-backup-keep.memory-backup-2026-01-01T00-00-00-000Z-deadbeef");
			await writeFile(nestedName, "user nested");
			const backupDirectory = path.join(path.dirname(healMemory), "MEMORY.md.memory-backup-2099-12-31T00-00-00-000Z-deadbeef");
			await mkdir(backupDirectory, { recursive: true });
			await backupMemoryBeforeWrite(healMemory);
			const afterUserFiles = await countBackups();
			check("pruning leaves user files and directories alone", (await readFile(keepMe, "utf8")) === "user copy" && (await readFile(nestedName, "utf8")) === "user nested" && (await readdir(backupDirectory)).length === 0 && afterUserFiles === 5);
		} finally {
			await rm(healTmp, { recursive: true, force: true });
		}
	}

	console.log("\n=== memory writes fail closed and create fresh files ===");
	{
		const failureTmp = await mkdtemp(path.join(os.tmpdir(), "pi-memory-write-"));
		try {
			// A MEMORY.md that cannot be read (a directory) must abort the pass, not overwrite it.
			await mkdir(path.join(failureTmp, ".agents/memory/MEMORY.md"), { recursive: true });
			const factory = await loadDefault(`${PC}/index.ts`);
			const pi = makePi({ cwd: failureTmp });
			await factory(pi);
			const ctx = makeCtx(failureTmp, {
				model: { provider: "test", id: "write-blocked", maxTokens: 32768 },
				sessionManager: makeSessionManager([messageEntry("m1", "user", "hello", "2026-09-12T10:00:00.000Z")], "write-blocked"),
			});
			ctx.modelRegistry.complete = async () => ({
				content: [{ type: "text", text: JSON.stringify({ memory_markdown: "# Project Memory\n\n## Project\n- must not land.", context: { title: "t", summary: "s", key_points: [], open_tasks: [] } }) }],
			});
			await pi.commands.get("memory-learn").handler("", ctx);
			const stillDirectory = await readdir(path.join(failureTmp, ".agents/memory/MEMORY.md")).then(() => true).catch(() => false);
			const failureLog = await readFile(path.join(failureTmp, ".agents/memory/errors.log"), "utf8").catch(() => "");
			check("an unreadable memory aborts the write end to end", stillDirectory && failureLog.includes("EISDIR"));
			await pi.commands.get("memory").handler("", ctx);
			check("the memory command reports an unreadable file", ctx.notifications.some(([message]) => message.includes("cannot be read")));

			// A fresh project has no file to back up; the first write creates it without a backup.
			const freshTmp = await mkdtemp(path.join(os.tmpdir(), "pi-memory-fresh-"));
			try {
				const freshFactory = await loadDefault(`${PC}/index.ts`);
				const freshPi = makePi({ cwd: freshTmp });
				await freshFactory(freshPi);
				const freshCtx = makeCtx(freshTmp, {
					model: { provider: "test", id: "write-fresh", maxTokens: 32768 },
					sessionManager: makeSessionManager([messageEntry("m1", "user", "hello", "2026-09-12T10:00:00.000Z")], "write-fresh"),
				});
				freshCtx.modelRegistry.complete = async () => ({
					content: [{ type: "text", text: JSON.stringify({ memory_markdown: "# Project Memory\n\n## Project\n- first memory.", context: { title: "t", summary: "s", key_points: [], open_tasks: [] } }) }],
				});
				await freshPi.commands.get("memory-learn").handler("", freshCtx);
				const created = await readFile(path.join(freshTmp, ".agents/memory/MEMORY.md"), "utf8").catch(() => "");
				const freshBackups = (await readdir(path.join(freshTmp, ".agents/memory"))).filter((name) => name.includes(".memory-backup-"));
				check("a first write creates the memory without a backup", created.includes("- first memory.") && freshBackups.length === 0);
			} finally {
				await rm(freshTmp, { recursive: true, force: true });
			}
		} finally {
			await rm(failureTmp, { recursive: true, force: true });
		}
	}

	console.log("\n=== the reply budget matches the existing memory ===");
	{
		const budgetTmp = await mkdtemp(path.join(os.tmpdir(), "pi-memory-budget-"));
		const budgetMemory = path.join(budgetTmp, ".agents/memory/MEMORY.md");
		const budgetContext = path.join(budgetTmp, ".agents/memory/CONTEXT.md");
		try {
			await mkdir(path.dirname(budgetMemory), { recursive: true });
			const middle = "MIDDLE-应当被裁掉的中间段";
			const big = "# Project Memory\n\n## Project\nHEAD-开头段\n" + "填充。".repeat(3000) + "\n" + middle + "\n" + "补充。".repeat(3000) + "\nTAIL-末端段\n";
			const contextMiddle = "CTX-MIDDLE-应当被裁掉的中间段";
			const bigContext = "# Project Context\n\n## Summary\nCTX-HEAD-开头段\n" + "上下文。".repeat(3000) + "\n" + contextMiddle + "\n" + "继续。".repeat(3000) + "\nCTX-TAIL-末端段\n";
			let call;
			const runPass = async (model, contextText, memoryText = big) => {
				await writeFile(budgetMemory, memoryText);
				await rm(budgetContext, { force: true });
				if (contextText) await writeFile(budgetContext, contextText);
				const { consolidateProjectState } = await loadNamespace(`${PC}/consolidate.ts`);
				const pi = makePi({ cwd: budgetTmp });
				const ctx = makeCtx(budgetTmp, {
					model,
					sessionManager: makeSessionManager([messageEntry("m1", "user", "hello", "2026-09-12T10:00:00.000Z")], `budget-${model.id}`),
				});
				ctx.modelRegistry.complete = async (_model, context, options) => {
					call = { maxTokens: options?.maxTokens, prompt: context.messages[0].content[0].text };
					return {
						content: [{
							type: "text",
							text: JSON.stringify({ memory_markdown: "# Project Memory\n\n## Project\n- trimmed.", context: { title: "t", summary: "s", key_points: [], open_tasks: [] } }),
						}],
					};
				};
				return consolidateProjectState(pi, ctx, { force: true });
			};

			const roomy = await runPass({ provider: "test", id: "cap-32k", maxTokens: 32768 });
			check("a large memory raises the output budget", call.maxTokens > 8192);
			check("a large memory is sent whole when the model allows it", roomy?.clipped === false && call.prompt.includes("HEAD-开头段") && call.prompt.includes(middle) && call.prompt.includes("TAIL-末端段"));

			const cramped = await runPass({ provider: "test", id: "cap-8k", maxTokens: 8192 });
			check("the model cap bounds the budget", call.maxTokens === 8192);
			check("a memory too large for the cap is clipped", cramped?.clipped === true && !call.prompt.includes(middle) && call.prompt.includes("HEAD-开头段") && call.prompt.includes("TAIL-末端段"));
			check("a clipped prompt tells the model to condense", call.prompt.includes("shortened to fit the output budget"));

			const both = await runPass({ provider: "test", id: "cap-8k-ctx", maxTokens: 8192 }, bigContext);
			check("a large context is budgeted too", both?.clipped === true && !call.prompt.includes(contextMiddle) && call.prompt.includes("CTX-HEAD-开头段") && call.prompt.includes("CTX-TAIL-末端段"));
			check("the context does not starve the memory", call.prompt.includes("HEAD-开头段") && call.prompt.includes("TAIL-末端段"));

			const sentLength = () => call.prompt.slice(call.prompt.indexOf("<existing-memory>"), call.prompt.indexOf("</existing-context>")).length;

			const tiny = await runPass({ provider: "test", id: "cap-tiny", maxTokens: 1400 }, bigContext);
			check("a tiny cap still sends memory content", tiny?.clipped === true && call.prompt.includes("HEAD-开头段"));
			check("a tiny cap bounds the artifacts sent", sentLength() > 0 && sentLength() <= 1400);
			check("a tiny cap does not starve the context", call.prompt.includes("CTX-HEAD-开头段"));

			const minimal = await runPass({ provider: "test", id: "cap-min", maxTokens: 1024 }, bigContext);
			check("the smallest cap still sends memory content", minimal?.clipped === true && call.prompt.includes("HEAD-开头段") && sentLength() > 0 && sentLength() <= 1024);
			check("the smallest cap does not starve the context", call.prompt.includes("CTX-HEAD-开头段"));

			const small = await runPass({ provider: "test", id: "cap-min-small", maxTokens: 1024 }, undefined, "# Project Memory\n\n## Project\nSMALL-记忆仍然保留\n");
			check("a small memory is sent whole at the smallest cap", small?.clipped === false && call.prompt.includes("SMALL-记忆仍然保留"));

			const smallContext = await runPass({ provider: "test", id: "cap-min-smallctx", maxTokens: 1024 }, bigContext, "# Project Memory\n\n## Project\nSMALL-记忆仍然保留\n");
			const sentContext = call.prompt.slice(call.prompt.indexOf("<existing-context>"), call.prompt.indexOf("</existing-context>")).length;
			check("a small memory returns its budget to the context", smallContext?.clipped === true && call.prompt.includes("SMALL-记忆仍然保留") && call.prompt.includes("CTX-HEAD-开头段") && sentContext > 300);

			// Mixed-language and uneven-density artifacts: each keeps its own rate, the split holds
			// the invariant, both stay alive, and the split does not waste the budget it was given.
			const { fitMemoryInput, replyTokenRate } = await loadNamespace(`${PC}/consolidate.ts`);
			const localRate = (text) => (text ? replyTokenRate(text) : 0);
			const budgetCases = [
				["small CJK memory × big ASCII context", "记".repeat(500), "a".repeat(16000) + "记".repeat(8000)],
				["big CJK memory × ASCII context", "记".repeat(7999) + "。", "a".repeat(32000)],
				["uneven head/tail density", "记".repeat(2000) + "x".repeat(50) + "记".repeat(2000), "y".repeat(28000) + "记".repeat(2000)],
				["ASCII memory × CJK context", "a".repeat(7999) + ".", "记".repeat(31999) + "。"],
				["ASCII body + CJK tail", "a".repeat(900), "b".repeat(1600) + "记".repeat(400)],
				["all-ASCII memory × dense CJK context", "a".repeat(5000), "记".repeat(12000) + "。".repeat(500)],
				["emoji-heavy memory × CJK context", "😀".repeat(400) + "a".repeat(200), "记".repeat(3000)],
				["quote-heavy memory × ASCII context", '"\\'.repeat(800) + "x".repeat(200), "y".repeat(6000)],
			];
			for (const cap of [1024, 1400, 2048, 8192, 32768]) {
				for (const [label, memoryText, contextText] of budgetCases) {
					const fitted = fitMemoryInput(memoryText, contextText, cap, { maxTokens: cap });
					const reserved = Math.min(1024, cap, Math.max(64, cap - 400));
					const tokens = fitted.text.length * localRate(fitted.text) + fitted.contextText.length * localRate(fitted.contextText);
					check(`budget invariant: ${label} @${cap} (${Math.round(tokens + reserved)}/${cap})`, tokens + reserved <= cap + 0.001);
					if (cap - reserved >= 800) {
						const wholeMemory = fitted.text.length === memoryText.length;
						const wholeContext = fitted.contextText.length === contextText.length;
						check(`artifact floor: ${label} @${cap} (${fitted.text.length}/${fitted.contextText.length})`, fitted.text.length >= Math.min(memoryText.length, 400) && fitted.contextText.length >= Math.min(contextText.length, 400));
						if (!(wholeMemory && wholeContext)) {
							const slack = Math.max(32, (cap - reserved) * 0.02);
							check(`budget is used, not wasted: ${label} @${cap} (${Math.round(tokens)}/${cap - reserved})`, tokens >= cap - reserved - slack);
						}
					}
				}
			}

			const near = await runPass({ provider: "test", id: "cap-near", maxTokens: 8192 }, undefined, "# Project Memory\n\n## Project\nNEAR-HEAD\n" + "接近。".repeat(3000) + "\nNEAR-MIDDLE\n" + "结尾。".repeat(1000) + "\nNEAR-TAIL\n");
			check("a near-budget memory keeps head and tail only", near?.clipped === true && call.prompt.includes("NEAR-HEAD") && call.prompt.includes("NEAR-TAIL") && !call.prompt.includes("NEAR-MIDDLE"));

			const { consolidateReply } = await loadNamespace(`${PC}/consolidate.ts`);
			check("a clipped reply is visible to explicit commands", consolidateReply("clipped").includes("output budget"));

			// The command path runs silently; it must still report the clip and leave a trace.
			const factory = await loadDefault(`${PC}/index.ts`);
			const pi = makePi({ cwd: budgetTmp });
			await factory(pi);
			await writeFile(budgetMemory, big);
			const ctx = makeCtx(budgetTmp, {
				model: { provider: "test", id: "cap-8k-command", maxTokens: 8192 },
				sessionManager: makeSessionManager([messageEntry("m1", "user", "hello", "2026-09-12T10:00:00.000Z")], "clip-command"),
			});
			ctx.hasUI = false; // headless: notifications are a no-op, the trace must still exist
			ctx.modelRegistry.complete = async (_model, context, options) => {
				call = { maxTokens: options?.maxTokens, prompt: context.messages[0].content[0].text };
				return {
					content: [{
						type: "text",
						text: JSON.stringify({ memory_markdown: "# Project Memory\n\n## Project\n- command trimmed.", context: { title: "t", summary: "s", key_points: [], open_tasks: [] } }),
					}],
				};
			};
			await pi.commands.get("memory-learn").handler("", ctx);
			const trace = await readFile(path.join(budgetTmp, ".agents/memory/errors.log"), "utf8").catch(() => "");
			check("a headless clip still leaves a trace", trace.includes("shortened"));
			const clipBackups = (await readdir(path.join(budgetTmp, ".agents/memory"))).filter((name) => name.includes(".memory-backup-"));
			check("a clipped rewrite keeps a backup", clipBackups.length === 1 && (await readFile(path.join(budgetTmp, ".agents/memory", clipBackups[0]), "utf8")) === big);
		} finally {
			await rm(budgetTmp, { recursive: true, force: true });
		}
	}

	console.log("\n=== residuals: recall, rate, lock, ignore, redaction ===");
	{
		const { loadMemory, backupMemoryBeforeWrite, logError, migrateProjectState, readJsonStringField, withMemoryLock } = await loadNamespace(`${PC}/project-state.ts`);
		const { fitMemoryInput, replyTokenRate, adaptiveOutputTokens, clipText } = await loadNamespace(`${PC}/consolidate.ts`);
		const fixTmp = await mkdtemp(path.join(os.tmpdir(), "pi-memory-residuals-"));
		try {
			const dir = path.join(fixTmp, ".agents/memory");
			await mkdir(dir, { recursive: true });
			const memory = path.join(dir, "MEMORY.md");
			const value = "# Project Memory\n\n## Project\n- " + "记".repeat(80);

			// context-first replies decode (the first key may be either reply field).
			await writeFile(memory, `{"context": {"title": "t"}, "memory_markdown": ${JSON.stringify(value)}}`);
			const contextFirst = await loadMemory(fixTmp);
			check("a context-first stored reply is decoded", contextFirst.poisoned === true && contextFirst.text.includes("记".repeat(80)));

			// A nested field with the same name is not the reply's field.
			await writeFile(memory, `{"context": {"note": ${JSON.stringify(`{"memory_markdown": ${JSON.stringify(value)}}`)}}, "memory_markdown": "short nested baseline"}`);
			check("a nested field is not mistaken for a stored reply", (await loadMemory(fixTmp)).poisoned === false);

			// A header-less but clearly document-shaped value decodes; a short one does not.
			await writeFile(memory, `{"memory_markdown": ${JSON.stringify("## Project\n- " + "x".repeat(200))}}`);
			check("a header-less document value is decoded", (await loadMemory(fixTmp)).poisoned === true);
			await writeFile(memory, `{"memory_markdown": "not a document"}`);
			check("a header-less short value is left alone", (await loadMemory(fixTmp)).poisoned === false);

			// Backslash escapes beyond n/t/r survive the field decoder.
			const escaped = readJsonStringField('{"memory_markdown": "a\\b\\f\\u0041"}', "memory_markdown");
			check("the field decoder maps \\b and \\f", escaped?.value === "a\b\fA" && escaped.end > 0);

			// Legacy .pi sources are decoded too.
			await rm(memory, { force: true });
			await mkdir(path.join(fixTmp, ".pi"), { recursive: true });
			await writeFile(path.join(fixTmp, ".pi/MEMORY.md"), `{"memory_markdown": ${JSON.stringify(value)}}`);
			const legacy = await loadMemory(fixTmp);
			check("a legacy .pi stored reply is decoded", legacy.poisoned === true && legacy.source.includes(".pi"));

			// An unreadable legacy source is reported too, not shown as "no memory".
			await rm(path.join(fixTmp, ".pi/MEMORY.md"), { force: true });
			await mkdir(path.join(fixTmp, ".pi/MEMORY.md"), { recursive: true });
			const legacyUnreadable = await loadMemory(fixTmp);
			check("an unreadable legacy source is flagged", legacyUnreadable.unreadable === true && legacyUnreadable.source.includes(".pi"));
			await rm(path.join(fixTmp, ".pi/MEMORY.md"), { recursive: true, force: true });

			// Token rate charges every non-ASCII code point and the escape cost.
			check("non-CJK scripts are charged a full token", replyTokenRate("привет") === 1);
			check("ASCII escapes cost extra", replyTokenRate('"\\\\') > replyTokenRate("ab"));
			const emoji = "😀";
			check("an emoji never costs less than one token", emoji.length * replyTokenRate(emoji) >= 1);

			// Clipping never splits a surrogate pair, at either boundary.
			const hasLoneSurrogate = (text) => {
				for (let index = 0; index < text.length; index += 1) {
					const code = text.charCodeAt(index);
					const high = code >= 0xd800 && code <= 0xdbff;
					const low = code >= 0xdc00 && code <= 0xdfff;
					if (high && !(text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff)) return true;
					if (low && !(text.charCodeAt(index - 1) >= 0xd800 && text.charCodeAt(index - 1) <= 0xdbff)) return true;
				}
				return false;
			};
			const surrogateHead = "x".repeat(10) + "😀" + "y".repeat(100);
			const surrogateTail = "y".repeat(100) + "😀" + "x".repeat(10);
			check("clipping keeps a pair whole at the head", !hasLoneSurrogate(clipText(surrogateHead, 20)));
			check("clipping keeps a pair whole at the tail", !hasLoneSurrogate(clipText(surrogateTail, 20)));
			let split = false;
			for (let limit = 4; limit <= 40; limit += 1) {
				if (hasLoneSurrogate(clipText(surrogateHead, limit)) || hasLoneSurrogate(clipText(surrogateTail, limit))) split = true;
			}
			check("no clip limit splits a surrogate pair", !split);
			let overLimit = false;
			for (const sample of [surrogateHead, surrogateTail, "😀".repeat(60), "a".repeat(50) + "😀😀" + "b".repeat(50)]) {
				for (let limit = 0; limit <= 70; limit += 1) {
					if (clipText(sample, limit).length > limit) overLimit = true;
				}
			}
			check("clipText never exceeds its limit", !overLimit);
			// A malformed orphan low surrogate just after a valid pair must not be promoted into it.
			const malformed = "a".repeat(30) + "😀" + "\uDC00" + "b".repeat(18);
			check("clipping drops a malformed orphan rather than splitting a pair", !clipText(malformed, 50).includes("\uDC00"));

			// The adaptive cap honours the configured ceiling and the model's own limit.
			check("the adaptive cap respects the ceiling", fitMemoryInput("记".repeat(20000), "", 8192, {}, 16384).maxTokens <= 16384);
			check("a model limit wins over the ceiling", fitMemoryInput("记".repeat(20000), "", 8192, { maxTokens: 4096 }, 16384).maxTokens <= 4096);
			check("a skill-sized need raises the cap", adaptiveOutputTokens(8192, 21000, {}, 32768) === 21000);

			// The write lock serializes writers, steals stale locks, and never leaks its file.
			let active = 0;
			let overlapped = false;
			const runLocked = () => withMemoryLock(memory, async () => {
				active += 1;
				if (active > 1) overlapped = true;
				await new Promise((resolve) => setTimeout(resolve, 30));
				active -= 1;
			});
			await Promise.all([runLocked(), runLocked(), runLocked()]);
			check("the write lock serializes writers", !overlapped && !(await readdir(dir)).includes("MEMORY.md.lock"));
			const stale = path.join(dir, "MEMORY.md.lock");
			await writeFile(stale, "stale");
			await utimes(stale, new Date(Date.now() - 2 * 60 * 60 * 1000), new Date(Date.now() - 2 * 60 * 60 * 1000));
			let stole = false;
			await withMemoryLock(memory, async () => {
				stole = true;
			});
			check("a stale lock is stolen and cleaned", stole && !(await readdir(dir)).includes("MEMORY.md.lock"));

			// A stolen lock belongs to the thief: the original holder's release must not delete it.
			let releaseOriginal;
			const originalHeld = new Promise((resolve) => {
				releaseOriginal = resolve;
			});
			let originalEntered;
			const originalEnteredPromise = new Promise((resolve) => {
				originalEntered = resolve;
			});
			const originalRun = withMemoryLock(memory, async () => {
				originalEntered();
				await originalHeld;
			});
			await originalEnteredPromise;
			const stolenPath = path.join(dir, "MEMORY.md.lock");
			await utimes(stolenPath, new Date(Date.now() - 2 * 60 * 60 * 1000), new Date(Date.now() - 2 * 60 * 60 * 1000));
			let thiefEntered = false;
			let releaseThief;
			const thiefHeld = new Promise((resolve) => {
				releaseThief = resolve;
			});
			const thiefRun = withMemoryLock(memory, async () => {
				thiefEntered = true;
				await thiefHeld;
			});
			for (let attempt = 0; attempt < 300 && !thiefEntered; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			releaseOriginal();
			await originalRun;
			let thirdEntered = false;
			const thirdRun = withMemoryLock(memory, async () => {
				thirdEntered = true;
			});
			await new Promise((resolve) => setTimeout(resolve, 100));
			const thirdBlocked = !thirdEntered;
			releaseThief();
			await thiefRun;
			await thirdRun;
			check("a stolen lock is not released by its original holder", thiefEntered && thirdBlocked && thirdEntered);

			// A stale lock plus concurrent writers never lets two critical sections overlap.
			const crashedLock = path.join(dir, "MEMORY.md.lock");
			await writeFile(crashedLock, "crashed\n");
			await utimes(crashedLock, new Date(Date.now() - 2 * 60 * 60 * 1000), new Date(Date.now() - 2 * 60 * 60 * 1000));
			let concurrent = 0;
			let contendedOverlap = false;
			const contended = [0, 1, 2].map(() => withMemoryLock(memory, async () => {
				concurrent += 1;
				if (concurrent > 1) contendedOverlap = true;
				await new Promise((resolve) => setTimeout(resolve, 20));
				concurrent -= 1;
			}));
			await Promise.all(contended);
			check("a stale lock is stolen exactly once under contention", !contendedOverlap && !(await readdir(dir)).includes("MEMORY.md.lock"));

			// A release that cannot take the claim must leave the lock for the claimed stealer.
			const heldLock = path.join(dir, "MEMORY.md.lock");
			const heldClaim = `${heldLock}.steal`;
			let releaseHolder;
			const holderHeld = new Promise((resolve) => {
				releaseHolder = resolve;
			});
			let holderEntered;
			const holderEnteredPromise = new Promise((resolve) => {
				holderEntered = resolve;
			});
			const holderRun = withMemoryLock(memory, async () => {
				holderEntered();
				await holderHeld;
			});
			await holderEnteredPromise;
			await writeFile(heldClaim, "foreign\n");
			releaseHolder();
			await holderRun;
			check("a release without the claim leaves the lock", (await readFile(heldLock, "utf8").catch(() => "")).includes(String(process.pid)));
			await rm(heldClaim, { force: true });
			await rm(heldLock, { force: true });

			// A held claim on a stale lock must fail the waiter at its deadline, not spin past it.
			await writeFile(heldLock, "stale\n");
			const agedByClaim = new Date(Date.now() - 2 * 60 * 60 * 1000);
			await utimes(heldLock, agedByClaim, agedByClaim);
			await writeFile(heldClaim, "fresh-claim\n");
			const waitStart = Date.now();
			let deadlineHit = false;
			try {
				await withMemoryLock(memory, async () => {});
			} catch {
				deadlineHit = true;
			}
			check("a held claim cannot bypass the lock deadline", deadlineHit && Date.now() - waitStart < 8000);
			await rm(heldClaim, { force: true });
			await rm(heldLock, { force: true });

			// The first lock in a new project also creates the local gitignore.
			const freshMemoryDir = path.join(fixTmp, "fresh", ".agents", "memory");
			await mkdir(freshMemoryDir, { recursive: true });
			await withMemoryLock(path.join(freshMemoryDir, "MEMORY.md"), async () => {});
			check("the first lock creates the local gitignore", (await readFile(path.join(freshMemoryDir, ".gitignore"), "utf8")).includes("*.lock"));

			// Cross-process writers serialize as well (three real child processes, one shared log).
			const lockLog = path.join(fixTmp, "lock-log.txt");
			const childScript = fileURLToPath(new URL("./helpers/lock-holder.mjs", import.meta.url));
			const children = [0, 1, 2].map(() => new Promise((resolve, reject) => {
				const child = spawn(process.execPath, [childScript, memory, lockLog, "60"], { stdio: "ignore", timeout: 15_000 });
				child.on("error", reject);
				child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`lock child exited ${code}`))));
			}));
			await Promise.all(children);
			const lockLines = (await readFile(lockLog, "utf8")).trim().split("\n");
			let lockDepth = 0;
			let nested = false;
			for (const line of lockLines) {
				if (line.startsWith("enter")) {
					lockDepth += 1;
					if (lockDepth > 1) nested = true;
				} else lockDepth -= 1;
			}
			const residue = (await readdir(dir)).filter((name) => name.startsWith("MEMORY.md.lock"));
			check("cross-process writers never overlap", !nested && lockDepth === 0 && lockLines.length === 6 && residue.length === 0);

			// A directory at the lock path heals instead of freezing every later write.
			const dirLockRoot = path.join(fixTmp, "locked", ".agents", "memory");
			await mkdir(path.join(dirLockRoot, "MEMORY.md.lock"), { recursive: true });
			let lockPathHealed = false;
			await withMemoryLock(path.join(dirLockRoot, "MEMORY.md"), async () => {
				lockPathHealed = true;
			});
			check("a directory at the lock path heals", lockPathHealed && !(await readdir(dirLockRoot)).includes("MEMORY.md.lock"));

			// Stale cleanup drops an empty broken artifact but keeps one that may hold user data.
			const cleanupRoot = path.join(fixTmp, "cleanup");
			const cleanupDir = path.join(cleanupRoot, ".agents", "memory");
			await mkdir(path.join(cleanupDir, "MEMORY.md.lock.broken-1234abcd"), { recursive: true });
			await mkdir(path.join(cleanupDir, "MEMORY.md.lock.broken-deadbeef"), { recursive: true });
			await writeFile(path.join(cleanupDir, "MEMORY.md.lock.broken-deadbeef", "user.txt"), "user data");
			await mkdir(path.join(cleanupDir, "MEMORY.md.lock.broken-feedface"), { recursive: true });
			const oldStamp = new Date(Date.now() - 2 * 60 * 60 * 1000);
			for (const name of ["MEMORY.md.lock.broken-1234abcd", "MEMORY.md.lock.broken-deadbeef"]) {
				await utimes(path.join(cleanupDir, name), oldStamp, oldStamp);
			}
			await migrateProjectState(cleanupRoot);
			const cleaned = await readdir(cleanupDir);
			check("stale cleanup drops only empty broken artifacts", !cleaned.includes("MEMORY.md.lock.broken-1234abcd") && cleaned.includes("MEMORY.md.lock.broken-deadbeef") && cleaned.includes("MEMORY.md.lock.broken-feedface"));

			// Local artifacts are ignored, once, next to the memory they belong to.
			await writeFile(memory, "# Project Memory\n\n## Project\n- keep.\n");
			await backupMemoryBeforeWrite(memory);
			const ignore = await readFile(path.join(dir, ".gitignore"), "utf8");
			check("backups are gitignored next to the memory", ignore.includes("*.memory-backup-*") && ignore.includes("errors.log"));
			await backupMemoryBeforeWrite(memory);
			check("the gitignore is appended only once", (await readFile(path.join(dir, ".gitignore"), "utf8")) === ignore);

			// Errors are redacted before they land in the log.
			await logError(fixTmp, "test", "api_key: sk-abcdef1234567890 and ghp_abcdefghijklmnop");
			const log = await readFile(path.join(dir, "errors.log"), "utf8");
			check("credentials are redacted from errors.log", !log.includes("sk-abcdef") && !log.includes("ghp_abcdef") && log.includes("[redacted"));

			// An unreadable memory file is reported, not reported as missing.
			await rm(memory, { force: true });
			await mkdir(memory, { recursive: true });
			const unreadable = await loadMemory(fixTmp);
			check("an unreadable memory is flagged", unreadable.unreadable === true && unreadable.text === "");
		} finally {
			await rm(fixTmp, { recursive: true, force: true });
		}
	}
} finally {
	await rm(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL OK" : `\nFAILURES: ${failures}`);
if (failures > 0) process.exitCode = 1;
