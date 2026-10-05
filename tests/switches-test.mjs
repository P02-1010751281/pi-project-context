import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadDefault, loadNamespace, makeCtx, makePi, makeSessionManager, messageEntry, PC, rmTemp, runHandlers, waitUntil } from "./harness.mjs";

/**
 * Feature-switch tests: every feature has an on/off switch in project-context.json,
 * switches gate automatic behavior, each layer command owns its own on/off while the bare
 * `/project-context on|off` is the target-less batch, and --no-project-context disables the
 * whole extension for one run.
 */

const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-switches-"));
let failures = 0;
function check(label, value) {
	console.log(`${value ? "OK  " : "FAIL"} ${label}`);
	if (!value) failures += 1;
}
/** Bounded negative probe: settle handlers are fire-and-forget, so "nothing happened" needs a bound. */
const stayedQuiet = async (predicate, timeoutMs = 150) => !(await waitUntil(predicate, timeoutMs));
const configPath = path.join(tmp, ".agents/memory/project-context.json");
const readConfig = () => readFile(configPath, "utf8").then((raw) => JSON.parse(raw)).catch(() => undefined);

try {
	await mkdir(path.join(tmp, ".agents/memory"), { recursive: true });
	await writeFile(path.join(tmp, ".agents/memory/MEMORY.md"), "# Project Memory\n\n## Project\n- Switch test project.\n");
	await writeFile(path.join(tmp, ".agents/memory/CONTEXT.md"), "# Project Context\n\n## Summary\nSwitch test context.\n");

	// Six user turns so the consolidation throttle (6 turns) lets a pass run on settle.
	const entries = Array.from({ length: 6 }, (_, index) => [
		messageEntry(`u${index}`, "user", `turn ${index}`, `2026-09-12T10:0${index}:00.000Z`),
		messageEntry(`a${index}`, "assistant", `answer ${index}`, `2026-09-12T10:0${index}:01.000Z`),
	]).flat();

	const factory = await loadDefault(`${PC}/index.ts`);
	const pi = makePi({ cwd: tmp });
	await factory(pi);
	const ctx = makeCtx(tmp, { sessionManager: makeSessionManager(entries, "sw-session"), getContextUsage: () => ({ tokens: 150_000, contextWindow: 200_000, percent: 75 }) });

	let modelCalls = 0;
	let learnCalls = 0;
	ctx.modelRegistry.complete = async (_model, context) => {
		modelCalls += 1;
		const prompt = context.messages[0].content[0].text;
		if (prompt.includes("Maintain durable project memory")) {
			return { content: [{ type: "text", text: JSON.stringify({ memory_markdown: "# Project Memory\n\n## Project\n- Switch test project updated.", context: { title: "Switch test", summary: "updated", key_points: [], open_tasks: [] } }) }] };
		}
		// Any other completion is an autolearn pass (its prompt asks for a skill).
		learnCalls += 1;
		return { content: [{ type: "text", text: JSON.stringify({ skill: null }) }] };
	};

	const command = pi.commands.get("project-context");
	const lastNotification = () => String(ctx.notifications.at(-1)?.[0] ?? "");
	const status = async () => {
		await command.handler("status", ctx);
		return lastNotification();
	};

	console.log("=== status / persistence ===");
	const initial = await status();
	check("all features on by default", ["archive=on", "memory=on", "autolearn=on", "handoff=on"].every((item) => initial.includes(item)));
	check("status shows the config path", initial.includes("project-context.json"));
	// Turn the autolearn switch off before the first settle: with it off from the start, any
	// autolearn completion in this test is a switch violation, which makes the probe below a
	// cumulative check instead of one that a mutated gate can satisfy earlier and hide.
	await pi.commands.get("autolearn").handler("off", ctx);

	console.log("\n=== archive switch ===");
	await pi.commands.get("session-log").handler("off", ctx);
	check("off persisted", (await readConfig())?.archiveEnabled === false);
	await runHandlers(pi, "session_start", ctx);
	await runHandlers(pi, "turn_end", ctx);
	const logDir = path.join(tmp, ".agents/memory/session-logs/sw-session");
	check(
		"no archive written while off",
		await stayedQuiet(async () => (await readFile(path.join(logDir, "session.jsonl"), "utf8").catch(() => "")).length > 0),
	);

	await pi.commands.get("session-log").handler("on", ctx);
	await runHandlers(pi, "turn_end", ctx);
	check("archive written after on", await waitUntil(async () => (await readFile(path.join(logDir, "session.jsonl"), "utf8").catch(() => "")).includes("turn 0")));

	// The bare call is a read path: pi writes the archive itself at turn_end, agent_settled and
	// session_shutdown, so it must not carry that write as a side effect. Removing the archive first is
	// the proof — a read cannot bring it back, and `write` is the verb that can.
	await rm(logDir, { recursive: true, force: true });
	await pi.commands.get("session-log").handler("", ctx);
	const bareLog = lastNotification();
	check("bare /session-log writes nothing", !(await readFile(path.join(logDir, "session.jsonl"), "utf8").catch(() => "")));
	check(
		"bare /session-log prints its status line and both paths",
		bareLog.includes("Session archive:") && bareLog.includes("Session index: ") && bareLog.includes("Session logs: "),
	);
	await pi.commands.get("session-log").handler("write", ctx);
	check("`write` writes the archive", await waitUntil(async () => (await readFile(path.join(logDir, "session.jsonl"), "utf8").catch(() => "")).includes("turn 0")));

	console.log("\n=== /context retired: the layer commands print its lines ===");
	{
		// `/context` printed three paths; the layers that own them print them now (the context file from
		// `/memory`, the index and the log directory from `/session-log`). The context-file line is
		// rendered by one helper for both `/memory` and the umbrella, so the two sides are compared line
		// by line — never as whole blocks, because the umbrella's copy carries an updated timestamp.
		const contextPath = path.join(tmp, ".agents/memory/CONTEXT.md");
		await pi.commands.get("memory").handler("", ctx);
		const memoryBare = lastNotification();
		await command.handler("status", ctx);
		const statusBody = lastNotification();
		const contextLine = (text) => (text.split("\n").find((entry) => entry.startsWith("Context file: ")) ?? "").replace(/ — updated .*/, "");
		check("/memory prints the context-file line", contextLine(memoryBare) === `Context file: ${contextPath}`);
		check("the umbrella prints the same context-file line", contextLine(statusBody) === contextLine(memoryBare));
		check("/session-log owns the other two lines", !memoryBare.includes("Session index:") && !memoryBare.includes("Session logs:"));
	}

	console.log("\n=== memory switch ===");
	await pi.commands.get("autolearn").handler("off", ctx); // isolate the model-call checks below
	const injected = await runHandlers(pi, "before_agent_start", ctx, { systemPrompt: "base" });
	const promptText = injected.filter(Boolean).map((result) => result.systemPrompt).join("\n");
	check("memory on injects MEMORY.md and CONTEXT.md", promptText.includes("## Project Memory") && promptText.includes("## Project Context"));

	await pi.commands.get("memory").handler("off", ctx);
	const skipped = await runHandlers(pi, "before_agent_start", ctx, { systemPrompt: "base" });
	check("memory off injects nothing", skipped.every((result) => result === undefined));
	const callsBefore = modelCalls;
	await runHandlers(pi, "agent_settled", ctx);
	check("memory off does not call the model", await stayedQuiet(() => modelCalls === callsBefore + 1));

	await pi.commands.get("memory").handler("on", ctx);
	await runHandlers(pi, "agent_settled", ctx);
	check("memory on consolidates", await waitUntil(() => modelCalls === callsBefore + 1));
	// The write lands after the model call resolves: wait for the file, not for the counter.
	check(
		"MEMORY.md rewritten",
		await waitUntil(async () => (await readFile(path.join(tmp, ".agents/memory/MEMORY.md"), "utf8")).includes("Switch test project updated.")),
	);
	// The status line reports what the injection actually reads and how old the context render is
	// (CONTEXT.md only moves when a pass returns one).
	const afterPass = await status();
	check("status names the memory source", /Memory: .*memory\.jsonl \(\d+ chars, \d+% of the \d+-char cap\)/.test(afterPass));
	check("status dates the context render", /Context file: .*CONTEXT\.md — updated \d{4}-\d{2}-\d{2}T[\d:]+Z \(.+ ago\)/.test(afterPass));

	console.log("\n=== autolearn switch ===");
	// The switch has been off since before the first settle, and its other gates (new material, an
	// archived session) are open, so this probe fails whenever a pass ran anywhere in this test —
	// including one that an earlier settle would otherwise have absorbed.
	const beforeManual = modelCalls;
	await runHandlers(pi, "agent_settled", ctx);
	check("autolearn off: no scheduled pass", await stayedQuiet(() => learnCalls > 0));
	await pi.commands.get("autolearn").handler("", ctx);
	check("manual /autolearn still runs", modelCalls === beforeManual + 1);

	console.log("\n=== handoff switch ===");
	// Fixed threshold so a synthetic conversation can cross it (auto mode needs real bulk).
	await pi.commands.get("handoff").handler("threshold 0.5", ctx);
	await pi.commands.get("handoff").handler("off", ctx);
	await runHandlers(pi, "session_start", ctx);
	await runHandlers(pi, "agent_settled", ctx);
	check("off: no handoff triggered", await stayedQuiet(() => pi.sentMessages.length > 0));

	await pi.commands.get("handoff").handler("on", ctx);
	await runHandlers(pi, "session_start", ctx);
	await runHandlers(pi, "agent_settled", ctx);
	check("on: handoff trigger sent", await waitUntil(() => pi.sentMessages.length === 1));
	check("trigger is the force-auto command", pi.sentMessages[0] === "/handoff force-auto");

	console.log("\n=== --no-project-context (one run) ===");
	const pi2 = makePi({ cwd: tmp, flags: { "no-project-context": true } });
	await (await loadDefault(`${PC}/index.ts`))(pi2);
	const ctx2 = makeCtx(tmp, { sessionManager: makeSessionManager(entries, "sw-disabled") });
	await runHandlers(pi2, "session_start", ctx2);
	check("disabled notice shown", String(ctx2.notifications.at(-1)?.[0] ?? "").includes("--no-project-context"));
	await runHandlers(pi2, "turn_end", ctx2);
	check(
		"no archive written",
		await stayedQuiet(async () =>
			(await readFile(path.join(tmp, ".agents/memory/session-logs/sw-disabled/session.jsonl"), "utf8").catch(() => "")).length > 0,
		),
	);
	const disabledInject = await runHandlers(pi2, "before_agent_start", ctx2, { systemPrompt: "base" });
	check("no injection", disabledInject.every((result) => result === undefined));

	console.log("\n=== the umbrella on|off is the target-less batch ===");
	const FEATURE_KEYS = ["archiveEnabled", "memoryEnabled", "autolearnEnabled", "handoffEnabled"];
	// One name, one path: a target (the old `<feature|all>`) and a per-feature toggle now belong to the
	// layer commands, so the batch refuses the token instead of silently doing the same thing.
	const beforeBatch = await readConfig();
	await command.handler("off all", ctx);
	check("the batch refuses a target", lastNotification().includes("takes no target"));
	const afterBatch = await readConfig();
	check("the refused batch changed nothing", FEATURE_KEYS.every((key) => afterBatch?.[key] === beforeBatch?.[key]));
	await command.handler("off", ctx);
	const allOff = await readConfig();
	check("all off persisted", FEATURE_KEYS.every((key) => allOff?.[key] === false));
	await command.handler("on", ctx);
	const allOn = await readConfig();
	check("all on persisted", FEATURE_KEYS.every((key) => allOn?.[key] === true));

	console.log("\n=== legacy autolearn.json compatibility ===");
	await rm(configPath, { force: true });
	await writeFile(path.join(tmp, ".agents/memory/autolearn.json"), `${JSON.stringify({ at: 123, enabled: false })}\n`);
	const { getConfig, takeConfigMigrationNotice } = await loadNamespace(`${PC}/shared/config.ts`);
	const legacy = await getConfig(tmp);
	check("legacy enabled=false maps to the switch", legacy.autolearnEnabled === false);
	check("legacy throttle timestamp kept", legacy.autolearnAt === 123);
	// The migration is a write, so it says what it moved instead of rewriting the file silently.
	const movedFrom = takeConfigMigrationNotice(tmp);
	check("the migration names the layout it moved", Array.isArray(movedFrom) && movedFrom.some((item) => String(item).includes("autolearn.json")));
	check("the notice is consumed once", takeConfigMigrationNotice(tmp) === undefined);

	console.log("\n=== nested config layout still loads (and upgrades on save) ===");
	await rm(path.join(tmp, ".agents/memory/autolearn.json"), { force: true });
	await writeFile(configPath, `${JSON.stringify({
		features: { archive: false, memory: false, autolearn: true, handoff: false },
		autolearn: { at: 456, turns: 7, intervalMs: 60_000 },
		consolidateTurns: 9,
		// `maxTokens` was added after the unification and never had a legacy term, so the nested record
		// must not move it: that is the freeze that keeps the migration from growing a term per key.
		handoff: { threshold: 0.6, autoTargetTokens: 32_000, keepRecentTokens: 1_000, summaryThinking: "session", mode: "draft", guard: "skip", maxTokens: 999 },
	}, null, 2)}\n`);
	const { getConfig: getNested, takeConfigMigrationNotice: takeNestedNotice, setFeature: setNested } = await loadNamespace(`${PC}/shared/config.ts`);
	const nested = await getNested(tmp);
	check("nested switches mapped", nested.archiveEnabled === false && nested.memoryEnabled === false && nested.handoffEnabled === false && nested.autolearnEnabled === true);
	check("nested threshold maps to adaptive=false + ratio", nested.handoffThresholdAuto === false && nested.handoffThresholdRatio === 0.6);
	check("nested handoff settings mapped", nested.handoffBudgetSummaryTokens === 32_000 && nested.handoffBudgetRecentTokens === 1_000);
	// `handoffThinking` was retired in v0.4.2; the nested `summaryThinking` it used to fold from must not
	// resurrect it (a retired key that came back would be write-only surface again).
	check("a retired key is not resurrected by the nested layout", !("handoffThinking" in nested));
	check("nested autolearn state mapped", nested.autolearnAt === 456 && nested.autolearnTurns === 7 && nested.autolearnIntervalMs === 60_000);
	check("flat consolidation cadence read", nested.consolidateTurns === 9 && nested.consolidateIntervalMs === 300_000 && nested.forceDedupeMs === 15_000);
	check("a key added after the unification gets no legacy term", nested.maxTokens === 8192);
	check("the nested migration names its source", (takeNestedNotice(tmp) ?? []).some((item) => String(item).includes("nested")));
	await setNested(tmp, "archive", true);
	const upgraded = await readConfig();
	check("file rewritten flat on save", upgraded.archiveEnabled === true && upgraded.features === undefined && upgraded.autolearn === undefined && upgraded.handoff === undefined);
	check("upgraded flat values kept", upgraded.handoffThresholdAuto === false && upgraded.handoffThresholdRatio === 0.6 && upgraded.autolearnAt === 456 && upgraded.autolearnTurns === 7);
	check("upgraded cadence kept", upgraded.consolidateTurns === 9 && upgraded.consolidateIntervalMs === 300_000);
	console.log("\n=== v0.4.0 key renames migrate once ===");
	// A file written before the rename carries the old flat names. They fold into the new ones the same
	// one-time way a legacy layout does, and the rewrite drops them; a project that never had them is untouched.
	await rm(configPath, { force: true });
	await writeFile(configPath, `${JSON.stringify({
		autoLearn: false,
		autoConsolidate: false,
		handoffTargetTokens: 48_000,
		handoffKeepTokens: 12_000,
		handoffAdaptive: false,
		handoffLanguage: "zh",
		handoffSummaryThinking: "session",
	}, null, 2)}\n`);
	const { getConfig: getRenamed, takeConfigMigrationNotice: takeRenamedNotice } = await loadNamespace(`${PC}/shared/config.ts`);
	const renamedConfig = await getRenamed(tmp);
	check("old switch names fold into the new ones", renamedConfig.autolearnEnabled === false && renamedConfig.memoryEnabled === false);
	check("old budget names fold into the new ones", renamedConfig.handoffBudgetSummaryTokens === 48_000 && renamedConfig.handoffBudgetRecentTokens === 12_000);
	check("old threshold and lang names fold in", renamedConfig.handoffThresholdAuto === false && renamedConfig.handoffLang === "zh");
	check("the retired thinking name folds into nothing", !("handoffThinking" in renamedConfig));
	check("the rename migration names itself", (takeRenamedNotice(tmp) ?? []).some((item) => String(item).includes("pre-v0.4")));
	const rewritten = JSON.parse(await readFile(configPath, "utf8"));
	check(
		"the old names are gone from the file",
		["autoLearn", "autoConsolidate", "handoffTargetTokens", "handoffKeepTokens", "handoffAdaptive", "handoffLanguage", "handoffSummaryThinking"].every(
			(key) => rewritten[key] === undefined,
		),
	);
	check("the new names are written", rewritten.memoryEnabled === false && rewritten.autolearnEnabled === false && rewritten.handoffBudgetSummaryTokens === 48_000);

	// Each case needs a fresh module instance: `getConfig` caches per project for the life of the module, so a
	// second call in the same instance would answer from memory and the file rewrite below would go unseen.
	const freshConfig = async () => (await loadNamespace(`${PC}/shared/config.ts`)).getConfig;
	await rm(configPath, { force: true });
	await writeFile(configPath, `${JSON.stringify({ autoLearn: false, autolearnEnabled: true, handoffTargetTokens: 64_000, handoffBudgetSummaryTokens: 32_000 }, null, 2)}\n`);
	const bothNames = await (await freshConfig())(tmp);
	check("the new name wins when both are present", bothNames.autolearnEnabled === true && bothNames.handoffBudgetSummaryTokens === 32_000);

	// A junk old value falls back to the default instead of entering the config unchecked.
	await rm(configPath, { force: true });
	await writeFile(configPath, `${JSON.stringify({ handoffTargetTokens: "nope", handoffKeepTokens: -5 }, null, 2)}\n`);
	const junk = await (await freshConfig())(tmp);
	check("a junk old value falls back to the default", junk.handoffBudgetSummaryTokens === 64_000 && junk.handoffBudgetRecentTokens === 20_000);


	console.log("\n=== a handoff save must not revert another writer's switch ===");
	// The whole-snapshot writer `saveConfig(projectRoot, config)` (removed in ed2704c) wrote this
	// module's entire session-start snapshot, and `/project-context off memory` publishes a NEW cached
	// object, so the next `/handoff` command silently turned the memory switch back on. One
	// process, no crash, no notice.
	await pi.commands.get("memory").handler("off", ctx);
	check("memory is off before the handoff save", (await readConfig())?.memoryEnabled === false);
	await pi.commands.get("handoff").handler("lang zh", ctx);
	const afterHandoff = await readConfig();
	check("the memory switch survives a handoff save", afterHandoff?.memoryEnabled === false);
	check("the handoff key is still persisted", afterHandoff?.handoffLang === "zh");
	await pi.commands.get("memory").handler("on", ctx);

	console.log("\n=== the config write takes the cross-process lock ===");
	// `updateConfig` is a read-modify-write of one file shared by every process that mounts the project,
	// and each process holds its own cache: without re-reading under a lock the second writer publishes
	// its snapshot and reverts the first one's fields.
	{
		const lockFile = path.join(tmp, ".agents/memory/project-context.json.lock");
		await writeFile(lockFile, "stale");
		const longAgo = new Date(Date.now() - 60_000);
		await utimes(lockFile, longAgo, longAgo);
		await pi.commands.get("memory").handler("off", ctx);
		check("the config write consumed and released the stale lock", await stat(lockFile).then(() => false).catch(() => true));
		check("the write still landed", (await readConfig())?.memoryEnabled === false);
	}
} finally {
	await rmTemp(tmp);
}

console.log(failures === 0 ? "\nALL OK" : `\nFAILURES: ${failures}`);
if (failures > 0) process.exitCode = 1;
