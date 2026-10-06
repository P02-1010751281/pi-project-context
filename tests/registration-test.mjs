import { readdir, readFile } from "node:fs/promises";
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
			const expected = ["on:session_start", "on:before_agent_start", "on:turn_end", "on:agent_settled", "on:session_shutdown", "cmd:project-context", "cmd:memory", "cmd:session-log", "cmd:autolearn", "cmd:handoff"];
			const missing = expected.filter((item) => !registrations.includes(item));
			if (missing.length > 0) {
				console.log(`FAIL missing registrations: ${missing.join(", ")}`);
				failures += 1;
			}
			// `/context` retired in v0.3.0: its three lines moved to the layer commands that own them
			// (the context file to `/memory`, the session index and log directory to `/session-log`).
			if (registrations.includes("cmd:context")) {
				console.log("FAIL /context is still registered");
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
			// One fact keeps one name: the path lookup lives in the layer commands' bare calls, and the
			// umbrella's `on|off` is a target-less batch (no feature names, no `all`).
			const sessionVerbs = (await pi.commands.get("session-log").getArgumentCompletions("")) ?? [];
			const sessionMissing = ["write", "import", "on", "off"].filter((verb) => !sessionVerbs.some((item) => item.value === verb));
			if (sessionMissing.length > 0) {
				console.log(`FAIL /session-log does not complete: ${sessionMissing.join(", ")}`);
				failures += 1;
			}
			const memoryMenu = (await pi.commands.get("memory").getArgumentCompletions("")) ?? [];
			for (const verb of ["update", "on", "off", "max-memory"]) {
				if (!memoryMenu.some((item) => item.value === verb)) {
					console.log(`FAIL /memory does not complete ${verb}`);
					failures += 1;
				}
			}
			if (!((await pi.commands.get("memory").getArgumentCompletions("max-memory ")) ?? []).some((item) => item.value === "default")) {
				console.log("FAIL /memory max-memory does not complete 'default'");
				failures += 1;
			}
			const umbrellaVerbs = (await pi.commands.get("project-context").getArgumentCompletions("")) ?? [];
			for (const verb of ["status", "on", "off", "model", "max-tokens"]) {
				if (!umbrellaVerbs.some((item) => item.value === verb)) {
					console.log(`FAIL /project-context does not complete ${verb}`);
					failures += 1;
				}
			}
			if (umbrellaVerbs.some((item) => item.value === "max-memory")) {
				console.log("FAIL /project-context still completes max-memory");
				failures += 1;
			}
			if ((await pi.commands.get("project-context").getArgumentCompletions("on ")) !== null) {
				console.log("FAIL /project-context on|off offers a target (it is the target-less batch)");
				failures += 1;
			}
			const handoffVerbs = (await pi.commands.get("handoff").getArgumentCompletions("")) ?? [];
			for (const verb of ["status", "on", "off", "threshold", "budget", "mode", "guard", "lang", "now"]) {
				if (!handoffVerbs.some((item) => item.value === verb)) {
					console.log(`FAIL /handoff does not complete ${verb}`);
					failures += 1;
				}
			}
			// `thinking` was retired with its write-only config key in v0.4.2: a completion that suggests it
			// would send the user into the unknown-option branch.
			for (const gone of ["auto", "target", "keep", "send", "draft", "thinking"]) {
				if (handoffVerbs.some((item) => item.value === gone)) {
					console.log(`FAIL /handoff still completes the retired verb ${gone}`);
					failures += 1;
				}
			}
			if (!((await pi.commands.get("handoff").getArgumentCompletions("budget ")) ?? []).some((item) => item.value === "summary")) {
				console.log("FAIL /handoff budget does not complete 'summary'");
				failures += 1;
			}
			if (!((await pi.commands.get("handoff").getArgumentCompletions("budget recent ")) ?? []).some((item) => item.value === "off")) {
				console.log("FAIL /handoff budget recent does not complete 'off'");
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

console.log("\n=== command spellings in user-facing strings ===");
{
	// v0.3.0 moved `max-memory` from /project-context to /memory, and three messages kept sending people
	// to the removed verb until review R3 caught them. Sweep the sources, not the strings someone remembered.
	const files = (await readdir(PC, { recursive: true, withFileTypes: true }))
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
		.map((entry) => `${entry.parentPath}/${entry.name}`);
	let stale = 0;
	for (const file of files) {
		const text = await readFile(file, "utf8");
		if (text.includes("/project-context max-memory")) {
			stale += 1;
			console.log(`FAIL ${file} still points at /project-context max-memory (moved to /memory in v0.3.0)`);
		}
	}
	if (stale === 0) {
		console.log(`OK   no source string sends users to the removed /project-context max-memory (${files.length} files)`);
	} else {
		failures += 1;
	}
}
