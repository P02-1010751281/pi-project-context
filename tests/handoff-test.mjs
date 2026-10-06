import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadDefault, loadNamespace, loadShared, makeCtx, makePi, makeSessionManager, contentEntry, messageEntry, PC, PI, rmTemp, runHandlers, toolResultEntry, waitUntil } from "./harness.mjs";

/**
 * Handoff scaffolding tests: the continuation prompt follows the conversation language
 * (`auto`), an explicit `lang` config wins, carried-over continuation prompts are replaced
 * by an omission marker in the verbatim replay slice, and the `runHandoff` call sites are pinned
 * through a `newSession` mock (review round 5, F3/F5). The handoff makes no model call, so the
 * integration block also pins that no model call happens.
 */

const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-handoff-"));
let failures = 0;
function check(label, value) {
	console.log(`${value ? "OK  " : "FAIL"} ${label}`);
	if (!value) failures += 1;
}
const configPath = path.join(tmp, ".agents/memory/project-context.json");
const readConfig = () => readFile(configPath, "utf8").then((raw) => JSON.parse(raw)).catch(() => undefined);
/** Verbatim reply the "no model call" checks reject: the handoff must never reach a model. */
const UNEXPECTED_MODEL_CALL = "the handoff must not call a model";

try {
	await mkdir(path.join(tmp, ".agents/memory"), { recursive: true });

	const handoff = await loadNamespace(`${PC}/handoff/handoff.ts`);
	const settings = await loadNamespace(`${PC}/handoff/session-settings.ts`);
	const lineage = await loadNamespace(`${PC}/handoff/session-lineage.ts`);

	console.log("=== detectHandoffLanguage ===");
	check("Chinese user text picks zh", handoff.detectHandoffLanguage(["那做了呗，统一一下", "把记忆也改成 append-only 的模型，别残留隐患"]) === "zh");
	check("English user text picks en", handoff.detectHandoffLanguage(["fix the bug", "add tests for the replay slice"]) === "en");
	check("short Chinese sample falls back to en", handoff.detectHandoffLanguage(["B C A", "好"]) === "en");
	check(
		"Chinese prose dominates code-heavy samples",
		handoff.detectHandoffLanguage(["这段代码 memory.jsonl 的 fold 逻辑要按 mtime 判断外部编辑，不要每次重扫", "const value = await readJson(file);"]) === "zh",
	);

	console.log("\n=== buildHandoffPrompt ===");
	const base = {
		percent: 16,
		keptTokens: 20_000,
		guardWaiting: false,
		fileOperations: "<read-files>\na.ts\n</read-files>",
		previousSessionId: "01a0a58e-7ef4-7763-95f3-5bcf04fdc388",
		previousSessionFile: "/home/user/.pi/agent/sessions/x.jsonl",
	};
	const zh = handoff.buildHandoffPrompt({ ...base, language: "zh" });
	check("zh preamble carries the percent", zh.startsWith("本会话接手上一会话（其上下文窗口已用 16%）。"));
	// No generated summary section: the details heading, the pointer and the file list are the payload.
	check("zh carries the details heading and no summary section", zh.includes("## 上一会话信息") && !zh.includes("## 交接摘要"));
	check("zh carries the file list", zh.includes("<read-files>") && zh.includes("a.ts"));
	check("zh details", zh.includes("- 上一会话 id：01a0a58e") && zh.includes("- 原始记录（JSONL）：/home/user/.pi/agent/sessions/x.jsonl"));
	check("zh detail lookup merges index and how-to", zh.includes(".agents/memory/session-logs/INDEX.md 指向的会话日志里查"));
	check("zh closing", zh.trimEnd().endsWith("从上次中断处继续。"));
	check("zh has no English scaffolding", !zh.includes("## Handoff Summary") && !zh.includes("Continue the task from where it left off."));

	const en = handoff.buildHandoffPrompt({ ...base, language: "en" });
	check(
		"en keeps the scaffolding shape",
		en.startsWith("This session continues work handed off from a previous session (16% of its context window had been used).") &&
			en.includes("## Previous session details") &&
			!en.includes("## Handoff Summary") &&
			en.trimEnd().endsWith("Continue the task from where it left off."),
	);

	const zhSummaryOnly = handoff.buildHandoffPrompt({ ...base, language: "zh", keptTokens: 0 });
	check("zh no-carry line says nothing was carried", zhSummaryOnly.includes("上一会话没有原文带入本会话"));

	const zhGuarded = handoff.buildHandoffPrompt({ ...base, language: "zh", guardWaiting: true, pendingQuestion: "选 1 还是 2？" });
	check("zh guarded prompt carries the question", zhGuarded.includes("## 待用户回答的问题") && zhGuarded.includes("选 1 还是 2？"));
	check("zh guarded prompt waits for the user", zhGuarded.trimEnd().endsWith("任务停在上面的问题上。不要替用户选选项或开工，等用户回答。"));
	// The pending state is announced once, by the pending block plus the closing line; the old early
	// announcement duplicated it. Single-sided pin: re-adding that line reddens this assertion.
	check("zh guarded prompt announces the pending state once", !zhGuarded.includes("这个决定仍未决"));

	const noFile = handoff.buildHandoffPrompt({ ...base, language: "zh", previousSessionFile: undefined });
	check("no transcript line without a session file", !noFile.includes("原始记录"));
	check("zh unknown percent is localized", handoff.buildHandoffPrompt({ ...base, language: "zh", percent: null }).includes("已用 阈值以上）。"));
	check(
		"en unknown percent keeps the legacy wording",
		handoff.buildHandoffPrompt({ ...base, language: "en", percent: null }).startsWith("This session continues work handed off from a previous session (over threshold"),
	);

	console.log("\n=== isHandoffPromptText ===");
	// Literal text generated by the pre-language build (kept 01a0a58e's prompt shape).
	const legacy = [
		"This session continues work handed off from a previous session (16% of its context window had been used).",
		"The handoff summary below covers the earlier part of that session; its most recent messages were carried over verbatim.",
		"Verify the current state of files with tools before re-applying changes, and do not redo completed work.",
		"",
		"## Handoff Summary",
		"",
		"## Goal\n- 收尾。",
		"",
		"## Previous session details",
		"- Previous session id: 01a0a58e-7ef4-7763-95f3-5bcf04fdc388",
		"Continue the task from where it left off.",
	].join("\n");
	check("recognizes a generated zh prompt", handoff.isHandoffPromptText(zh));
	check("recognizes a generated en prompt", handoff.isHandoffPromptText(en));
	check("recognizes a legacy English prompt", handoff.isHandoffPromptText(legacy));
	check("ordinary user message is not a prompt", !handoff.isHandoffPromptText("那做了呗，统一一下"));
	check("assistant report is not a prompt", !handoff.isHandoffPromptText("## Goal\n- 收尾。"));
	check("a quote prefixed by the user is not a prompt", !handoff.isHandoffPromptText(`补，但是当前会话怎么出现了：\n${en}`));
	check("a quote with appended text is not a prompt", !handoff.isHandoffPromptText(`${en}\n\n顺便问一下，这个 HANDOFF.md 为什么没人看？`));
	check("a legacy quote with appended text is not a prompt", !handoff.isHandoffPromptText(`${legacy}\n另外把 v0.1.3 也处理一下`));
	check("headings alone are not a prompt", !handoff.isHandoffPromptText("## Handoff Summary\n\n没什么。"));
	check("empty text is not a prompt", !handoff.isHandoffPromptText("   "));

	console.log("\n=== replayMessagesFor ===");
	const entries = [
		messageEntry("e1", "user", "那做了呗，统一一下", "2026-09-16T00:41:39.660Z"),
		messageEntry("e2", "user", legacy, "2026-09-16T00:41:39.844Z"),
		messageEntry("e3", "assistant", "按交接要求先核对当前实际状态。", "2026-09-16T00:41:44.876Z"),
		contentEntry("e3a", "assistant", [{ type: "toolCall", id: "tc9", name: "bash", arguments: { command: "git log" } }], "2026-09-16T00:41:45.000Z"),
		toolResultEntry("e4", "tc9", "=== HEAD ===\ne4d48c4", "2026-09-16T00:41:57.106Z"),
		messageEntry("e5", "user", zh, "2026-09-16T00:41:58.000Z"),
	];
	const kept = handoff.replayMessagesFor(entries);
	check("stale continuation prompts are replaced by the marker", kept.filter((message) => message.content?.[0]?.text === handoff.REPLAY_MARKER).length === 2);
	check("the raw prompt text never reaches the replay", !kept.some((message) => (message.content?.[0]?.text ?? "").includes("## Handoff Summary")));
	// e1, e3, the tool call and its paired result stay; the two prompts become markers.
	check("real conversation stays in the slice", kept.filter((message) => message.content?.[0]?.text !== handoff.REPLAY_MARKER).length === 4);

	console.log("\n=== replay block shape ===");
	// A slice that starts on a carried-over prompt used to be kept as-is (user-first); replacing
	// it must not make the block open with an assistant message, which some providers reject.
	const cutSlice = [
		messageEntry("c0", "user", legacy, "2026-09-16T00:41:00.000Z"),
		messageEntry("c1", "assistant", "按交接要求先核对当前实际状态。", "2026-09-16T00:41:01.000Z"),
		messageEntry("c2", "user", "真实用户问题", "2026-09-16T00:41:02.000Z"),
	];
	const replayed = handoff.replayMessagesFor(cutSlice);
	check("the replay block still opens with a user message", replayed[0]?.role === "user");
	check("the opening message is the omission marker", replayed[0]?.content?.[0]?.text === handoff.REPLAY_MARKER);
	check("later real messages are untouched", replayed[2]?.content?.[0]?.text === "真实用户问题");
	const plain = handoff.replayMessagesFor([messageEntry("q0", "user", "普通消息", "2026-09-16T00:42:00.000Z"), messageEntry("q1", "assistant", "普通回答", "2026-09-16T00:42:01.000Z")]);
	check("no prompt means no marker", !plain.some((message) => message.content?.[0]?.text === handoff.REPLAY_MARKER));

	console.log("\n=== buildHandoffDocument ===");
	const docParts = {
		previousSessionId: "01a0a7a9-7235-7763-95f3-5bdc121f5eff",
		projectRoot: "/tmp/proj",
		sessionLogRel: ".agents/memory/session-logs/01a0a7a9/session.md",
		fileOperations: "<modified-files>\na.ts\n</modified-files>",
		createdAt: "2026-09-16T00:50:03.901Z",
	};
	const zhDoc = handoff.buildHandoffDocument({ ...docParts, language: "zh" });
	check("zh document header", zhDoc.startsWith("# pi 会话 01a0a7a9-7235-7763-95f3-5bdc121f5eff 的交接文档") && zhDoc.includes("- 生成时间：2026-09-16T00:50:03.901Z"));
	check("zh document fields", zhDoc.includes("- 项目：/tmp/proj") && zhDoc.includes("- 会话日志：.agents/memory/session-logs/01a0a7a9/session.md") && zhDoc.includes("- 会话索引：.agents/memory/session-logs/INDEX.md"));
	check("document carries the file list and no summary", zhDoc.includes("<modified-files>") && zhDoc.includes("a.ts") && !zhDoc.includes("## 交接摘要"));
	const enDoc = handoff.buildHandoffDocument({ ...docParts, language: "en" });
	check(
		"en document keeps the legacy header",
		enDoc.startsWith("# Handoff from pi session 01a0a7a9-7235-7763-95f3-5bdc121f5eff") && enDoc.includes("- Created: 2026-09-16T00:50:03.901Z"),
	);

	console.log("\n=== resolveLanguage (auto) ===");
	const msg = (role, text) => ({ role, content: [{ type: "text", text }] });
	const englishTask = [msg("user", "please implement item 2 and run the tests"), msg("assistant", "done")];
	check(
		"injected prompts do not poison the language decision",
		handoff.resolveLanguage([msg("user", zh), ...englishTask], "auto") === "en",
	);
	check(
		"the user's own Chinese decides zh",
		handoff.resolveLanguage([msg("user", "那做了呗，统一一下"), ...englishTask], "auto") === "zh",
	);
	check(
		"recent messages win over older ones",
		handoff.resolveLanguage([msg("user", "这段中文很长很长，说明一开始说的是中文。"), ...[1, 2, 3, 4, 5, 6, 7, 8].map((index) => msg("user", `english follow-up number ${index}`))], "auto") === "en",
	);
	check(
		"a tiny recent sample falls back to the whole session",
		handoff.resolveLanguage([msg("user", "中文背景说明，包含足够多的汉字。"), msg("user", "ok")], "auto") === "zh",
	);
	check("explicit config wins", handoff.resolveLanguage(englishTask, "zh") === "zh" && handoff.resolveLanguage([msg("user", "中文")], "en") === "en");
	check(
		"the omission marker is ignored by language sampling",
		handoff.resolveLanguage([msg("user", zh), msg("user", handoff.REPLAY_MARKER)], "auto") === "zh",
	);
	// Pins the runHandoff wiring: the decision samples the raw carried slice, so the prompt sitting
	// on the cut point stays visible to the carry-forward rule (a marker-substituted slice hides it).
	check(
		"the raw slice feeds the language decision",
		handoff.resolveLanguage(handoff.languageMessagesFor([msg("user", "older english turn")], [msg("user", zh), msg("user", "ok")]), "auto") === "zh",
	);
	check("a short Chinese reply keeps zh", handoff.resolveLanguage([msg("user", zh), msg("user", "继续")], "auto") === "zh");
	check(
		"a single-character reply carries the language forward",
		handoff.resolveLanguage([msg("user", zh), msg("user", "好")], "auto") === "zh",
	);
	check(
		"an ASCII reply carries the language forward",
		handoff.resolveLanguage([msg("user", zh), msg("user", "ok")], "auto") === "zh" &&
			handoff.resolveLanguage([msg("user", en), msg("user", "ok")], "auto") === "en",
	);
	check(
		"substantive English still flips to en",
		handoff.resolveLanguage([msg("user", zh), msg("user", "please implement item 2 and run the tests")], "auto") === "en",
	);

	console.log("\n=== config parsing ===");
	const parseConfig = async (raw) => {
		await writeFile(configPath, JSON.stringify(raw));
		return (await loadNamespace(`${PC}/shared/config.ts`)).getConfig(tmp);
	};
	const flat = await parseConfig({ handoffLang: "zh" });
	check("flat handoffLang loads", flat.handoffLang === "zh");
	const flatWins = await parseConfig({ handoffLang: "zh", handoff: { language: "en" } });
	check("flat value beats the nested legacy key", flatWins.handoffLang === "zh");
	const nestedInvalid = await parseConfig({ handoff: { language: "fr" } });
	check("invalid nested value falls back to auto", nestedInvalid.handoffLang === "auto");
	const nested = await parseConfig({ handoff: { language: "en" } });
	check("nested legacy handoff.language loads", nested.handoffLang === "en");
	const invalid = await parseConfig({ handoffLang: "fr" });
	check("unknown language falls back to auto", invalid.handoffLang === "auto");
	const defaults = await parseConfig({});
	check("defaults to auto", defaults.handoffLang === "auto");
	// Legacy global file (`~/.pi/agent/auto-handoff.json`); redirect the agent dir instead.
	const agentDir = path.join(tmp, "agentdir");
	await mkdir(agentDir, { recursive: true });
	await writeFile(path.join(agentDir, "auto-handoff.json"), JSON.stringify({ language: "en" }));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await writeFile(configPath, JSON.stringify({}));
		const globalLegacy = await (await loadNamespace(`${PC}/shared/config.ts`)).getConfig(tmp);
		check("global legacy language loads", globalLegacy.handoffLang === "en");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}

	console.log("\n=== /handoff lang ===");
	await writeFile(configPath, JSON.stringify({}));
	const pi = makePi({ cwd: tmp });
	await (await loadDefault(`${PC}/index.ts`))(pi);
	const ctx = makeCtx(tmp, { sessionManager: makeSessionManager([], "handoff-lang") });
	await runHandlers(pi, "session_start", ctx);
	const command = pi.commands.get("handoff");
	check("command registered", command !== undefined);
	await command.handler("lang zh", ctx);
	check("lang zh persists", (await readConfig())?.handoffLang === "zh");
	await command.handler("lang fr", ctx);
	check("invalid language warns and leaves the config", (await readConfig())?.handoffLang === "zh" && String(ctx.notifications.at(-1)?.[0] ?? "").includes("lang auto|zh|en"));
	await command.handler("lang auto", ctx);
	check("lang auto persists", (await readConfig())?.handoffLang === "auto");
	await command.handler("language zh", ctx);
	check("the language alias works", (await readConfig())?.handoffLang === "zh");
	await command.handler("lang EN", ctx);
	check("the language value is case-insensitive", (await readConfig())?.handoffLang === "en");
	await command.handler("lang", ctx);
	check("a missing value warns and leaves the config", (await readConfig())?.handoffLang === "en" && String(ctx.notifications.at(-1)?.[0] ?? "").includes("lang auto|zh|en"));
	await command.handler("lang auto", ctx);
	await command.handler("status", ctx);
	check("status reports the language", String(ctx.notifications.at(-1)?.[0] ?? "").includes("lang auto"));

	// v0.3.0 shrank the verb set: three bare-word forms became value-taking verbs, and the two token
	// amounts moved under `budget` with names that say which quantity they size.
	console.log("\n=== /handoff threshold | budget | mode ===");
	await command.handler("threshold 0.55", ctx);
	let verbs = await readConfig();
	check("threshold <ratio> pins a fixed share", verbs?.handoffThresholdAuto === false && verbs?.handoffThresholdRatio === 0.55);
	await command.handler("threshold 40%", ctx);
	check("threshold accepts a percentage", (await readConfig())?.handoffThresholdRatio === 0.4);
	await command.handler("threshold 0.9", ctx);
	await command.handler("threshold auto", ctx);
	verbs = await readConfig();
	check("threshold auto restores adaptive mode and keeps the ratio aside", verbs?.handoffThresholdAuto === true && verbs?.handoffThresholdRatio === 0.9);
	await command.handler("threshold nope", ctx);
	check(
		"an invalid threshold warns and leaves the config",
		(await readConfig())?.handoffThresholdRatio === 0.9 && String(ctx.notifications.at(-1)?.[0] ?? "").includes("Usage: /handoff threshold"),
	);
	await command.handler("budget summary 48k", ctx);
	check("budget summary sets the summary target", (await readConfig())?.handoffBudgetSummaryTokens === 48_000);
	await command.handler("budget recent 12k", ctx);
	check("budget recent sets the recent window", (await readConfig())?.handoffBudgetRecentTokens === 12_000);
	await command.handler("budget recent off", ctx);
	check("budget recent off carries nothing verbatim", (await readConfig())?.handoffBudgetRecentTokens === 0);
	await command.handler("budget summary 1", ctx);
	check(
		"a below-floor summary budget warns and leaves the config",
		(await readConfig())?.handoffBudgetSummaryTokens === 48_000 && String(ctx.notifications.at(-1)?.[0] ?? "").includes("Usage: /handoff budget"),
	);
	await command.handler("mode draft", ctx);
	check("mode draft persists", (await readConfig())?.handoffMode === "draft");
	await command.handler("mode nope", ctx);
	check("an invalid mode warns and leaves the config", (await readConfig())?.handoffMode === "draft" && String(ctx.notifications.at(-1)?.[0] ?? "").includes("Usage: /handoff mode"));
	// The retired bare forms must not act silently: a bare ratio used to pin the threshold and the bare
	// `send`/`draft` words used to set the mode.
	await command.handler("0.6", ctx);
	check(
		"the bare ratio is retired",
		(await readConfig())?.handoffThresholdRatio === 0.9 && String(ctx.notifications.at(-1)?.[0] ?? "").includes("Unknown option"),
	);
	await command.handler("send", ctx);
	check(
		"bare send is retired",
		(await readConfig())?.handoffMode === "draft" && String(ctx.notifications.at(-1)?.[0] ?? "").includes("Unknown option"),
	);

	console.log("\n=== /handoff now (nothing to hand off) ===");
	// A no-op handoff must explain itself: both bail-outs used to return without any notify.
	await writeFile(configPath, JSON.stringify({ handoffBudgetRecentTokens: 50 }));
	const quiet = makePi({ cwd: tmp });
	await (await loadDefault(`${PC}/index.ts`))(quiet);
	const emptyCtx = makeCtx(tmp, { sessionManager: makeSessionManager([], "handoff-empty") });
	await runHandlers(quiet, "session_start", emptyCtx);
	await quiet.commands.get("handoff").handler("now", emptyCtx);
	check(
		"an empty session reports the skip",
		String(emptyCtx.notifications.at(-1)?.[0] ?? "").includes("no messages yet") &&
			String(emptyCtx.notifications.at(-1)?.[1] ?? "") === "warning",
	);

	const short = makeSessionManager(
		[
			messageEntry("m1", "user", "你好", "2026-09-16T00:00:00.000Z"),
			messageEntry("m2", "assistant", "你好", "2026-09-16T00:00:01.000Z"),
		],
		"handoff-short",
	);
	const shortCtx = makeCtx(tmp, { sessionManager: short });
	await runHandlers(quiet, "session_start", shortCtx);
	await quiet.commands.get("handoff").handler("now", shortCtx);
	check(
		"a session inside the keep window reports the skip",
		String(shortCtx.notifications.at(-1)?.[0] ?? "").includes("nothing older than the recent window") &&
			String(shortCtx.notifications.at(-1)?.[1] ?? "") === "warning",
	);

	console.log("\n=== auto trigger backoff ===");
	// maybeTrigger fires on every settle; the trigger must not stack on the next one. Auto now sits at
	// the window boundary, so the mock conversation must fill most of the window — a tiny conversation
	// against a huge baseline leaves no usable threshold at all.
	await writeFile(configPath, JSON.stringify({ handoffEnabled: true, handoffBudgetRecentTokens: 50, handoffBudgetSummaryTokens: 8_000, memoryEnabled: false }));
	const auto = makePi({ cwd: tmp });
	await (await loadDefault(`${PC}/index.ts`))(auto);
	const filler = "documentation line repeated to give the session real context weight. ".repeat(700);
	// buildContextEntries walks the parent chain from the leaf, so the mock entries must link.
	const firstTurn = messageEntry("a1", "user", filler, "2026-09-16T00:00:00.000Z");
	const secondTurn = messageEntry("a2", "assistant", "已收到。", "2026-09-16T00:00:01.000Z");
	secondTurn.parentId = firstTurn.id;
	const triggerTurn = messageEntry("t1", "user", filler.repeat(15), "2026-09-15T23:59:00.000Z");
	const triggerReply = messageEntry("t2", "assistant", "已收到。", "2026-09-15T23:59:01.000Z");
	triggerReply.parentId = triggerTurn.id;
	const autoCtx = makeCtx(tmp, {
		sessionManager: makeSessionManager([triggerTurn, triggerReply], "handoff-auto"),
		mode: "tui",
		getContextUsage: () => ({ tokens: 190_000, percent: 95, contextWindow: 200_000 }),
	});
	await runHandlers(auto, "session_start", autoCtx);
	await runHandlers(auto, "agent_settled", autoCtx);
	await waitUntil(() => auto.sentMessages.includes("/handoff force-auto"));
	check("the threshold triggers the scheduled handoff", auto.sentMessages.includes("/handoff force-auto"));
	// The mock has no newSession, so the manual command fails; it must still release the trigger and
	// not stack another one on the next settle.
	await auto.commands.get("handoff").handler("force-auto", autoCtx);
	await runHandlers(auto, "agent_settled", autoCtx);
	// Negative assertion: a pending setTimeout(0) trigger runs before this timer, so one flush is enough.
	await new Promise((resolve) => setTimeout(resolve, 0));
	check("an attempted auto handoff does not retrigger on the next settle", auto.sentMessages.length === 1);

	console.log("\n=== adaptive threshold: the conservative knee, with a physical floor ===");
	// Auto hands off at the **two-term** guardrail: the lower of the model's conservative quality knee
	// (honest windows keep their own boundary, large ones saturate at the population-median knee) and
	// the last usable point before pi's own compaction reserve, minus the tier margin. The only cap is
	// the first pricing tier. `handoffBudgetSummaryTokens` is a
	// manual **request**, not a term on that line: it cannot lift the trigger, and when the guardrail
	// lands below what it asked for the receipt names it (checked below).
	await writeFile(configPath, JSON.stringify({ handoffEnabled: true, handoffBudgetRecentTokens: 20_000, handoffBudgetSummaryTokens: 64_000 }));
	// `handoff` here is a direct namespace load: it reads the module defaults (keep 20k / target 64k /
	// ratio 0.4, same as the config written above). The extension-driven checks below load their own
	// instance and go through the project config.
	const floorCtx = makeCtx(tmp, {
		sessionManager: makeSessionManager([firstTurn, secondTurn], "handoff-floor"),
		mode: "tui",
		// 12k of conversation, so the measured baseline is small and the target math stays low.
		getContextUsage: () => ({ tokens: 24_000, percent: 2.4, contextWindow: 1_000_000 }),
	});
	const wide = handoff.resolveThreshold(floorCtx, floorCtx.getContextUsage());
	check("a wide window hands off at the conservative knee", wide?.tokens === 157_000);
	check("the label reports the knee it triggers at", String(wide?.label ?? "").includes("auto 157k (16%)"));
	check("the knee threshold reports the effective drop amount", wide?.dropTokens === 125_076);
	check("a knee threshold reports the adaptive bound", wide?.bound === "adaptive");
	// The conservative curve keeps honest windows on their own boundary and saturates for inflated ones.
	const midCtx = makeCtx(tmp, {
		sessionManager: makeSessionManager([firstTurn, secondTurn], "handoff-mid"),
		getContextUsage: () => ({ tokens: 24_000, percent: 8.8, contextWindow: 272_000 }),
	});
	const mid = handoff.resolveThreshold(midCtx, midCtx.getContextUsage());
	check("a 272K window hands off at its own boundary", mid?.tokens === 251_616 && mid?.bound === "adaptive");
	const honestCtx = makeCtx(tmp, {
		sessionManager: makeSessionManager([firstTurn, secondTurn], "handoff-honest"),
		getContextUsage: () => ({ tokens: 24_000, percent: 6, contextWindow: 400_000 }),
	});
	check("a 400K honest window keeps its own boundary", handoff.resolveThreshold(honestCtx, honestCtx.getContextUsage())?.tokens === 379_616);
	const curveCtx = makeCtx(tmp, {
		sessionManager: makeSessionManager([firstTurn, secondTurn], "handoff-curve"),
		getContextUsage: () => ({ tokens: 24_000, percent: 3, contextWindow: 768_000 }),
	});
	check("the conservative curve saturates above the transition", handoff.resolveThreshold(curveCtx, curveCtx.getContextUsage())?.tokens === 157_001);
	// A heavy baseline pushes the physical floor above the knee. The floor is a **refusal gate, not a
	// lift**: raising the trigger to `baseline + keep + target` here (583_924) is what the two-term rule
	// forbids, because it would let a 1M-window model run to 584k — past the very knee the curve exists
	// to distrust. Auto refuses instead, and the receipt names the knee as the cause.
	const heavyCtx = makeCtx(tmp, {
		sessionManager: makeSessionManager([firstTurn, secondTurn], "handoff-heavy"),
		getContextUsage: () => ({ tokens: 512_000, percent: 51, contextWindow: 1_000_000 }),
	});
	check(
		"a heavy baseline whose floor sits above the knee leaves no threshold",
		handoff.resolveThreshold(heavyCtx, heavyCtx.getContextUsage()) === undefined,
	);
	check(
		"the heavy-baseline refusal blames the quality knee, not the target or the window",
		handoff.thresholdRefusal(heavyCtx, heavyCtx.getContextUsage()) === "below-quality-knee",
	);
	// `handoffBudgetSummaryTokens` is a manual request the guardrail may refuse. Raising it must not move the
	// trigger — pi's old `max(boundary, targetValue)` lifted this one to 232k — and the refusal must be
	// visible: a user who raises the target and reads the same threshold has been sent to a dead control.
	// This needs a project config (the direct `handoff` namespace above holds the module defaults).
	const targetTmp = await mkdtemp(path.join(os.tmpdir(), "pi-handoff-target-"));
	try {
		await mkdir(path.join(targetTmp, ".agents/memory"), { recursive: true });
		await writeFile(
			path.join(targetTmp, ".agents/memory/project-context.json"),
			JSON.stringify({ handoffEnabled: true, handoffBudgetRecentTokens: 20_000, handoffBudgetSummaryTokens: 200_000 }),
		);
		const targetPi = makePi({ cwd: targetTmp });
		await (await loadDefault(`${PC}/index.ts`))(targetPi);
		const targetCtx = makeCtx(targetTmp, {
			sessionManager: makeSessionManager([firstTurn, secondTurn], "handoff-target"),
			mode: "tui",
			getContextUsage: () => ({ tokens: 24_000, percent: 2.4, contextWindow: 1_000_000 }),
		});
		await runHandlers(targetPi, "session_start", targetCtx);
		await targetPi.commands.get("handoff").handler("status", targetCtx);
		const targetReceipt = String(targetCtx.notifications.at(-1)?.[0] ?? "");
		check("a raised target cannot lift the trigger above the knee", targetReceipt.includes("auto 157k (16%)"));
		check(
			"the overridden target is named, not silently ignored",
			/· handoff budget summary 200k is not applied in full/.test(targetReceipt),
		);
		check("the warning names the guardrail that bound it", /quality knee allows 157k/.test(targetReceipt));
	} finally {
		await rmTemp(targetTmp);
	}
	// The dropped prefix costs nothing to produce now, so no auxiliary window bounds the threshold and
	// `resolveThreshold` takes no summary model.
	// A window that cannot hold baseline + keep + the minimum drop is not a threshold at all.
	const tinyCtx = makeCtx(tmp, {
		sessionManager: makeSessionManager([firstTurn, secondTurn], "handoff-tiny"),
		getContextUsage: () => ({ tokens: 24_000, percent: 60, contextWindow: 40_000 }),
	});
	check("a window too small for the configuration resolves to no threshold", handoff.resolveThreshold(tinyCtx, tinyCtx.getContextUsage()) === undefined);
	const tierCtx = makeCtx(tmp, {
		sessionManager: makeSessionManager([firstTurn, secondTurn], "handoff-tier"),
		model: { provider: "test", id: "tiered", cost: { tiers: [{ inputTokensAbove: 120_000 }] } },
		getContextUsage: () => ({ tokens: 24_000, percent: 2.4, contextWindow: 1_000_000 }),
	});
	const tiered = handoff.resolveThreshold(tierCtx, tierCtx.getContextUsage());
	check("a pricing tier cap wins when it is below the knee", tiered?.bound === "tier" && tiered?.tokens === 116_000);
	// The tier cap can only bind at or above the physical floor (`baseline + keep + 8000` = 39,924
	// here). Exactly on the margin it caps to the floor; below it the two constraints are
	// unsatisfiable and auto must fail closed instead of silently crossing the paid boundary.
	const tierEdgeCtx = makeCtx(tmp, {
		sessionManager: makeSessionManager([firstTurn, secondTurn], "handoff-tier-edge"),
		model: { provider: "test", id: "tier-edge", cost: { tiers: [{ inputTokensAbove: 43_924 }] } },
		getContextUsage: () => ({ tokens: 24_000, percent: 2.4, contextWindow: 1_000_000 }),
	});
	const tierEdge = handoff.resolveThreshold(tierEdgeCtx, tierEdgeCtx.getContextUsage());
	check("a tier edge exactly at floor + margin caps to the floor", tierEdge?.bound === "tier" && tierEdge?.tokens === 39_924);
	check("the floor-level tier cap still reports the minimum drop amount", tierEdge?.dropTokens === 8_000);
	const tierBelowCtx = makeCtx(tmp, {
		sessionManager: makeSessionManager([firstTurn, secondTurn], "handoff-tier-below"),
		model: { provider: "test", id: "tier-below", cost: { tiers: [{ inputTokensAbove: 43_000 }] } },
		getContextUsage: () => ({ tokens: 24_000, percent: 2.4, contextWindow: 1_000_000 }),
	});
	check("a tier edge inside the floor leaves no threshold", handoff.resolveThreshold(tierBelowCtx, tierBelowCtx.getContextUsage()) === undefined);
	// Every refusal above used to render as "auto (no room at this window)" — a claim about the
	// window. Only the window-too-small cause is about the window; the tier one is **billing**, and a
	// user told "no room at this window" goes and changes the model or the target in vain. The status
	// line must name the term that actually refused.
	check(
		"a window that cannot hold the configuration is reported as a small window",
		handoff.thresholdRefusal(tinyCtx, tinyCtx.getContextUsage()) === "window-too-small",
	);
	check(
		"the tier refusal is attributed to the pricing tier, not the window",
		handoff.thresholdRefusal(tierBelowCtx, tierBelowCtx.getContextUsage()) === "below-first-tier",
	);
	check(
		"a resolved threshold has no refusal cause",
		handoff.thresholdRefusal(floorCtx, floorCtx.getContextUsage()) === undefined,
	);
	const tierReceipt = handoff.handoffStatusLine(tierBelowCtx);
	check(
		"the status line does not blame the window for a billing refusal",
		/auto \(/.test(tierReceipt) && !/no room at this window/.test(tierReceipt) && !/window too small/.test(tierReceipt),
	);
	const smallReceipt = handoff.handoffStatusLine(tinyCtx);
	check("the status line explains the tier refusal", /pricing tier/.test(tierReceipt));
	check(
		"the two refusals do not render as the same sentence",
		smallReceipt !== tierReceipt && /window too small/.test(smallReceipt),
	);
	// `handoffThresholdRatio` belongs to fixed mode, and `/handoff auto` takes no parameters.
	const fixedTmp = await mkdtemp(path.join(os.tmpdir(), "pi-handoff-fixed-"));
	try {
		await mkdir(path.join(fixedTmp, ".agents/memory"), { recursive: true });
		await writeFile(
			path.join(fixedTmp, ".agents/memory/project-context.json"),
			JSON.stringify({ handoffEnabled: true, handoffThresholdAuto: false, handoffThresholdRatio: 0.6 }),
		);
		const fixedPi = makePi({ cwd: fixedTmp });
		await (await loadDefault(`${PC}/index.ts`))(fixedPi);
		const fixedCtx = makeCtx(fixedTmp, {
			sessionManager: makeSessionManager([firstTurn, secondTurn], "handoff-fixed"),
			mode: "tui",
			getContextUsage: () => ({ tokens: 24_000, percent: 2.4, contextWindow: 1_000_000 }),
		});
		await runHandlers(fixedPi, "session_start", fixedCtx);
		await fixedPi.commands.get("handoff").handler("status", fixedCtx);
		check("fixed mode uses the configured window share", String(fixedCtx.notifications.at(-1)?.[0] ?? "").includes("60% of window"));
		await fixedPi.commands.get("handoff").handler("threshold auto 0.7", fixedCtx);
		check(
			"adaptive mode rejects a ratio argument",
			fixedCtx.notifications.some((entry) => String(entry?.[0] ?? "").includes("takes no ratio")),
		);
		const persisted = JSON.parse(await readFile(path.join(fixedTmp, ".agents/memory/project-context.json"), "utf8"));
		check(
			"adaptive mode does not persist the rejected ratio",
			persisted.handoffThresholdAuto === true && persisted.handoffThresholdRatio === 0.6,
		);
	} finally {
		await rmTemp(fixedTmp);
	}
	// The ratio parser's range and the shared constants are one source: mutating the constant alone has to
	// move the parser with it (settings.ts imports them rather than repeating the literals).
	const [ratioSettings, ratioConstants] = await loadShared([
		`${PC}/handoff/settings.ts`,
		`${PC}/shared/config.ts`,
	]);
	check(
		"the ratio parser accepts the shared maximum",
		ratioSettings.parseRatio(String(ratioConstants.MAX_THRESHOLD_RATIO)) === ratioConstants.MAX_THRESHOLD_RATIO,
	);
	check(
		"the ratio parser refuses just above the shared maximum",
		ratioSettings.parseRatio(String((ratioConstants.MAX_THRESHOLD_RATIO + 0.01).toFixed(2))) === undefined,
	);
	check(
		"the ratio parser accepts the shared minimum",
		ratioSettings.parseRatio(String(ratioConstants.MIN_THRESHOLD_RATIO)) === ratioConstants.MIN_THRESHOLD_RATIO,
	);
	check(
		"the ratio parser refuses just below the shared minimum",
		ratioSettings.parseRatio(String((ratioConstants.MIN_THRESHOLD_RATIO - 0.01).toFixed(2))) === undefined,
	);
	// The physical floor guards fixed mode too: a ratio that resolves below `baseline + keep + MIN_DROP`
	// would hand off and drop almost nothing, so it is refused with its own cause rather than run. The two
	// modules load through one registry so the settings object mutated here is the one the math reads.
	const [fixedHandoff, fixedSettings, fixedThreshold] = await loadShared([
		`${PC}/handoff/handoff.ts`,
		`${PC}/handoff/settings.ts`,
		`${PC}/handoff/threshold.ts`,
	]);
	const savedAuto = fixedSettings.config.handoffThresholdAuto;
	const savedRatio = fixedSettings.config.handoffThresholdRatio;
	const fixedFloorCtx = makeCtx(tmp, {
		sessionManager: makeSessionManager([firstTurn, secondTurn], "handoff-fixed-floor"),
		mode: "tui",
		getContextUsage: () => ({ tokens: 50_000, percent: 50, contextWindow: 100_000 }),
	});
	const fixedWideCtx = makeCtx(tmp, {
		sessionManager: makeSessionManager([firstTurn, secondTurn], "handoff-fixed-wide"),
		mode: "tui",
		getContextUsage: () => ({ tokens: 50_000, percent: 5, contextWindow: 1_000_000 }),
	});
	try {
		fixedSettings.config.handoffThresholdAuto = false;
		fixedSettings.config.handoffThresholdRatio = 0.1;
		check(
			"a fixed ratio below the physical floor resolves to no threshold",
			fixedHandoff.resolveThreshold(fixedFloorCtx, fixedFloorCtx.getContextUsage()) === undefined,
		);
		check(
			"the fixed-floor refusal has its own cause",
			fixedHandoff.thresholdRefusal(fixedFloorCtx, fixedFloorCtx.getContextUsage()) === "fixed-below-floor",
		);
		check(
			"the same ratio above the floor still resolves",
			fixedHandoff.resolveThreshold(fixedWideCtx, fixedWideCtx.getContextUsage())?.tokens === 100_000,
		);
		// The gate is inclusive, and the floor it compares against is the one the refusal text quotes: read it
		// from the sentence, then place the threshold exactly on it and one step below.
		const floorTokens =
			fixedThreshold.baselineTokens(fixedFloorCtx, fixedFloorCtx.getContextUsage()) +
			fixedSettings.config.handoffBudgetRecentTokens +
			8_000;
		const floorText = fixedHandoff.thresholdRefusalText("fixed-below-floor", fixedFloorCtx, fixedFloorCtx.getContextUsage());
		const quotedFloor = Math.round(Number((floorText.match(/([\d.]+)k-token floor/) ?? [])[1]) * 1000);
		check(
			"the refusal text quotes the floor it compared against",
			Number.isFinite(quotedFloor) && Math.abs(quotedFloor - floorTokens) <= 100,
		);
		const atFloorCtx = makeCtx(tmp, {
			sessionManager: makeSessionManager([firstTurn, secondTurn], "handoff-fixed-at-floor"),
			mode: "tui",
			getContextUsage: () => ({ tokens: 50_000, percent: 5, contextWindow: floorTokens * 10 }),
		});
		check(
			"a fixed threshold exactly at the floor resolves",
			fixedHandoff.resolveThreshold(atFloorCtx, atFloorCtx.getContextUsage())?.tokens === floorTokens,
		);
		const belowFloorCtx = makeCtx(tmp, {
			sessionManager: makeSessionManager([firstTurn, secondTurn], "handoff-fixed-below-floor"),
			mode: "tui",
			getContextUsage: () => ({ tokens: 50_000, percent: 5, contextWindow: (floorTokens - 1_000) * 10 }),
		});
		check(
			"a fixed threshold below the floor is refused",
			fixedHandoff.resolveThreshold(belowFloorCtx, belowFloorCtx.getContextUsage()) === undefined,
		);
		// `fmtTokens` rounds to 0.1k, so a threshold just under the floor can render the same as it: the
		// sentence must not read "the 78.0k threshold is below the 78.0k floor".
		const nearFloorCtx = makeCtx(tmp, {
			sessionManager: makeSessionManager([firstTurn, secondTurn], "handoff-fixed-near-floor"),
			mode: "tui",
			getContextUsage: () => ({ tokens: 50_000, percent: 5, contextWindow: floorTokens * 10 - 10 }),
		});
		const nearFloorText = fixedHandoff.thresholdRefusalText(
			"fixed-below-floor",
			nearFloorCtx,
			nearFloorCtx.getContextUsage(),
		);
		check("the near-floor refusal still reads as a refusal", /below the .*floor/.test(nearFloorText));
		check(
			"the refusal never calls a number below itself",
			!/the ([\d.]+k)-token threshold is below the \1-token floor/.test(nearFloorText),
		);
	} finally {
		fixedSettings.config.handoffThresholdAuto = savedAuto;
		fixedSettings.config.handoffThresholdRatio = savedRatio;
	}
	// And through the extension, so the receipt the user reads is pinned as well.
	const fixedFloorTmp = await mkdtemp(path.join(os.tmpdir(), "pi-handoff-fixed-floor-"));
	try {
		await mkdir(path.join(fixedFloorTmp, ".agents/memory"), { recursive: true });
		await writeFile(
			path.join(fixedFloorTmp, ".agents/memory/project-context.json"),
			JSON.stringify({
				handoffEnabled: true,
				handoffThresholdAuto: false,
				// Derived from the shared minimum so a constant move does not silently invalidate the fixture.
				handoffThresholdRatio: ratioConstants.MIN_THRESHOLD_RATIO,
			}),
		);
		const fixedFloorPi = makePi({ cwd: fixedFloorTmp });
		await (await loadDefault(`${PC}/index.ts`))(fixedFloorPi);
		const narrowCtx = makeCtx(fixedFloorTmp, {
			sessionManager: makeSessionManager([firstTurn, secondTurn], "handoff-fixed-floor-e2e"),
			mode: "tui",
			getContextUsage: () => ({ tokens: 50_000, percent: 50, contextWindow: 100_000 }),
		});
		await runHandlers(fixedFloorPi, "session_start", narrowCtx);
		await fixedFloorPi.commands.get("handoff").handler("status", narrowCtx);
		const refusalReceipt = String(narrowCtx.notifications.at(-1)?.[0] ?? "");
		check(
			"the status line explains the fixed-floor refusal",
			/fixed/.test(refusalReceipt) && /floor/.test(refusalReceipt),
		);
		check(
			"the refusal names the real threshold and floor numbers",
			new RegExp(
				`fixed ${ratioConstants.MIN_THRESHOLD_RATIO * 100}% \\(the ${(ratioConstants.MIN_THRESHOLD_RATIO * 100).toFixed(1)}k-token threshold is below the [\\d.]+k-token floor`,
			).test(refusalReceipt),
		);
		const wideCtx = makeCtx(fixedFloorTmp, {
			sessionManager: makeSessionManager([firstTurn, secondTurn], "handoff-fixed-wide-e2e"),
			mode: "tui",
			getContextUsage: () => ({ tokens: 50_000, percent: 5, contextWindow: 1_000_000 }),
		});
		await runHandlers(fixedFloorPi, "session_start", wideCtx);
		await fixedFloorPi.commands.get("handoff").handler("status", wideCtx);
		check(
			"the status line shows the fixed share when the floor allows it",
			String(wideCtx.notifications.at(-1)?.[0] ?? "").includes(`${ratioConstants.MIN_THRESHOLD_RATIO * 100}% of window`),
		);
	} finally {
		await rmTemp(fixedFloorTmp);
	}
	const usableTmp = await mkdtemp(path.join(os.tmpdir(), "pi-handoff-usable-"));
	try {
		await mkdir(path.join(usableTmp, ".agents/memory"), { recursive: true });
		await writeFile(path.join(usableTmp, ".agents/memory/project-context.json"), JSON.stringify({ handoffEnabled: true }));
		const usablePi = makePi({ cwd: usableTmp });
		await (await loadDefault(`${PC}/index.ts`))(usablePi);
		const usableCtx = makeCtx(usableTmp, {
			sessionManager: makeSessionManager([], "handoff-usable"),
			getContextUsage: () => ({ tokens: 1, percent: 0, contextWindow: 64_000 }),
		});
		await runHandlers(usablePi, "session_start", usableCtx);
		await usablePi.commands.get("handoff").handler("status", usableCtx);
		// The usable window is one of the two adaptive terms, not a cap bolted on afterwards, so the
		// receipt reports the value without a "capped by" suffix. The number is unchanged: the old target
		// lift pushed it to 84k and the usable window then capped it back to the same 43.6k.
		const usableReceipt = String(usableCtx.notifications.at(-1)?.[0] ?? "");
		check("status reports the adaptive value at the usable-window limit", usableReceipt.includes("auto 43.6k (68%)"));
		check("the usable window is not reported as a bolt-on cap", !usableReceipt.includes("capped by"));
		check("status reports the effective drop amount under the guardrail", usableReceipt.includes("drop 23.6k"));
	} finally {
		await rmTemp(usableTmp);
	}

	console.log("\n=== auto trigger: the knee and the floor stop an early handoff ===");
	// The threshold math derives the baseline as usage − estimated conversation, so a mock whose
	// conversation is tiny reports a huge baseline and its floor (`baseline + keep + target`) lands
	// above the knee. That used to be rescued by lifting the trigger with the target, which the
	// two-term rule now forbids — so the fixture has to keep usage consistent with the conversation
	// instead of leaning on the lift. A session below the 157k knee does not hand off; a 620k one
	// whose baseline stayed small clears the floor and does.
	const bulkTurn = messageEntry("b1", "user", filler.repeat(10), "2026-09-16T00:01:00.000Z");
	const bulkReply = messageEntry("b2", "assistant", "已收到。", "2026-09-16T00:01:01.000Z");
	bulkReply.parentId = bulkTurn.id;
	const loudTurn = messageEntry("b3", "user", filler.repeat(50), "2026-09-16T00:01:02.000Z");
	const loudReply = messageEntry("b4", "assistant", "已收到。", "2026-09-16T00:01:03.000Z");
	loudReply.parentId = loudTurn.id;
	const floorQuietPi = makePi({ cwd: tmp });
	await (await loadDefault(`${PC}/index.ts`))(floorQuietPi);
	const quietCtx = makeCtx(tmp, {
		sessionManager: makeSessionManager([bulkTurn, bulkReply], "handoff-quiet"),
		mode: "tui",
		getContextUsage: () => ({ tokens: 140_000, percent: 14, contextWindow: 1_000_000 }),
	});
	await runHandlers(floorQuietPi, "session_start", quietCtx);
	await runHandlers(floorQuietPi, "agent_settled", quietCtx);
	await new Promise((resolve) => setTimeout(resolve, 0));
	check("a session below the knee does not hand off", floorQuietPi.sentMessages.length === 0);
	// The same extension on a session well past the knee: the baseline stays small, the floor clears,
	// and the trigger fires.
	const loudCtx = makeCtx(tmp, {
		sessionManager: makeSessionManager([loudTurn, loudReply], "handoff-loud"),
		mode: "tui",
		getContextUsage: () => ({ tokens: 620_000, percent: 62, contextWindow: 1_000_000 }),
	});
	await runHandlers(floorQuietPi, "session_start", loudCtx);
	await runHandlers(floorQuietPi, "agent_settled", loudCtx);
	await waitUntil(() => floorQuietPi.sentMessages.includes("/handoff force-auto"));
	check("a session above the floor does hand off", floorQuietPi.sentMessages.includes("/handoff force-auto"));

	console.log("\n=== replay block shape (mid-turn cut) ===");
	// The keep-budget cut can land inside a turn, so the slice opens on an assistant message, which
	// Anthropic/Gemini routes reject; it gets a user-role stand-in for the dropped prefix.
	const turnEntries = [
		contentEntry("k0", "user", [{ type: "text", text: "原始请求" }], "2026-09-16T00:43:00.000Z"),
		contentEntry(
			"k1",
			"assistant",
			[{ type: "text", text: "先看实现。" }, { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "cat x" } }],
			"2026-09-16T00:43:01.000Z",
		),
	];
	const midTurn = handoff.replayMessagesFor([turnEntries[1], toolResultEntry("k2", "tc1", "输出", "2026-09-16T00:43:02.000Z")]);
	check("a mid-turn slice opens with the split-turn marker", midTurn[0]?.role === "user" && midTurn[0]?.content?.[0]?.text === handoff.SPLIT_TURN_MARKER);
	check("the tool call and its result stay paired after the marker", midTurn[1]?.content?.[1]?.type === "toolCall" && midTurn[2]?.content?.[0]?.text === "输出");
	check("a slice that already opens with a user message gets no split marker", handoff.replayMessagesFor([turnEntries[0]])[0]?.content?.[0]?.text === "原始请求");
	// A cut can land on a summary entry that the replay filters out, exposing a tool result whose
	// call lives in the dropped prefix: the orphan is dropped and the block still opens user-first.
	const filteredInputs = [
		contentEntry("s0", "branchSummary", [{ type: "text", text: "分支摘要" }], "2026-09-16T00:44:00.000Z"),
		contentEntry("s1", "toolResult", [{ type: "text", text: "结果" }], "2026-09-16T00:44:01.000Z"),
		contentEntry("s2", "assistant", [{ type: "text", text: "继续。" }], "2026-09-16T00:44:02.000Z"),
	];
	const orphanInbox = [];
	const filteredHead = handoff.replayMessagesFor(filteredInputs, orphanInbox);
	check(
		"a filtered summary entry drops the orphan result and opens user-first",
		filteredHead[0]?.role === "user" &&
			filteredHead[0]?.content?.[0]?.text === handoff.SPLIT_TURN_MARKER &&
			filteredHead.map((message) => message.role).join(",") === "user,assistant",
	);
	check("the dropped orphan result is still reported", orphanInbox.length === 1 && orphanInbox[0]?.content?.[0]?.text === "结果");
	check(
		"a slice holding only orphan results replays nothing",
		handoff.replayMessagesFor([contentEntry("s3", "toolResult", [{ type: "text", text: "结果" }], "2026-09-16T00:44:03.000Z")]).length === 0,
	);
	// An orphan in the middle of a slice (its call is not part of it) is dropped as well, while a
	// result whose call is kept stays paired.
	const midOrphans = [];
	const midSlice = handoff.replayMessagesFor(
		[
			contentEntry("q0", "user", [{ type: "text", text: "用户" }], "2026-09-16T00:45:00.000Z"),
			toolResultEntry("q1", "gone", "孤儿结果", "2026-09-16T00:45:01.000Z"),
			contentEntry("q2", "assistant", [{ type: "toolCall", id: "keep1", name: "bash", arguments: {} }], "2026-09-16T00:45:02.000Z"),
			toolResultEntry("q3", "keep1", "配对结果", "2026-09-16T00:45:03.000Z"),
		],
		midOrphans,
	);
	check(
		"a mid-slice orphan is dropped and handed back",
		midOrphans.length === 1 && midOrphans[0]?.content?.[0]?.text === "孤儿结果" && !JSON.stringify(midSlice).includes("孤儿结果") && JSON.stringify(midSlice).includes("配对结果"),
	);
	const bashEntry = {
		type: "message",
		id: "s9",
		parentId: null,
		timestamp: "2026-09-16T00:44:04.000Z",
		message: { role: "bashExecution", command: "ls", output: "", timestamp: Date.parse("2026-09-16T00:44:04.000Z") },
	};
	check("a bash turn start needs no split marker", handoff.replayMessagesFor([bashEntry])[0]?.role === "bashExecution");

	console.log("\n=== runHandoff call sites ===");
	// Pins what the pure-function tests cannot: which slice is replayed, which language directive the
	// prompt gets, and that the replay is the post-cut slice. The handoff makes no model call at all, so
	// the integration block ends by asserting that every scenario above ran without one. (The raw-vs-marker
	// distinction inside the carried slice is behaviourally equivalent here, so it is deliberately not
	// asserted; see analysis R2.)
	let modelCalls = 0;
	const countModelCall = async () => {
		modelCalls += 1;
		throw new Error(UNEXPECTED_MODEL_CALL);
	};

	await writeFile(configPath, JSON.stringify({ handoffEnabled: true, handoffBudgetRecentTokens: 50, handoffBudgetSummaryTokens: 8_000, memoryEnabled: false }));
	const toolOutput = "tool output line that was read earlier in this turn. ".repeat(200);
	const pinEntries = [
		contentEntry("p1", "user", [{ type: "text", text: "Please make the memory journal append-only and add tests for it." }], "2026-09-16T00:50:00.000Z"),
		contentEntry(
			"p2",
			"assistant",
			[{ type: "text", text: "Reading the current implementation first." }, { type: "toolCall", id: "pc1", name: "bash", arguments: { command: "cat extensions/project-context/shared/project-state.ts" } }],
			"2026-09-16T00:50:01.000Z",
			"p1",
		),
		toolResultEntry("p3", "pc1", toolOutput, "2026-09-16T00:50:02.000Z", "p2"),
		contentEntry("p4", "assistant", [{ type: "text", text: "看完了，我来改。" }], "2026-09-16T00:50:03.000Z", "p3"),
		contentEntry("p5", "user", [{ type: "text", text: "好，动手。" }], "2026-09-16T00:50:04.000Z", "p4"),
	];
	const captureNewSession = (store) => async (options) => {
		const replacement = makeSessionManager([], "handoff-pin-next");
		await options.setup(replacement);
		store.replay = replacement.entries.slice();
		const replacementCtx = makeCtx(tmp, { sessionManager: replacement });
		store.notifications = replacementCtx.notifications;
		replacementCtx.sendUserMessage = (text) => {
			store.prompt = text;
		};
		await options.withSession(replacementCtx);
		return { cancelled: false };
	};
	const captured = { replay: [], prompt: undefined };
	const pinPi = makePi({ cwd: tmp });
	await (await loadDefault(`${PC}/index.ts`))(pinPi);
	const pinCtx = makeCtx(tmp, {
		sessionManager: makeSessionManager(pinEntries, "handoff-pin"),
		getContextUsage: () => ({ tokens: 200_000, percent: 20, contextWindow: 1_000_000 }),
		modelRegistry: {
			hasConfiguredAuth: () => true,
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
			complete: countModelCall,
		},
	});
	pinCtx.newSession = captureNewSession(captured);
	await runHandlers(pinPi, "session_start", pinCtx);
	await pinPi.commands.get("handoff").handler("now", pinCtx);

	check("the forced handoff switches sessions", captured.replay.length > 0 && captured.prompt !== undefined);
	check("the handoff reaches no model at all", modelCalls === 0);
	check("the continuation follows the conversation language", String(captured.prompt).startsWith("本会话接手上一会话（"));
	check(
		"the prompt carries no summary section",
		!String(captured.prompt).includes("## 交接摘要") && !String(captured.prompt).includes("## Handoff Summary"),
	);
	check(
		"the prompt points at the previous session and the log index",
		String(captured.prompt).includes("handoff-pin") &&
			String(captured.prompt).includes("session-logs/INDEX.md") &&
			String(captured.prompt).includes("不确定的事实不得凭印象作答"),
	);
	check(
		"the split turn's opening question is anchored into the replay",
		captured.replay[0]?.role === "user" &&
			captured.replay[0]?.content?.[0]?.text === "Please make the memory journal append-only and add tests for it." &&
			captured.replay.map((message) => message.role).join(",") === "user,assistant,user",
	);
	check("the dropped tool output never enters the replay", !JSON.stringify(captured.replay).includes("tool output line"));
	check("the continuation is announced", String(captured.notifications?.at(-1)?.[0] ?? "").includes("continued in a fresh session"));
	const handoffDoc = await readFile(path.join(tmp, ".agents/memory/HANDOFF.md"), "utf8").catch(() => "");
	check(
		"the archived handoff document points at the log and carries no summary",
		handoffDoc.includes("session-logs/handoff-pin/session.md") && !handoffDoc.includes("## 交接摘要"),
	);

	// An orphan result (its call left in the dropped prefix) cannot be replayed; it leaves the replay and
	// stays reachable through the session log.
	const orphanEntries = [
		contentEntry("o1", "user", [{ type: "text", text: "先看实现，再改。" }], "2026-09-16T01:00:00.000Z"),
		contentEntry(
			"o2",
			"assistant",
			[{ type: "text", text: "读取实现。" }, { type: "toolCall", id: "oc1", name: "bash", arguments: { command: "cat x" } }],
			"2026-09-16T01:00:01.000Z",
			"o1",
		),
		{ type: "branch_summary", id: "o3", parentId: "o2", timestamp: "2026-09-16T01:00:02.000Z", summary: "分支摘要 branch summary filler. ".repeat(60) },
		toolResultEntry("o4", "oc1", "孤儿结果 ORPHAN_SECRET", "2026-09-16T01:00:03.000Z", "o3"),
		contentEntry("o5", "assistant", [{ type: "text", text: "继续改。" }], "2026-09-16T01:00:04.000Z", "o4"),
		contentEntry("o6", "user", [{ type: "text", text: "好。" }], "2026-09-16T01:00:05.000Z", "o5"),
	];
	const orphanCaptured = { replay: [], prompt: undefined };
	const orphanCtx = makeCtx(tmp, {
		sessionManager: makeSessionManager(orphanEntries, "handoff-orphan"),
		getContextUsage: () => ({ tokens: 200_000, percent: 20, contextWindow: 1_000_000 }),
		modelRegistry: {
			hasConfiguredAuth: () => true,
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
			complete: countModelCall,
		},
	});
	orphanCtx.newSession = captureNewSession(orphanCaptured);
	await runHandlers(pinPi, "session_start", orphanCtx);
	await pinPi.commands.get("handoff").handler("now", orphanCtx);
	check("the orphan scenario still hands off", orphanCaptured.prompt !== undefined);
	check("the kept tail is in the replay", JSON.stringify(orphanCaptured.replay).includes("继续改"));
	check("the orphan replay carries the kept tail", orphanCaptured.replay.map((message) => message.role).join(",") === "user,assistant,user");
	check("the orphan result never enters the replay", !JSON.stringify(orphanCaptured.replay).includes("ORPHAN_SECRET"));
	check("the orphan replay opens user-first", orphanCaptured.replay[0]?.role === "user" && orphanCaptured.replay[0]?.content?.[0]?.text === handoff.SPLIT_TURN_MARKER);

	// A split turn whose cut-off prefix fits inside one window is snapped to the turn start: the whole last
	// turn is then replayed verbatim and only the older side is dropped.
	const snapEntries = [
		contentEntry("sn1", "user", [{ type: "text", text: "OLDER_QUESTION 先把旧逻辑读完。" }], "2026-09-16T01:10:00.000Z"),
		contentEntry("sn2", "assistant", [{ type: "text", text: "旧回合的答复。" }], "2026-09-16T01:10:01.000Z", "sn1"),
		contentEntry("sn3", "user", [{ type: "text", text: "SNAP_QUESTION 把 A 改成 B。" }], "2026-09-16T01:10:02.000Z", "sn2"),
		contentEntry(
			"sn4",
			"assistant",
			[{ type: "text", text: `SNAP_KEEP_MARKER ${"长正文 ".repeat(600)}` }],
			"2026-09-16T01:10:03.000Z",
			"sn3",
		),
	];
	const snapCaptured = { replay: [], prompt: undefined };
	const snapCtx = makeCtx(tmp, {
		sessionManager: makeSessionManager(snapEntries, "handoff-snap"),
		getContextUsage: () => ({ tokens: 200_000, percent: 20, contextWindow: 1_000_000 }),
		modelRegistry: {
			hasConfiguredAuth: () => true,
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
			complete: countModelCall,
		},
	});
	snapCtx.newSession = captureNewSession(snapCaptured);
	await runHandlers(pinPi, "session_start", snapCtx);
	await pinPi.commands.get("handoff").handler("now", snapCtx);
	check("a turn whose prefix fits the window snaps to the turn start", snapCaptured.replay[0]?.content?.[0]?.text === "SNAP_QUESTION 把 A 改成 B。");
	check("the snapped turn is replayed whole", JSON.stringify(snapCaptured.replay).includes("SNAP_KEEP_MARKER"));
	check("the older side is dropped, not replayed", !JSON.stringify(snapCaptured.replay).includes("OLDER_QUESTION"));

	// A session that is a single turn cannot snap (the older side would be empty); the handoff must keep
	// running on the mid-turn cut instead of reporting "nothing older to drop".
	const singleTurnEntries = [
		contentEntry("sg1", "user", [{ type: "text", text: "SINGLE_QUESTION 只有这一轮。" }], "2026-09-16T01:20:00.000Z"),
		contentEntry(
			"sg2",
			"assistant",
			[{ type: "text", text: `SINGLE_KEEP_MARKER ${"长正文 ".repeat(600)}` }],
			"2026-09-16T01:20:01.000Z",
			"sg1",
		),
	];
	const singleCaptured = { replay: [], prompt: undefined };
	const singleCtx = makeCtx(tmp, {
		sessionManager: makeSessionManager(singleTurnEntries, "handoff-single-turn"),
		getContextUsage: () => ({ tokens: 200_000, percent: 20, contextWindow: 1_000_000 }),
		modelRegistry: {
			hasConfiguredAuth: () => true,
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
			complete: countModelCall,
		},
	});
	singleCtx.newSession = captureNewSession(singleCaptured);
	await runHandlers(pinPi, "session_start", singleCtx);
	await pinPi.commands.get("handoff").handler("now", singleCtx);
	check("a single-turn session still hands off instead of snapping to an empty older side", singleCaptured.prompt !== undefined);
	check("the single turn replays its opening question", singleCaptured.replay[0]?.content?.[0]?.text === "SINGLE_QUESTION 只有这一轮。");

	// A split turn whose cut-off prefix overruns the window must not be snapped whole: the bulky middle
	// stays in the dropped prefix and only the turn's opening question is anchored.
	const bigPrefixEntries = [
		contentEntry("bp1", "user", [{ type: "text", text: "BIGPREFIX_OLDER 更早的那一轮。" }], "2026-09-16T01:30:00.000Z"),
		contentEntry("bp2", "assistant", [{ type: "text", text: "更早的答复。" }], "2026-09-16T01:30:01.000Z", "bp1"),
		contentEntry("bp3", "user", [{ type: "text", text: "BIGPREFIX_QUESTION 读大文件再改。" }], "2026-09-16T01:30:02.000Z", "bp2"),
		contentEntry(
			"bp4",
			"assistant",
			[{ type: "text", text: "读取中。" }, { type: "toolCall", id: "bc1", name: "bash", arguments: { command: "cat big" } }],
			"2026-09-16T01:30:03.000Z",
			"bp3",
		),
		toolResultEntry("bp5", "bc1", `BIGPREFIX_DROP_MARKER ${"大文件内容 ".repeat(600)}`, "2026-09-16T01:30:04.000Z", "bp4"),
		contentEntry("bp6", "assistant", [{ type: "text", text: "大文件读完了。" }], "2026-09-16T01:30:05.000Z", "bp5"),
	];
	const bigCaptured = { replay: [], prompt: undefined };
	const bigCtx = makeCtx(tmp, {
		sessionManager: makeSessionManager(bigPrefixEntries, "handoff-big-prefix"),
		getContextUsage: () => ({ tokens: 200_000, percent: 20, contextWindow: 1_000_000 }),
		modelRegistry: {
			hasConfiguredAuth: () => true,
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
			complete: countModelCall,
		},
	});
	bigCtx.newSession = captureNewSession(bigCaptured);
	await runHandlers(pinPi, "session_start", bigCtx);
	await pinPi.commands.get("handoff").handler("now", bigCtx);
	check("an overrun prefix is not snapped whole", bigCaptured.replay[0]?.content?.[0]?.text === "BIGPREFIX_QUESTION 读大文件再改。");
	check("the bulky prefix stays out of the replay", !JSON.stringify(bigCaptured.replay).includes("BIGPREFIX_DROP_MARKER"));

	// Session settings survive the switch and the pi session tree stays flat. Session files on
	// disk give the parent chain meaning: the replacement must point at the chain root, and the
	// staged settings must be keyed to the session that is being replaced.
	console.log("\n=== handoff session settings + tree flattening ===");
	const sessionDir = path.join(tmp, "sessions");
	await mkdir(sessionDir, { recursive: true });
	const sessionFile = (name) => path.join(sessionDir, `${name}.jsonl`);
	const writeHeader = async (file, id, parentSession) =>
		writeFile(file, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-17T00:00:00.000Z", cwd: tmp, ...(parentSession ? { parentSession } : {}) })}\n`);
	await writeHeader(sessionFile("root"), "root");
	await writeHeader(sessionFile("mid"), "mid", sessionFile("root"));
	await writeHeader(sessionFile("leaf"), "leaf", sessionFile("mid"));
	check("a session chain resolves to its root", (await lineage.resolveHandoffParentSession(sessionFile("leaf"))) === sessionFile("root"));
	check("a root session is its own parent", (await lineage.resolveHandoffParentSession(sessionFile("root"))) === sessionFile("root"));
	check("a missing session file is its own parent", (await lineage.resolveHandoffParentSession(sessionFile("nope"))) === sessionFile("nope"));
	check("an in-memory session has no parent", (await lineage.resolveHandoffParentSession(undefined)) === undefined);
	await writeHeader(sessionFile("cyc-a"), "cyc-a", sessionFile("cyc-b"));
	await writeHeader(sessionFile("cyc-b"), "cyc-b", sessionFile("cyc-a"));
	check("a parent cycle terminates", [sessionFile("cyc-a"), sessionFile("cyc-b")].includes(await lineage.resolveHandoffParentSession(sessionFile("cyc-a"))));
	// The header is the first line and is read to its newline, so an oversized one no longer costs
	// the whole ancestor walk (the old fixed 64KB read failed to parse and fell back to chaining).
	const oversized = JSON.stringify({ type: "session", version: 3, id: "big", timestamp: "2026-09-17T00:00:00.000Z", cwd: tmp, note: "x".repeat(80_000), parentSession: sessionFile("root") });
	await writeFile(sessionFile("big"), `${oversized}\n`);
	check("an oversized session header still resolves to its root", (await lineage.resolveHandoffParentSession(sessionFile("big"))) === sessionFile("root"));
	const pathological = JSON.stringify({ type: "session", version: 3, id: "huge", timestamp: "2026-09-17T00:00:00.000Z", cwd: tmp, note: "x".repeat(1_100_000), parentSession: sessionFile("root") });
	await writeFile(sessionFile("huge"), `${pathological}\n`);
	check("a header beyond the pathological cap falls back to chaining", (await lineage.resolveHandoffParentSession(sessionFile("huge"))) === sessionFile("huge"));
	// Exactly at the cap is still a header when the file ends there: the boundary is decided by one
	// extra byte, not by equality (`>` vs `>=` must not turn into a silent downgrade).
	const cap = 1024 * 1024;
	const headerFor = (note) => JSON.stringify({ type: "session", version: 3, id: "edge", timestamp: "2026-09-17T00:00:00.000Z", cwd: tmp, note, parentSession: sessionFile("root") });
	const exact = headerFor("x".repeat(cap - headerFor("").length));
	await writeFile(sessionFile("cap"), `${exact}\n`);
	check("a header exactly at the cap is still read", exact.length === cap && (await lineage.resolveHandoffParentSession(sessionFile("cap"))) === sessionFile("root"));

	const settingsEntries = [
		contentEntry("s1", "user", [{ type: "text", text: `Please carry the session settings over. ${'filler sentence. '.repeat(200)}` }], "2026-09-17T00:10:00.000Z"),
		contentEntry(
			"s2",
			"assistant",
			[{ type: "text", text: "Reading the current implementation first." }, { type: "toolCall", id: "sc1", name: "bash", arguments: { command: "cat settings.ts" } }],
			"2026-09-17T00:10:01.000Z",
			"s1",
		),
		toolResultEntry("s3", "sc1", "settings output line. ".repeat(60), "2026-09-17T00:10:02.000Z", "s2"),
		contentEntry("s4", "assistant", [{ type: "text", text: "Settings are read, carrying on." }], "2026-09-17T00:10:03.000Z", "s3"),
		contentEntry("s5", "user", [{ type: "text", text: "好，继续。" }], "2026-09-17T00:10:04.000Z", "s4"),
	];
	const settingsCtx = makeCtx(tmp, {
		sessionManager: { ...makeSessionManager(settingsEntries, "leaf"), getSessionFile: () => sessionFile("leaf") },
		getContextUsage: () => ({ tokens: 200_000, percent: 20, contextWindow: 1_000_000 }),
		thinkingLevel: "high",
		model: { provider: "deepseek", id: "deepseek-flash" },
		modelRegistry: {
			hasConfiguredAuth: () => true,
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
			complete: countModelCall,
		},
	});
	const settingsCaptured = { parentSession: undefined, replay: [], prompt: undefined };
	settingsCtx.newSession = async (options) => {
		settingsCaptured.parentSession = options.parentSession;
		const replacement = makeSessionManager([], "settings-next");
		await options.setup(replacement);
		settingsCaptured.replay = replacement.entries.slice();
		const replacementCtx = makeCtx(tmp, { sessionManager: replacement });
		replacementCtx.sendUserMessage = (text) => {
			settingsCaptured.prompt = text;
		};
		await options.withSession(replacementCtx);
		return { cancelled: false };
	};
	await runHandlers(pinPi, "session_start", settingsCtx);
	await pinPi.commands.get("handoff").handler("now", settingsCtx);

	const markerFile = settings.handoffSettingsFile(tmp);
	const markerExists = () => readFile(markerFile, "utf8").then(() => true).catch(() => false);
	const staged = JSON.parse(await readFile(markerFile, "utf8").catch(() => "{}"));
	check("the handoff still continues in a fresh session", settingsCaptured.prompt !== undefined && settingsCaptured.replay.length > 0);
	check("the replacement is parented to the chain root", settingsCaptured.parentSession === sessionFile("root"));
	check(
		"the outgoing model and thinking level are staged",
		staged.model?.provider === "deepseek" && staged.model?.id === "deepseek-flash" && staged.thinkingLevel === "high",
	);
	check("the stage is keyed to the replaced session", staged.previousSessionFile === sessionFile("leaf") && typeof staged.at === "number");
	const memoryGitignore = await readFile(path.join(tmp, ".agents/memory/.gitignore"), "utf8").catch(() => "");
	check("the staged settings stay out of commits", memoryGitignore.includes(settings.HANDOFF_SETTINGS_FILE));

	// pi builds the replacement from its own defaults, so the staged settings are applied from the
	// fresh extension instance's session_start (after the replay, before the continuation prompt).
	console.log("\n=== restoreHandoffSessionSettings ===");
	const restorePi = makePi({ cwd: tmp, thinkingLevel: "max" });
	await (await loadDefault(`${PC}/index.ts`))(restorePi);
	const restoredModel = { provider: "deepseek", id: "deepseek-flash", name: "deepseek flash" };
	const replacementCtx = makeCtx(tmp, {
		sessionManager: makeSessionManager([], "settings-next"),
		model: { provider: "deepseek", id: "deepseek-lite" },
		thinkingLevel: "max",
		modelRegistry: { hasConfiguredAuth: () => true, find: () => restoredModel, complete: countModelCall },
	});
	await runHandlers(restorePi, "session_start", replacementCtx, { reason: "new", previousSessionFile: sessionFile("leaf") });
	check("the replacement switches to the outgoing model", restorePi.modelCalls[0] === restoredModel);
	check("the replacement takes the outgoing thinking level", restorePi.thinkingCalls.join(",") === "high");
	check("the staged settings are consumed by that one switch", !(await markerExists()));

	const stageFor = (overrides) =>
		settings.stageHandoffSessionSettings(tmp, {
			previousSessionFile: sessionFile("leaf"),
			model: { provider: "deepseek", id: "deepseek-flash" },
			thinkingLevel: "high",
			at: Date.now(),
			...overrides,
		});
	const resetCalls = () => {
		restorePi.modelCalls.length = 0;
		restorePi.thinkingCalls.length = 0;
	};

	resetCalls();
	await stageFor({});
	await runHandlers(restorePi, "session_start", replacementCtx, { reason: "new", previousSessionFile: sessionFile("mid") });
	check("a different predecessor never inherits", restorePi.modelCalls.length === 0 && restorePi.thinkingCalls.length === 0);
	// The marker is one file per project, so two handoffs in flight overwrite each other's stage. A
	// *recent* foreign one may belong to a handoff whose successor has not started yet: clearing it here
	// would silently deny that successor its model and thinking level, so it is left in place (and the
	// skipped restore is reported).
	check("a recent foreign switch leaves the stage for its own successor", await markerExists());
	check(
		"the skipped restore is reported, not silent",
		replacementCtx.notifications.some((entry) => String(entry?.[0] ?? "").includes("not the successor the staged settings belong to")),
	);

	// An older foreign marker is the leftover of a crash between staging and the switch: dropped now
	// instead of waiting out the TTL.
	resetCalls();
	await stageFor({ at: Date.now() - 5 * 60_000 });
	await runHandlers(restorePi, "session_start", replacementCtx, { reason: "new", previousSessionFile: sessionFile("mid") });
	check("a stale foreign switch drops the stage", !(await markerExists()));

	resetCalls();
	await stageFor({ at: Date.now() - 11 * 60_000 });
	await runHandlers(restorePi, "session_start", replacementCtx, { reason: "new", previousSessionFile: sessionFile("leaf") });
	check("a stale stage is ignored", restorePi.modelCalls.length === 0 && restorePi.thinkingCalls.length === 0);
	check("a stale stage is cleaned up", !(await markerExists()));

	resetCalls();
	await stageFor({});
	await runHandlers(restorePi, "session_start", replacementCtx, { reason: "resume", previousSessionFile: sessionFile("leaf") });
	check("a resume is not the handoff successor", restorePi.modelCalls.length === 0 && restorePi.thinkingCalls.length === 0);
	check("a resume leaves the stage alone", await markerExists());

	resetCalls();
	await stageFor({ model: { provider: "deepseek", id: "deepseek-lite" }, thinkingLevel: "max" });
	await runHandlers(restorePi, "session_start", replacementCtx, { reason: "new", previousSessionFile: sessionFile("leaf") });
	check("settings that already match are left untouched", restorePi.modelCalls.length === 0 && restorePi.thinkingCalls.length === 0);
	check("matching settings are still consumed", !(await markerExists()));

	resetCalls();
	const ghostCtx = makeCtx(tmp, {		sessionManager: makeSessionManager([], "settings-next"),
		model: { provider: "deepseek", id: "deepseek-lite" },
		thinkingLevel: "max",
		modelRegistry: { hasConfiguredAuth: () => true, find: () => undefined, complete: countModelCall },
	});
	await stageFor({ model: { provider: "ghost", id: "gone" }, thinkingLevel: "low" });
	await runHandlers(restorePi, "session_start", ghostCtx, { reason: "new", previousSessionFile: sessionFile("leaf") });
	check(
		"an unavailable model warns instead of breaking session start",
		ghostCtx.notifications.some(([message, type]) => type === "warning" && message.includes("ghost/gone")),
	);
	check("the thinking level still applies without the model", restorePi.thinkingCalls.join(",") === "low");

	resetCalls();
	const originalSetModel = restorePi.setModel;
	restorePi.setModel = async () => false;
	await stageFor({});
	await runHandlers(restorePi, "session_start", replacementCtx, { reason: "new", previousSessionFile: sessionFile("leaf") });
	check(
		"a refused model switch warns",
		replacementCtx.notifications.some(([message, type]) => type === "warning" && message.includes("no authentication")),
	);
	restorePi.setModel = originalSetModel;

	// The stage is private but transient, so a session_start that is not its successor must stop
	// before resolving the project root (which shells out to git).
	const quietCwd = path.join(tmp, "quiet-cwd");
	await mkdir(quietCwd, { recursive: true });
	const quietPi = makePi({ cwd: quietCwd });
	let quietExecs = 0;
	const quietExec = quietPi.exec;
	quietPi.exec = async (...execArgs) => {
		quietExecs += 1;
		return quietExec(...execArgs);
	};
	await stageFor({});
	await settings.restoreHandoffSessionSettings(quietPi, makeCtx(quietCwd, { sessionManager: makeSessionManager([], "quiet") }), { reason: "resume", previousSessionFile: sessionFile("leaf") });
	check("a non-handoff session start stops before resolving the project root", quietExecs === 0);
	await settings.clearHandoffSessionSettings(tmp);

	// A switch cancelled by another extension must not leave a stage behind for a later `/new`.
	const cancelCtx = makeCtx(tmp, {
		sessionManager: { ...makeSessionManager(settingsEntries, "leaf-2"), getSessionFile: () => sessionFile("leaf") },
		getContextUsage: () => ({ tokens: 200_000, percent: 20, contextWindow: 1_000_000 }),
		modelRegistry: pinCtx.modelRegistry,
	});
	cancelCtx.newSession = async () => ({ cancelled: true });
	await pinPi.commands.get("handoff").handler("now", cancelCtx);
	check("a cancelled handoff clears its stage", !(await markerExists()));
	check("a cancelled handoff keeps the session", cancelCtx.notifications.some(([message]) => message.includes("cancelled by another extension")));

	// A switch that throws never produced a replacement either: the stage must be cleared too.
	const throwCtx = makeCtx(tmp, {
		sessionManager: { ...makeSessionManager(settingsEntries, "leaf-3"), getSessionFile: () => sessionFile("leaf") },
		getContextUsage: () => ({ tokens: 200_000, percent: 20, contextWindow: 1_000_000 }),
		modelRegistry: pinCtx.modelRegistry,
	});
	throwCtx.newSession = async () => {
		throw new Error("switch exploded");
	};
	await pinPi.commands.get("handoff").handler("now", throwCtx);
	check("a failed switch clears its stage", !(await markerExists()));
	check(
		"a failed switch is reported to the user",
		throwCtx.notifications.some(([message, type]) => type === "error" && message.includes("Handoff: failed")),
	);
	// The toast used to promise that pi's own compaction would still apply; the handoff stopped claiming
	// what it does not control. Single-sided pin: re-adding the clause reddens.
	check(
		"the failure toast does not promise pi's compaction",
		throwCtx.notifications.every(([message]) => !String(message).includes("auto-compaction")),
	);
	// The two receipts that used to describe a summary that no longer exists, one single-sided pin each:
	// re-adding the claim reddens without breaking anything else.
	const receiptPi = makePi({ cwd: tmp });
	await (await loadDefault(`${PC}/index.ts`))(receiptPi);
	const receiptCtx = makeCtx(tmp, {});
	await runHandlers(receiptPi, "session_start", receiptCtx);
	await receiptPi.commands.get("handoff").handler("budget recent off", receiptCtx);
	check(
		"the off receipt does not claim a summary carries the rest",
		receiptCtx.notifications.some(([message]) => String(message).includes("no recent carry-over")) &&
			receiptCtx.notifications.every(([message]) => !String(message).toLowerCase().includes("summary only")),
	);
	receiptCtx.notifications.length = 0;
	// `handoffThinking` was retired in v0.4.2: it had no reader on this side, so the value was never acted on
	// (whether the dsh counterpart reads it cannot be checked from this repo; see audit R-2). Up to v0.4.1 it was still a known key that round-tripped through config; the
	// retirement is what makes it an unknown key the next rewrite drops. The verb must now be refused like
	// any other unknown option, persist nothing, and be gone from the completion surface.
	await receiptPi.commands.get("handoff").handler("thinking session", receiptCtx);
	check(
		"the retired thinking verb is refused as an unknown option",
		receiptCtx.notifications.some(([message]) => String(message).includes('Unknown option "thinking session"')),
	);
	check(
		"the retired thinking verb persists nothing",
		!Object.prototype.hasOwnProperty.call((await readConfig()) ?? {}, "handoffThinking"),
	);
	check(
		"the retired thinking verb is gone from the completion surface",
		!((await receiptPi.commands.get("handoff").getArgumentCompletions("")) ?? []).some((item) => item.value === "thinking") &&
			!((await receiptPi.commands.get("handoff").getArgumentCompletions("thinking ")) ?? []).some((item) => item.value === "off"),
	);
	// Every scenario above shares the same counting stub, so this is the one place the "no model call"
	// property is asserted over all of them at once: a regression that swallowed an error and fell back
	// to a model would have to have called `complete`, which throws and would have failed its own check too.
	check("no scenario above reached a model", modelCalls === 0);
} finally {
		await rmTemp(tmp);
}

console.log(failures === 0 ? "\nhandoff: all checks passed." : `\nhandoff: ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
