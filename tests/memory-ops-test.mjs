import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadDefault, loadNamespace, makeCtx, makePi, PC } from "./harness.mjs";

/**
 * Memory operations: error-log noise folding (B4), head+tail fallback clipping (M3), cap
 * visibility and the `/project-context max-memory` verb (M4), and the output-ceiling
 * satisfiability check (M7).
 */

const tmpDirs = [];
let failures = 0;
function check(label, value) {
	console.log(`${value ? "OK  " : "FAIL"} ${label}`);
	if (!value) failures += 1;
}

/** A clock the tests advance on purpose; the extension reads the same `Date.now`. */
const realNow = Date.now;
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;

async function makeProject(extra = {}) {
	const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-memory-ops-"));
	tmpDirs.push(tmp);
	await mkdir(path.join(tmp, ".agents/memory"), { recursive: true });
	await writeFile(path.join(tmp, ".agents/memory/MEMORY.md"), "# Project Memory\n\n## Project\n- ops test.\n");
	await writeFile(path.join(tmp, ".agents/memory/project-context.json"), `${JSON.stringify(extra)}\n`);
	return tmp;
}

try {
	console.log("=== B4: identical errors collapse to one record plus a count ===");
	{
		const tmp = await makeProject();
		const { logError, ERROR_DEDUPE_WINDOW_MS } = await loadNamespace(`${PC}/shared/error-log.ts`);
		for (let i = 0; i < 5; i += 1) await logError(tmp, "memory", new Error("model call error: Connection error."));
		await logError(tmp, "memory", new Error("a different failure"));
		let log = await readFile(path.join(tmp, ".agents/memory/errors.log"), "utf8");
		check("five identical failures leave one record", (log.match(/Connection error\.\n/g) ?? []).length === 1);
		check("a different failure is still written", log.includes("a different failure"));
		// The suppressed run is only folded when the same key comes back (a new episode).
		clockOffset = ERROR_DEDUPE_WINDOW_MS + 1;
		await logError(tmp, "memory", new Error("model call error: Connection error."));
		clockOffset = 0;
		log = await readFile(path.join(tmp, ".agents/memory/errors.log"), "utf8");
		check("after the window the failure is recorded again", (log.match(/Connection error\.\n/g) ?? []).length === 2);
		check("the swallowed copies are counted once", /4 identical failure\(s\) suppressed/.test(log));
	}

	console.log("\n=== M3: fallback clipping keeps the head and the tail ===");
	{
		const doc = await loadNamespace(`${PC}/memory/document.ts`);
		const prefix = "# Project Memory\n\n## Project\n- head fact that must survive.\n";
		const middle = `## Big\n${Array.from({ length: 300 }, (_, i) => `- big ${i} ${"x".repeat(80)}`).join("\n")}\n`;
		const tail = "## Lessons\n- the durable tail lesson.\n";
		const clipped = doc.normalizeMemoryDocument(prefix + middle + tail, 4_000);
		check("the opening facts survive", clipped.includes("- head fact that must survive."));
		check("the closing lessons survive", clipped.includes("- the durable tail lesson."));
		check("the middle is what was dropped", !clipped.includes("- big 150 "));
		check("the drop is still marked", /_\[memory truncated at 4000 characters: \d+ dropped\]_/.test(clipped));
		check("clipping stays idempotent", doc.normalizeMemoryDocument(clipped, 4_000) === clipped);
		check(
			"the body stays within the cap",
			clipped.split("\n").filter((line) => !line.startsWith("_[memory truncated")).join("\n").trimEnd().length <= 4_000,
		);
		check("a document that fits is untouched", doc.normalizeMemoryDocument(prefix, 4_000) === prefix);
		// A single over-long line used to be non-idempotent: the heading separator was consumed by the cut.
		const longLine = `# Project Memory\n\n${"x".repeat(10_000)}`;
		const once = doc.normalizeMemoryDocument(longLine, 4_000);
		check("an over-long single line clips idempotently", doc.normalizeMemoryDocument(once, 4_000) === once);
		const emoji = `# Project Memory\n\n- ${"😀".repeat(4_000)}`;
		const clippedEmoji = doc.normalizeMemoryDocument(emoji, 4_000);
		const emojiBody = clippedEmoji.split("\n").filter((line) => !line.startsWith("_[memory truncated")).join("\n");
		check("clipping never splits a surrogate pair", Buffer.from(emojiBody, "utf8").toString("utf8") === emojiBody);
	}

	console.log("\n=== M7: a cap the output ceiling cannot hold is flagged ===");
	{
		const budget = await loadNamespace(`${PC}/shared/output-budget.ts`);
		check("32000 chars cannot be re-emitted in the default ceiling", budget.memoryCapUnsatisfiable(32_000, 8_192, 32_768) === true);
		check("a smaller cap fits the same ceiling", budget.memoryCapUnsatisfiable(20_000, 8_192, 32_768) === false);
		check("a larger request cap lifts the ceiling", budget.memoryCapUnsatisfiable(40_000, 42_000, 32_768) === false);
		check("the needed tokens include the JSON margin", budget.memoryReplyTokens(32_000) === 32_000 + budget.REPLY_OUTPUT_MARGIN_TOKENS);
	}

	console.log("\n=== M4: status reports the cap and the verb changes it ===");
	{
		const tmp = await makeProject();
		const pi = makePi({ cwd: tmp });
		await (await loadDefault(`${PC}/index.ts`))(pi);
		const ctx = makeCtx(tmp);
		const status = async () => {
			await pi.commands.get("project-context").handler("status", ctx);
			return String(ctx.notifications.at(-1)?.[0] ?? "");
		};
		const memoryCmd = async () => {
			await pi.commands.get("memory").handler("", ctx);
			return String(ctx.notifications.at(-1)?.[0] ?? "");
		};
		check("status shows the percentage of the cap", /Memory: .*\(\d+ chars, \d+% of the 32000-char cap\)/.test(await status()));
		check("status warns when the default cap is unsatisfiable", (await status()).includes("Memory cap warning"));
		check("the memory command shows the percentage too", /\d+% of the 32000-char cap/.test(await memoryCmd()));

		await pi.commands.get("project-context").handler("max-memory 20000", ctx);
		check("a fitting cap is accepted", (await readFile(path.join(tmp, ".agents/memory/project-context.json"), "utf8")).includes("20000"));
		check("the accepted cap is reported", String(ctx.notifications.at(-1)?.[0] ?? "").includes("Memory cap: 20000 characters."));
		check("status now uses the new cap", (await status()).includes("of the 20000-char cap"));
		check("a fitting cap raises no warning", !(await status()).includes("Memory cap warning"));

		await pi.commands.get("project-context").handler("max-memory 32000", ctx);
		check("an unsatisfiable cap is warned about on set", String(ctx.notifications.at(-1)?.[0] ?? "").includes("output ceiling of 32768"));
		check("the unsatisfiable cap is still persisted", (await readFile(path.join(tmp, ".agents/memory/project-context.json"), "utf8")).includes("32000"));

		await pi.commands.get("project-context").handler("max-memory 10", ctx);
		check("a below-floor cap is refused", String(ctx.notifications.at(-1)?.[0] ?? "").includes("Usage: /project-context max-memory"));
		check("the refused value is not written", (await readFile(path.join(tmp, ".agents/memory/project-context.json"), "utf8")).includes("32000"));

		await pi.commands.get("project-context").handler("max-memory default", ctx);
		check("default restores the built-in cap", (await readFile(path.join(tmp, ".agents/memory/project-context.json"), "utf8")).includes("32000"));
	}
} finally {
	for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
	Date.now = realNow;
}

console.log(failures === 0 ? "\nALL OK" : `\nFAILURES: ${failures}`);
if (failures > 0) process.exitCode = 1;
