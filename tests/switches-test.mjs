import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadDefault, loadNamespace, makeCtx, makePi, makeSessionManager, messageEntry, PC, runHandlers, waitUntil } from "./harness.mjs";

/**
 * Feature-switch tests: every feature has an on/off switch in project-context.json,
 * switches gate automatic behavior, `/project-context on|off` persists them, and
 * --no-project-context disables the whole extension for one run.
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
	await command.handler("off autolearn", ctx);

	console.log("\n=== archive switch ===");
	await command.handler("off archive", ctx);
	check("off persisted", (await readConfig())?.archiveEnabled === false);
	await runHandlers(pi, "session_start", ctx);
	await runHandlers(pi, "turn_end", ctx);
	const logDir = path.join(tmp, ".agents/memory/session-logs/sw-session");
	check(
		"no archive written while off",
		await stayedQuiet(async () => (await readFile(path.join(logDir, "session.jsonl"), "utf8").catch(() => "")).length > 0),
	);

	await command.handler("on archive", ctx);
	await runHandlers(pi, "turn_end", ctx);
	check("archive written after on", await waitUntil(async () => (await readFile(path.join(logDir, "session.jsonl"), "utf8").catch(() => "")).includes("turn 0")));

	console.log("\n=== memory switch ===");
	await command.handler("off autolearn", ctx); // isolate the model-call checks below
	const injected = await runHandlers(pi, "before_agent_start", ctx, { systemPrompt: "base" });
	const promptText = injected.filter(Boolean).map((result) => result.systemPrompt).join("\n");
	check("memory on injects MEMORY.md and CONTEXT.md", promptText.includes("## Project Memory") && promptText.includes("## Project Context"));

	await command.handler("off memory", ctx);
	const skipped = await runHandlers(pi, "before_agent_start", ctx, { systemPrompt: "base" });
	check("memory off injects nothing", skipped.every((result) => result === undefined));
	const callsBefore = modelCalls;
	await runHandlers(pi, "agent_settled", ctx);
	check("memory off does not call the model", await stayedQuiet(() => modelCalls === callsBefore + 1));

	await command.handler("on memory", ctx);
	await runHandlers(pi, "agent_settled", ctx);
	check("memory on consolidates", await waitUntil(() => modelCalls === callsBefore + 1));
	// The write lands after the model call resolves: wait for the file, not for the counter.
	check(
		"MEMORY.md rewritten",
		await waitUntil(async () => (await readFile(path.join(tmp, ".agents/memory/MEMORY.md"), "utf8")).includes("Switch test project updated.")),
	);

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
	await pi.commands.get("auto-handoff").handler("0.5", ctx);
	await command.handler("off handoff", ctx);
	await runHandlers(pi, "session_start", ctx);
	await runHandlers(pi, "agent_settled", ctx);
	check("off: no handoff triggered", await stayedQuiet(() => pi.sentMessages.length > 0));

	await command.handler("on handoff", ctx);
	await runHandlers(pi, "session_start", ctx);
	await runHandlers(pi, "agent_settled", ctx);
	check("on: handoff trigger sent", await waitUntil(() => pi.sentMessages.length === 1));
	check("trigger is the force-auto command", pi.sentMessages[0] === "/auto-handoff force-auto");

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

	console.log("\n=== off all / on all ===");
	const FEATURE_KEYS = ["archiveEnabled", "autoConsolidate", "autoLearn", "handoffEnabled"];
	await command.handler("off all", ctx);
	const allOff = await readConfig();
	check("all off persisted", FEATURE_KEYS.every((key) => allOff?.[key] === false));
	await command.handler("on all", ctx);
	const allOn = await readConfig();
	check("all on persisted", FEATURE_KEYS.every((key) => allOn?.[key] === true));

	console.log("\n=== legacy autolearn.json compatibility ===");
	await rm(configPath, { force: true });
	await writeFile(path.join(tmp, ".agents/memory/autolearn.json"), `${JSON.stringify({ at: 123, enabled: false })}\n`);
	const { getConfig } = await loadNamespace(`${PC}/config.ts`);
	const legacy = await getConfig(tmp);
	check("legacy enabled=false maps to the switch", legacy.autoLearn === false);
	check("legacy throttle timestamp kept", legacy.autolearnAt === 123);

	console.log("\n=== nested config layout still loads (and upgrades on save) ===");
	await rm(path.join(tmp, ".agents/memory/autolearn.json"), { force: true });
	await writeFile(configPath, `${JSON.stringify({
		features: { archive: false, memory: false, autolearn: true, handoff: false },
		autolearn: { at: 456, turns: 7, intervalMs: 60_000 },
		consolidateTurns: 9,
		handoff: { threshold: 0.6, autoTargetTokens: 32_000, keepRecentTokens: 1_000, summaryThinking: "session", mode: "draft", guard: "skip" },
	}, null, 2)}\n`);
	const { getConfig: getNested, setFeature: setNested } = await loadNamespace(`${PC}/config.ts`);
	const nested = await getNested(tmp);
	check("nested switches mapped", nested.archiveEnabled === false && nested.autoConsolidate === false && nested.handoffEnabled === false && nested.autoLearn === true);
	check("nested threshold maps to adaptive=false + ratio", nested.handoffAdaptive === false && nested.handoffThresholdRatio === 0.6);
	check("nested handoff settings mapped", nested.handoffTargetTokens === 32_000 && nested.handoffKeepTokens === 1_000 && nested.handoffSummaryThinking === "session" && nested.handoffMode === "draft" && nested.handoffGuard === "skip");
	check("nested autolearn state mapped", nested.autolearnAt === 456 && nested.autolearnTurns === 7 && nested.autolearnIntervalMs === 60_000);
	check("flat consolidation cadence read", nested.consolidateTurns === 9 && nested.consolidateIntervalMs === 300_000 && nested.forceDedupeMs === 15_000);
	await setNested(tmp, "archive", true);
	const upgraded = await readConfig();
	check("file rewritten flat on save", upgraded.archiveEnabled === true && upgraded.features === undefined && upgraded.autolearn === undefined && upgraded.handoff === undefined);
	check("upgraded flat values kept", upgraded.handoffAdaptive === false && upgraded.handoffThresholdRatio === 0.6 && upgraded.autolearnAt === 456 && upgraded.autolearnTurns === 7);
	check("upgraded cadence kept", upgraded.consolidateTurns === 9 && upgraded.consolidateIntervalMs === 300_000);
} finally {
	await rm(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL OK" : `\nFAILURES: ${failures}`);
if (failures > 0) process.exitCode = 1;
