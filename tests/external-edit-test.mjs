import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadDefault, loadNamespace, makeCtx, makePi, makeSessionManager, messageEntry, PC, rmTemp } from "./harness.mjs";

/**
 * The external-edit adoption fix. A reply whose baseline changed while the model was writing must
 * not be published: the newer bytes stay effective, and neither the log nor the command reply may
 * claim a write that did not happen. The no-edit path stays byte-identical, and the orderings that
 * must NOT refuse (an edit the pass already read, a memory the owner cleared) are pinned too.
 */

const tmpDirs = [];
let failures = 0;
function check(label, value) {
	console.log(`${value ? "OK  " : "FAIL"} ${label}`);
	if (!value) failures += 1;
}

const memoryPath = (root) => path.join(root, ".agents/memory/MEMORY.md");
const contextPath = (root) => path.join(root, ".agents/memory/CONTEXT.md");
const journalPath = (root) => path.join(root, ".agents/memory/memory.jsonl");
const logPath = (root) => path.join(root, ".agents/memory/errors.log");

const { loadMemory, nextRenderSupersedes, recordMemoryDocument } = await loadNamespace(`${PC}/memory/store.ts`);
const { readMemoryJournal } = await loadNamespace(`${PC}/memory/journal.ts`);
const { memoryComparisonKey } = await loadNamespace(`${PC}/memory/poison.ts`);

const CAP = 32_000;
const key = (text) => memoryComparisonKey(text, CAP);
const FOUR =
	"# Project Memory\n\n## Project\n- base project line.\n\n## Invariants\n- base invariant.\n\n## Pitfalls\n\n## Index\n";
const HAND = FOUR.replace("- base project line.", "- base project line.\n- a hand edit landed during the pass.");
const REPLY = FOUR.replace("- base project line.", "- the pass's own reply.");

async function makeProject(seed) {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-external-edit-"));
	tmpDirs.push(root);
	await mkdir(path.join(root, ".agents/memory"), { recursive: true });
	if (seed !== null) await writeFile(memoryPath(root), seed ?? FOUR);
	return root;
}

