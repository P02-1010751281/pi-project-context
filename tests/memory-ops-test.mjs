import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadDefault, loadNamespace, makeCtx, makePi, makeSessionManager, messageEntry, PC, rmTemp, runHandlers, waitUntil } from "./harness.mjs";

/**
 * Memory operations: error-log noise folding (B4), head+tail fallback clipping (M3), cap
 * visibility and the `/memory max-memory` verb (M4), and the output-ceiling
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
	const cap = 4_000;
	const bigMemory = `# Project Memory\n\n${Array.from({ length: 60 }, (_, i) => `- fact ${i} ${"x".repeat(100)}`).join("\n")}\n`;
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
		// A marker-shaped line glued mid-line must not resurrect once the clip re-breaks it onto a line start.
		const glued = `x_[memory truncated 是遗留]_## S\n😀_[memory truncated at 4000 characters: 10 dropped]_`;
		const gluedOnce = doc.normalizeMemoryDocument(glued, 100);
		check("a glued marker does not break idempotence", doc.normalizeMemoryDocument(gluedOnce, 100) === gluedOnce);
		// A non-canonical heading must not be split into a bare word (it stays as body content).
		const notes = doc.normalizeMemoryDocument("# Project Memory Notes\n\n- x\n", 4_000);
		check("a non-canonical heading is not split", notes.includes("# Project Memory Notes") && !notes.includes("\n\nNotes"));
	}

	console.log("\n=== M7: a cap the output ceiling cannot hold is flagged ===");
	{
		const budget = await loadNamespace(`${PC}/shared/output-budget.ts`);
		check("32000 chars cannot be re-emitted in the default ceiling", budget.memoryCapUnsatisfiable(32_000, 8_192, 32_768) === true);
		check("a smaller cap fits the same ceiling", budget.memoryCapUnsatisfiable(20_000, 8_192, 32_768) === false);
		check("a larger request cap lifts the ceiling", budget.memoryCapUnsatisfiable(40_000, 42_000, 32_768) === false);
		check("the needed tokens include the JSON margin", budget.memoryReplyTokens(32_000) === 32_000 + budget.REPLY_OUTPUT_MARGIN_TOKENS);
		// The field case (Quantum_Matrix, 2026-10-08) spent 20489 hidden-reasoning tokens against a reserve
		// capped at 8192: a cap that fits the visible reply alone is still unsatisfiable on such a route.
		check("a reasoning route is charged for its hidden thinking", budget.memoryCapUnsatisfiable(28_000, 8_192, 32_768, true) === true);
		check("the same cap fits when the route does not reason", budget.memoryCapUnsatisfiable(28_000, 8_192, 32_768, false) === false);
		check("the warning omits the reserve on a plain route", !budget.capCeilingWarning({ maxMemoryChars: 28_000, maxTokens: 8_192, maxOutputTokens: 32_768 }).includes("hidden reasoning"));
		check("the warning names the reserve on a reasoning route", budget.capCeilingWarning({ maxMemoryChars: 28_000, maxTokens: 8_192, maxOutputTokens: 32_768 }, true).includes("hidden reasoning"));
		// Round 15's N-4: the reserve is a first-attempt estimate (the field case spent 20489 against 8192),
		// so the user-visible sentence must not present it as a bound.
		check("the warning calls the reserve an estimate, not a bound", (() => {
			const sentence = budget.capCeilingWarning({ maxMemoryChars: 28_000, maxTokens: 8_192, maxOutputTokens: 32_768 }, true);
			return sentence.includes("reserve of about") && !sentence.includes("up to");
		})());
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

		await pi.commands.get("memory").handler("max-memory 20000", ctx);
		check("a fitting cap is accepted", (await readFile(path.join(tmp, ".agents/memory/project-context.json"), "utf8")).includes("20000"));
		check("the accepted cap is reported", String(ctx.notifications.at(-1)?.[0] ?? "").includes("Memory: cap 20000 characters."));
		check("status now uses the new cap", (await status()).includes("of the 20000-char cap"));
		check("a fitting cap raises no warning", !(await status()).includes("Memory cap warning"));

		await pi.commands.get("memory").handler("max-memory 32000", ctx);
		check("an unsatisfiable cap is warned about on set", String(ctx.notifications.at(-1)?.[0] ?? "").includes("output ceiling of 32768"));
		check("the unsatisfiable cap is still persisted", (await readFile(path.join(tmp, ".agents/memory/project-context.json"), "utf8")).includes("32000"));

		await pi.commands.get("memory").handler("max-memory 10", ctx);
		check("a below-floor cap is refused", String(ctx.notifications.at(-1)?.[0] ?? "").includes("Usage: /memory max-memory"));
		check("the refused value is not written", (await readFile(path.join(tmp, ".agents/memory/project-context.json"), "utf8")).includes("32000"));

		await pi.commands.get("memory").handler("max-memory default", ctx);
		check("default restores the built-in cap", (await readFile(path.join(tmp, ".agents/memory/project-context.json"), "utf8")).includes("32000"));
	}

	console.log("\n=== M4b: the cap warning follows the route the auxiliary call will use (round 15, I-A) ===");
	{
		// The field case is a reasoning route; a configured aux override decides that, not the session model.
		// Both call sites must read the resolved route: the umbrella status (index.ts) and the set-time reply.
		const tmp = await makeProject();
		const pi = makePi({ cwd: tmp });
		await (await loadDefault(`${PC}/index.ts`))(pi);
		const plain = { provider: "test", id: "plain", reasoning: false };
		const thinker = { provider: "aux", id: "thinker", reasoning: true };
		const ctx = makeCtx(tmp, { model: plain });
		ctx.modelRegistry.find = (provider, id) => (provider === "aux" && id === "thinker" ? thinker : undefined);
		const status = async () => {
			await pi.commands.get("project-context").handler("status", ctx);
			return String(ctx.notifications.at(-1)?.[0] ?? "");
		};
		await pi.commands.get("project-context").handler("model aux/thinker", ctx);
		check("status charges a configured reasoning aux route", (await status()).includes("hidden reasoning"));
		await pi.commands.get("memory").handler("max-memory 28000", ctx);
		check("the set-time warning charges the same route", String(ctx.notifications.at(-1)?.[0] ?? "").includes("hidden reasoning"));
		await pi.commands.get("project-context").handler("model off", ctx);
		// Positive control: the same cap on a plain session model must stay quiet, so the check above is
		// not merely reading a route-independent warning.
		check("the same cap is quiet once the aux route is cleared", !(await status()).includes("Memory cap warning"));
		await pi.commands.get("memory").handler("max-memory 28000", ctx);
		check("the set-time reply is quiet on a plain route too", !String(ctx.notifications.at(-1)?.[0] ?? "").includes("hidden reasoning"));
		await rmTemp(tmp);
	}

	console.log("\n=== M4: the automatic cap toast names the cap (not a scope error) ===");
	{
		const tmp = await makeProject({ memoryEnabled: true, autolearnEnabled: false, handoffEnabled: false, maxMemoryChars: cap, consolidateTurns: 1, consolidateIntervalMs: 1000, forceDedupeMs: 0 });
		const pi = makePi({ cwd: tmp });
		await (await loadDefault(`${PC}/index.ts`))(pi);
		const ctx = makeCtx(tmp, { sessionManager: makeSessionManager([messageEntry("m1", "user", "hello", "2026-09-12T10:00:00.000Z")], "cap-toast-session") });
		ctx.modelRegistry.complete = async () => ({
			content: [{ type: "text", text: JSON.stringify({ memory_markdown: bigMemory, context: { title: "t", summary: "s", key_points: [], open_tasks: [] } }) }],
		});
		await runHandlers(pi, "agent_settled", ctx);
		await waitUntil(() => ctx.notifications.some(([message]) => String(message).includes("-character cap")), 5_000);
		const capToast = ctx.notifications.map(([message]) => String(message)).find((message) => message.includes("-character cap")) ?? "";
		check("the automatic cap toast names the cap", capToast.includes(`${cap}-character cap`));
		check("the automatic cap toast is not a scoping failure", !capToast.includes("not defined"));
	}

	console.log("\n=== marker provenance: an import keeps it, a fresh reply drops it ===");
	{
		const store = await loadNamespace(`${PC}/shared/project-state.ts`);
		const doc = await loadNamespace(`${PC}/memory/document.ts`);
		const tmp = await makeProject();
		const clipped = doc.normalizeMemoryDocument(bigMemory, cap);
		await store.recordMemoryDocument(tmp, clipped, cap, { preserveMarker: true });
		const imported = await store.loadMemory(tmp, cap);
		check("an import keeps a genuine truncation marker", doc.isMemoryTruncated(imported.text));
		await store.recordMemoryDocument(tmp, clipped, cap);
		const fresh = await store.loadMemory(tmp, cap);
		check("a fresh reply drops a carried marker", !doc.isMemoryTruncated(fresh.text));
	}

	console.log("\n=== M4: an empty memory reports empty, not the heading size ===");
	{
		const tmp = await makeProject();
		await writeFile(path.join(tmp, ".agents/memory/MEMORY.md"), "");
		const pi = makePi({ cwd: tmp });
		await (await loadDefault(`${PC}/index.ts`))(pi);
		const ctx = makeCtx(tmp);
		await pi.commands.get("project-context").handler("status", ctx);
		check("an empty memory reports empty", String(ctx.notifications.at(-1)?.[0] ?? "").includes("(empty)"));
	}

	console.log("\n=== M4: /memory and /project-context status share one memory-status wording ===");
	{
		// The two entry points used to render the status separately and had drifted; this pins the
		// shared body for every branch, including the journal-unreadable case the umbrella lacked.
		const both = async (tmp) => {
			const pi = makePi({ cwd: tmp });
			await (await loadDefault(`${PC}/index.ts`))(pi);
			const ctx = makeCtx(tmp);
			await pi.commands.get("memory").handler("", ctx);
			const notified = ctx.notifications.at(-1) ?? [];
			await pi.commands.get("project-context").handler("status", ctx);
			const status = String(ctx.notifications.at(-1)?.[0] ?? "");
			const line = status.split("\n").find((entry) => entry.startsWith("Memory: ")) ?? "";
			// `/memory` prints the CONTEXT.md line in the same notification, after the status line; the
			// equality pin is over line one only, so a one-sided body change still turns it red.
			return { fromCommand: String(notified[0] ?? "").split("\n")[0], level: notified[1], statusBody: line.slice("Memory: ".length) };
		};
		const cases = [];
		cases.push(["normal", await makeProject(), /of the 32000-char cap/, "info"]);
		{
			const tmp = await makeProject();
			await writeFile(path.join(tmp, ".agents/memory/MEMORY.md"), "");
			cases.push(["empty", tmp, /\(empty\)/, "info"]);
		}
		{
			const tmp = await makeProject();
			await writeFile(path.join(tmp, ".agents/memory/MEMORY.md"), "# Project Memory\n\n## Project\n- fact.\n_[memory truncated at 4000 characters: 12 dropped]_\n");
			cases.push(["at the cap", tmp, /both ends were kept and the middle dropped/, "warning"]);
		}
		{
			const tmp = await makeProject();
			await writeFile(path.join(tmp, ".agents/memory/MEMORY.md"), '# Project Memory\n\n{\n  "memory_markdown": "# Project Memory\\n\\n## Project\\n- decoded fact.\\n"\n}\n');
			cases.push(["poisoned", tmp, /stored as raw JSON/, "warning"]);
		}
		{
			const tmp = await makeProject();
			await rm(path.join(tmp, ".agents/memory/MEMORY.md"));
			await writeFile(path.join(tmp, ".agents/memory/memory.jsonl"), "not a journal record\n");
			cases.push(["journal unreadable", tmp, /no usable record/, "warning"]);
		}
		{
			const tmp = await makeProject();
			await rm(path.join(tmp, ".agents/memory/MEMORY.md"));
			await mkdir(path.join(tmp, ".agents/memory/MEMORY.md"));
			cases.push(["file unreadable", tmp, /cannot be read/, "warning"]);
		}
		for (const [label, tmp, expected, level] of cases) {
			const { fromCommand, statusBody, level: notified } = await both(tmp);
			check(`${label}: both entry points print the same body`, fromCommand === `Memory: ${statusBody}`);
			check(`${label}: the shared body reports it`, expected.test(statusBody));
			check(`${label}: /memory warns with level ${level}`, notified === level);
		}
	}

	console.log("\n=== M4: the cap suggestion is a value the command accepts ===");
	{
		const tmp = await makeProject({ memoryEnabled: true, autolearnEnabled: false, handoffEnabled: false, maxMemoryChars: cap, consolidateTurns: 1, consolidateIntervalMs: 1000, forceDedupeMs: 0 });
		const pi = makePi({ cwd: tmp });
		await (await loadDefault(`${PC}/index.ts`))(pi);
		const ctx = makeCtx(tmp, { sessionManager: makeSessionManager([messageEntry("m1", "user", "hello", "2026-09-12T10:00:00.000Z")], "cap-suggest-session") });
		// Heading-less body under the raw length but over the cap once the heading is counted.
		const body = `- ${"x".repeat(3_988)}`;
		ctx.modelRegistry.complete = async () => ({ content: [{ type: "text", text: JSON.stringify({ memory_markdown: body, context: { title: "t", summary: "s", key_points: [], open_tasks: [] } }) }] });
		await runHandlers(pi, "agent_settled", ctx);
		await waitUntil(() => ctx.notifications.some(([message]) => String(message).includes("max-memory")), 5_000);
		const toast = ctx.notifications.map(([message]) => String(message)).find((message) => message.includes("max-memory")) ?? "";
		const { MAX_MEMORY_CHARS_LIMIT } = await loadNamespace(`${PC}/shared/limits.ts`);
		const suggested = Number((toast.match(/max-memory (\d+)/) ?? [])[1]);
		check("the suggested cap is within the accepted range", Number.isFinite(suggested) && suggested >= cap && suggested <= MAX_MEMORY_CHARS_LIMIT);
	}

	console.log("\n=== migration keeps a capped legacy memory's marker ===");
	{
		const doc = await loadNamespace(`${PC}/memory/document.ts`);
		const store = await loadNamespace(`${PC}/shared/project-state.ts`);
		const { migrateProjectState } = await loadNamespace(`${PC}/shared/migrate.ts`);
		const tmp = await makeProject();
		await rm(path.join(tmp, ".agents/memory/MEMORY.md"));
		const savedHome = process.env.HOME;
		process.env.HOME = tmp;
		try {
			const legacy = path.join(tmp, ".omp", "agent", "memories", `--${tmp.replaceAll(path.sep, "-")}--`);
			await mkdir(legacy, { recursive: true });
			await writeFile(path.join(legacy, "MEMORY.md"), doc.normalizeMemoryDocument(bigMemory, cap));
			await migrateProjectState(tmp, cap);
			const loaded = await store.loadMemory(tmp, cap);
			check("a migrated capped memory keeps its marker", doc.isMemoryTruncated(loaded.text));
		} finally {
			process.env.HOME = savedHome;
		}
	}
} finally {
	for (const dir of tmpDirs) await rmTemp(dir);
	Date.now = realNow;
}

console.log(failures === 0 ? "\nALL OK" : `\nFAILURES: ${failures}`);
if (failures > 0) process.exitCode = 1;
