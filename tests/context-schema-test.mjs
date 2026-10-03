import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadDefault, loadNamespace, makeCtx, makePi, makeSessionManager, messageEntry, PC, rmTemp } from "./harness.mjs";

/**
 * The CONTEXT.md fixed schema (S2): the section table, the per-section budgets derived from
 * `MAX_CONTEXT_CHARS`, the prompt that states them, and the truncation marker that replaces the
 * old silent mid-line slice.
 */

const tmpDirs = [];
let failures = 0;
function check(label, value) {
	console.log(`${value ? "OK  " : "FAIL"} ${label}`);
	if (!value) failures += 1;
}

/** Test-local marker reader, independent of the production parser it validates. */
const MARKER_LINE = /_\[context truncated: (\d+) characters dropped\]_/;
function markerCount(text) {
	// Mirror the production tail policy: only the last non-empty line is the appended marker.
	const last = text.split("\n").map((line) => line.trim()).filter(Boolean).at(-1);
	const match = last ? MARKER_LINE.exec(last) : null;
	return match ? Number(match[1]) : undefined;
}

try {
	console.log("=== the context schema contract ===");
	const schema = await loadNamespace(`${PC}/memory/context-schema.ts`);
	const { CONTEXT_SECTIONS, contextSectionBudgets, contextSchemaOverheadChars, contextTruncationDropped, contextTruncationMarker, isContextTruncated } = schema;
	const { MAX_LIST_ITEM_CHARS } = await loadNamespace(`${PC}/shared/limits.ts`);
	const documented = [
		["Summary", "what this session is about and where it stands", "summary", 0.4],
		["Key points", "facts, decisions, and findings worth carrying forward", "key_points", 0.35],
		["Open tasks", "unfinished work and the agreed next steps", "open_tasks", 0.25],
	];
	check(
		"the section order, descriptions, entries and shares match the documented contract",
		CONTEXT_SECTIONS.every((section, index) => section.heading === documented[index][0] && section.description === documented[index][1] && section.entry === documented[index][2] && section.share === documented[index][3]),
	);
	check("the shares sum to 1", CONTEXT_SECTIONS.reduce((sum, section) => sum + section.share, 0) === 1);
	const cap = 32_000;
	const overhead = contextSchemaOverheadChars();
	check("the fixed overhead covers the header, timestamp line, headings, trailing comment and marker", overhead === 349);
	check("the truncation marker has the documented strict shape", contextTruncationMarker(12) === "_[context truncated: 12 characters dropped]_");
	check("the detector accepts the marker and rejects a near-miss", isContextTruncated(`# x\n${contextTruncationMarker(3)}\n`) && !isContextTruncated("_[context truncated: three characters dropped]_"));
	check(
		"the scanner tolerates padding, CRLF and trailing blank lines",
		contextTruncationDropped("x\n\n  _[context truncated: 5 characters dropped]_  \n") === 5 &&
			contextTruncationDropped("x\r\n_[context truncated: 7 characters dropped]_\r\n") === 7 &&
			contextTruncationDropped("# x\n_[context truncated: 9 characters dropped]_\n\n") === 9,
	);
	const budgets = contextSectionBudgets(cap);
	check(
		"the budgets are the documented shares of the cap after the fixed overhead",
		budgets[0].chars === 6_000 &&
			budgets[1].chars === Math.floor((cap - overhead) * 0.35) &&
			budgets[2].chars === Math.floor((cap - overhead) * 0.25),
	);
	check("the budgets keep the schema order and entries", budgets.every((section, index) => section.heading === documented[index][0] && section.entry === documented[index][2]));
	check(
		"the budgets plus the fixed overhead stay within the cap",
		overhead + budgets.reduce((sum, section) => sum + section.chars, 0) <= cap,
	);
	check("the smallest section budget exceeds the per-item cap, so one item always fits", Math.min(...budgets.map((section) => section.chars)) > MAX_LIST_ITEM_CHARS + 2);
	const scaled = contextSectionBudgets(8_001);
	check("the budget formula scales with the cap", scaled[1].chars === Math.floor((8_001 - overhead) * 0.35) && scaled[2].chars === Math.floor((8_001 - overhead) * 0.25));
	check("the summary keeps its long-standing per-section cap", budgets[0].chars === 6_000);

	console.log("\n=== the renderer lays out the fixed sections ===");
	const { renderContextDocument } = await loadNamespace(`${PC}/memory/context-doc.ts`);
	const small = renderContextDocument(
		{ title: "a session", summary: "small summary", key_points: ["point a"], open_tasks: ["task b"] },
		{ updatedAt: "2026-09-12T00:00:00.000Z" },
	);
	check(
		"the render carries the header, timestamp, three sections in order and the trailing comment",
		small.startsWith("# Project Context\n\nLast updated: 2026-09-12T00:00:00.000Z\n\n## Summary\n\nsmall summary\n\n## Key points\n\n- point a\n\n## Open tasks\n\n- task b\n\n<!-- latest-session-title: a session -->\n"),
	);
	check("a fitting context carries no truncation marker", !isContextTruncated(small) && small.length <= cap);
	// A marker-shaped line inside a section is not the appended marker.
	const phantom = renderContextDocument({ title: "t", summary: "_[context truncated: 5 characters dropped]_", key_points: [], open_tasks: [] }, { updatedAt: "2026-09-12T00:00:00.000Z" });
	check("a marker-shaped summary line is not mistaken for a real clip", !isContextTruncated(phantom) && contextTruncationDropped(phantom) === undefined);

	console.log("\n=== an over-budget section is clipped and marked ===");
	const longSummary = "s".repeat(9_000);
	const summaryOnly = renderContextDocument({ title: "big", summary: longSummary, key_points: [], open_tasks: [] }, { updatedAt: "2026-09-12T00:00:00.000Z" });
	check("the summary is clipped to its section budget", !summaryOnly.includes("s".repeat(6_001)) && summaryOnly.includes("s".repeat(6_000)));
	check("the marker reports the exact summary loss", summaryOnly.includes("_[context truncated: 3000 characters dropped]_"));

	const longItems = Array.from({ length: 50 }, (_, index) => `${String(index).padStart(2, "0")}-${"x".repeat(700)}`);
	const truncated = renderContextDocument(
		{ title: "big", summary: longSummary, key_points: longItems, open_tasks: longItems },
		{ updatedAt: "2026-09-12T00:00:00.000Z" },
	);
	check("the over-budget render is marked truncated", isContextTruncated(truncated));
	check("the marker reports a positive dropped count", /_\[context truncated: \d+ characters dropped\]_/.test(truncated));
	check("the truncated render still fits the document cap", truncated.length <= cap);
	check("the lists are clipped to their section budgets", !truncated.includes("49-") && truncated.includes("00-"));

	// A single item over the per-item cap: the trim itself must be reported, not silently dropped.
	const perItem = renderContextDocument({ title: "big", summary: "s", key_points: [`${"y".repeat(5_000)}`], open_tasks: [] }, { updatedAt: "2026-09-12T00:00:00.000Z" });
	check("an over-long item is trimmed", !perItem.includes("y".repeat(801)) && perItem.includes("y".repeat(800)));
	check("the marker counts the per-item trim", perItem.includes(`_[context truncated: ${5_000 - 800} characters dropped]_`));

	// The entry cap is a clip too, and its loss must be counted.
	const manyShort = Array.from({ length: 60 }, (_, index) => `key point ${index}`);
	const entryCapped = renderContextDocument({ title: "t", summary: "s", key_points: manyShort, open_tasks: [] }, { updatedAt: "2026-09-12T00:00:00.000Z" });
	const fullMany = manyShort.map((item) => `- ${item}`);
	const entryDrop = fullMany.join("\n").length - fullMany.slice(0, 50).join("\n").length;
	check(
		"the entry cap keeps 50 items and reports the exact drop",
		entryCapped.includes("key point 49") && !entryCapped.includes("key point 50") && entryCapped.includes(`_[context truncated: ${entryDrop} characters dropped]_`),
	);

	// Empty/whitespace items must render as no items, not a dangling bullet.
	const emptyItems = renderContextDocument({ title: "t", summary: "s", key_points: [""], open_tasks: ["   "] }, { updatedAt: "2026-09-12T00:00:00.000Z" });
	check("empty items render as None recorded", (emptyItems.match(/- None recorded/g) ?? []).length === 2 && !emptyItems.includes("\n\n- \n"));

	// A surrogate pair must not be split by the per-item trim or the title trim.
	const surrogate = renderContextDocument(
		{ title: `${"t".repeat(159)}😀x`, summary: "s", key_points: [`${"a".repeat(799)}😀${"b".repeat(100)}`], open_tasks: [] },
		{ updatedAt: "2026-09-12T00:00:00.000Z" },
	);
	check("a trimmed item or title does not leave a lone surrogate", !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(surrogate));

	// A title must collapse to one line so it cannot break the trailing comment.
	const messyTitle = renderContextDocument(
		{ title: "  a\n\nb  ", summary: "s", key_points: [], open_tasks: [] },
		{ updatedAt: "2026-09-12T00:00:00.000Z" },
	);
	check("a title with whitespace is normalized to one line", messyTitle.includes("<!-- latest-session-title: a b -->"));

	// Whitespace normalization is part of the render and must not be reported as a cap loss.
	const normalizedDoc = renderContextDocument({ title: "t", summary: "a\n\n\n\nb", key_points: ["  a  b  "], open_tasks: [] }, { updatedAt: "2026-09-12T00:00:00.000Z" });
	check("a summary and item are normalized to one line", normalizedDoc.includes("## Summary\n\na b\n") && normalizedDoc.includes("- a b"));
	check("normalization alone does not raise a truncation marker", !isContextTruncated(normalizedDoc));
	check("the detector rejects the singular marker shape", !isContextTruncated("_[context truncated: 5 character dropped]_"));

	// The fallback summary loss is reported too (it used to be pre-trimmed and hidden).
	const { fallbackUpdate } = await loadNamespace(`${PC}/memory/context-doc.ts`);
	const fallbackContent = "z".repeat(7_002);
	const fallbackDoc = renderContextDocument(
		fallbackUpdate({ sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: fallbackContent } }] } }),
		{ updatedAt: "2026-09-12T00:00:00.000Z" },
	);
	check("the fallback summary loss is reported", fallbackDoc.includes(`_[context truncated: ${JSON.stringify(fallbackContent).length - 6_000} characters dropped]_`));

	// Summary plus both lists clipped: the total must include every section (not just one list).
	const bothLists = renderContextDocument(
		{ title: "t", summary: longSummary, key_points: manyShort, open_tasks: [`${"y".repeat(5_000)}`] },
		{ updatedAt: "2026-09-12T00:00:00.000Z" },
	);
	check("the marker total sums every clipped section", bothLists.includes(`_[context truncated: ${3_000 + entryDrop + 4_200} characters dropped]_`));

	console.log("\n=== the prompt states the context sections and budgets ===");
	const { buildPrompt } = await loadNamespace(`${PC}/memory/prompt.ts`);
	const { fitMemoryInput } = await loadNamespace(`${PC}/memory/input.ts`);
	const fitted = fitMemoryInput("# Project Memory\n\n- a fact\n", "", 8_192, { maxTokens: 32_768 });
	const prompt = buildPrompt("/tmp/p", fitted, "conversation", { maxMemoryChars: cap, currentChars: 10 });
	check(
		"the prompt lists every context section with its description and budget",
		budgets.every((section) => prompt.includes(`## ${section.heading}: ${section.description} (about ${section.chars} characters)`)),
	);
	check(
		"the prompt fixes the context section order",
		documented.every(([heading], index) => index === 0 || prompt.indexOf(`## ${documented[index - 1][0]}:`) < prompt.indexOf(`## ${heading}:`)),
	);
	check("the prompt keeps the JSON key contract", prompt.includes("summary (string, required), title (string), key_points (array of strings), open_tasks (array of strings)"));

	console.log("\n=== the pass logs context truncation once per project ===");
	{
		const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-context-schema-"));
		tmpDirs.push(tmp);
		await mkdir(path.join(tmp, ".agents/memory"), { recursive: true });
		await writeFile(path.join(tmp, ".agents/memory/MEMORY.md"), "# Project Memory\n\n## Project\n- a fact.\n");
		await writeFile(
			path.join(tmp, ".agents/memory/project-context.json"),
			`${JSON.stringify({ autoConsolidate: true, autoLearn: false, handoffEnabled: false, forceDedupeMs: 0 })}\n`,
		);
		const pi = makePi({ cwd: tmp });
		await (await loadDefault(`${PC}/index.ts`))(pi);
		const ctx = makeCtx(tmp, { sessionManager: makeSessionManager([messageEntry("c1", "user", "hello", "2026-09-12T10:00:00.000Z")], "context-schema-session") });
		const reply = (summary) => ({
			content: [{ type: "text", text: JSON.stringify({ memory_markdown: "# Project Memory\n\n## Project\n- a fact.\n", context: { title: "big", summary, key_points: longItems, open_tasks: longItems } }) }],
		});
		ctx.modelRegistry.complete = async () => reply(longSummary);
		await pi.commands.get("memory").handler("update", ctx);
		const contextFile = path.join(tmp, ".agents/memory/CONTEXT.md");
		const written = await readFile(contextFile, "utf8");
		const errors = await readFile(path.join(tmp, ".agents/memory/errors.log"), "utf8").catch(() => "");
		const logged = errors.match(/CONTEXT\.md was clipped[^\n]*/g) ?? [];
		const firstCount = markerCount(written);
		check("the written CONTEXT.md is marked truncated and fits the cap", isContextTruncated(written) && written.length <= cap);
		check("the log carries the written marker's exact count", logged.length === 1 && firstCount !== undefined && logged[0].includes(`${firstCount} characters were dropped`));
		// A materially different clip makes the second line distinguishable, so this pins the once-per-project Set
		// rather than logError's own same-headline dedupe.
		ctx.modelRegistry.complete = async () => reply("s".repeat(15_000));
		await pi.commands.get("memory").handler("update", ctx);
		const writtenAgain = await readFile(contextFile, "utf8");
		const secondCount = markerCount(writtenAgain);
		const errorsAgain = await readFile(path.join(tmp, ".agents/memory/errors.log"), "utf8").catch(() => "");
		const loggedAgain = errorsAgain.match(/CONTEXT\.md was clipped[^\n]*/g) ?? [];
		check("the second pass clipped a different amount", secondCount !== undefined && secondCount !== firstCount);
		check("a second truncated pass does not log again", loggedAgain.length === 1 && loggedAgain[0] === logged[0]);
	}
} finally {
	for (const dir of tmpDirs) await rmTemp(dir);
}

console.log(failures === 0 ? "\nALL OK" : `\nFAILURES: ${failures}`);
if (failures > 0) process.exitCode = 1;
