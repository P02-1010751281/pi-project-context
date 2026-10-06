/**
 * The sectioned memory representation, the two strict-ready tool schemas, and the shared auxiliary
 * call plumbing (`callAux` / `pickToolCall`).
 *
 * The renderer and the extractor are the contract the structured and the parseable-fallback entries
 * both depend on, so both are pinned here; the end-to-end cases live in consolidation-test.
 */

import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertStrictReady, loadNamespace, loadShared, makeCtx, PC, PI_AI_DIST, rmTemp } from "./harness.mjs";

let failures = 0;
function check(label, value) {
	const ok = Boolean(value);
	console.log(`${ok ? "OK  " : "FAIL"} ${label}`);
	if (!ok) failures += 1;
}

const schema = await loadNamespace(`${PC}/memory/schema.ts`);
const sections = await loadNamespace(`${PC}/memory/sections.ts`);
const autolearnSchema = await loadNamespace(`${PC}/autolearn/schema.ts`);
// Loaded together so the policy the test observes IS the one `callAux` records into.
const [llm, policy] = await loadShared([`${PC}/shared/llm.ts`, `${PC}/shared/call-policy.ts`]);

const { makeStrictJsonSchema } = await import(`${PI_AI_DIST}/api/constrained-sampling.js`);

console.log("=== strict-ready schemas ===");
{
	// The union scan, not `() => false`: that callback IS the provider check.
	try {
		await assertStrictReady(sections.RECORD_MEMORY_TOOL.parameters);
		check("record_memory is strict-ready (16 + 11 keyword union)", true);
	} catch (error) {
		check(`record_memory is strict-ready: ${error.message}`, false);
	}
	try {
		await assertStrictReady(autolearnSchema.RECORD_SKILL_TOOL.parameters);
		check("record_skill is strict-ready (16 + 11 keyword union)", true);
	} catch (error) {
		check(`record_skill is strict-ready: ${error.message}`, false);
	}
	// The union scan has to be able to fail, or it proves nothing.
	try {
		await assertStrictReady({ type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "array", items: { type: "string" }, maxItems: 3 } } });
		check("a schema carrying maxItems is rejected", false);
	} catch {
		check("a schema carrying maxItems is rejected", true);
	}
	// ... while the always-false callback really does let it through (the F8 loophole).
	try {
		makeStrictJsonSchema({ type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "array", items: { type: "string" }, maxItems: 3 } } }, () => false);
		check("the always-false callback misses maxItems (so the union scan is what pins it)", true);
	} catch {
		check("the always-false callback misses maxItems", false);
	}
	// Base-table counterexamples: a banned keyword, and the object union strict mode refuses.
	for (const [label, schema] of [
		["$ref", { type: "object", additionalProperties: false, required: ["a"], properties: { a: { $ref: "#/defs/x" } } }],
		["a required anyOf of an object and null", { type: "object", additionalProperties: false, required: ["a"], properties: { a: { anyOf: [{ type: "object", additionalProperties: false, required: [], properties: {} }, { type: "null" }] } } }],
	]) {
		try {
			makeStrictJsonSchema(schema);
			check(`${label} is rejected by makeStrictJsonSchema`, false);
		} catch {
			check(`${label} is rejected by makeStrictJsonSchema`, true);
		}
	}
	// Both tools declare the conservative strictness, not "require": require throws on the
	// OpenAI-compatible routes this project actually runs on.
	check("record_memory asks for strict: prefer", sections.RECORD_MEMORY_TOOL.constrainedSampling?.strict === "prefer");
	check("record_skill asks for strict: prefer", autolearnSchema.RECORD_SKILL_TOOL.constrainedSampling?.strict === "prefer");
}

// `assertStrictReady` above only inspects the SCHEMA. The gate that actually decides strict-vs-
// downgrade at request time is `resolveJsonSchemaStrictSampling`, which nothing exercised until now.
// Driving it with the real tool objects is as far as the strict path can be pinned on this machine:
// every route it can reach is OpenAI-compatible (`compat.supportsStrictMode` defaults false), so a
// live provider-side strict request is not obtainable here — this proves the schema WOULD be sent
// strict when a strict-capable provider is present, which is the part that was unverified.
console.log("\n=== strict resolver (pi-ai's real gate) ===");
{
	const { resolveJsonSchemaStrictSampling } = await import(`${PI_AI_DIST}/api/constrained-sampling.js`);
	for (const [label, tool] of [
		["record_memory", sections.RECORD_MEMORY_TOOL],
		["record_skill", autolearnSchema.RECORD_SKILL_TOOL],
	]) {
		let capable;
		try {
			capable = resolveJsonSchemaStrictSampling(tool, true);
		} catch (error) {
			capable = `threw: ${error.message}`;
		}
		check(`${label} resolves to strict on a strict-capable provider`, capable === true);
		// OpenAI-compatible / Bedrock / Anthropic routes: downgrade to undefined, and "prefer" must not throw.
		check(`${label} downgrades silently where strict is unsupported`, resolveJsonSchemaStrictSampling(tool, false) === undefined);
	}
	// Non-vacuous control: a base-table-forbidden keyword must NOT resolve to strict, or the two
	// assertions above would pass for any schema at all. `$ref` is in pi-ai's base table, unlike
	// `maxItems` (Anthropic-only), which the base-table check lets through.
	const notReady = {
		...sections.RECORD_MEMORY_TOOL,
		parameters: { type: "object", additionalProperties: false, required: ["a"], properties: { a: { $ref: "#/defs/x" } } },
	};
	check("a $ref schema does not resolve to strict (the control)", resolveJsonSchemaStrictSampling(notReady, true) === undefined);
	// "require" is the trap this project stays out of: on the routes it actually runs on it throws.
	let requireThrew = false;
	try {
		resolveJsonSchemaStrictSampling({ ...sections.RECORD_MEMORY_TOOL, constrainedSampling: { type: "json_schema", strict: "require" } }, false);
	} catch {
		requireThrew = true;
	}
	check("strict: require on an unsupported route throws (why both tools use prefer)", requireThrew);
}

