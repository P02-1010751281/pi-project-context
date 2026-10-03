import { loadDefault, loadNamespace, makePi, messageEntry, PC, PI } from "./harness.mjs";

/**
 * Registration and rendering checks:
 *  - the merged project-context extension registers the expected hooks, commands and flags
 *  - conversation projection produces text (the Bug 1 regression: raw SessionEntry[]
 *    passed straight to convertToLlm silently produced an empty conversation)
 *  - CONTEXT.md rendering keeps one line per session id and adds the current one
 */

const marker = "MARKER-registration-projection";
const entries = [
	messageEntry("m1", "user", `please ${marker}`, "2026-09-12T10:00:00.000Z"),
	messageEntry("m2", "assistant", "working on it", "2026-09-12T10:00:01.000Z"),
];

console.log("=== registration ===");
let failures = 0;
for (const [name, file] of [
	["project-context", `${PC}/index.ts`],
]) {
	try {
		const factory = await loadDefault(file);
		const pi = makePi();
		await factory(pi);
		const registrations = [...pi.handlers.keys()].map((event) => `on:${event}`).concat([...pi.commands.keys()].map((command) => `cmd:${command}`));
		console.log(`OK   ${name}: ${registrations.join(", ")}`);
		if (name === "project-context") {
			const expected = ["on:session_start", "on:before_agent_start", "on:turn_end", "on:agent_settled", "on:session_shutdown", "cmd:project-context", "cmd:memory", "cmd:session-log", "cmd:context", "cmd:autolearn", "cmd:handoff"];
			const missing = expected.filter((item) => !registrations.includes(item));
			if (missing.length > 0) {
				console.log(`FAIL missing registrations: ${missing.join(", ")}`);
				failures += 1;
			}
			// The naming consolidation deleted these outright: no alias, no transition period.
			const removed = ["cmd:memory-learn", "cmd:context-update", "cmd:auto-handoff"].filter((item) => registrations.includes(item));
			if (removed.length > 0) {
				console.log(`FAIL commands that should be gone are still registered: ${removed.join(", ")}`);
				failures += 1;
			}
			// Every surviving command answers Tab completion; none of them did before the rename.
			const withoutCompletion = [...pi.commands.entries()]
				.filter(([, options]) => typeof options.getArgumentCompletions !== "function")
				.map(([name]) => name);
			if (withoutCompletion.length > 0) {
				console.log(`FAIL commands without argument completion: ${withoutCompletion.join(", ")}`);
				failures += 1;
			}
			// Completion is filtering, not enumeration: the prefix narrows the list and a verb that takes
			// no second argument must not offer one.
			const memoryVerbs = await pi.commands.get("memory").getArgumentCompletions("u");
			if (!(memoryVerbs ?? []).some((item) => item.value === "update")) {
				console.log("FAIL /memory does not complete 'update'");
				failures += 1;
			}
			const guardValues = await pi.commands.get("handoff").getArgumentCompletions("guard " + "");
			if (!(guardValues ?? []).some((item) => item.value === "wait")) {
				console.log("FAIL /handoff does not complete the guard values");
				failures += 1;
			}
			if ((await pi.commands.get("context").getArgumentCompletions("")) !== null) {
				console.log("FAIL /context takes no arguments but offers completions");
				failures += 1;
			}
		}
	} catch (error) {
		console.log(`FAIL ${name}: ${error?.stack ?? error}`);
		failures += 1;
	}
}

console.log("\n=== conversation projection ===");
const { parseSessionEntries, sessionEntryToContextMessages } = await import(`${PI}/dist/core/session-manager.js`);
const { convertToLlm } = await import(`${PI}/dist/core/messages.js`);
const { serializeConversation } = await import(`${PI}/dist/core/compaction/utils.js`);
const raw = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
const parsed = parseSessionEntries(raw);
const messages = parsed.flatMap((entry) => sessionEntryToContextMessages(entry));
const fixed = serializeConversation(convertToLlm(messages));
const buggy = serializeConversation(convertToLlm(parsed));
console.log(`entries=${parsed.length} messages=${messages.length}`);
console.log(`projected path chars=${fixed.length} has marker=${fixed.includes(marker)}`);
console.log(`raw-entries path chars=${buggy.length} (expect 0)`);
if (!(fixed.includes(marker) && buggy.length === 0)) failures += 1;

console.log("\n=== context-doc rendering ===");
const { renderContextDocument } = await loadNamespace(`${PC}/memory/context-doc.ts`);
const { parseIndexLines, renderIndexDocument } = await loadNamespace(`${PC}/archive/session-index.ts`);
const existing = [
	"# Session Index",
	"",
	"- [old-one](old-one/session.md) — 2026-09-01 — old one",
	"- [old-two](old-two/session.md) — 2026-09-02 — old two",
	"",
].join("\n");
const indexLines = parseIndexLines(existing);
const indexDocument = renderIndexDocument(existing, "- [cur-sess](cur-sess/session.md) — 2026-09-12 — registration test");
const rendered = parseIndexLines(indexDocument);
const ids = rendered.map((line) => /^- \[([^\]]+)\]/.exec(line)?.[1]);
console.log(`existing lines=${indexLines.length} rendered=${rendered.length} (expect +1)`);
console.log(`current line last, no duplicate ids: ${indexDocument.includes("[cur-sess]") && new Set(ids).size === ids.length}`);
if (!(rendered.length === indexLines.length + 1 && new Set(ids).size === ids.length && indexDocument.includes("[cur-sess]"))) failures += 1;

const contextDocument = renderContextDocument({
	title: "registration test",
	summary: "rendering",
	key_points: ["a"],
	open_tasks: ["b"],
}, { updatedAt: "2026-09-12T00:00:00.000Z" });
console.log(`CONTEXT.md has no session index: ${!contextDocument.includes("## Session index")}`);
if (!(contextDocument.includes("## Summary") && contextDocument.includes("rendering") && !contextDocument.includes("## Session index"))) failures += 1;

console.log(failures === 0 ? "\nALL OK" : `\nFAILURES: ${failures}`);
if (failures > 0) process.exitCode = 1;
