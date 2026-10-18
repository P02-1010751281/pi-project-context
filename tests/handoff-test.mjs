import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bashExecutionEntry, loadDefault, loadNamespace, loadShared, makeCtx, makePi, makeSessionManager, contentEntry, contextEditEntry, messageEntry, PC, PI, rmTemp, runHandlers, toolResultEntry, waitUntil } from "./harness.mjs";

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
	const fileOps = await loadNamespace(`${PC}/handoff/file-ops.ts`);
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
	check("zh closing asks for a restatement first", zh.trimEnd().endsWith("先复述上一轮用户的要求、当前进度，以及仍在生效的技能或模式；如果该技能的说明已被丢弃，先重新读取它的技能文件，再从上次中断处继续。"));
	check(
		"zh has no English scaffolding",
		!zh.includes("## Handoff Summary") && !zh.includes("Continue the task from where it left off.") && !zh.includes("First restate"),
	);

	const en = handoff.buildHandoffPrompt({ ...base, language: "en" });
	check(
		"en keeps the scaffolding shape",
		en.startsWith("This session continues work handed off from a previous session (16% of its context window had been used).") &&
			en.includes("## Previous session details") &&
			!en.includes("## Handoff Summary") &&
			en.trimEnd().endsWith("First restate in one or two sentences what the user last asked, where the work stands, and any skill or mode still in effect; if its instructions were dropped, re-read its skill file first, then continue from where it left off."),
	);

	const activeParts = { ...base, activeSkills: [{ name: "grilling", file: "/home/user/.agents/skills/grilling/SKILL.md" }] };
	const zhActive = handoff.buildHandoffPrompt({ ...activeParts, language: "zh" });
	check("zh names the previous session's active skills", zhActive.includes("## 上一会话加载的技能与模式") && zhActive.includes("- grilling：/home/user/.agents/skills/grilling/SKILL.md"));
	check("zh tells the successor to re-read the skill", zhActive.includes("先重新读取它的技能文件并继续遵循"));
	check("an active-skills section does not break prompt recognition", handoff.isHandoffPromptText(zhActive));
	const oldSkillClosing = "先复述上一轮用户的要求、当前进度，以及仍在生效的技能或模式；如果该技能的说明已被丢弃，先重新读取它的 SKILL.md，再从上次中断处继续。";
	const oldSkillPrompt = zhActive.slice(0, zhActive.lastIndexOf("先复述上一轮")) + oldSkillClosing;
	check("the v0.4.11 SKILL.md closing is still recognized", handoff.isHandoffPromptText(oldSkillPrompt));
	const enActive = handoff.buildHandoffPrompt({ ...activeParts, language: "en" });
	check("en names the previous session's active skills", enActive.includes("## Skills and modes from the previous session") && enActive.includes("- grilling: /home/user/.agents/skills/grilling/SKILL.md"));
	const oldEnClosing = "First restate in one or two sentences what the user last asked, where the work stands, and any skill or mode still in effect; if its instructions were dropped, re-read its SKILL.md first, then continue from where it left off.";
	const oldEnPrompt = enActive.slice(0, enActive.lastIndexOf("First restate")) + oldEnClosing;
	check("the v0.4.11 English SKILL.md closing is still recognized", oldEnPrompt !== enActive && handoff.isHandoffPromptText(oldEnPrompt));
	check("no active skills means no section", !zh.includes("## 上一会话加载的技能与模式") && !en.includes("## Skills and modes from the previous session"));

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

	console.log("\n=== collectActiveSkills ===");
	const skillEntries = [
		contentEntry("sk1", "assistant", [{ type: "toolCall", id: "sk1", name: "read", arguments: { path: "/home/user/.agents/skills/grilling/SKILL.md" } }], "2026-09-16T00:49:00.000Z"),
		contentEntry("sk2", "assistant", [{ type: "toolCall", id: "sk2", name: "read", arguments: { path: "/tmp/notes.md" } }], "2026-09-16T00:49:01.000Z"),
		contentEntry("sk3", "assistant", [{ type: "toolCall", id: "sk3", name: "read", arguments: { path: "/home/user/.agents/skills/grilling/SKILL.md" } }], "2026-09-16T00:49:02.000Z"),
		contentEntry("sk4", "assistant", [{ type: "toolCall", id: "sk4", name: "read", arguments: { path: "/repo/.agents/skills/mcl-spec/SKILL.md" } }], "2026-09-16T00:49:03.000Z"),
	];
	const skills = handoff.collectActiveSkills(skillEntries);
	check("detects SKILL.md reads, dedupes and keeps the most recent first", skills.length === 2 && skills[0]?.name === "mcl-spec" && skills[1]?.name === "grilling");
	const compactedSkill = handoff.collectActiveSkills([
		{ type: "compaction", id: "csk", parentId: null, timestamp: "2026-09-16T00:49:04.000Z", fromHook: false, details: { readFiles: ["/home/user/.agents/skills/grilling/SKILL.md"] } },
	]);
	check("a compaction's readFiles keeps a skill that fell out of the branch", compactedSkill.length === 1 && compactedSkill[0]?.name === "grilling");
	const priorPrompt = handoff.buildHandoffPrompt({
		...base,
		language: "zh",
		fileOperations: "<read-files>\n/home/user/.agents/skills/grilling/SKILL.md\n</read-files>",
	});
	const fromPriorPrompt = handoff.collectActiveSkills([contentEntry("sk5", "user", [{ type: "text", text: priorPrompt }], "2026-09-16T00:49:05.000Z")]);
	check("a prior continuation prompt keeps a skill whose read call was dropped", fromPriorPrompt.length === 1 && fromPriorPrompt[0]?.name === "grilling");
	const skillBlock = `<skill name="grilling" location="/home/user/.agents/skills/grilling/SKILL.md">
References are relative to /home/user/.agents/skills/grilling.

# Grilling
Ask one question at a time.
</skill>`;
	const fromSkillCommand = handoff.collectActiveSkills([contentEntry("skc1", "user", [{ type: "text", text: skillBlock }], "2026-09-16T00:49:05.500Z")]);
	check("a /skill: invocation is detected without a read", fromSkillCommand.length === 1 && fromSkillCommand[0]?.name === "grilling" && fromSkillCommand[0]?.file === "/home/user/.agents/skills/grilling/SKILL.md");
	const fromSkillCommandWithMessage = handoff.collectActiveSkills([contentEntry("skc2", "user", [{ type: "text", text: `${skillBlock}\n\n请继续盘问` }], "2026-09-16T00:49:05.600Z")]);
	check("a /skill: block with a trailing user message is still detected", fromSkillCommandWithMessage.length === 1 && fromSkillCommandWithMessage[0]?.name === "grilling");
	const standaloneBlock = `<skill name="notes" location="/tmp/notes.md">\nReferences are relative to /tmp.\n\n# Notes\nA note.\n</skill>`;
	const standalone = handoff.collectActiveSkills([contentEntry("skc5", "user", [{ type: "text", text: standaloneBlock }], "2026-09-16T00:49:05.750Z")]);
	check("a /skill: block for a standalone .md skill is detected with its block name", standalone.length === 1 && standalone[0]?.name === "notes" && standalone[0]?.file === "/tmp/notes.md");
	const nonMarkdownBlock = `<skill name="notes" location="/tmp/notes.txt">\nReferences are relative to /tmp.\n\n# Notes\nA note.\n</skill>`;
	check("a /skill: block for a non-Markdown file is ignored", handoff.collectActiveSkills([contentEntry("skc5b", "user", [{ type: "text", text: nonMarkdownBlock }], "2026-09-16T00:49:05.760Z")]).length === 0);
	check("a direct read of a standalone .md is still ignored", handoff.collectActiveSkills([contentEntry("skc5c", "assistant", [{ type: "toolCall", id: "skc5c", name: "read", arguments: { path: "/tmp/notes.md" } }], "2026-09-16T00:49:05.770Z")]).length === 0);
	const commandVsRead = handoff.collectActiveSkills([
		contentEntry("skc3", "assistant", [{ type: "toolCall", id: "skc3", name: "read", arguments: { path: "/repo/.agents/skills/mcl-spec/SKILL.md" } }], "2026-09-16T00:49:05.700Z"),
		contentEntry("skc4", "user", [{ type: "text", text: skillBlock }], "2026-09-16T00:49:05.800Z"),
	]);
	check("a /skill: invocation outranks a read", commandVsRead.length === 2 && commandVsRead[0]?.name === "grilling" && commandVsRead[1]?.name === "mcl-spec");
	const sameSkillBothOrders = [
		handoff.collectActiveSkills([
			contentEntry("skc6", "user", [{ type: "text", text: skillBlock }], "2026-09-16T00:49:05.810Z"),
			contentEntry("skc7", "assistant", [{ type: "toolCall", id: "skc7", name: "read", arguments: { path: "/home/user/.agents/skills/grilling/SKILL.md" } }], "2026-09-16T00:49:05.820Z"),
		]),
		handoff.collectActiveSkills([
			contentEntry("skc8", "assistant", [{ type: "toolCall", id: "skc8", name: "read", arguments: { path: "/home/user/.agents/skills/grilling/SKILL.md" } }], "2026-09-16T00:49:05.830Z"),
			contentEntry("skc9", "user", [{ type: "text", text: skillBlock }], "2026-09-16T00:49:05.840Z"),
		]),
	];
	check("the same skill through /skill: and read dedupes in both orders", sameSkillBothOrders.every((list) => list.length === 1 && list[0]?.name === "grilling"));
	const noDowngrade = handoff.collectActiveSkills([
		contentEntry("skc14", "user", [{ type: "text", text: skillBlock }], "2026-09-16T00:49:05.805Z"),
		contentEntry("skc15", "assistant", [{ type: "toolCall", id: "skc15", name: "read", arguments: { path: "/home/user/.agents/skills/grilling/SKILL.md" } }], "2026-09-16T00:49:05.815Z"),
		contentEntry("skc16", "assistant", [{ type: "toolCall", id: "skc16", name: "read", arguments: { path: "/repo/.agents/skills/mcl-spec/SKILL.md" } }], "2026-09-16T00:49:05.825Z"),
	]);
	check("a later read of the same skill does not downgrade the /skill: entry", noDowngrade.length === 2 && noDowngrade[0]?.name === "grilling" && noDowngrade[1]?.name === "mcl-spec");
	const proseSkillBlock = `先看看：\n${skillBlock}`;
	const singleNewlineTrailer = `${skillBlock}\n请继续`;
	check("a skill block embedded in prose is not a load", handoff.collectActiveSkills([contentEntry("skc10", "user", [{ type: "text", text: proseSkillBlock }], "2026-09-16T00:49:05.850Z")]).length === 0);
	check("a skill block with a single-newline trailer is not a load", handoff.collectActiveSkills([contentEntry("skc11", "user", [{ type: "text", text: singleNewlineTrailer }], "2026-09-16T00:49:05.860Z")]).length === 0);
	const cappedCommand = handoff.collectActiveSkills([
		contentEntry("skc12", "user", [{ type: "text", text: skillBlock }], "2026-09-16T00:49:05.870Z"),
		...Array.from({ length: 8 }, (_, index) =>
			contentEntry(`skc13${index}`, "assistant", [{ type: "toolCall", id: `skc13${index}`, name: "read", arguments: { path: `/repo/.agents/skills/cap-skill-${String(index).padStart(2, "0")}/SKILL.md` } }], `2026-09-16T00:49:${String(6 + index).padStart(2, "0")}.000Z`),
		),
	]);
	check("a /skill: entry survives the 8-cap against eight reads", cappedCommand.length === 8 && cappedCommand[0]?.name === "grilling" && !cappedCommand.some((skill) => skill.name === "cap-skill-00"));
	const nestedRead = {
		type: "message",
		id: "skn1",
		parentId: null,
		timestamp: "2026-09-16T00:49:05.900Z",
		message: {
			role: "toolResult",
			toolCallId: "codemode1",
			content: [{ type: "text", text: "script output" }],
			timestamp: Date.parse("2026-09-16T00:49:05.900Z"),
			nestedCalls: { calls: [{ name: "read", arguments: { path: "/home/user/.agents/skills/grilling/SKILL.md" } }] },
		},
	};
	const nestedReads = handoff.collectActiveSkills([nestedRead]);
	check("a codemode nested read is detected", nestedReads.length === 1 && nestedReads[0]?.name === "grilling");
	const nestedReadLists = fileOps.computeFileLists(fileOps.collectFileOps([nestedRead]));
	check("a nested read enters <read-files>", nestedReadLists.readFiles.includes("/home/user/.agents/skills/grilling/SKILL.md"));
	const nestedResult = (id, calls) => ({
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-09-16T00:49:05.910Z",
		message: { role: "toolResult", toolCallId: id, content: [{ type: "text", text: "script output" }], timestamp: Date.parse("2026-09-16T00:49:05.910Z"), nestedCalls: { calls } },
	});
	check(
		"a nested read of a non-SKILL file is ignored",
		handoff.collectActiveSkills([nestedResult("skn2", [{ name: "read", arguments: { path: "/tmp/notes.md" } }])]).length === 0,
	);
	check(
		"a nested write is not a skill read",
		handoff.collectActiveSkills([nestedResult("skn3", [{ name: "write", arguments: { path: "/repo/.agents/skills/grilling/SKILL.md" } }])]).length === 0,
	);
	const nestedWriteLists = fileOps.computeFileLists(fileOps.collectFileOps([nestedResult("skn3w", [{ name: "write", arguments: { path: "/tmp/nested-write.ts" } }])]));
	check("a nested write enters <modified-files>", nestedWriteLists.modifiedFiles.includes("/tmp/nested-write.ts"));
	let nestedThrew = false;
	try {
		handoff.collectActiveSkills([nestedResult("skn4", [null, 42, { name: "read", arguments: null }])]);
	} catch {
		nestedThrew = true;
	}
	check("malformed nested calls do not throw", !nestedThrew);
	let nonArrayNestedThrew = false;
	try {
		handoff.collectActiveSkills([nestedResult("skn6", "not-an-array")]);
	} catch {
		nonArrayNestedThrew = true;
	}
	check("a non-array nestedCalls list does not throw", !nonArrayNestedThrew);
	let nestedOpsThrew = false;
	try {
		fileOps.collectFileOps([nestedResult("skn7", [null, 42, { name: "read", arguments: null }])]);
	} catch {
		nestedOpsThrew = true;
	}
	check("malformed nested calls do not throw in collectFileOps", !nestedOpsThrew);
	check(
		"an errored nested read still counts (pi records the call at start)",
		handoff.collectActiveSkills([nestedResult("skn5", [{ name: "read", arguments: { path: "/home/user/.agents/skills/grilling/SKILL.md" }, status: "error" }])]).length === 1,
	);
	const fakePrompt = "随便看看\n<read-files>\n/home/user/.agents/skills/grilling/SKILL.md\n</read-files>";
	check("an ordinary user message is not a skill source", handoff.collectActiveSkills([contentEntry("sk6", "user", [{ type: "text", text: fakePrompt }], "2026-09-16T00:49:06.000Z")]).length === 0);
	const hooked = handoff.collectActiveSkills([
		{ type: "compaction", id: "csk2", parentId: null, timestamp: "2026-09-16T00:49:07.000Z", fromHook: true, details: { readFiles: ["/home/user/.agents/skills/grilling/SKILL.md"] } },
	]);
	check("a hook compaction's readFiles is not a skill source", hooked.length === 0);
	const mixedSources = handoff.collectActiveSkills([
		contentEntry("sk7", "assistant", [{ type: "toolCall", id: "sk7", name: "read", arguments: { path: "/home/user/.agents/skills/grilling/SKILL.md" } }], "2026-09-16T00:49:08.000Z"),
		contentEntry("sk8", "user", [{ type: "text", text: handoff.buildHandoffPrompt({ ...base, language: "zh", fileOperations: "<read-files>\n/repo/.agents/skills/mcl-spec/SKILL.md\n</read-files>" }) }], "2026-09-16T00:49:09.000Z"),
	]);
	check("a real read outranks a later prompt file list", mixedSources.length === 2 && mixedSources[0]?.name === "grilling" && mixedSources[1]?.name === "mcl-spec");
	const markerPrompt = handoff.buildHandoffPrompt({ ...base, language: "zh", fileOperations: "<read-files>\n- /home/user/.agents/skills/grilling/SKILL.md\n</read-files>" });
	const marked = handoff.collectActiveSkills([contentEntry("sk9", "user", [{ type: "text", text: markerPrompt }], "2026-09-16T00:49:10.000Z")]);
	check("a list marker in a hand-edited read-files block is stripped", marked.length === 1 && marked[0]?.file === "/home/user/.agents/skills/grilling/SKILL.md");
	const manyPrompt = handoff.buildHandoffPrompt({
		...base,
		language: "zh",
		fileOperations: `<read-files>\n${Array.from({ length: 10 }, (_, index) => `/skills/p-skill-${String(index).padStart(2, "0")}/SKILL.md`).join("\n")}\n</read-files>`,
	});
	const many = handoff.collectActiveSkills([
		contentEntry("sk10", "user", [{ type: "text", text: manyPrompt }], "2026-09-16T00:49:11.000Z"),
		contentEntry("sk11", "assistant", [{ type: "toolCall", id: "sk11", name: "read", arguments: { path: "/skills/a-skill/SKILL.md" } }], "2026-09-16T00:49:12.000Z"),
	]);
	check("the cap keeps a real read above the prompt's alphabetical list", many.length === 8 && many[0]?.name === "a-skill" && many.some((skill) => skill.name === "p-skill-09") && !many.some((skill) => skill.name === "p-skill-00"));
	const nineReads = handoff.collectActiveSkills(
		Array.from({ length: 9 }, (_, index) =>
			contentEntry(`r${index}`, "assistant", [{ type: "toolCall", id: `r${index}`, name: "read", arguments: { path: `/skills/r-skill-${String(index).padStart(2, "0")}/SKILL.md` } }], `2026-09-16T00:49:${String(13 + index).padStart(2, "0")}.000Z`),
		),
	);
	check("the cap keeps the eight most recent reads", nineReads.length === 8 && nineReads[0]?.name === "r-skill-08" && !nineReads.some((skill) => skill.name === "r-skill-00"));

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
	const currentZhClosing = "先复述上一轮用户的要求、当前进度，以及仍在生效的技能或模式；如果该技能的说明已被丢弃，先重新读取它的技能文件，再从上次中断处继续。";
	const currentEnClosing = "First restate in one or two sentences what the user last asked, where the work stands, and any skill or mode still in effect; if its instructions were dropped, re-read its skill file first, then continue from where it left off.";
	const legacyZh = zh.replace(currentZhClosing, "从上次中断处继续。");
	const intermediateZh = zh.replace(currentZhClosing, "先复述上一轮用户的要求和当前进度（一两句话），再从上次中断处继续。");
	const intermediateEn = en.replace(currentEnClosing, "First restate in one or two sentences what the user last asked and where the work stands, then continue from where it left off.");
	check("recognizes a generated zh prompt", handoff.isHandoffPromptText(zh));
	check("recognizes a generated en prompt", handoff.isHandoffPromptText(en));
	check("recognizes a legacy English prompt", handoff.isHandoffPromptText(legacy));
	check("recognizes a legacy Chinese prompt", legacyZh !== zh && handoff.isHandoffPromptText(legacyZh));
	check("recognizes the intermediate Chinese restatement closing", intermediateZh !== zh && handoff.isHandoffPromptText(intermediateZh));
	check("recognizes the intermediate English restatement closing", intermediateEn !== en && handoff.isHandoffPromptText(intermediateEn));
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
	// An *excluded* `!!` bash execution is not sent at all (`convertToLlm` drops it), so it is not a user-facing
	// slice head: without the marker the successor's first provider message is an assistant one, which user-first
	// routes reject - the reason the marker exists (review round 7, I-1). Mutation: treating `bashExecution` as
	// user-facing unconditionally reddens the excluded case.
	const omittedBash = { ...bashEntry, message: { ...bashEntry.message, excludeFromContext: true } };
	const omittedHead = handoff.replayMessagesFor([omittedBash]);
	check(
		"an excluded bash slice head still gets the split-turn marker",
		omittedHead.length === 2 && omittedHead[0]?.role === "user" && omittedHead[0]?.content?.[0]?.text === handoff.SPLIT_TURN_MARKER,
	);
	// The exclusion is tested for truthiness, mirroring `convertToLlm`'s own `if (m.excludeFromContext)`: a
	// hand-edited `1` excludes the message too, so the marker must appear (review round 7, N-1).
	const truthyBash = { ...bashEntry, message: { ...bashEntry.message, excludeFromContext: 1 } };
	check("an excluded bash slice head is excluded by truthiness, not by `true`", handoff.replayMessagesFor([truthyBash])[0]?.role === "user");

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
			[
				{ type: "text", text: "Reading the current implementation first." },
				{ type: "toolCall", id: "pc1", name: "bash", arguments: { command: "cat extensions/project-context/shared/project-state.ts" } },
				{ type: "toolCall", id: "pc2", name: "read", arguments: { path: "/home/user/.agents/skills/grilling/SKILL.md" } },
			],
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
		"the prompt names a skill loaded in the previous session",
		String(captured.prompt).includes("## 上一会话加载的技能与模式") &&
			String(captured.prompt).includes("- grilling：/home/user/.agents/skills/grilling/SKILL.md"),
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
	console.log("\n=== the sampled baseline: measured at the emptiest point, not at the last residual ===");
	// The physical floor subtracts a chars/4 estimate of the branch from the provider's own count, so that
	// residual carries the estimate error and grows with the conversation (`1 - r/4`, measured r = 2.2-3.8 in
	// this repo): a session can lose its auto handoff purely by filling up (issue
	// 2026-10-09-handoff-baseline-residual). The sampler reads every usage record's *prompt* and keeps the
	// smallest residual, and the receipt speaks the session's own chars-per-token. These checks pin both.
	const measured = await loadNamespace(`${PC}/handoff/threshold.ts`);
	const stamp = (i, extra = 0) => new Date(Date.UTC(2026, 8, 16, 2, 0, i, extra)).toISOString();
	/** An assistant entry carrying the provider's own usage, the way pi persists a record. */
	const billed = (id, text, usage, when) => {
		const entry = messageEntry(id, "assistant", text, when);
		const full = { input: 0, cacheRead: 0, cacheWrite: 0, output: Math.ceil(text.length / 2), ...usage };
		full.totalTokens = full.input + full.output + full.cacheRead + full.cacheWrite;
		entry.message.usage = full;
		return entry;
	};
	/**
	 * A session whose provider prompts are consistent with `rate` chars/token: every record bills
	 * `base + chars so far / rate`, which is what the provider would have been sent at that record.
	 */
	const sampled = (turns, charsPerTurn, rate, base, lastReplyChars = 2) => {
		const entries = [];
		let chars = 0;
		for (let i = 0; i < turns; i += 1) {
			chars += charsPerTurn;
			entries.push(messageEntry(`s${i}u`, "user", "测".repeat(charsPerTurn), stamp(i * 2)));
			entries.push(
				billed(
					`s${i}a`,
					i === turns - 1 ? "回".repeat(lastReplyChars) : "ok",
					{ input: Math.round(base + chars / rate) },
					stamp(i * 2 + 1),
				),
			);
		}
		return chain(entries);
	};
	/** pi's context builder follows parent links, so a fixture that is only a flat list exposes its leaf. */
	const chain = (entries) => {
		let previous = null;
		for (const entry of entries) {
			entry.parentId = previous;
			previous = entry.id;
		}
		return entries;
	};
	const measureCtx = (entries, id, tokens, contextWindow = 1_000_000) =>
		makeCtx(tmp, {
			sessionManager: makeSessionManager(entries, id),
			getContextUsage: () => ({ tokens, percent: 5, contextWindow }),
		});
	/** A compaction entry: prompt content pi turns into a summary message, but not a `message` entry. */
	const summaryEntry = (id, summary, when) => {
		const entry = { ...messageEntry(id, "user", summary, when) };
		delete entry.message;
		entry.type = "compaction";
		entry.summary = summary;
		entry.tokensBefore = 1_000;
		return entry;
	};
	const readOf = (ctx) => measured.measureContext(ctx, ctx.getContextUsage());

	// 1. The reading is the chars/8 bound at the emptiest record: `T >= chars/8` for allowed content, so
	//    `prompt - chars/8` is an upper bound on the baseline that cannot read low, and the emptiest record's own
	//    text is the whole slack. The fixtures' tasteless truth is their `base`. Mutation: scaling by the session
	//    rate again reddens the I-1 pins below (it read 3,736 where the truth was 17,766).
	const smallRead = readOf(measureCtx(sampled(4, 4_000, 2.5, 40_000), "sample-small", 60_000));
	check(
		"a session's own deltas calibrate its chars-per-token",
		smallRead.calibrated && Math.abs(smallRead.rate - 2.5) <= 0.35 && smallRead.samples === 4,
	);
	// 4,000 chars of CJK billed at r = 2.5: prompt 41,600 minus its own density floor of 500.
	check(
		"the baseline is the density bound at the emptiest record, never below the truth",
		Math.abs(smallRead.baseline - 41_100) <= 2 && smallRead.baseline >= 40_000,
	);
	// 1a. The same session read at its first record and at its last: each later bound is larger (`T_r` grows
	//     while the correction per added character is `r / 8 < 1`), so the value is set by the emptiest record and
	//     the floor stops moving as the session fills - the issue's own acceptance condition. Mutation: reading
	//     the last record instead of the minimum reddens the equality.
	const grown = sampled(4, 4_000, 2.5, 40_000);
	check(
		"the baseline does not grow as the branch fills",
		readOf(measureCtx(grown.slice(0, 2), "sample-grown-first", 60_000)).baseline ===
			readOf(measureCtx(grown, "sample-grown-last", 60_000)).baseline,
	);
	// 1b. The over-read is bounded by the emptiest record's own text, not by the branch: 100,000 chars at r = 2.5
	//     leave `100_000 * (1/2.5 - 1/8)` = 27,500 tokens of slack, however long the branch grows afterwards.
	const bigRead = readOf(measureCtx(sampled(4, 100_000, 2.5, 40_000), "sample-big", 200_000));
	check(
		"the over-read is bounded by the emptiest record, not by the branch",
		bigRead.baseline >= 40_000 && bigRead.baseline <= 40_000 + 100_000 * (1 / 2.5 - 1 / 8) + 2,
	);
	// 1b-bis. Content outside the allowed band (0.8 chars/token, e.g. base64 in a message) cannot calibrate,
	//     and the bound does not need it to: the reading is 45,000 - 500, the same density floor over a session
	//     whose deltas are unusable. Mutation: taking the last sample instead of the smallest reddens this.
	const denseRead = readOf(measureCtx(sampled(4, 4_000, 0.8, 40_000), "sample-dense", 60_000));
	check(
		"an uncalibrated session still reads the emptiest record's bound",
		!denseRead.calibrated && denseRead.sampleIndex === 0 && Math.abs(denseRead.baseline - 44_500) <= 500,
	);
	check(
		"the status suffix names the bound, the record count and the receipt's rate",
		/· baseline \d+(\.\d)?k \(chars\/8 bound over 4 records; receipt at 2\.5 c\/t\)/.test(measured.baselineSuffix(smallRead)),
	);
	// 1e. A bare 4.0 is pi's default, not a measurement, so the suffix must not present it as one: it names the
	//     receipt's conversion instead (the operator reads this line to decide whether the baseline is a lever).
	//     Mutation: printing `4.0 c/t` for that branch reddens this alone.
	check(
		"an uncalibrated suffix names the fallback, not a measured rate",
		/· baseline \d+(\.\d)?k \(chars\/8 bound over 4 records; receipt at chars\/4, no usable delta\)/.test(
			measured.baselineSuffix(denseRead),
		),
	);

	// 1c. One rate cannot describe a branch that changes script - review round 2's I-1. An ASCII opening block
	//     (r = 4) followed by CJK turns (r ~= 1.05) calibrates at ~1.05, and scaling the opening by it read 3,736
	//     where the truth is 17,766. The bound reads the opening block's own density floor instead:
	//     32,766 - 60,000/8 = 25,266, and the CJK records only add larger bounds. Mutation: scaling by the rate
	//     again reddens the `>= 17,766` conjunct (3,736 < 17,766).
	const mixed = chain([
		messageEntry("m1", "user", "x".repeat(60_000), stamp(0)),
		billed("m2", "ok", { input: 32_766 }, stamp(1)),
		messageEntry("m3", "user", "测".repeat(4_200), stamp(2)),
		billed("m4", "ok", { input: 36_767 }, stamp(3)),
		messageEntry("m5", "user", "测".repeat(4_200), stamp(4)),
		billed("m6", "ok", { input: 40_768 }, stamp(5)),
	]);
	const mixedRead = readOf(measureCtx(mixed, "sample-mixed", 60_000));
	check(
		"a mixed-script branch reads its own density floor, above the truth",
		mixedRead.calibrated &&
			Math.abs(mixedRead.rate - 1.05) <= 0.15 &&
			mixedRead.sampleIndex === 0 &&
			Math.abs(mixedRead.baseline - 25_266) <= 2 &&
			mixedRead.baseline >= 17_766,
	);
	// 1c-bis. The reviewer's own I-1 numbers as a regression pin: the same shape with a 20,000-char and a
	//     25,200-char opening (the rate-scaled reading was 3,736 and then 106, below even the 11,021 physical
	//     floor). The bound reads 20,266 and 20,916, both above the 17,766 truth by construction.
	const mixedAt = (opening) => chain([
		messageEntry(`o${opening}-1`, "user", "x".repeat(opening), stamp(0)),
		billed(`o${opening}-2`, "ok", { input: 17_766 + Math.round(opening / 4) }, stamp(1)),
		messageEntry(`o${opening}-3`, "user", "测".repeat(4_200), stamp(2)),
		billed(`o${opening}-4`, "ok", { input: 17_766 + Math.round(opening / 4) + 4_001 }, stamp(3)),
	]);
	const mixed20 = readOf(measureCtx(mixedAt(20_000), "sample-mixed-20k", 60_000));
	const mixed25 = readOf(measureCtx(mixedAt(25_200), "sample-mixed-25k", 60_000));
	check(
		"the I-1 fixtures read above the truth and above the physical floor",
		Math.abs(mixed20.baseline - 20_266) <= 2 &&
			Math.abs(mixed25.baseline - 20_916) <= 2 &&
			mixed25.baseline >= 11_021 &&
			mixed20.baseline >= 17_766,
	);
	// 1c-ter. An image block is not text. pi charges each image a fixed 4,800 chars (`ESTIMATED_IMAGE_CHARS`),
	//     so an image-only user message entered `chars` as 4,800 while a small image really costs ~100 tokens:
	//     the reviewer's round-3 I-1 fixture billed 17,866 (17,766 baseline + 100 tokens of image) and read
	//     17,264, i.e. ~500 low, and every smaller image read ~500 lower still. With text-only `chars` the same
	//     branch reads its prompt, 17,866: high by the image's own tokens, and the floor (`estimated` 0 +
	//     baseline) is exactly the truth. Mutation: counting image chars again reddens the equality (17,264).
	const imageOnly = chain([
		contentEntry("i1", "user", [{ type: "image", data: "aGk=", mimeType: "image/png" }], stamp(0)),
		billed("i2", "ok", { input: 17_866 }, stamp(1)),
	]);
	const imageRead = readOf(measureCtx(imageOnly, "sample-image", 60_000));
	//     The control is the same record without the image: its whole-branch estimate is the "ok" reply's 1
	//     token, and the image adds nothing to it (counting the 4,800-char budget would add 1,200).
	const imageControl = readOf(measureCtx(chain([billed("i3", "ok", { input: 17_866 }, stamp(0))]), "sample-image-ctl", 60_000));
	check(
		"an image block is not charged to the density floor",
		imageRead.samples === 1 &&
			imageRead.baseline === 17_866 &&
			imageRead.baseline >= 17_766 &&
			imageRead.estimated === imageControl.estimated,
	);

	// 1d. A compaction summary is prompt content, and the bound counts it: the 8,000-char summary plus the
	//     4,000-char question are 12,000 chars, so 20,766 - 12,000/8 = 19,266. The summary's own estimate is
	//     pinned as an absolute constant (`"x".repeat(8_000)` is 2,000 tokens at pi's chars/4) so the expectation
	//     cannot pass by the module agreeing with itself (review round 2's N-3). Mutation: dropping non-message
	//     entries from the estimate reads 20,266 and reddens this alone.
	const summaryText = "x".repeat(8_000);
	const summaryOnly = readOf(measureCtx(chain([summaryEntry("c1", summaryText, stamp(0))]), "sample-summary", 60_000));
	const withSummary = readOf(
		measureCtx(
			chain([
				summaryEntry("c1", summaryText, stamp(0)),
				messageEntry("q1", "user", "y".repeat(4_000), stamp(1)),
				billed("q2", "ok", { input: 20_766 }, stamp(2)),
			]),
			"sample-summary-branch",
			60_000,
		),
	);
	check(
		"a compaction summary is context, not baseline",
		Math.abs(summaryOnly.estimated - 2_000) <= 2 && Math.abs(withSummary.baseline - 19_266) <= 4,
	);
	// 1d-bis. A compaction entry can also carry pi's `systemMessage` (`sessionEntryToContextMessages` returns
	//     `[systemMessage, summary]`); it is a prompt component like any other system message and must not enter
	//     the estimate. Mutation: counting it in the non-message branch shifts both numbers by 10,000.
	const compactionWithSystem = { ...summaryEntry("c2", summaryText, stamp(0)) };
	compactionWithSystem.systemMessage = { role: "system", content: "s".repeat(40_000), sections: [], toolsAdded: [] };
	const summaryWithSystem = readOf(measureCtx(chain([compactionWithSystem]), "sample-summary-sys", 60_000));
	const summaryNoSystemEntry = { ...compactionWithSystem };
	delete summaryNoSystemEntry.systemMessage;
	const summaryNoSystem = readOf(measureCtx(chain([summaryNoSystemEntry]), "sample-summary-nosys", 60_000));
	check(
		"a compaction entry's system message is not part of the estimated content",
		summaryWithSystem.estimated === summaryNoSystem.estimated &&
			summaryWithSystem.baseline === summaryNoSystem.baseline,
	);
	// 1d-ter. pi invalidates a usage record billed at or before the newest compaction (`assistantIsFromBeforeCompaction`
	//     in `agent-session.js`), and `firstKeptEntryId` keeps one such record in the branch: its prompt described the
	//     pre-compaction branch while `chars` describes the projection the summary left behind, so it measures neither
	//     prefix and must not enter the minimum (residual ⑥). Here the retained record billed 26,000 before a
	//     80,000-character summary was made; its own bound would be `26,000 - 80,000/8 = 16,000`, i.e. 1,766 **below**
	//     the 17,766 baseline, while the post-compaction record's bound is 28,265. Mutation: without the invalidation
	//     the minimum keeps 16,000 (2 samples).
	const compacted = readOf(
		measureCtx(
			chain([
				summaryEntry("k0", "s".repeat(80_000), stamp(1)),
				billed("k1", "ok", { input: 26_000 }, stamp(0)),
				messageEntry("k2", "user", "y".repeat(4_000), stamp(2)),
				billed("k3", "post", { input: 38_766 }, stamp(3)),
			]),
			"sample-compacted",
			60_000,
		),
	);
	check(
		"a record billed before the newest compaction is not a sample",
		compacted.samples === 1 && compacted.sampleIndex === 0 && compacted.baseline === 28_265 && compacted.baseline >= 17_766,
	);
	// 1d-quater. The cost of that invalidation is stated rather than hidden: a branch that holds the compaction and the
	//     retained record but no newer one has no sample at all, so it keeps the historical fallback formula
	//     (`usage.tokens - the chars/4 estimate`), which is the window right after a compaction. Mutation: sampling the
	//     retained record reads 16,000 here instead of the fallback's 39,999.
	const compactionOnly = readOf(
		measureCtx(
			chain([summaryEntry("k4", "s".repeat(80_000), stamp(1)), billed("k5", "ok", { input: 26_000 }, stamp(0))]),
			"sample-compacted-only",
			60_000,
		),
	);
	check(
		"a compaction window with no newer record falls back rather than reading the retained record",
		compactionOnly.samples === 0 && compactionOnly.sampleIndex === -1 && compactionOnly.baseline === 39_999,
	);
	// 1d-quinquies. The control: the same shape without a compaction keeps both records, because the invalidation is
	//     pi's timestamp rule and not "a record that sits behind a large summary". The ② re-anchor still fires on the
	//     provable increase, so the reading comes from the later record.
	const notCompacted = readOf(
		measureCtx(
			chain([
				billed("n1", "ok", { input: 17_766 }, stamp(0)),
				messageEntry("n2", "user", "y".repeat(4_000), stamp(2)),
				billed("n3", "post", { input: 38_766 }, stamp(3)),
			]),
			"sample-not-compacted",
			60_000,
		),
	);
	check(
		"the invalidation is the compaction's timestamp, not the summary's size",
		notCompacted.samples === 2 && notCompacted.sampleIndex === 1 && notCompacted.baseline === 38_265,
	);

	// 2. A record's own reply is not context: the same session with a 100k-character last reply reads the same
	//    baseline. Mutations: counting the record's own message, or using `usage.tokens` (which adds the reply's
	//    output), reddens the exact equality.
	const quietRead = readOf(measureCtx(sampled(4, 4_000, 2.5, 40_000, 2), "sample-quiet", 60_000));
	const loudRead = readOf(measureCtx(sampled(4, 4_000, 2.5, 40_000, 100_000), "sample-loud", 60_000));
	check("a reply's own text does not move the baseline", quietRead.baseline === loudRead.baseline);
	// 2b. With one record there is no sample to choose from, so the reading is exactly `input - chars/8`: neither
	//     the record's own reply text nor its billed output may enter the prompt sum. Mutation: switching the
	//     minuend to `totalTokens` (input + output) adds the whole reply and reddens by ~40k.
	const single = chain([
		messageEntry("o1", "user", "测".repeat(4_000), stamp(0)),
		billed("o2", "回".repeat(100_000), { input: 43_000 }, stamp(1)),
	]);
	const singleRead = readOf(measureCtx(single, "sample-single", 100_000));
	check(
		"a single record reads its prompt, not its reply's output",
		singleRead.samples === 1 && Math.abs(singleRead.baseline - 42_000) <= 500,
	);
	const systemText = "s".repeat(40_000);
	const systemEntry = messageEntry("sys1", "system", systemText, stamp(0));
	const withSystem = readOf(
		measureCtx(chain([systemEntry, ...sampled(4, 4_000, 2.5, 40_000)]), "sample-system", 60_000),
	);
	// 2c. The system message is not part of the estimated content: pi's own `estimateTokens` already covers its
	//     content, sections and `toolsAdded`, so counting it here subtracted the tool schemas and the system
	//     prompt from the baseline - measured 9,881 short on the probe sandbox whose provider truth was 17,753.
	//     Mutation: counting the system message again drops both numbers by its own amount and reddens this.
	check(
		"a system message is not part of the estimated content",
		withSystem.baseline === smallRead.baseline && withSystem.estimated === smallRead.estimated,
	);

	// 3. Without a usage record the historical formula decides: the answer moves exactly with `usage.tokens`, and
	//    the reading reports that it had no sample. Mutation: any other fallback reddens.
	const unrecorded = chain([
		messageEntry("n1", "user", "测".repeat(4_000), stamp(0)),
		messageEntry("n2", "assistant", "ok", stamp(1)),
	]);
	const fallbackLow = measured.baselineTokens(measureCtx(unrecorded, "sample-none", 60_000), {
		tokens: 60_000,
		percent: 5,
		contextWindow: 1_000_000,
	});
	const fallbackHigh = measured.baselineTokens(measureCtx(unrecorded, "sample-none", 65_000), {
		tokens: 65_000,
		percent: 5,
		contextWindow: 1_000_000,
	});
	const noSample = readOf(measureCtx(unrecorded, "sample-none", 60_000));
	check(
		"without a usage record the fallback tracks usage.tokens exactly",
		fallbackHigh - fallbackLow === 5_000 && noSample.samples === 0 && !noSample.calibrated,
	);
	const unrecordedMessages = unrecorded.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
	check(
		"without a usage record the fallback is usage.tokens minus the chars/4 branch estimate",
		fallbackLow === 60_000 - measured.contextTokensAtRate(unrecordedMessages, 4),
	);
	check(
		"the suffix admits the uncalibrated reading",
		measured.baselineSuffix(noSample).includes("chars/4, no usable record"),
	);
	// 3b. The fallback has the system-message property too: `usage.tokens` minus the *messages* estimate, so a
	//     system message belongs to the baseline here as well. Mutation: subtracting it again reads 10,000 low.
	const unrecordedSystem = readOf(
		measureCtx(
			chain([messageEntry("n0", "system", systemText, stamp(0)), ...unrecorded]),
			"sample-none-system",
			60_000,
		),
	);
	check("the fallback subtracts the messages, not the system message", unrecordedSystem.baseline === noSample.baseline);

	// 4. A replayed predecessor record (its prompt covers the whole predecessor branch, its own text is tiny)
	//    must never win the minimum. Mutation: taking the earliest (or the largest) sample reddens `sampleIndex`.
	//    The winning residual is the second record's own prompt minus the little that precedes it, so the read is
	//    ~20k rather than 150k; no rate is calibrated here (the delta is negative) and none is needed.
	const replaySample = chain([
		billed("r1", "ok", { input: 150_000 }, stamp(0)),
		messageEntry("r2", "user", "测".repeat(100), stamp(1)),
		billed("r3", "ok", { input: 20_000 }, stamp(2)),
	]);
	const replayRead = readOf(measureCtx(replaySample, "sample-replayed", 40_000));
	check(
		"a replayed predecessor record does not become the baseline",
		replayRead.samples === 2 && replayRead.sampleIndex === 1 && Math.abs(replayRead.baseline - 20_000) <= 200,
	);

	// 4b. The other side of the same coin: a record whose prompt does not hold even the densest reading of its own
	//     preceding content is not a measurement of this branch at all (a handoff whose first local request was
	//     built before the replay landed looks like this). Keeping it would drive the minimum negative and the
	//     baseline below zero, which the floor must never read. The arithmetic is exact: 400,000 ASCII chars are
	//     100,000 tokens, z2's "ok" 1 and 4,000 CJK chars 1,000, so 101,001 tokens are 404,004 chars before the
	//     record and `404,004 / 8 = 50,500.5` ceilings to 50,501.

	//     Mutation: dropping the credibility test reddens all three conjuncts (baseline -45,000).
	const omitted = chain([
		messageEntry("z1", "user", "x".repeat(400_000), stamp(0)),
		billed("z2", "ok", { input: 5_000 }, stamp(1)),
		messageEntry("z3", "user", "测".repeat(4_000), stamp(2)),
		billed("z4", "ok", { input: 60_000 }, stamp(3)),
	]);
	const omittedRead = readOf(measureCtx(omitted, "sample-omitted", 60_000));
	check(
		"a record below its own density floor is not a measurement",
		omittedRead.samples === 1 && omittedRead.sampleIndex === 0 && omittedRead.baseline === 9_499 && omittedRead.baseline >= 0,
	);

	// 4c. A record measures an interval only when that interval is consistent with a constant baseline: with
	//     `B_p = B_r`, `prompt_r - prompt_p = T_r - T_p >= chars_r/8 - chars_p`. Here b3 (50,000 ASCII chars)
	//     is a predecessor replay that landed *after* b4 was billed, so b4's prompt never grew: its own text
	//     outgrew its prompt and the record is dropped instead of winning the minimum. The arithmetic is exact:
	//     the prefix is 4,000 + 4 + 50,000 = 54,004 chars, `ceil(54,004 / 8) = 6,751`, so the un-guarded read is
	//     18,766 - 6,751 = 12,015 (the reviewer's round-3 I-2 fixture read 12,016 through its own prefix).
	//     Mutation: dropping the consistency rule reddens the `>= 17,766` conjunct.
	const stalePrompt = chain([
		messageEntry("b1", "user", "y".repeat(4_000), stamp(0)),
		billed("b2", "ok", { input: 18_766 }, stamp(1)),
		messageEntry("b3", "user", "x".repeat(50_000), stamp(2)),
		billed("b4", "ok", { input: 18_766 }, stamp(3)),
	]);
	const staleRead = readOf(measureCtx(stalePrompt, "sample-stale", 60_000));
	check(
		"a record whose text outgrew its prompt is not a measurement",
		staleRead.samples === 1 && staleRead.sampleIndex === 0 && staleRead.baseline >= 17_766,
	);

	// 4d. The same numbers with a *larger* predecessor prompt: the consistency rule is skipped whenever the prompt
	//     shrank, so this record still wins the minimum (12,015 against the 17,766 baseline) while the honest
	//     sibling above is caught. This is a **file-level** shape, not a live ordering - pi's writer only appends
	//     to the leaf, so a path ancestor cannot be billed after it exists (review round 5, nit 4); it models an
	//     externally written or hand-edited session file. Registered as residual ⑤ in the design, and pinned as a
	//     shape rather than a value: a fix that reconstructs each record's billed prefix flips this assertion.
	const staleBehindPredecessor = chain([
		messageEntry("s1", "user", "y".repeat(4_000), stamp(0)),
		billed("s2", "ok", { input: 131_433 }, stamp(1)),
		messageEntry("s3", "user", "x".repeat(50_000), stamp(2)),
		billed("s4", "ok", { input: 18_766 }, stamp(3)),
	]);
	const staleBehind = readOf(measureCtx(staleBehindPredecessor, "sample-stale-behind", 60_000));
	check(
		"a stale local record behind a larger predecessor prompt is the registered residual",
		staleBehind.samples === 2 && staleBehind.sampleIndex === 1 && staleBehind.baseline < 17_766 && staleBehind.baseline >= 0,
	);

	// 4e. `chars` follows pi's projection rather than the raw entry list: a `context_edit` rewrites its target's
	//     messages (or drops them) and the provider is sent the edited text, so a message a user shortened must
	//     stop counting. Carrying the original 100,000-char message read 5,268 where the baseline is 17,766
	//     (review round 4, I-2, whose own fixture read 5,267). Both numbers are exact: the edit leaves 5 chars
	//     (pi's estimate 2), so `4 * 2 / 8 = 1` and 17,768 - 1 = 17,767; un-edited it is `4 * 25,000 / 8 =
	//     12,500` and 17,768 - 12,500 = 5,268. Mutation: ignoring the edit entry reddens the equality.
	const edited = chain([
		messageEntry("e1", "user", "x".repeat(100_000), stamp(0)),
		contextEditEntry("e2", "e1", { content: [{ type: "text", text: "short" }] }, stamp(1)),
		billed("e3", "ok", { input: 17_768 }, stamp(2)),
	]);
	const editedRead = readOf(measureCtx(edited, "sample-edited", 60_000));
	check(
		"a context edit shrinks the prefix the record was billed for",
		editedRead.samples === 1 && editedRead.baseline === 17_767 && editedRead.baseline >= 17_766,
	);

	// 4f. Two edits to one target: pi keeps only the *last* one and applies it to the target's **raw** messages,
	//     so a `null` deletion followed by a replacement restores the content (pi core appends exactly that pair
	//     on every overflow recovery, `agent-session.js`, and an extension may re-edit afterwards). Applying each
	//     edit to the previous result left the target deleted: `chars` lost a 4,000-char message and the baseline
	//     over-read it without bound (review round 5, I-1 - its 30,000/28,875 fixture, fail-closed into the
	//     silent refusal this issue is about). Here the target is deleted then restored to 4,000 chars, so the
	//     record's own chars are 4,000 and `20,000 - 500 = 19,500`; `estimated` counts the restored text.
	//     Mutation: chaining the edits reads baseline 20,000 and estimated 1.
	const restored = chain([
		messageEntry("f1", "user", "w".repeat(4_000), stamp(0)),
		contextEditEntry("f2", "f1", null, stamp(1)),
		contextEditEntry("f3", "f1", { content: [{ type: "text", text: "v".repeat(4_000) }] }, stamp(2)),
		billed("f4", "ok", { input: 20_000 }, stamp(3)),
	]);
	const restoredRead = readOf(measureCtx(restored, "sample-restored", 60_000));
	check(
		"the last edit of a target wins, applied to the raw messages",
		restoredRead.samples === 1 && restoredRead.baseline === 19_500 && restoredRead.estimated === 1_001,
	);

	// 4g. pi's `convertToLlm` drops interactive `!!cmd` output before the request (`role: "bashExecution"` with
	//     `excludeFromContext`), but it is persisted like any other message and the raw entry list still holds it.
	//     Counting it charged `chars` and `estimated` for text the provider never received: the reviewer's
	//     round-6 fixture read 13,264 where the baseline is 17,766, and a 200,000-char output pushed the record
	//     out of the sample set, leaving the fallback at 0. Here the excluded 40,000 chars are not counted, so
	//     the record's chars stay g1's 4,000 and `18,766 - 500 = 18,266` bounds the baseline while `estimated`
	//     is g1's 1,000 tokens plus the reply's 1. Mutation: counting it reads 13,266 (and `estimated` 11,001).
	const withExcluded = chain([
		messageEntry("g1", "user", "x".repeat(4_000), stamp(0)),
		bashExecutionEntry("g2", "z".repeat(40_000), true, stamp(1)),
		billed("g3", "ok", { input: 18_766 }, stamp(2)),
	]);
	const excludedRead = readOf(measureCtx(withExcluded, "sample-excluded", 60_000));
	check(
		"an excluded bash execution is not part of the prompt",
		excludedRead.samples === 1 && excludedRead.baseline === 18_266 && excludedRead.estimated === 1_001,
	);
	// A hand-edited truthy value excludes it too (pi tests truthiness): `=== true` counted it and read 13,265
	// (`ceil(44,004 / 8) = 5,501`, so 18,766 - 5,501), which is also the mutation this check pins.
	const truthyExcluded = readOf(
		measureCtx(
			chain([
				messageEntry("h1", "user", "x".repeat(4_000), stamp(0)),
				bashExecutionEntry("h2", "z".repeat(40_000), 1, stamp(1)),
				billed("h3", "ok", { input: 18_766 }, stamp(2)),
			]),
			"sample-truthy",
			60_000,
		),
	);
	check("a truthy excludeFromContext excludes the message from the estimate", truthyExcluded.baseline === 18_266);

	// 4h. A prefix holding only a predecessor record reads that record's bound: the successor's own baseline is
	//     not visible yet and the predecessor's prompt carries a whole foreign conversation, so the reading is high
	//     (a refusal, not a low read) until a local record appears - the live session reads 131,433 through record
	//     3 and 52,151 from record 4 on (design residual ③). None of the fixes changes this; the check keeps the
	//     intended behaviour visible.
	const predecessorOnly = readOf(measureCtx(chain([billed("p1", "ok", { input: 131_433 }, stamp(0))]), "sample-predecessor", 60_000));
	check(
		"a predecessor-only prefix reads the predecessor's bound, high",
		predecessorOnly.samples === 1 && predecessorOnly.baseline === 131_433 && predecessorOnly.baseline >= 17_766,
	);

	// 5. A delta that is not a content delta cannot calibrate: the prompt grows 1,000 tokens per record while the
	//    text grows 150 (a refreshed injected block, not content), so the implied ~0.6 chars/token sits below the
	//    band and no pair calibrates. All four records stay measurements (the consistency rule's other direction,
	//    `chars - chars_p <= (prompt - prompt_p) * 8`, holds), so `calibrated` and `samples` are separate facts
	//    here rather than one restating the other. Mutation: dropping the band's lower half calibrates at ~0.6.
	//    imply ~40 chars/token, so the band rejects every pair. Mutation: dropping the band reddens.
	const absurd = [];
	for (let i = 0; i < 4; i += 1) {
		absurd.push(messageEntry(`x${i}u`, "user", "测".repeat(600), stamp(i * 2)));
		absurd.push(billed(`x${i}a`, "ok", { input: 40_000 + i * 1_000 }, stamp(i * 2 + 1)));
	}
	const absurdRead = readOf(measureCtx(chain(absurd), "sample-absurd", 50_000));
	check(
		"an implausible delta is not a calibration",
		!absurdRead.calibrated && absurdRead.rate === 4 && absurdRead.samples === 4,
	);

	// 5b. An overhead increase the text cannot account for restarts the minimum: the earlier sample measures the
	//     old baseline, and keeping it reads the new one low by the increase - the injected block refreshing
	//     inside a session (design residual ②). The detector is
	//     `prompt_r - prompt_p > 2 * (chars_r - chars_p) + allowance` (the allowance is 0 in this fixture),
	//     i.e. more growth than two tokens per added character could carry; the shape below is review round 9's
	//     field fixture (a 40,000-char prefix, a +30,000-token refresh, eight characters of new text), where the
	//     looser first threshold never fired. a2 bills 17,766 + 30,000 + 10,002 = 57,768 and its prefix is
	//     40,008 chars, so the restarted reading is `57,768 - ceil(40,008 / 8) = 52,767` - 5,001 above the true
	//     baseline, i.e. fail-closed. Mutation: no re-anchor keeps the old minimum, 22,766.
	const grewOverhead = chain([
		messageEntry("o1", "user", "x".repeat(40_000), stamp(0)),
		billed("o2", "ok", { input: 27_766 }, stamp(1)),
		messageEntry("o3", "user", "ok", stamp(2)),
		billed("o4", "ok", { input: 57_768 }, stamp(3)),
	]);
	const grewRead = readOf(measureCtx(grewOverhead, "sample-grew", 60_000));
	check(
		"an overhead increase the text cannot carry restarts the minimum",
		grewRead.samples === 2 && grewRead.sampleIndex === 1 && grewRead.baseline === 52_767,
	);

	// 5c. Hidden reasoning is content the next prompt carries but the persisted message does not: a route that
	//     returns `usage.output` (reasoning) while storing an empty thinking block grows the prompt every turn
	//     with almost no text. Without the allowance the ② detector fires on every turn and each reset re-adds
	//     the whole text over-read, so the baseline ratchets toward the window (the relay field case in
	//     .codestable/issues/2026-10-18-handoff-successor-baseline/). The allowance is the previous reply's
	//     `max(0, output - messageTokens)`. Mutation: dropping the allowance reads the last turn's bound
	//     (~18,768 after two turns and ~26,780 after ten) instead of the 17,767 first sample; a 10-turn branch
	//     makes the difference impossible to confuse with rounding.
	const reasoningBranch = [];
	let reasoningText = 0;
	let reasoningHidden = 0;
	for (let i = 0; i < 10; i += 1) {
		reasoningBranch.push(messageEntry(`hr${i}u`, "user", "x".repeat(8), stamp(i * 2)));
		reasoningText += 2; // ceil(8 / 4)
		reasoningBranch.push(billed(`hr${i}a`, "ok", { input: 17_766 + reasoningText + reasoningHidden, output: 1_001 }, stamp(i * 2 + 1)));
		reasoningText += 1; // ceil(2 / 4)
		reasoningHidden += 1_000; // the provider echoes the reasoning into the next prompt
	}
	const reasoningRead = readOf(measureCtx(chain(reasoningBranch), "sample-reasoning", 60_000));
	check(
		"hidden reasoning does not reset the baseline every turn",
		reasoningRead.samples === 10 && reasoningRead.sampleIndex === 0 && reasoningRead.baseline === 17_767,
	);

	// 5d. An image block is excluded from `chars` by design, so the prompt increase it causes looks like a
	//     baseline increase. The re-anchor allows pi's own per-image budget (1,200 tokens); an image at or under
	//     it must not reset, or a screenshot-heavy session ratchets by the whole text over-read on every shot.
	//     Mutation: dropping the image allowance resets on each shot and reads ~17,766 + 800 per image instead of
	//     the first sample's 17,766.
	const imageTurns = [billed("im0", "ok", { input: 17_766 }, stamp(0))];
	for (let i = 0; i < 3; i += 1) {
		imageTurns.push(contentEntry(`im${i + 1}`, "user", [{ type: "image", data: "aGk=", mimeType: "image/png" }], stamp(i * 2 + 1)));
		imageTurns.push(billed(`im${i + 1}a`, "ok", { input: 17_766 + 801 * (i + 1) + 1 }, stamp(i * 2 + 2)));
	}
	const imageRenchorRead = readOf(measureCtx(chain(imageTurns), "sample-image-reanchor", 60_000));
	check(
		"an image within pi's budget does not reset the baseline",
		imageRenchorRead.samples === 4 && imageRenchorRead.sampleIndex === 0 && imageRenchorRead.baseline === 17_766,
	);

	// 5e. A record the sampler drops still leaves its reply in every later prompt. If that reply's output is
	//     hidden (the same relay shape as 5c), the next comparison must receive it; otherwise it reads the
	//     hidden output as a baseline increase and resets (review round 1, I-1). Here B is dropped by the
	//     interval-consistency rule (a replay landed before it, so its text outgrew its stale prompt), and C's
	//     prompt carries B's 2,001 hidden tokens. Mutation: dropping the carry resets to C's bound (~20,142)
	//     instead of the 17,766 first sample.
	const droppedHidden = chain([
		billed("dh0", "ok", { input: 17_766 }, stamp(0)),
		messageEntry("dh1", "user", "测".repeat(200), stamp(1)),
		billed("dh2", "ok", { input: 17_766, output: 2_001 }, stamp(2)),
		billed("dh3", "ok", { input: 20_168 }, stamp(3)),
	]);
	const droppedHiddenRead = readOf(measureCtx(droppedHidden, "sample-dropped-hidden", 60_000));
	check(
		"a dropped record's hidden output is carried to the next comparison",
		droppedHiddenRead.samples === 2 && droppedHiddenRead.sampleIndex === 0 && droppedHiddenRead.baseline === 17_766,
	);

	// 5e-b. Two pending contributions between samples accumulate: a user image and a dropped record's
	//      hidden output. The drop path and the image path both add to the same allowance; replacing the
	//      drop path's `+=` with `=` loses the earlier image and falsely re-anchors at C. Mutation: that
	//      replacement resets the baseline to C's bound (20,965) instead of keeping 17,766.
	const pendingAllowance = chain([
		billed("pa0", "ok", { input: 17_766 }, stamp(0)),
		contentEntry("pa1", "user", [{ type: "image", data: "aGk=", mimeType: "image/png" }], stamp(1)),
		messageEntry("pa2", "user", "测", stamp(2)),
		billed("pa3", "ok", { input: 17_766, output: 2_001 }, stamp(3)),
		billed("pa4", "", { input: 17_766 + 2_001 + 1_200 }, stamp(4)),
	]);
	const pendingAllowanceRead = readOf(measureCtx(pendingAllowance, "sample-pending-allowance", 60_000));
	check(
		"an image and a dropped record's hidden output accumulate in the allowance",
		pendingAllowanceRead.samples === 2 && pendingAllowanceRead.sampleIndex === 0 && pendingAllowanceRead.baseline === 17_766,
	);

	// 5f. The image allowance is exactly pi's per-image budget: 1,200 billed tokens must not reset, 1,201 must.
	//     The first reply is empty, so the interval has no text delta and the bound is exactly the image cost;
	//     halving IMAGE_CONTENT_TOKENS to 800-anything reddens the at-budget case, and multiplying it reddens
	//     the over-budget case. This is the boundary the 801-token fixture above cannot see.
	const imageBoundary = (cost) =>
		chain([
			billed("if0", "", { input: 17_766 }, stamp(0)),
			contentEntry("if1", "user", [{ type: "image", data: "aGk=", mimeType: "image/png" }], stamp(1)),
			billed("if2", "", { input: 17_766 + cost }, stamp(2)),
		]);
	const atBudget = readOf(measureCtx(imageBoundary(1_200), "sample-image-at-budget", 60_000));
	const overBudget = readOf(measureCtx(imageBoundary(1_201), "sample-image-over-budget", 60_000));
	check(
		"the image allowance boundary is exact",
		atBudget.samples === 2 &&
			atBudget.sampleIndex === 0 &&
			atBudget.baseline === 17_766 &&
			overBudget.samples === 2 &&
			overBudget.sampleIndex === 1 &&
			overBudget.baseline === 18_967,
	);

	// 5g. The allowance resets at a split sample: an image added in a split interval must not be credited to
	//     the comparison after it. A no-op context edit makes the image interval split; B is accepted with the
	//     check skipped, and C (a 1,200-token increase, no image) must still re-anchor. Mutation: leaking the
	//     pre-split image allowance keeps the 17,766 minimum instead of C's 20,165.
	const splitImage = chain([
		billed("sg0", "ok", { input: 17_766 }, stamp(0)),
		contextEditEntry("sg1", "sg0", { content: "ok" }, stamp(1)),
		contentEntry("sg2", "user", [{ type: "image", data: "aGk=", mimeType: "image/png" }], stamp(2)),
		billed("sg3", "", { input: 17_766 + 1_200 }, stamp(3)),
		billed("sg4", "", { input: 17_766 + 2_400 }, stamp(4)),
	]);
	const splitImageRead = readOf(measureCtx(splitImage, "sample-image-split", 60_000));
	check(
		"an image in a split interval is not credited after the split sample",
		splitImageRead.samples === 3 && splitImageRead.sampleIndex === 2 && splitImageRead.baseline === 20_165,
	);

	// 6. The receipt's conversion follows the session rate (run.ts uses this for the slices it reports and for
	//    the split-turn budget). Mutation: ignoring the rate argument reddens the ratio.
	const converted = sampled(2, 4_000, 2.0, 10_000);
	const convertedMessages = converted.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
	check(
		"the receipt's conversion follows the rate",
		Math.abs(measured.contextTokensAtRate(convertedMessages, 2) / measured.contextTokensAtRate(convertedMessages, 4) - 2) <= 0.05,
	);

	// 7. The floor no longer follows the branch: this session's last residual is ~260k (base 100k plus a drift the
	//    size of the conversation) while its reading is 127,500 - the 100k truth plus the emptiest record's
	//    27,500-token slack - so the threshold still resolves. Mutation: the current-point residual refuses the
	//    threshold and the auto handoff silently disappears. The margin is thin by construction (floor 155.5k
	//    against a 157k knee), which is the fail-closed side: an even larger opening block refuses instead.
	const heavySampled = measureCtx(sampled(4, 100_000, 2.5, 100_000), "sample-heavy", 400_000);
	const heavyRead = readOf(heavySampled);
	const heavyThreshold = handoff.resolveThreshold(heavySampled, heavySampled.getContextUsage());
	check(
		"a heavy branch keeps its auto handoff once the baseline is bounded instead of following the branch",
		Math.abs(heavyRead.baseline - 127_500) <= 2 && heavyThreshold?.tokens === 157_000,
	);

	// 8. The two consumers of the rate: the status receipt names the sample it measured, and the handoff receipt
	//    converts the slices it reports at the session's rate. Mutation: dropping the suffix, or reverting run.ts
	//    to `estimateTokens`, reddens one of these.
	const statusLine = handoff.handoffStatusLine(measureCtx(sampled(4, 4_000, 2.5, 40_000), "sample-status", 60_000));
	check(
		"the status receipt names the baseline measurement",
		/· baseline \d+(\.\d)?k \(chars\/8 bound over 4 records; receipt at 2\.5 c\/t\)/.test(statusLine),
	);
	await writeFile(configPath, JSON.stringify({ handoffEnabled: true, handoffBudgetRecentTokens: 20_000 }));
	const carryPi = makePi({ cwd: tmp });
	await (await loadDefault(`${PC}/index.ts`))(carryPi);
	const carriedTokens = async (entries, id) => {
		const ctx = makeCtx(tmp, {
			sessionManager: makeSessionManager(entries, id),
			getContextUsage: () => ({ tokens: 400_000, percent: 40, contextWindow: 1_000_000 }),
		});
		await runHandlers(carryPi, "session_start", ctx);
		await carryPi.commands.get("handoff").handler("force", ctx);
		const line = String(ctx.notifications.map(([message]) => message).find((message) => String(message).includes("carrying ~")) ?? "");
		return Number((line.match(/carrying ~([\d.]+)k recent/) ?? [])[1]);
	};
	const carriedAtTwo = await carriedTokens(sampled(12, 8_000, 2.5, 60_000), "receipt-rate");
	const carriedAtFour = await carriedTokens(sampled(12, 8_000, 4.0, 60_000), "receipt-four");
	check(
		"the handoff receipt converts the carried slice at the session's rate",
		carriedAtFour > 0 && Math.abs(carriedAtTwo / carriedAtFour - 1.6) <= 0.15,
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
