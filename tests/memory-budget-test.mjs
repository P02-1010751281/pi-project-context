import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadDefault, loadNamespace, makeCtx, makePi, makeSessionManager, messageEntry, PC, rmTemp } from "./harness.mjs";

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
	check("the measured size excludes a carried marker", doc.memoryDocumentChars(copiedMarker) === doc.memoryDocumentChars(small));
	check("an empty document measures zero, not the heading", doc.memoryDocumentChars("") === 0);
	const clipped = doc.normalizeMemoryDocument(big, cap);
	check("the fitting document is stored verbatim", doc.normalizeMemoryDocument(small, cap) === small);
	check("an over-cap document is clipped with a positive dropped count", doc.isMemoryTruncated(clipped) && /_\[memory truncated at 4000 characters: \d+ dropped\]_/.test(clipped));
	check("normalizing a capped document is idempotent", doc.normalizeMemoryDocument(clipped, cap) === clipped);

	console.log("\n=== the prompt names the real character budget ===");
	const { buildPrompt } = await loadNamespace(`${PC}/memory/prompt.ts`);
	const { fitMemoryInput } = await loadNamespace(`${PC}/memory/input.ts`);
	const fitted = fitMemoryInput(small, "", 8192, { maxTokens: 32768 });
	const budgeted = buildPrompt("/tmp/p", fitted, "conversation", { maxMemoryChars: 4_000, currentChars: 1_234 });
	check("the prompt states the cap and the current size", budgeted.includes("at or under 4000 characters") && budgeted.includes("currently about 1234"));
	check("the prompt calls it a hard cap", budgeted.includes("hard cap"));
	check("the prompt forbids writing truncation markers and names both shapes", budgeted.includes("Never write omission or truncation markers") && budgeted.includes("_[context truncated: … characters dropped]_"));
	console.log("\n=== the prompt draws the cross-project boundary where the conversation enters ===");
	// Three renders of this repo's own MEMORY.md pulled a sibling repo's state back in from the session
	// context, so the boundary is stated twice: as a rule, and at the block that carries the foreign text.
	const boundaryRule = "Write only durable facts about this project itself";
	const boundaryCaption = "[This session's working state. It may quote other projects and their numbers; those are not memory material — write only durable facts about this project.]";
	check("the prompt states the boundary as a rule", budgeted.includes(boundaryRule) && budgeted.includes("Never copy another repository's state or measurements"));
	check("naming another project stays allowed for ownership", budgeted.includes("naming another project is fine only to record who owns an open item"));
	check("the caption opens the conversation block, before its content", budgeted.includes(`<recent-conversation>\n${boundaryCaption}\nconversation`));
	check("the caption sits below the existing memory and context blocks", budgeted.indexOf(boundaryCaption) > budgeted.lastIndexOf("</existing-context>"));
	console.log("\n=== the prompt tells the model to keep entries instead of dropping them ===");
	// A render on 2026-10-06 added six facts and dropped eleven durable entries while the document shrank,
	// so the drops were not forced by the cap; the compression default and the block caption are both
	// pinned here because the rule alone was the wording that read as permission to delete.
	const keepRule = "Keep every entry that is still true: merge duplicates within a section, deduplicate across sections, then condense the wording until each section fits its budget above";
	const keepCaption = "The <existing-memory> block below is what has to survive this pass";
	check("the prompt makes compression the default over deletion", budgeted.includes(keepRule) && budgeted.includes("never to make room for a new one"));
	check("the prompt still allows deleting what is superseded", budgeted.includes("Delete an entry only when it is superseded or already covered elsewhere"));
	check("the prompt no longer offers dropping entries as the over-budget step", !budgeted.includes("then drop the least durable entries"));
	const captionAt = budgeted.indexOf(keepCaption);
	// N3: the caption has to be its own line, not text appended to the previous line, so the check
	// anchors on a line start and a line end around it rather than on the phrase alone.
	check(
		"the keeping caption sits on its own line at the memory block it protects",
		captionAt > 0 &&
			budgeted.slice(0, captionAt).endsWith("\n") &&
			budgeted.slice(budgeted.indexOf("\n", captionAt)).startsWith("\n\n<existing-memory>"),
	);
	console.log("\n=== S1/S3: fixed schema, per-section budgets, pointerized entries ===");
	const { MEMORY_SECTIONS, memorySchemaOverheadChars, memorySectionBudgets } = await loadNamespace(`${PC}/memory/schema.ts`);
	const freeFitted = fitMemoryInput("# Project Memory\n\n- a free-form fact\n", "", 8192, { maxTokens: 32768 });
	const cap401 = 4_001;
	const documented = [
		["Project", "purpose, stack, structure", 0.2],
		["Invariants", "standing decisions, conventions, hard constraints, user preferences", 0.4],
		["Pitfalls", "operational traps and the lessons behind them", 0.25],
		["Index", "pointers to docs, source files, and commands", 0.15],
	];
	const overhead = memorySchemaOverheadChars();
	check("the fixed overhead covers exactly the header, headings, and one blank line per section", overhead === 76);
	const intendedBudgets = memorySectionBudgets(cap401);
	const expectedBudgets = documented.map(([heading, , share]) => [heading, Math.floor((cap401 - overhead) * share)]);
	check(
		"the schema order, descriptions, and shares match the documented contract",
		MEMORY_SECTIONS.every((section, index) => section.heading === documented[index][0] && section.description === documented[index][1] && section.share === documented[index][2]),
	);
	check(
		"the budgets are the documented shares of the cap after the fixed overhead",
		intendedBudgets.every((section, index) => section.heading === expectedBudgets[index][0] && section.chars === expectedBudgets[index][1]),
	);
	const budgets8001 = memorySectionBudgets(8_001);
	const expected8001 = documented.map(([heading, , share]) => [heading, Math.floor((8_001 - overhead) * share)]);
	check("the budget formula scales with the cap", budgets8001.every((section, index) => section.heading === expected8001[index][0] && section.chars === expected8001[index][1]));
	check(
		"the budgets plus the fixed overhead stay within the cap",
		overhead + intendedBudgets.reduce((sum, section) => sum + section.chars, 0) <= cap401 && intendedBudgets.every((section) => section.chars >= 0),
	);
	const filled = `# Project Memory\n\n${intendedBudgets.map((section) => `## ${section.heading}\n\n${"x".repeat(section.chars)}\n`).join("\n")}`;
	check("a document that fills every budget and the real structure stays within the cap", !doc.exceedsMemoryCap(filled, cap401));
	const schemaPrompt = buildPrompt("/tmp/p", freeFitted, "conversation", { maxMemoryChars: cap401, currentChars: 10 });
	check("the prompt lists every section with its description and budget", intendedBudgets.every((section) => schemaPrompt.includes(`## ${section.heading}: ${section.description} (about ${section.chars} characters)`)));
	check("the prompt uses the documented section descriptions", documented.every(([heading, description]) => schemaPrompt.includes(`## ${heading}: ${description} (`)));
	check(
		"the prompt fixes the section order before the fitted memory",
		documented.every(
			([heading], index) =>
				schemaPrompt.indexOf(`## ${heading}:`) < schemaPrompt.indexOf("<existing-memory>") &&
				(index === 0 || schemaPrompt.indexOf(`## ${documented[index - 1][0]}:`) < schemaPrompt.indexOf(`## ${heading}:`)),
		),
	);
	check(
		"the prompt asks for one-line pointers, forbids inventing paths, and uses no project-specific path",
		schemaPrompt.includes("docs/<topic>.md") && schemaPrompt.includes("never invent a path") && !schemaPrompt.includes("157K/450K") && !schemaPrompt.includes("docs/handoff.md"),
	);
	check(
		"the pointer rule requires the target to hold the detail and keeps homeless details inline",
		schemaPrompt.includes("already exists in this project and actually holds the detail") &&
			schemaPrompt.includes("never an inline formula, table, or command transcript") &&
			schemaPrompt.includes("A detail with no home stays as one short line."),
	);
	check(
		"the prompt ties the drop rule to each section's budget",
		schemaPrompt.includes("then condense the wording until each section fits its budget above") &&
			schemaPrompt.includes("never to make room for a new one"),
	);

	console.log("\n=== M2: an overflowing reply is condensed once, not silently truncated ===");
	{
		const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-memory-budget-"));
		tmpDirs.push(tmp);
		await mkdir(path.join(tmp, ".agents/memory"), { recursive: true });
		await writeFile(path.join(tmp, ".agents/memory/MEMORY.md"), small);
		await writeFile(path.join(tmp, ".agents/memory/project-context.json"), `${JSON.stringify({ maxMemoryChars: cap, memoryEnabled: true, autolearnEnabled: false, handoffEnabled: false })}\n`);
		const pi = makePi({ cwd: tmp });
		await (await loadDefault(`${PC}/index.ts`))(pi);
		const ctx = makeCtx(tmp, { sessionManager: makeSessionManager([messageEntry("m1", "user", "hello", "2026-09-12T10:00:00.000Z")], "budget-session") });
		const prompts = [];
		ctx.modelRegistry.complete = async (_model, context) => {
			const prompt = context.messages[0].content[0].text;
			prompts.push(prompt);
			if (prompt.includes(`overflowed a section budget`)) {
				// The condensation compacts the memory but drops the context section.
				return { content: [{ type: "text", text: JSON.stringify({ memory_markdown: small }) }] };
			}
			return {
				content: [{
					type: "text",
					text: JSON.stringify({ memory_markdown: big, context: { title: "t", summary: "FIRST CONTEXT", key_points: [], open_tasks: [] } }),
				}],
			};
		};
		await pi.commands.get("memory").handler("update", ctx);
		const written = await readFile(path.join(tmp, ".agents/memory/MEMORY.md"), "utf8");
		const writtenContext = await readFile(path.join(tmp, ".agents/memory/CONTEXT.md"), "utf8").catch(() => "");
		check("the first reply overflowed and the condensation ran", prompts.length === 2 && prompts[1].includes(`overflowed a section budget`));
		check("the condensed reply is written, not the truncated original", written.includes("- A short fact.") && !doc.isMemoryTruncated(written));
		check("the prompt carried the real cap on both calls", prompts.every((p) => p.includes(`at or under ${cap} characters`)));
		check(
			"the condensation retry asks for compression, not for deleting the least durable",
			prompts[1].includes("keep every durable fact that is still true") &&
				prompts[1].includes("condense the wording") &&
				!prompts[1].includes("remove the least durable"),
		);
		check("a condensed reply without context keeps the first reply's context", writtenContext.includes("FIRST CONTEXT"));
	}

	console.log("\n=== M2: a failed condensation keeps the valid over-cap reply ===");
	{
		const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-memory-condense-fail-"));
		tmpDirs.push(tmp);
		await mkdir(path.join(tmp, ".agents/memory"), { recursive: true });
		await writeFile(path.join(tmp, ".agents/memory/MEMORY.md"), small);
		await writeFile(path.join(tmp, ".agents/memory/project-context.json"), `${JSON.stringify({ maxMemoryChars: cap, memoryEnabled: true, autolearnEnabled: false, handoffEnabled: false })}\n`);
		const pi = makePi({ cwd: tmp });
		await (await loadDefault(`${PC}/index.ts`))(pi);
		const ctx = makeCtx(tmp, { sessionManager: makeSessionManager([messageEntry("m1", "user", "hello", "2026-09-12T10:00:00.000Z")], "condense-fail-session") });
		let calls = 0;
		ctx.modelRegistry.complete = async (_model, context) => {
			calls += 1;
			const prompt = context.messages[0].content[0].text;
			if (prompt.includes(`overflowed a section budget`)) throw new Error("model call error: Connection error.");
			return { content: [{ type: "text", text: JSON.stringify({ memory_markdown: big, context: { title: "t", summary: "s", key_points: [], open_tasks: [] } }) }] };
		};
		await pi.commands.get("memory").handler("update", ctx);
		const stored = await readFile(path.join(tmp, ".agents/memory/MEMORY.md"), "utf8");
		const errors = await readFile(path.join(tmp, ".agents/memory/errors.log"), "utf8").catch(() => "");
		check("the condensation was attempted and failed", calls === 2);
		check("the over-cap reply is still written with its marker", doc.isMemoryTruncated(stored));
		check("the condensation failure is logged", errors.includes("condensation retry failed"));
	}

	console.log("\n=== M6: a copied marker does not raise a false cap warning ===");
	{
		const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-memory-marker-"));
		tmpDirs.push(tmp);
		await mkdir(path.join(tmp, ".agents/memory"), { recursive: true });
		await writeFile(path.join(tmp, ".agents/memory/MEMORY.md"), small);
		await writeFile(path.join(tmp, ".agents/memory/project-context.json"), `${JSON.stringify({ maxMemoryChars: cap, memoryEnabled: true, autolearnEnabled: false, handoffEnabled: false })}\n`);
		const pi = makePi({ cwd: tmp });
		await (await loadDefault(`${PC}/index.ts`))(pi);
		const ctx = makeCtx(tmp, { sessionManager: makeSessionManager([messageEntry("m1", "user", "hello", "2026-09-12T10:00:00.000Z")], "marker-session") });
		ctx.modelRegistry.complete = async () => ({
			content: [{
				type: "text",
				text: JSON.stringify({ memory_markdown: copiedMarker, context: { title: "t", summary: "s", key_points: [], open_tasks: [] } }),
			}],
		});
		await pi.commands.get("memory").handler("update", ctx);
		const errors = await readFile(path.join(tmp, ".agents/memory/errors.log"), "utf8").catch(() => "");
		check("no cap warning is logged for a copied marker", !errors.includes("exceeded maxMemoryChars"));
		// The reply is a fresh write, so the marker it copied describes an older clip and must not be
		// carried into the render (it used to survive and drive `status`/`/memory` forever).
		const stored = await readFile(path.join(tmp, ".agents/memory/MEMORY.md"), "utf8");
		check("the copied marker is not carried into the render", !stored.includes("memory truncated"));
		check("the stored body is the plain short memory", stored.trim() === small.trim());
		await pi.commands.get("memory").handler("", ctx);
		check("the memory command does not claim the cap was hit", !String(ctx.notifications.at(-1)?.[0] ?? "").includes("at the cap"));
	}
} finally {
	for (const dir of tmpDirs) await rmTemp(dir);
}

console.log(failures === 0 ? "\nALL OK" : `\nFAILURES: ${failures}`);
if (failures > 0) process.exitCode = 1;