console.log("\n=== entry hygiene ===");
{
	check("a bullet prefix and embedded newline are removed", sections.normalizeMemoryEntry("-  foo\n bar  ") === "foo bar");
	check("a negative number keeps its sign", sections.normalizeMemoryEntry("-32°C threshold") === "-32°C threshold");
	for (const [label, value] of [["an empty string", ""], ["whitespace", "   "], ["a zero-width space", "\u200b"], ["punctuation only", "##"]]) {
		check(`${label} is an empty entry`, sections.isMemoryEntryEmpty(value));
	}
	check("a single character is a real entry", !sections.isMemoryEntryEmpty("x"));
}

console.log("\n=== renderMemoryDocument ===");
{
	const rendered = sections.renderMemoryDocument({ project: ["p1"], invariants: ["i1", "i2"], pitfalls: ["q1"], index: ["x1"] }, 32000);
	check("the document opens with the canonical header", rendered.text.startsWith("# Project Memory\n\n"));
	check("sections appear in schema order", /## Project\n- p1\n\n## Invariants\n- i1\n- i2\n\n## Pitfalls\n- q1\n\n## Index\n- x1\n$/.test(rendered.text));
	check("nothing is dropped at a comfortable cap", rendered.sectionDropped === 0 && rendered.droppedItems === 0 && rendered.itemTruncated === 0);
	check("the storage format is untouched (no blank line after a heading)", !rendered.text.includes("## Project\n\n- "));

	// Byte-for-byte round trip is what lets the fallback entry and the guard reuse this renderer.
	const parsed = sections.sectionsFromMarkdown(rendered.text);
	check("the render round-trips through the extractor", JSON.stringify(parsed) === JSON.stringify({ project: ["p1"], invariants: ["i1", "i2"], pitfalls: ["q1"], index: ["x1"] }));

	// A huge single entry: the per-item cap has to come from what the section may spend, not MAX_LIST_ITEM_CHARS.
	const big = sections.renderMemoryDocument({ project: [], invariants: [], pitfalls: [], index: ["x".repeat(803)] }, 4000);
	check("cap 4000 keeps the document inside the cap", big.text.length <= 4000);
	check("an over-long entry is truncated, not left to break the cap", big.itemTruncated === 1);
	check("an over-long entry alone does not drop its section", big.sectionDropped === 0);

	const many = sections.renderMemoryDocument({ project: Array.from({ length: 400 }, (_, index) => `short entry ${index}`), invariants: [], pitfalls: [], index: [] }, 4000);
	check("a flood of entries still fits the cap", many.text.length <= 4000);
	check("the flood reports the section it overflowed", many.sectionDropped === 1 && many.droppedItems > 0);

	// The per-section numbers are targets, not caps: a section over its share is served from the room its
	// neighbours left, and the renderer spends entries only when the document itself is full. The field
	// case that forced this (2026-10-06): 1,839 characters idle in `Project` while `Invariants`,
	// `Pitfalls` and `Index` were a combined 1,670 over, so four real passes dropped 10-15 entries each.
	// Under the old hard share this fixture loses Invariants entries; that is the mutation this pair reddens.
	const overShare = Array.from({ length: 10 }, (_, index) => `invariant ${index} ${"x".repeat(170)}`);
	const borrowed = sections.renderMemoryDocument({ project: [], invariants: overShare, pitfalls: ["p"], index: ["i"] }, 4000);
	const parsedBorrowed = sections.sectionsFromMarkdown(borrowed.text);
	check("the fixture really is over the Invariants share", overShare.reduce((n, entry) => n + entry.length + 3, 0) > 1569);
	check("a section over its share borrows instead of dropping entries", borrowed.sectionDropped === 0 && borrowed.droppedItems === 0);
	check("every over-share entry survives the borrow", parsedBorrowed.invariants.length === 10);
	check("the borrowed document stays inside the cap", borrowed.text.length <= 4000);

	const full = sections.renderMemoryDocument(
		{ project: [], invariants: Array.from({ length: 400 }, (_, index) => `entry-${index}-${"y".repeat(40)}`), pitfalls: ["keep me"], index: ["and me"] },
		4000,
	);
	const parsedFull = sections.sectionsFromMarkdown(full.text);
	const invariantsSpent = parsedFull.invariants.reduce((n, entry) => n + entry.length + 3, 0) + "## Invariants\n".length;
	check("a document that is really full still drops entries", full.droppedItems > 0 && full.sectionDropped >= 1);
	check("the over-share section takes the room its neighbours left", invariantsSpent > 1569);
	check("neighbours under their share keep every entry", parsedFull.pitfalls.length === 1 && parsedFull.index.length === 1);

	// The per-item cap follows the borrowed budget, not the share: at cap 4000 the Index share is 588, so a
	// 700-character entry would be clipped there, but Index borrows the room its neighbours left and keeps
	// the entry whole. This is the assertion that reddens if the item cap goes back to the raw share.
	const longIndex = [`i ${"z".repeat(700)}`];
	const keptWhole = sections.renderMemoryDocument({ project: [], invariants: [], pitfalls: [], index: longIndex }, 4000);
	check("a borrowing section keeps a longer entry whole", keptWhole.itemTruncated === 0 && sections.sectionsFromMarkdown(keptWhole.text).index[0] === longIndex[0].trim());

	// The renderer must never write the old marker: the write path strips it again.
	check("the renderer writes no truncation marker", !rendered.text.includes("_[memory truncated") && !many.text.includes("_[memory truncated"));

	let worst = Number.POSITIVE_INFINITY;
	let over = 0;
	for (let index = 0; index < 2000; index += 1) {
		const cap = 4000 + Math.floor(Math.random() * 196_001);
		const make = () => Array.from({ length: Math.floor(Math.random() * 10) }, () => "y".repeat(1 + Math.floor(Math.random() * 900)));
		const text = sections.renderMemoryDocument({ project: make(), invariants: make(), pitfalls: make(), index: make() }, cap).text;
		if (text.length > cap) over += 1;
		worst = Math.min(worst, cap - text.length);
	}
	check(`2000 random caps all fit (worst margin ${worst} chars)`, over === 0);

	// The guarantee the borrowing exists for, stated as a property: when the canonical document fits the
	// cap, nothing is dropped - however unevenly the content sits across the sections. The premise has to
	// be the document's own size (structure plus entries), not the sum of the targets: a target-floored
	// pool is a few characters smaller than the cap, and charging those characters as drops is exactly the
	// bug this property exists to catch.
	let fitsButDropped = 0;
	let considered = 0;
	for (let index = 0; index < 2000; index += 1) {
		const cap = 4000 + Math.floor(Math.random() * 196_001);
		const make = () => Array.from({ length: Math.floor(Math.random() * 6) }, () => "z".repeat(1 + Math.floor(Math.random() * 300)));
		const shape = [make(), make(), make(), make()];
		const wantedDoc = schema.memoryStructureOverheadChars() + shape.reduce((sum, list) => sum + list.reduce((n, entry) => n + entry.length + 3, 0), 0);
		if (wantedDoc > cap) continue;
		considered += 1;
		const fits = sections.renderMemoryDocument({ project: shape[0], invariants: shape[1], pitfalls: shape[2], index: shape[3] }, cap);
		if (fits.droppedItems > 0) fitsButDropped += 1;
	}
	check(`a document that fits the cap never drops (${fitsButDropped} violations of ${considered})`, fitsButDropped === 0 && considered > 100);

	// The exact boundary that produced B1: content whose canonical document fits the cap while the sum of
	// the floored targets does not cover it. Ten 390-character entries need 3,930 of the 3,933 characters
	// cap 4000 leaves for bodies, against 3,922 of targets - the 8-character gap is what must not be spent
	// as a dropped entry.
	const tight = sections.renderMemoryDocument({ project: [], invariants: Array.from({ length: 10 }, () => "t".repeat(390)), pitfalls: [], index: [] }, 4000);
	check("content that fits the cap but exceeds the target sum keeps every entry", tight.droppedItems === 0 && tight.text.length <= 4000);
}

console.log("\n=== sectionsFromMarkdown contract ===");
{
	const good = "## Project\n- a\n\n## Invariants\n- b\n\n## Pitfalls\n- c\n\n## Index\n- d";
	const reject = {
		"a preamble before the first heading": `Here is the memory.\n${good}`,
		"an unknown section": "## Project\n- a\n\n## Notes\n- z\n\n## Invariants\n- b\n\n## Pitfalls\n- c\n\n## Index\n- d",
		"a missing section": "## Project\n- a\n\n## Invariants\n- b\n\n## Pitfalls\n- c",
		"prose inside a section": "## Project\n- a\ncontinued on the next line\n\n## Invariants\n- b\n\n## Pitfalls\n- c\n\n## Index\n- d",
		"a star bullet": "## Project\n* a\n\n## Invariants\n- b\n\n## Pitfalls\n- c\n\n## Index\n- d",
		"an indented bullet": "## Project\n  - a\n\n## Invariants\n- b\n\n## Pitfalls\n- c\n\n## Index\n- d",
		"content after the last section": `${good}\ntrailing prose`,
		"an empty string": "",
	};
	for (const [label, text] of Object.entries(reject)) {
		check(`${label} falls back to the opaque path`, sections.sectionsFromMarkdown(text) === undefined);
	}
	check("the header line is optional", JSON.stringify(sections.sectionsFromMarkdown(good)) === JSON.stringify(sections.sectionsFromMarkdown(`# Project Memory\n\n${good}`)));
	// Without this, every memory that was ever over the cap would be rejected as "not bullets".
	const capped = `${good}\n\n_[memory truncated at 8000 characters: 123 dropped]_`;
	check("a trailing truncation marker is stripped, not treated as content", JSON.stringify(sections.sectionsFromMarkdown(capped)) === JSON.stringify(sections.sectionsFromMarkdown(good)));
	const empty = sections.sectionsFromMarkdown("## Project\n\n## Invariants\n\n## Pitfalls\n\n## Index\n");
	check("four empty sections parse as four empty sections", empty !== undefined && sections.sectionsSemanticallyEmpty(empty));
}

console.log("\n=== sectionsFromToolCall and the semantic gate ===");
{
	const args = { memory: { project: ["- p"], invariants: ["i"], pitfalls: [], index: [] }, context: {} };
	const parsed = sections.sectionsFromToolCall(args);
	check("a tool call parses into sections", parsed !== undefined && parsed.project[0] === "p");
	check("a missing section array is rejected", sections.sectionsFromToolCall({ memory: { project: ["p"], invariants: ["i"], pitfalls: [] } }) === undefined);
	check("a non-string entry is rejected", sections.sectionsFromToolCall({ memory: { project: [1], invariants: [], pitfalls: [], index: [] } }) === undefined);
	check("a non-object argument is rejected", sections.sectionsFromToolCall("nope") === undefined);

	for (const [label, value] of [
		["an empty string", [""]],
		["whitespace", [" "]],
		["a zero-width space", ["\u200b"]],
		["punctuation only", ["##"]],
	]) {
		const empty = sections.sectionsFromToolCall({ memory: { project: value, invariants: [], pitfalls: [], index: [] } });
		check(`${label} counts as no content at all`, empty !== undefined && sections.sectionsSemanticallyEmpty(empty));
	}
	check("one real entry anywhere defeats the gate", !sections.sectionsSemanticallyEmpty({ project: [], invariants: ["x"], pitfalls: [], index: [] }));
}

console.log("\n=== pickToolCall policy ===");
{
	const mem = { memory: { project: ["p"], invariants: [], pitfalls: [], index: [] } };
	check("a matching call returns its arguments", llm.pickToolCall([{ name: "record_memory", arguments: mem }], "record_memory", "") === mem);
	// Name mismatch with readable text is the fail-open text path, not an error.
	check("a mismatched name with text falls back to the text path", llm.pickToolCall([{ name: "other", arguments: mem }], "record_memory", "{\"memory_markdown\":\"x\"}") === undefined);
	// Name mismatch with nothing to parse must be an error: "" would read as an empty, successful reply.
	let threw = false;
	try {
		llm.pickToolCall([{ name: "other", arguments: mem }], "record_memory", "   ");
	} catch {
		threw = true;
	}
	check("a mismatched name with no text is an error", threw);
	check("no call and no text is not an error here", llm.pickToolCall(undefined, "record_memory", "") === undefined);
	check("no call with text falls back", llm.pickToolCall([], "record_memory", "text") === undefined);
}

console.log("\n=== callAux: retry, stickiness and one failure per pass ===");
{
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-sections-aux-"));
	try {
		/** A ctx whose model records every request and replies (or throws) per `script`. */
		const scripted = (script) => {
			const seen = [];
			const ctx = makeCtx(root, {});
			ctx.modelRegistry.complete = async (_model, context) => {
				const step = script[Math.min(seen.length, script.length - 1)];
				seen.push({ tools: context.tools, step });
				if (step.throw) throw new Error(step.throw);
				return { content: [{ type: "text", text: step.text ?? "{}" }], stopReason: step.stopReason };
			};
			return { ctx, seen };
		};
		const tool = [{ name: "record_memory", description: "d", parameters: { type: "object" } }];

		// A tools-shaped rejection: retry once without tools, and keep them off afterwards.
		const rejection = scripted([{ throw: "tools are not supported by this endpoint" }]);
		let state = {};
		let failed = false;
		try {
			await llm.callAux(rejection.ctx, "p", { model: rejection.ctx.model, tools: tool, scope: "s1", projectRoot: root, state });
		} catch {
			failed = true;
		}
		check("a tools rejection fails after the retry", failed);
		check("it reached the model exactly twice", rejection.seen.length === 2);
		check("the first attempt carried tools and the retry did not", rejection.seen[0].tools?.length === 1 && rejection.seen[1].tools === undefined);
		check("the no-tools switch is sticky for the pass", state.toolsDisabled === true);

		// A provider failure is not a tools rejection: retrying it would double the calls an outage makes.
		const outage = scripted([{ throw: "model call error: Connection error." }]);
		state = {};
		try {
			await llm.callAux(outage.ctx, "p", { model: outage.ctx.model, tools: tool, scope: "s2", projectRoot: root, state });
		} catch {
			// expected
		}
		check("a provider outage is not retried", outage.seen.length === 1);
		check("the outage armed the cooldown", policy.modelCooldownRemaining("s2", root) > 0);

		// Both attempts failing records ONE failure: two records would double the transient cooldown.
		const both = scripted([{ throw: "tools are not supported by this endpoint" }, { throw: "model call error: Connection error." }]);
		state = {};
		try {
			await llm.callAux(both.ctx, "p", { model: both.ctx.model, tools: tool, scope: "s3", projectRoot: root, state });
		} catch {
			// expected
		}
		check("two failed attempts still reach the model twice", both.seen.length === 2);
		const remaining = policy.modelCooldownRemaining("s3", root);
		check(`the failure was recorded once, not twice (cooldown ${Math.round(remaining / 60_000)} min)`, remaining > 0 && remaining <= policy.TRANSIENT_BASE_COOLDOWN_MS);

		// A success clears the episode.
		const ok = scripted([{ text: "{}", stopReason: "stop" }]);
		state = {};
		await llm.callAux(ok.ctx, "p", { model: ok.ctx.model, tools: tool, scope: "s3", projectRoot: root, state });
		check("a success clears the recorded failure", policy.modelCooldownRemaining("s3", root) === 0);

		// Tools accepted once means a later failure is the provider's, so it is not retried.
		const late = scripted([{ text: "{}", stopReason: "stop" }, { throw: "tools are not supported by this endpoint" }]);
		state = {};
		await llm.callAux(late.ctx, "p", { model: late.ctx.model, tools: tool, scope: "s4", projectRoot: root, state });
		try {
			await llm.callAux(late.ctx, "p", { model: late.ctx.model, tools: tool, scope: "s4", projectRoot: root, state });
		} catch {
			// expected
		}
		check("a failure after a tools success is not retried", late.seen.length === 2);
	} finally {
		await rmTemp(root);
	}
}

console.log("\n=== the opaque entry's half of the gate ===");
{
	// The opaque path has no sections to judge, so a content-free document is how a reply that lost its
	// body looks. Writing one would replace a real memory with a skeleton.
	const skeleton = "# Project Memory\n\n## Project\n\n## Invariants\n\n## Pitfalls\n\n## Index\n";
	for (const [label, text] of [
		["a four-heading skeleton", skeleton],
		["a partial skeleton", "# Project Memory\n\n## Project\n\n## Invariants\n"],
		["a ```markdown fence", `\`\`\`markdown\n${skeleton}\`\`\``],
		["a ```md fence", `\`\`\`md\n${skeleton}\`\`\``],
		["a ```json fence", `\`\`\`json\n${skeleton}\`\`\``],
		["a bare ``` fence", `\`\`\`\n${skeleton}\`\`\``],
		["a ~~~ fence", `~~~\n${skeleton}~~~`],
		["a frontmatter delimiter", `---\n${skeleton}`],
		["a thematic break", `${skeleton}\n---\n`],
		["a zero-width prefix line", `\u200b\n${skeleton}`],
		["soft hyphens and BOM", `\u00ad\ufeff\n${skeleton}`],
		["a star separator line", "*".repeat(60)],
		["a 7-hash pseudo-heading only", "####### Project\n####### Invariants\n"],
		["a U+2028 line separator", "# Project\u2028## Invariants\u2028## Pitfalls\n"],
		["a U+2029 line separator", "# Project\u2029## Invariants\n"],
		["CR line endings", skeleton.replace(/\n/g, "\r")],
		["an HTML comment only", "<!-- Project Memory -->\n<!-- Invariants -->\n"],
		["bullets with no text", "- \n- \n- \n"],
		["an empty string", ""],
		["whitespace only", "   \n\t\n"],
		["a marker-only document", "_[memory truncated at 8000 characters: 12 dropped]_"],
		["a bullet-prefixed skeleton", "- # Project Memory\n- ## Project\n- ## Invariants\n"],
		["a nested bullet-prefixed skeleton", "- - # Project Memory\n- - ## Project\n"],
		["a blockquote-prefixed skeleton", "> # Project Memory\n> ## Project\n"],
		["an ordered-marker skeleton", "1. # Project Memory\n2. ## Project\n"],
		["an XML-tag-wrapped skeleton", `<memory>\n${skeleton}</memory>`],
		["an HTML-heading skeleton", "<h2>Project Memory</h2>\n<h2>Invariants</h2>\n"],
		["a setext skeleton", "Project Memory\n===\nInvariants\n===\n"],
		["a fence line alone", "```"],
		["a ZWSP-prefixed heading line", "\u200b# Project Memory\n\u200b## Project\n"],
		["a U+200E LRM-prefixed skeleton", "\u200e# Project Memory\n\u200e## Project\n"],
		["a U+200F RLM-prefixed skeleton", "\u200f# Project Memory\n\u200f## Project\n"],
		["a U+202A bidi-prefixed skeleton", "\u202a# Project Memory\n\u202a## Project\n"],
		["a U+2066 isolate-prefixed skeleton", "\u2066# Project Memory\n\u2066## Project\n"],
		["an `<foo_bar>`-wrapped skeleton", "<foo_bar>\n# Project Memory\n## Project\n</foo_bar>"],
		["an `<ns:memory>`-wrapped skeleton", "<ns:memory>\n# Project Memory\n## Project\n</ns:memory>"],
		["a `<my.tag>`-wrapped skeleton", "<my.tag>\n# Project Memory\n## Project\n</my.tag>"],
		["an `<_x>`-wrapped skeleton", "<_x>\n# Project Memory\n## Project\n</_x>"],
		["a `<1memory>`-wrapped skeleton", "<1memory>\n# Project Memory\n## Project\n</1memory>"],
		["a CJK-tag-wrapped skeleton", "<\u8bb0\u5fc6>\n# Project Memory\n## Project\n</\u8bb0\u5fc6>"],
		["a tag whose attribute holds a `>`", '<x title="a>b">\n# Project Memory\n## Project\n</x>'],
		["an unterminated tag wrapper", "<memory\n# Project Memory\n## Project"],
		["a `<tel:…>` line alone (recorded boundary)", "<tel:+15551234567>\n"],
	]) {
		check(`${label} carries nothing worth writing`, sections.isHeadingOnlyDocument(text));
	}
	// R3-I1: a FENCED reply joined by anything other than `\n` must still count as content. The
	// separators are normalized before the structural matchers run, so the matchers (which are anchored)
	// cannot swallow the rest of the reply and silently refuse a memory the model did write.
	{
		const real = "# Project Memory\n\n## Project\n- a durable fact worth storing in the memory\n";
		for (const [name, separator] of [["LF", "\n"], ["CR", "\r"], ["CRLF", "\r\n"], ["U+2028", "\u2028"], ["U+2029", "\u2029"]]) {
			const fenced = `\`\`\`md${separator}${real.replace(/\n/g, separator)}\`\`\``;
			check(`a fenced memory joined by ${name} counts as content`, !sections.isHeadingOnlyDocument(fenced));
		}
		check("an unclosed fence over a real memory counts as content", !sections.isHeadingOnlyDocument(`\`\`\`md\n${real}`));
	}
	// Content lines are what keep the opaque path's behaviour unchanged for real memories.
	for (const [label, text] of [
		["prose", "# Project Memory\n\n## Project\nThis project does a thing.\n"],
		["a bullet", "# Project Memory\n\n## Project\n- a\n"],
		["a star bullet", "# Project Memory\n\n## Project\n* a free-form note\n"],
		["a plus bullet", "+ a free-form note\n"],
		["a numbered rule that starts with a hash", "#1 rule must hold\n"],
		["a bulleted rule that starts with a hash", "- #1 rule must hold\n"],
		["a quoted fact", "> a quoted durable fact\n"],
		["a bare number", "42\n"],
		["a date", "2026-10-02\n"],
		["a CJK-only line", "\u4e00\u4e2a\u771f\u7684\u9879\u76ee\n"],
		["a fenced code block with a body", "```md\n# Project Memory\n\n## Project\n- real\n```"],
		["an autolink as the only line", "<https://example.com/notes>\n"],
		["a mailto autolink as the only line", "<mailto:someone@example.com>\n"],
		["a bare email autolink as the only line", "<user@example.com>\n"],
		["an upper-cased MAILTO autolink", "<MAILTO:x@y.example>\n"],
		["a `<3 …` line", "<3 this project\n"],
		["a fenced block whose body ends in a `===` line", "# Project Memory\n## Project\n```\nvalue\n===\n```\n"],
		// The block is `~~~`, so the ``` line inside it is body, not a closer: the parity must not flip
		// and `===` must not eat the only real line.
		["a `~~~` block containing a ``` line and a `===` line", "# Project Memory\n## Project\n~~~\n```\nreal fact must hold\n===\n~~~\n"],
		["a decorated fence line inside a block", "# Project Memory\n## Project\n```\n> ```\nreal fact must hold\n===\n```\n"],
		// A closer is same-character, at least as long, and carries no info string.
		["a block whose body holds an info-string fence line", "# Project Memory\n## Project\n```\n```js\nreal fact must hold\n===\n```\n"],
		["a 4-backtick block closed by 3", "# Project Memory\n## Project\n````\n```\nreal fact must hold\n===\n"],
		// A decorated `===` is a bullet, not a setext underline, so it consumes nothing.
		["a real line followed by `- ===`", "real fact must hold\n- ===\n"],
	]) {
		check(`${label} counts as content`, !sections.isHeadingOnlyDocument(text));
	}
	// A heading's own text is not a body: a document made only of heading lines carries nothing, which
	// is exactly how a reply that lost its body looks. (`#1 rule` is not a heading — see above.)
	check("a heading whose text continues on the line is still just a heading", sections.isHeadingOnlyDocument("## Project Memory uses Postgres\n"));
	// The recorded fail-open boundary: a wrapper that holds real words is content. The other answer is
	// "refuse a memory the model did write", so this boundary is documented rather than closed.
	check("a prose preamble over a skeleton counts as content (recorded boundary)", !sections.isHeadingOnlyDocument(`Here is the consolidated project memory:\n${skeleton}`));
	check("a `---` setext skeleton counts as content (recorded boundary)", !sections.isHeadingOnlyDocument("Project Memory\n---\nInvariants\n---\n"));
}

console.log("\n=== progressive disclosure injection (memory + context) ===");
const injection = await loadNamespace(`${PC}/memory/injection.ts`);
const memorySchema = await loadNamespace(`${PC}/memory/schema.ts`);
const contextSchema = await loadNamespace(`${PC}/memory/context-schema.ts`);

// Totality: every heading the render schemas own is either kept inline or named by a pointer. A spec that
// stopped covering a heading would silently inline it (the fail-safe), so this pin is what makes a schema
// rename visible instead of quiet.
const specHeadings = (spec) => [...spec.keep, ...Object.keys(spec.pointers)];
const memoryHeadings = memorySchema.MEMORY_SECTIONS.map((section) => section.heading);
const contextHeadings = contextSchema.CONTEXT_SECTIONS.map((section) => section.heading);
check(
	"the memory split covers the schema exactly",
	memoryHeadings.every((heading) => specHeadings(injection.MEMORY_INJECTION).includes(heading)) &&
		specHeadings(injection.MEMORY_INJECTION).length === memoryHeadings.length,
);
check(
	"the context split covers the schema exactly",
	contextHeadings.every((heading) => specHeadings(injection.CONTEXT_INJECTION).includes(heading)) &&
		specHeadings(injection.CONTEXT_INJECTION).length === contextHeadings.length,
);
// The two lists stay disjoint: the renderer indexes by pointer presence, so a heading that is both kept
// and pointed at would silently take the pointer branch and the declared intent would be a lie.
const alsoPointedAt = (spec) => [...spec.keep].filter((heading) => heading in spec.pointers);
check("the memory split keeps nothing it also points at", alsoPointedAt(injection.MEMORY_INJECTION).length === 0);
check("the context split keeps nothing it also points at", alsoPointedAt(injection.CONTEXT_INJECTION).length === 0);

const memoryFixture = `# Project Memory\n\n## Project\n- 项目布局。\n\n## Invariants\n\n- 绝不删除 .agents/memory/ 下的文件。\n\n## Pitfalls\n\n- specVersion 不是 version。\n\n## Index\n- a.ts - 合并逻辑。\n`;
const memoryInjected = injection.buildMemoryInjection(memoryFixture);
check(
	"kept bodies stay verbatim",
	memoryInjected.includes("## Invariants\n\n- 绝不删除 .agents/memory/ 下的文件。") &&
		memoryInjected.includes("## Pitfalls\n\n- specVersion 不是 version。"),
);
check("indexed bodies are dropped", !memoryInjected.includes("- 项目布局。") && !memoryInjected.includes("- a.ts - 合并逻辑。"));
check(
	"indexed sections become one named line each",
	memoryInjected.includes("其余小节在 `.agents/memory/MEMORY.md`：") &&
		memoryInjected.includes("- `## Project` ——") &&
		memoryInjected.includes("- `## Index` ——"),
);
// The sentence the probe showed is what makes a pointer get read; dropping it is the failure mode.
check("the read-first instruction follows the pointers", memoryInjected.includes("必须先 read 该文件再回答"));

const contextFixture = `# Project Context\n\nLast updated: 2026-10-05T00:00:00.000Z\n\n## Summary\n\n摘要正文。\n\n## Key points\n\n- 要点。\n\n## Open tasks\n\n- 待办。\n`;
const contextInjected = injection.buildContextInjection(contextFixture);
check(
	"context keeps its two decision sections",
	contextInjected.includes("## Key points\n\n- 要点。") && contextInjected.includes("## Open tasks\n\n- 待办。"),
);
check(
	"context indexes only its summary",
	!contextInjected.includes("摘要正文。") &&
		contextInjected.includes("其余小节在 `.agents/memory/CONTEXT.md`：") &&
		contextInjected.includes("- `## Summary` ——"),
);
// The preamble and any document-level note are not section content, so indexing the sections must not
// index them away: the freshness timestamp and the truncation marker are what keep the injected view honest.
check(
	"the document preamble stays inline",
	memoryInjected.includes("# Project Memory") && contextInjected.includes("Last updated: 2026-10-05T00:00:00.000Z"),
);
const truncatedFixture = `# Project Memory\n\n## Project\n- 布局。\n\n## Invariants\n\n- 铁律。\n\n## Pitfalls\n\n- 坑。\n\n## Index\n- a.ts - 合并。\n\n_[memory truncated at 4000 characters: 120 dropped]_\n`;
const truncatedInjected = injection.buildMemoryInjection(truncatedFixture);
check(
	"a document-level note stays inline next to the pointers",
	truncatedInjected.includes("_[memory truncated at 4000 characters: 120 dropped]_") &&
		!truncatedInjected.includes("- a.ts - 合并。"),
);
check(
	"the pointer path resolves against the project root when it is known",
	injection.buildMemoryInjection(memoryFixture, "/tmp/proj").includes("其余小节在 `/tmp/proj/.agents/memory/MEMORY.md`："),
);
// Recorded boundary: the language is counted over the whole document, so two CJK characters anywhere (a
// filename, a quoted word) flip every pointer line to Chinese and one does not. Pinned as-is so a future
// change of the heuristic shows up as a red assertion instead of a silent prompt-language flip.
check(
	"two CJK characters anywhere flip the pointers to Chinese (recorded boundary)",
	injection
		.buildMemoryInjection("# Project Memory\n\n## Project\n- note\n\n## Invariants\n\n- x\n\n## Index\n- 中文.ts - a\n")
		.includes("其余小节在"),
);
check(
	"one CJK character keeps the pointers English (recorded boundary)",
	injection
		.buildMemoryInjection("# Project Memory\n\n## Project\n- note\n\n## Invariants\n\n- x\n\n## Index\n- 中.ts - a\n")
		.includes("The remaining sections are in"),
);

// A fenced code block can hold a heading-shaped line; it is content, so it must not split the document
// (otherwise the pointer list names the same section twice and a real section loses its body).
const fencedFixture = `# Project Memory\n\n## Project\n- 布局。\n\n## Invariants\n\n- 铁律。\n\n## Pitfalls\n\n- 坑。\n\n## Index\n- a.ts - 合并。\n\n\`\`\`md\n## Project\n- 代码里的示例。\n\`\`\`\n`;
const fencedInjected = injection.buildMemoryInjection(fencedFixture);
check(
	"a heading-shaped line inside a fence does not split the document",
	(fencedInjected.match(/- `## /g) ?? []).length === 2 && fencedInjected.includes("## Invariants\n\n- 铁律。"),
);
// The preamble is found by the same fence-aware traversal as the sections, so a heading-shaped line inside
// a fenced block at the top stays content. A fence-blind preamble scan instead cut the preamble at the fake
// heading - the fenced content was lost with it - while the section scan (already fence-aware) never treated
// that line as a section, so the two views of the document disagreed about where it starts.
const fencedPreambleFixture = `# Project Memory\n\n\`\`\`md\n## Project\n- 围栏内是内容。\n\`\`\`\n\n## Project\n- 真实布局。\n\n## Invariants\n\n- 铁律。\n\n## Index\n- a.ts - 合并。\n`;
const fencedPreambleInjected = injection.buildMemoryInjection(fencedPreambleFixture);
check(
	"a heading-shaped line in a fenced preamble does not become a section",
	(fencedPreambleInjected.match(/- `## Project`/g) ?? []).length === 1 &&
		fencedPreambleInjected.includes("- 围栏内是内容。") &&
		fencedPreambleInjected.includes("## Invariants\n\n- 铁律。"),
);
// A closing fence repeats the opening character at least as many times with nothing else on the line, so a
// shorter run inside the block is content and the real `## Index` is the only one indexed. Under the old
// one-character close test the inner three backticks ended the four-backtick fence early.
const shortFenceFixture = `# Project Memory\n\n## Project\n- 布局。\n\n## Invariants\n\n- 铁律。\n\n## Pitfalls\n\n\`\`\`\`\n\`\`\`\n## Index\n- 围栏内假索引。\n\`\`\`\`\n\n## Index\n- a.ts - 合并。\n`;
const shortFenceInjected = injection.buildMemoryInjection(shortFenceFixture);
check(
	"a shorter fence run inside a block does not close it",
	(shortFenceInjected.match(/- `## Index`/g) ?? []).length === 1 &&
		shortFenceInjected.includes("- 围栏内假索引。") &&
		shortFenceInjected.includes("## Invariants\n\n- 铁律。"),
);
// Fail-safes: an unlisted heading and a document with no headings both stay whole, and the pointer
// language follows the body it points into.
check(
	"an unlisted heading stays inline",
	injection
		.buildMemoryInjection("# Project Memory\n\n## Project\n- 布局。\n\n## Future section\n- 新节正文。\n")
		.includes("- 新节正文。"),
);
check(
	"a document without headings is injected whole",
	injection.buildMemoryInjection("# Project Memory\n- 无小节正文。\n").includes("- 无小节正文。"),
);
check(
	"an English body gets English pointers",
	injection
		.buildMemoryInjection("# Project Memory\n\n## Project\n- layout.\n\n## Invariants\n- never delete.\n")
		.includes("The remaining sections are in `.agents/memory/MEMORY.md`:"),
);

console.log(failures === 0 ? "\nsections: all checks passed." : `\nsections: ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
