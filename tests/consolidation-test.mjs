import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
			check("the failed pass is logged to errors.log", errors.includes("consolidation reply was not a usable JSON object"));
		} finally {
			await rm(jsonTmp, { recursive: true, force: true });
		}
	}
} finally {
	await rm(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL OK" : `\nFAILURES: ${failures}`);
if (failures > 0) process.exitCode = 1;
