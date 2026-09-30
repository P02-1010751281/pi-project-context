import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadDefault, loadNamespace, makeCtx, makePi, makeSessionManager, messageEntry, PC } from "./harness.mjs";

/**
 * The memory character budget: the reply is told the real cap (M1), an overflowing reply gets one
 * bounded condensation attempt instead of a silent tail drop (M2), and a marker copied from the
 * stored render no longer makes a short reply look capped (M6).
 */

const tmpDirs = [];
let failures = 0;
function check(label, value) {
	console.log(`${value ? "OK  " : "FAIL"} ${label}`);
	if (!value) failures += 1;
}

try {
	console.log("=== exceedsMemoryCap and the truncation marker ===");
	const doc = await loadNamespace(`${PC}/memory/document.ts`);
	const cap = 4_000;
	const small = "# Project Memory\n\n## Project\n- A short fact.\n";
	const big = `# Project Memory\n\n${Array.from({ length: 60 }, (_, i) => `- fact ${i} ${"x".repeat(100)}`).join("\n")}\n`;
	const copiedMarker = `${small}\n_[memory truncated at ${cap} characters: 1234 dropped]_\n`;
	check("a fitting document does not exceed the cap", doc.exceedsMemoryCap(small, cap) === false);
	check("an over-cap document exceeds the cap", doc.exceedsMemoryCap(big, cap) === true);
	check("a copied marker on a short document does not count as overflow", doc.exceedsMemoryCap(copiedMarker, cap) === false);
	const clipped = doc.normalizeMemoryDocument(big, cap);
	check("the fitting document is stored verbatim", doc.normalizeMemoryDocument(small, cap) === small);
	check("an over-cap document is clipped with a positive dropped count", doc.isMemoryTruncated(clipped) && /_\[memory truncated at 4000 characters: \d+ dropped\]_/.test(clipped));
	check("normalizing a capped document is idempotent", doc.normalizeMemoryDocument(clipped, cap) === clipped);

	console.log("\n=== the prompt names the real character budget ===");
	const { buildPrompt } = await loadNamespace(`${PC}/memory/prompt.ts`);
	const { fitMemoryInput } = await loadNamespace(`${PC}/memory/input.ts`);
	const fitted = fitMemoryInput(small, "", 8192, { maxTokens: 32768 });
	const budgeted = buildPrompt("/tmp/p", fitted, "conversation", { maxMemoryChars: 4_000, currentChars: 1_234 });
	check("the prompt states the cap and the current size", budgeted.includes("under 4000 characters") && budgeted.includes("currently about 1234"));
	check("the prompt calls it a hard cap", budgeted.includes("hard cap"));
	check("the prompt forbids writing truncation markers", budgeted.includes("Never write omission or truncation markers"));
	const unbudgeted = buildPrompt("/tmp/p", fitted, "conversation");
	check("without a budget the prompt keeps the concise wording", unbudgeted.includes("Keep memory concise") && !unbudgeted.includes("hard cap"));

	console.log("\n=== M2: an overflowing reply is condensed once, not silently truncated ===");
	{
		const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-memory-budget-"));
		tmpDirs.push(tmp);
		await mkdir(path.join(tmp, ".agents/memory"), { recursive: true });
		await writeFile(path.join(tmp, ".agents/memory/MEMORY.md"), small);
		await writeFile(path.join(tmp, ".agents/memory/project-context.json"), `${JSON.stringify({ maxMemoryChars: cap, autoConsolidate: true, autoLearn: false, handoffEnabled: false })}\n`);
		const pi = makePi({ cwd: tmp });
		await (await loadDefault(`${PC}/index.ts`))(pi);
		const ctx = makeCtx(tmp, { sessionManager: makeSessionManager([messageEntry("m1", "user", "hello", "2026-09-12T10:00:00.000Z")], "budget-session") });
		const prompts = [];
		ctx.modelRegistry.complete = async (_model, context) => {
			const prompt = context.messages[0].content[0].text;
			prompts.push(prompt);
			const context1 = { title: "t", summary: "s", key_points: [], open_tasks: [] };
			const memory = prompt.includes(`${cap}-character cap`) ? small : big;
			return { content: [{ type: "text", text: JSON.stringify({ memory_markdown: memory, context: context1 }) }] };
		};
		await pi.commands.get("memory-learn").handler("", ctx);
		const written = await readFile(path.join(tmp, ".agents/memory/MEMORY.md"), "utf8");
		check("the first reply overflowed and the condensation ran", prompts.length === 2 && prompts[1].includes(`exceeded the ${cap}-character cap`));
		check("the condensed reply is written, not the truncated original", written.includes("- A short fact.") && !doc.isMemoryTruncated(written));
		check("the prompt carried the real cap on both calls", prompts.every((p) => p.includes(`under ${cap} characters`)));
	}

	console.log("\n=== M6: a copied marker does not raise a false cap warning ===");
	{
		const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-memory-marker-"));
		tmpDirs.push(tmp);
		await mkdir(path.join(tmp, ".agents/memory"), { recursive: true });
		await writeFile(path.join(tmp, ".agents/memory/MEMORY.md"), small);
		await writeFile(path.join(tmp, ".agents/memory/project-context.json"), `${JSON.stringify({ maxMemoryChars: cap, autoConsolidate: true, autoLearn: false, handoffEnabled: false })}\n`);
		const pi = makePi({ cwd: tmp });
		await (await loadDefault(`${PC}/index.ts`))(pi);
		const ctx = makeCtx(tmp, { sessionManager: makeSessionManager([messageEntry("m1", "user", "hello", "2026-09-12T10:00:00.000Z")], "marker-session") });
		ctx.modelRegistry.complete = async () => ({
			content: [{
				type: "text",
				text: JSON.stringify({ memory_markdown: copiedMarker, context: { title: "t", summary: "s", key_points: [], open_tasks: [] } }),
			}],
		});
		await pi.commands.get("memory-learn").handler("", ctx);
		const errors = await readFile(path.join(tmp, ".agents/memory/errors.log"), "utf8").catch(() => "");
		check("no cap warning is logged for a copied marker", !errors.includes("exceeded maxMemoryChars"));
	}
} finally {
	for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL OK" : `\nFAILURES: ${failures}`);
if (failures > 0) process.exitCode = 1;