/** The two durable artifacts of a write: the journal's records and the rendered document. */
async function shape(root) {
	const journal = await readMemoryJournal(journalPath(root));
	return {
		ops: journal.entries.map((entry) => `${entry.op}|${entry.text}`).join("\n"),
		render: await readFile(memoryPath(root), "utf8").catch(() => ""),
	};
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
	console.log("=== T6: nextRenderSupersedes ===");
	{
		const publish = "the-document-about-to-be-published";
		check("the same document does not supersede", nextRenderSupersedes("A", "A", publish) === false);
		check("a blanked document does not supersede", nextRenderSupersedes("A", "", publish) === false);
		check("an absent document does not supersede", nextRenderSupersedes("", "", publish) === false);
		check("a document that appeared after the read supersedes", nextRenderSupersedes("", "E", publish) === true);
		check("different content supersedes", nextRenderSupersedes("A", "E", publish) === true);
		check("content equal to the publish supersedes nothing", nextRenderSupersedes("A", publish, publish) === false);
	}

	console.log("=== T1/T5: no external edit, four project shapes, identical to the option-less path ===");
	{
		const fixtures = [
			{ name: "journal", seed: FOUR, prepare: (root) => recordMemoryDocument(root, FOUR, CAP) },
			{ name: "preserveMarker", seed: FOUR, prepare: (root) => recordMemoryDocument(root, FOUR, CAP), options: { preserveMarker: true } },
			{ name: "legacy-no-journal", seed: FOUR, prepare: async () => {} },
			{ name: "fresh", seed: null, prepare: async () => {} },
		];
		for (const fixture of fixtures) {
			// `basisKey` absent is today's code path: it must not change a single byte.
			const legacy = await makeProject(fixture.seed);
			await fixture.prepare(legacy);
			await recordMemoryDocument(legacy, REPLY, CAP, fixture.options ?? {});
			const before = await shape(legacy);

			const guarded = await makeProject(fixture.seed);
			await fixture.prepare(guarded);
			const basisKey = (await loadMemory(guarded, CAP)).text;
			await recordMemoryDocument(guarded, REPLY, CAP, { ...(fixture.options ?? {}), basisKey });
			const after = await shape(guarded);

			check(`${fixture.name}: journal records identical`, before.ops === after.ops);
			check(`${fixture.name}: render byte-identical`, before.render === after.render);
			check(`${fixture.name}: the reply was published`, key(after.render) === key(REPLY));
		}
		// One explicit golden, so "identical" cannot be satisfied by two identically wrong paths.
		const golden = await makeProject(FOUR);
		await recordMemoryDocument(golden, REPLY, CAP);
		const seeded = await readMemoryJournal(journalPath(golden));
		check("legacy fixture: one seed record then one replacement", seeded.entries.length === 2 && seeded.entries[0].op === "replace" && key(seeded.entries[1].text) === key(REPLY));
	}

	console.log("=== T3: an edit the pass already read is published normally ===");
	{
		const root = await makeProject(FOUR);
		await recordMemoryDocument(root, FOUR, CAP);
		await sleep(25);
		await writeFile(memoryPath(root), HAND);
		// The pass reads after the edit landed, so its baseline already carries it.
		const basisKey = (await loadMemory(root, CAP)).text;
		const result = await recordMemoryDocument(root, REPLY, CAP, { basisKey });
		const log = await readFile(logPath(root), "utf8").catch(() => "");
		check("an edit read before the pass is not a race", result.written === true);
		check("the reply is published", key((await shape(root)).render) === key(REPLY));
		check("nothing claims the reply was discarded", !log.includes("was not published"));
	}

	console.log("=== T4: no journal, the mid-call edit wins ===");
	{
		const root = await makeProject(FOUR);
		const basisKey = (await loadMemory(root, CAP)).text;
		await sleep(25);
		await writeFile(memoryPath(root), HAND);
		const result = await recordMemoryDocument(root, REPLY, CAP, { basisKey });
		const journal = await readMemoryJournal(journalPath(root));
		check("the reply is not published", result.written === false);
		check("the edit stays on disk byte for byte", (await readFile(memoryPath(root), "utf8")) === HAND);
		check("no journal record holds the reply", journal.entries.every((entry) => key(entry.text) !== key(REPLY)));
	}

	console.log("=== cleared memory: the existing semantics, both shapes ===");
	{
		const blank = await makeProject(FOUR);
		await recordMemoryDocument(blank, FOUR, CAP);
		const blankBasis = (await loadMemory(blank, CAP)).text;
		await writeFile(memoryPath(blank), "");
		const blankResult = await recordMemoryDocument(blank, REPLY, CAP, { basisKey: blankBasis });
		check("a blanked file does not refuse the reply", blankResult.written === true);

		// A document that still carries the header is content, not a blank: the clear wins and the
		// reply is refused. Pinned here so the behaviour is explicit rather than incidental.
		const header = await makeProject(FOUR);
		await recordMemoryDocument(header, FOUR, CAP);
		const headerBasis = (await loadMemory(header, CAP)).text;
		await sleep(25);
		await writeFile(memoryPath(header), "# Project Memory\n");
		const headerResult = await recordMemoryDocument(header, REPLY, CAP, { basisKey: headerBasis });
		check("a header-only rewrite refuses the reply", headerResult.written === false);
		check("and its bytes stay on disk", (await readFile(memoryPath(header), "utf8")) === "# Project Memory\n");
	}

	console.log("=== T2: the core timing, through the real pass ===");
	for (const sub of [
		{ name: "reply carries a context section", reply: { memory_markdown: REPLY, context: { title: "t", summary: "s", key_points: [], open_tasks: [] } }, claimsContext: true },
		{ name: "reply carries no context section", reply: { memory_markdown: REPLY }, claimsContext: false },
	]) {
		const root = await makeProject(FOUR);
		await recordMemoryDocument(root, FOUR, CAP);
		await writeFile(contextPath(root), "# Project Context\n\n## Summary\nKept.\n");
		await sleep(25);
		const factory = await loadDefault(`${PC}/index.ts`);
		const pi = makePi({ cwd: root });
		await factory(pi);
		const ctx = makeCtx(root, {
			sessionManager: makeSessionManager([messageEntry("m1", "user", "remember this", "2026-09-12T10:00:00.000Z")], "external-edit"),
		});
		const contextBefore = await readFile(contextPath(root), "utf8");
		ctx.modelRegistry.complete = async () => {
			await sleep(25);
			await writeFile(memoryPath(root), HAND);
			return { content: [{ type: "text", text: JSON.stringify(sub.reply) }] };
		};
		await pi.commands.get("memory").handler("update", ctx);

		const after = await shape(root);
		const log = await readFile(logPath(root), "utf8").catch(() => "");
		const reply = String(ctx.notifications.at(-1)?.[0] ?? "");

		check(`${sub.name}: the hand edit is still the effective memory`, after.render === HAND);
		check(`${sub.name}: the reply never entered the journal`, key(after.ops) !== "" && !after.ops.includes(key(REPLY)));
		check(`${sub.name}: the edit entered the journal`, after.ops.includes(key(HAND)));
		check(`${sub.name}: the refusal is in the log`, log.includes("the reply was not published"));
		check(`${sub.name}: the adoption is still traced`, log.includes("adopted an externally edited MEMORY.md"));
		check(
			`${sub.name}: no write is claimed elsewhere in the log`,
			!log.includes("replaced a stored JSON reply") && !log.includes("exceeded") && !log.includes("shortened") && !log.includes("no longer carries"),
		);
		check(`${sub.name}: the command reply says the reply was discarded`, reply.includes("was discarded"));
		check(`${sub.name}: the command reply does not claim a cap`, !reply.includes("maxMemoryChars"));
		check(
			`${sub.name}: the context claim matches what happened`,
			sub.claimsContext ? reply.startsWith("Project context updated; ") : !reply.includes("Project context updated"),
		);
		if (!sub.claimsContext) {
			check(`${sub.name}: CONTEXT.md was left untouched`, (await readFile(contextPath(root), "utf8")) === contextBefore);
		}
	}
} finally {
	for (const root of tmpDirs) await rmTemp(root);
}

console.log(failures === 0 ? "\nALL OK" : `\nFAILURES: ${failures}`);
if (failures > 0) process.exitCode = 1;
