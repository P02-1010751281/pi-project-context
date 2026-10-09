import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, open, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadDefault, loadNamespace, makeCtx, makePi, makeSessionManager, messageEntry, PC, rmTemp, runHandlers, waitUntil } from "./harness.mjs";

/**
 * End-to-end test of the settle/shutdown path in one extension: the archive writes session.jsonl /
 * session.md / session-index.md at exit, and the consolidation pass - driven here through the forced
 * `/memory update` path, because the exit only flushes since 2026-10-06 (decision 1) - rewrites
 * MEMORY.md and CONTEXT.md from the real conversation projection.
 */

const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-consolidation-"));
const marker = "MARKER-consolidation-4217";
let failures = 0;
function check(label, value) {
	console.log(`${value ? "OK  " : "FAIL"} ${label}`);
	if (!value) failures += 1;
}

/**
 * Drive the memory write path explicitly. Since 2026-10-06 (decision 1) `session_shutdown` only flushes:
 * it folds a hand-edited MEMORY.md into the journal and leaves the file as the journal's render, and it
 * calls no model. A test that wants a consolidation pass uses the forced, user-facing path instead.
 */
async function consolidateNow(pi, ctx) {
	await pi.commands.get("memory").handler("update", ctx);
}

try {
	await mkdir(path.join(tmp, ".agents/memory"), { recursive: true });
	await writeFile(path.join(tmp, ".agents/memory/MEMORY.md"), "# Project Memory\n\n## Project\n- Old memory.\n");
	await writeFile(
		path.join(tmp, ".agents/memory/CONTEXT.md"),
		"# Project Context\n\n## Summary\nOld summary.\n\n## Session index\n\n- [old](session-logs/old/session.md) — 2026-09-01 — old\n",
	);

	const entries = [
		messageEntry("m1", "user", `please keep ${marker} in the summary`, "2026-09-12T10:00:00.000Z"),
		messageEntry("m2", "assistant", "noted", "2026-09-12T10:00:01.000Z"),
	];
	const factory = await loadDefault(`${PC}/index.ts`);
	const pi = makePi({ cwd: tmp });
	await factory(pi);
	const ctx = makeCtx(tmp, { sessionManager: makeSessionManager(entries, "e2e-session") });

	let prompt = "";
	ctx.modelRegistry.complete = async (_model, context) => {
		prompt = context.messages[0].content[0].text;
		return {
			content: [{
				type: "text",
				text: JSON.stringify({
					memory_markdown: "# Project Memory\n\n## Project\n- Consolidation e2e project.",
					context: { title: "Consolidation test session", summary: "Consolidation e2e ran.", key_points: ["one"], open_tasks: ["two"] },
				}),
			}],
		};
	};

	// The archive layer still writes at exit; the memory pass is a separate path that calls a model.
	await runHandlers(pi, "session_shutdown", ctx);
	await consolidateNow(pi, ctx);

	console.log("=== archive ===");
	const rawLog = await readFile(path.join(tmp, ".agents/memory/session-logs/e2e-session/session.jsonl"), "utf8").catch(() => "");
	check("session.jsonl written with the marker", rawLog.includes(marker));
	const markdown = await readFile(path.join(tmp, ".agents/memory/session-logs/e2e-session/session.md"), "utf8").catch(() => "");
	check("session.md rendered with the entry count", markdown.includes("# Pi Session e2e-session") && markdown.includes("- Entries: 2"));
	const index = await readFile(path.join(tmp, ".agents/memory/session-logs/INDEX.md"), "utf8").catch(() => "");
	check("session index has the current session", index.includes("[e2e-session]"));

	console.log("\n=== consolidation ===");
	const memory = await readFile(path.join(tmp, ".agents/memory/MEMORY.md"), "utf8");
	const context = await readFile(path.join(tmp, ".agents/memory/CONTEXT.md"), "utf8");
	check("MEMORY.md rewritten", memory.includes("Consolidation e2e project."));
	check("CONTEXT.md has the new summary", context.includes("Consolidation e2e ran."));
	check("CONTEXT.md has no session index", !context.includes("## Session index"));
	check("prompt had the real conversation", prompt.includes(marker));
	check("prompt has boundary rules", prompt.includes("long-term memory"));
	check("prompt has both artifacts", prompt.includes("<existing-memory>") && prompt.includes("<existing-context>"));

	console.log("\nnotifications:", JSON.stringify(ctx.notifications.map(([message]) => message)));

	console.log("\n=== malformed consolidation replies ===");
	{
		const { parseConsolidated } = await loadNamespace(`${PC}/memory/parse.ts`);
		// The reply that used to poison MEMORY.md: a stray member made JSON.parse fail and the
		// raw object was stored as memory.
		const corrupted = '{"memory_markdown":"# Project Memory\\n\\n## Project\\n- kept.","context":"# Project Context","stray\\n\\n- tail"}';
		check("malformed JSON: the memory field is recovered", parseConsolidated(corrupted)?.memory === "# Project Memory\n\n## Project\n- kept.");
		check("truncated JSON: no memory is invented", parseConsolidated('{"memory_markdown":"# Project Memory\\n\\n- cut') === undefined);
		check("unusable JSON: the pass fails instead of storing raw JSON", parseConsolidated('{"memory_markdown": 17, "context": {') === undefined);
		check("plain markdown still becomes memory", parseConsolidated("still plain markdown")?.memory === "still plain markdown");
		// A context the model shaped differently used to disappear without a trace, leaving the
		// previous CONTEXT.md injected for days; the caller reports it instead.
		check("a context in another shape is flagged", parseConsolidated('{"memory_markdown":"# m","context":"## Summary\\n- text"}')?.contextUnusable === true);
		// A present-but-wrong-typed list is the narrow version of the same drift: emptying the field
		// silently is what left CONTEXT.md stale, so the whole context is refused instead.
		check("a wrong-typed context list is flagged", parseConsolidated('{"memory_markdown":"# m","context":{"summary":"s","key_points":"a, b"}}')?.contextUnusable === true);
		check("absent lists are not flagged", parseConsolidated('{"memory_markdown":"# m","context":{"summary":"s"}}')?.contextUnusable === undefined && parseConsolidated('{"memory_markdown":"# m","context":{"summary":"s","open_tasks":null}}')?.contextUnusable === undefined);
		check(
			"an absent or null context is not flagged",
			parseConsolidated('{"memory_markdown":"# m"}')?.contextUnusable === undefined && parseConsolidated('{"memory_markdown":"# m","context":null}')?.contextUnusable === undefined,
		);
		// An object that never closes means the reply hit the output cap after the memory field; the
		// context was never emitted. Flagging it is what turns a silently stale CONTEXT.md into a trace.
		check("a reply whose object never closed is flagged", parseConsolidated(corrupted)?.recovered === true);
		check(
			"a complete reply is not flagged as recovered",
			parseConsolidated('{"memory_markdown":"# m"}')?.recovered === undefined && parseConsolidated("plain markdown")?.recovered === undefined,
		);
	}

	console.log("\n=== transient unusable JSON gets one bounded retry ===");
	{
		const retryTmp = await mkdtemp(path.join(os.tmpdir(), "pi-consolidation-retry-"));
		try {
			await mkdir(path.join(retryTmp, ".agents/memory"), { recursive: true });
			await writeFile(path.join(retryTmp, ".agents/memory/MEMORY.md"), "# Project Memory\n\n## Project\n- Previous memory.\n");
			let calls = 0;
			const retryFactory = await loadDefault(`${PC}/index.ts`);
			const retryPi = makePi({ cwd: retryTmp });
			await retryFactory(retryPi);
			const retryCtx = makeCtx(retryTmp, {
				sessionManager: makeSessionManager([messageEntry("r1", "user", "retry this consolidation", "2026-09-12T10:00:00.000Z")], "retry-session"),
				modelRegistry: {
					hasConfiguredAuth: () => true,
					complete: async () => {
						calls += 1;
						return {
							content: [{
								type: "text",
								text: calls === 1
									? '{"memory_markdown": 17, "context": {"summary":"bad"}}'
									: JSON.stringify({
										memory_markdown: "# Project Memory\n\n## Project\n- recovered after one transient malformed reply.",
										context: { title: "Retry", summary: "Recovered.", key_points: [], open_tasks: [] },
									}),
							}],
						};
					},
				},
			});
			await consolidateNow(retryPi, retryCtx);
			const retryMemory = await readFile(path.join(retryTmp, ".agents/memory/MEMORY.md"), "utf8");
			const retryErrors = await readFile(path.join(retryTmp, ".agents/memory/errors.log"), "utf8").catch(() => "");
			check("a transient malformed reply is retried once", calls === 2);
			check("the retry writes the valid memory", retryMemory.includes("recovered after one transient malformed reply"));
			check("a recovered retry does not log a failed pass", !retryErrors.includes("consolidation reply was not a usable JSON object"));
		} finally {
			await rmTemp(retryTmp);
		}
	}

	console.log("\n=== a reply cut off at the output cap is retried with more room ===");
	{
		const capTmp = await mkdtemp(path.join(os.tmpdir(), "pi-consolidation-cap-retry-"));
		try {
			await mkdir(path.join(capTmp, ".agents/memory"), { recursive: true });
			// The ceiling decides how much of the observed reasoning spend the retry may ask for; the default
			// 32768 would clamp the growth this case is about.
			await writeFile(path.join(capTmp, ".agents/memory/project-context.json"), JSON.stringify({ maxOutputTokens: 131_072 }));
			// Large enough that the fitted budget is driven by the memory, not by the 8192 default.
			// Keep it multi-line: whole-line truncation drops an oversized single line entirely.
			await writeFile(path.join(capTmp, ".agents/memory/MEMORY.md"), "# Project Memory\n\n## Project\n- old.\n" + ("x".repeat(200) + "\n").repeat(200));
			let calls = 0;
			const budgets = [];
			const prompts = [];
			const factory = await loadDefault(`${PC}/index.ts`);
			const pi = makePi({ cwd: capTmp });
			await factory(pi);
			const ctx = makeCtx(capTmp, {
				model: { provider: "test", id: "cap-retry", maxTokens: 65536 },
				sessionManager: makeSessionManager([messageEntry("r1", "user", "truncated retry", "2026-09-12T10:00:00.000Z")], "cap-retry-session"),
			});
			ctx.modelRegistry.complete = async (_model, context, options) => {
				calls += 1;
				budgets.push(options?.maxTokens);
				prompts.push(context.messages[0].content[0].text);
				if (calls === 1) return { content: [{ type: "text", text: '{"memory_markdown":"# Project Memory\\n\\n- cut' }], stopReason: "length", usage: { reasoning: 20_000 } };
				return {
					content: [{ type: "text", text: JSON.stringify({ memory_markdown: "# Project Memory\n\n## Project\n- recovered after the cap.", context: { title: "t", summary: "s", key_points: [], open_tasks: [] } }) }],
					stopReason: "stop",
				};
			};
			await consolidateNow(pi, ctx);
			const memory = await readFile(path.join(capTmp, ".agents/memory/MEMORY.md"), "utf8");
			const errors = await readFile(path.join(capTmp, ".agents/memory/errors.log"), "utf8").catch(() => "");
			check("a truncated reply is retried once with a larger budget", calls === 2 && budgets[1] > budgets[0]);
			// The field case spent 20489 hidden-reasoning tokens against a reserve capped at 8192, so the fixed
			// +4096 headroom was not enough; the retry must carry what the first attempt actually spent.
			const { RETRY_OUTPUT_HEADROOM_TOKENS } = await loadNamespace(`${PC}/shared/output-budget.ts`);
			check(
				"the retry carries the hidden reasoning the first attempt actually spent",
				budgets[1] - budgets[0] >= 20_000 - RETRY_OUTPUT_HEADROOM_TOKENS,
			);
			check("the forced pass says it is consolidating before the wait", ctx.notifications.some(([message]) => message.includes("Memory: consolidating")));
			check("the truncated retry asks the model to condense", prompts[1].includes("cut off by the output limit") && prompts[1].includes("condense"));
			check("the retried pass writes the complete memory", memory.includes("recovered after the cap."));
			check("a recovered truncation is not logged as a failure", !errors.includes("not a usable JSON object") && !errors.includes("output limit"));
		} finally {
			await rmTemp(capTmp);
		}
	}

	console.log("\n=== a persistent truncation names the output limit ===");
	{
		const hardTmp = await mkdtemp(path.join(os.tmpdir(), "pi-consolidation-cap-hard-"));
		try {
			await mkdir(path.join(hardTmp, ".agents/memory"), { recursive: true });
			const previous = "# Project Memory\n\n## Project\n- previous memory.\n";
			await writeFile(path.join(hardTmp, ".agents/memory/MEMORY.md"), previous);
			let calls = 0;
			const factory = await loadDefault(`${PC}/index.ts`);
			const pi = makePi({ cwd: hardTmp });
			await factory(pi);
			const ctx = makeCtx(hardTmp, {
				model: { provider: "test", id: "cap-hard", maxTokens: 65536 },
				sessionManager: makeSessionManager([messageEntry("h1", "user", "always truncated", "2026-09-12T10:00:00.000Z")], "cap-hard-session"),
			});
			ctx.modelRegistry.complete = async () => {
				calls += 1;
				return { content: [{ type: "text", text: '{"memory_markdown":"# Project Memory\\n\\n- cut' }], stopReason: "length" };
			};
			await consolidateNow(pi, ctx);
			const memory = await readFile(path.join(hardTmp, ".agents/memory/MEMORY.md"), "utf8");
			const errors = await readFile(path.join(hardTmp, ".agents/memory/errors.log"), "utf8").catch(() => "");
			check("a persistent truncation gets only one retry", calls === 2);
			check("a persistent truncation names the output limit", errors.includes("cut off by the model output limit"));
			check("a persistent truncation leaves MEMORY.md untouched", memory === previous);
		} finally {
			await rmTemp(hardTmp);
		}
	}

	console.log("\n=== a complete reply that stopped at the cap is accepted ===");
	{
		const okTmp = await mkdtemp(path.join(os.tmpdir(), "pi-consolidation-cap-complete-"));
		try {
			await mkdir(path.join(okTmp, ".agents/memory"), { recursive: true });
			await writeFile(path.join(okTmp, ".agents/memory/MEMORY.md"), "# Project Memory\n\n## Project\n- old.\n");
			let calls = 0;
			const factory = await loadDefault(`${PC}/index.ts`);
			const pi = makePi({ cwd: okTmp });
			await factory(pi);
			const ctx = makeCtx(okTmp, {
				model: { provider: "test", id: "cap-complete", maxTokens: 65536 },
				sessionManager: makeSessionManager([messageEntry("c1", "user", "complete at cap", "2026-09-12T10:00:00.000Z")], "cap-complete-session"),
			});
			ctx.modelRegistry.complete = async () => {
				calls += 1;
				return {
					content: [{ type: "text", text: JSON.stringify({ memory_markdown: "# Project Memory\n\n## Project\n- complete at the cap.", context: { title: "t", summary: "s", key_points: [], open_tasks: [] } }) }],
					stopReason: "length",
				};
			};
			await consolidateNow(pi, ctx);
			const memory = await readFile(path.join(okTmp, ".agents/memory/MEMORY.md"), "utf8");
			check("a complete JSON that stopped at the cap is written without a retry", calls === 1 && memory.includes("complete at the cap."));
		} finally {
			await rmTemp(okTmp);
		}
	}

	console.log("\n=== a provider error is a failure, not an empty memory ===");
	{
		const errTmp = await mkdtemp(path.join(os.tmpdir(), "pi-consolidation-provider-error-"));
		try {
			await mkdir(path.join(errTmp, ".agents/memory"), { recursive: true });
			const previous = "# Project Memory\n\n## Project\n- previous memory.\n";
			await writeFile(path.join(errTmp, ".agents/memory/MEMORY.md"), previous);
			await writeFile(path.join(errTmp, ".agents/memory/CONTEXT.md"), "# Project Context\n\n## Summary\nkept context.\n");
			let calls = 0;
			const factory = await loadDefault(`${PC}/index.ts`);
			const pi = makePi({ cwd: errTmp });
			await factory(pi);
			const ctx = makeCtx(errTmp, {
				model: { provider: "test", id: "provider-error" },
				sessionManager: makeSessionManager([messageEntry("e1", "user", "provider error", "2026-09-12T10:00:00.000Z")], "provider-error-session"),
			});
			ctx.modelRegistry.complete = async () => {
				calls += 1;
				return { content: [], stopReason: "error", errorMessage: "402: Insufficient Balance" };
			};
			await consolidateNow(pi, ctx);
			const memory = await readFile(path.join(errTmp, ".agents/memory/MEMORY.md"), "utf8");
			const errors = await readFile(path.join(errTmp, ".agents/memory/errors.log"), "utf8").catch(() => "");
			check("a provider error is not parsed and not retried", calls === 1);
			check("a provider error leaves MEMORY.md untouched", memory === previous);
			check("the provider message reaches errors.log", errors.includes("model call error: 402: Insufficient Balance"));
			check("an empty provider error is not read as a missing context", !errors.includes("carried no context section"));
		} finally {
			await rmTemp(errTmp);
		}
	}

	console.log("\n=== a call that never finished is a failure, not an empty memory ===");
	{
		const pendingTmp = await mkdtemp(path.join(os.tmpdir(), "pi-consolidation-pending-"));
		try {
			await mkdir(path.join(pendingTmp, ".agents/memory"), { recursive: true });
			const previous = "# Project Memory\n\n## Project\n- previous memory.\n";
			await writeFile(path.join(pendingTmp, ".agents/memory/MEMORY.md"), previous);
			let calls = 0;
			const factory = await loadDefault(`${PC}/index.ts`);
			const pi = makePi({ cwd: pendingTmp });
			await factory(pi);
			const ctx = makeCtx(pendingTmp, {
				model: { provider: "test", id: "pending" },
				sessionManager: makeSessionManager([messageEntry("p1", "user", "no answer", "2026-09-12T10:00:00.000Z")], "pending-session"),
			});
			ctx.modelRegistry.complete = async () => {
				calls += 1;
				return { content: [], stopReason: "toolUse" };
			};
			await consolidateNow(pi, ctx);
			const memory = await readFile(path.join(pendingTmp, ".agents/memory/MEMORY.md"), "utf8");
			const errors = await readFile(path.join(pendingTmp, ".agents/memory/errors.log"), "utf8").catch(() => "");
			check("a non-final stop reason fails the pass without a retry", calls === 1 && memory === previous);
			check("a non-final stop reason is named in errors.log", errors.includes("model call toolUse without text"));
		} finally {
			await rmTemp(pendingTmp);
		}
	}

	console.log("\n=== reasoning models reserve output room for hidden thinking ===");
	{
		const { fitMemoryInput } = await loadNamespace(`${PC}/memory/input.ts`);
		const { reasoningReserveTokens } = await loadNamespace(`${PC}/shared/output-budget.ts`);
		const plainFit = fitMemoryInput("记".repeat(6000), "", 8192, { maxTokens: 32768 });
		const reasoningFit = fitMemoryInput("记".repeat(6000), "", 8192, { maxTokens: 32768, reasoning: true });
		check("a reasoning model asks for extra output room", reasoningFit.maxTokens > plainFit.maxTokens);
		check("a reasoning model still receives the whole memory", reasoningFit.text.length === 6000 && reasoningFit.clipped === false);
		check("a capped reasoning model keeps content room", fitMemoryInput("记".repeat(20000), "", 8192, { maxTokens: 8192, reasoning: true }).text.length > 0);
		check("the reasoning reserve stays bounded", reasoningReserveTokens(1, { reasoning: true }) === 1024 && reasoningReserveTokens(1_000_000, { reasoning: true }) === 8192);
		check("a non-reasoning model pays no reasoning reserve", reasoningReserveTokens(10_000, {}) === 0 && reasoningReserveTokens(10_000, { reasoning: false }) === 0);
	}

	console.log("\n=== a reply that cannot be read never reaches MEMORY.md ===");
	{
		const jsonTmp = await mkdtemp(path.join(os.tmpdir(), "pi-consolidation-json-"));
		try {
			await mkdir(path.join(jsonTmp, ".agents/memory"), { recursive: true });
			const previous = "# Project Memory\n\n## Project\n- Previous memory.\n";
			await writeFile(path.join(jsonTmp, ".agents/memory/MEMORY.md"), previous);
			let reply = '{"memory_markdown":"# Project Memory\\n\\n## Project\\n- recovered.","context":"# Project Context","stray\\n\\n- tail"}';
			let calls = 0;
			const factory = await loadDefault(`${PC}/index.ts`);
			const pi = makePi({ cwd: jsonTmp });
			await factory(pi);
			const ctx = makeCtx(jsonTmp, {
				sessionManager: makeSessionManager([messageEntry("m1", "user", "hello", "2026-09-12T10:00:00.000Z")], "json-session"),
				modelRegistry: {
					hasConfiguredAuth: () => true,
					complete: async () => {
						calls += 1;
						return { content: [{ type: "text", text: reply }] };
					},
				},
			});
			await consolidateNow(pi, ctx);
			const recovered = await readFile(path.join(jsonTmp, ".agents/memory/MEMORY.md"), "utf8");
			check("a malformed reply stores the recovered memory", recovered.includes("- recovered.") && !recovered.includes("memory_markdown"));

			// Second pass: nothing readable at all; the file must stay exactly as it is.
			reply = '{"memory_markdown": 17, "context": {';
			const realNow = Date.now;
			Date.now = () => realNow() + 60 * 1000;
			try {
				await consolidateNow(pi, ctx);
			} finally {
				Date.now = realNow;
			}
			const untouched = await readFile(path.join(jsonTmp, ".agents/memory/MEMORY.md"), "utf8");
			const errors = await readFile(path.join(jsonTmp, ".agents/memory/errors.log"), "utf8").catch(() => "");
			check("an unusable reply leaves MEMORY.md untouched", untouched === recovered);
			check("the failed pass is logged to errors.log", errors.includes("consolidation reply was not a usable JSON object") && errors.includes('"memory_markdown": 17'));
			check("a persistent malformed reply gets only one retry", calls === 3);
		} finally {
			await rmTemp(jsonTmp);
		}
	}

	console.log("\n=== a stored JSON reply is decoded on read and repaired on write ===");
	{
		const { loadMemory, backupMemoryBeforeWrite } = await loadNamespace(`${PC}/shared/project-state.ts`);
		const healTmp = await mkdtemp(path.join(os.tmpdir(), "pi-memory-heal-"));
		const healMemory = path.join(healTmp, ".agents/memory/MEMORY.md");
		const backupCount = async () => (await readdir(path.dirname(healMemory))).filter((name) => name.includes(".memory-backup-")).length;
		try {
			await mkdir(path.dirname(healMemory), { recursive: true });
			const poison = '# Project Memory\n\n{\n  "memory_markdown": "# Project Memory\\n\\n## Project\\n- decoded fact.\\n\\n## Tail\\n- 已确认的事实。截断的尾巴\n';
			await writeFile(healMemory, poison);
			const first = await loadMemory(healTmp);
			check("a stored reply is decoded to markdown on read", first.poisoned === true && first.text.startsWith("# Project Memory") && first.text.includes("- decoded fact.") && !first.text.includes("memory_markdown"));
			check("every recovered line is kept", first.text.includes("已确认的事实。") && first.text.includes("截断的尾巴"));
			check("reading never rewrites the stored file", (await readFile(healMemory, "utf8")) === poison && (await backupCount()) === 0);
			const second = await loadMemory(healTmp);
			check("decoding is stable across reads", second.text === first.text && second.poisoned === true && (await readFile(healMemory, "utf8")) === poison);

			// A value cut at a line boundary, or ending with a complete Latin line, keeps its last line too.
			await writeFile(healMemory, '# Project Memory\n\n{"memory_markdown": "# Project Memory\\n\\n## Project\\n- complete English line.\\n", "context": {}}\n');
			const latin = await loadMemory(healTmp);
			check("a complete Latin tail survives decoding", latin.poisoned === true && latin.text.includes("- complete English line."));
			await writeFile(healMemory, '# Project Memory\n\n{"memory_markdown": "# Project Memory\\n\\n## Project\\n- boundary line\\n", "context": {}}\n');
			const boundary = await loadMemory(healTmp);
			check("a value cut at a line boundary survives decoding", boundary.poisoned === true && boundary.text.includes("- boundary line"));

			const healthy = '# Project Memory\n\n## Project\n- layout note: `{"memory_markdown": ...}` is what an old bug wrote.\n';
			await writeFile(healMemory, healthy);
			const kept = await loadMemory(healTmp);
			check("a healthy memory mentioning the field is not decoded", kept.poisoned === false && kept.text.includes("is what an old bug wrote.") && (await readFile(healMemory, "utf8")) === healthy);

			// A JSON-shaped healthy file whose field value is not the memory document must stay.
			const sample = '# Project Memory\n\n{\n  "endpoint": "local",\n  "memory_markdown": "legacy poison sample: see issue",\n  "note": "kept"\n}\n\n## Real notes\n- keep me\n';
			await writeFile(healMemory, sample);
			const held = await loadMemory(healTmp);
			check("a JSON-shaped healthy memory is not decoded", held.poisoned === false && held.text.includes("## Real notes") && (await readFile(healMemory, "utf8")) === sample);

			// A mention that actually matches the field regex (open quote) must still stay untouched.
			const mention = '# Project Memory\n\n## Project\n- the old bug wrote {"memory_markdown": " and cut the rest\n- keep this fact\n';
			await writeFile(healMemory, mention);
			const mentioned = await loadMemory(healTmp);
			check("a regex-matching mention is not decoded", mentioned.poisoned === false && mentioned.text.includes("keep this fact") && (await readFile(healMemory, "utf8")) === mention);

			// A documented reply sample followed by real content must not be treated as stored poison.
			const example = '# Project Memory\n\n```json\n{"memory_markdown": "# Project Memory\\n\\n## Example\\n- documented reply format", "context": {}}\n```\n\n## Real notes\n- keep me\n';
			await writeFile(healMemory, example);
			const exemplified = await loadMemory(healTmp);
			check("a documented JSON example is not decoded", exemplified.poisoned === false && exemplified.text.includes("## Real notes") && (await readFile(healMemory, "utf8")) === example);

			// A trailing JSON snippet after the example must not unlock a decode.
			const trailed = `${example}{"a":1}\n`;
			await writeFile(healMemory, trailed);
			const trailer = await loadMemory(healTmp);
			check("a trailing JSON snippet does not unlock a decode", trailer.poisoned === false && trailer.text.includes("## Real notes") && (await readFile(healMemory, "utf8")) === trailed);

			// An unrelated brace near the top plus a documented example later must stay untouched.
			const unrelated = '# Project Memory\n\nUse `{}` for empty maps.\n\n```json\n{"memory_markdown": "# Project Memory\\n\\n## Example\\n- documented reply format", "context": {}}\n```\n\n## Real notes\n- keep me\n{"a":1}\n';
			await writeFile(healMemory, unrelated);
			const unrelatedRead = await loadMemory(healTmp);
			check("an unrelated brace does not unlock a decode", unrelatedRead.poisoned === false && unrelatedRead.text.includes("## Real notes") && (await readFile(healMemory, "utf8")) === unrelated);

			// Real content before a documented reply example must stay untouched too.
			const notesFirst = '# Project Memory\n\n## Notes\n- keep me (durable fact)\n{"memory_markdown": "# Project Memory\\n\\n## Sample\\n- documented reply format", "context": {}}\n';
			await writeFile(healMemory, notesFirst);
			const notesRead = await loadMemory(healTmp);
			check("real notes before an example are not decoded", notesRead.poisoned === false && notesRead.text.includes("keep me (durable fact)") && (await readFile(healMemory, "utf8")) === notesFirst);

			// The same shape with an unterminated example at the end.
			const notesFirstCut = '# Project Memory\n\n## Notes\n- keep me (durable fact)\n{"memory_markdown": "# Project Memory\\n\\n## Sample\\n- documented reply cut';
			await writeFile(healMemory, notesFirstCut);
			const notesCut = await loadMemory(healTmp);
			check("an unterminated trailing example is not decoded", notesCut.poisoned === false && notesCut.text.includes("keep me (durable fact)") && (await readFile(healMemory, "utf8")) === notesFirstCut);

			// A single-line bullet before an example must not pass for a wrapper either.
			const bulletFirst = '# Project Memory\n\n- keep me (durable fact)\n{"memory_markdown": "# Project Memory\\n\\n## Sample\\n- documented reply format", "context": {}}\n';
			await writeFile(healMemory, bulletFirst);
			const bulletRead = await loadMemory(healTmp);
			check("a single-line bullet prefix is not decoded", bulletRead.poisoned === false && bulletRead.text.includes("keep me (durable fact)") && (await readFile(healMemory, "utf8")) === bulletFirst);

			// A nested field is an example, not a stored reply.
			const nested = '# Project Memory\n\n{"real_fact": "KEEP", "inner": {"memory_markdown": "# Project Memory\\n\\n## Nested\\n- inner"}}\n';
			await writeFile(healMemory, nested);
			const nestedRead = await loadMemory(healTmp);
			check("a nested field is not decoded", nestedRead.poisoned === false && nestedRead.text.includes("KEEP") && (await readFile(healMemory, "utf8")) === nested);

			// A fence-wrapped stored value still heals (the value is normalized before the shape check).
			await writeFile(healMemory, '# Project Memory\n\n{"memory_markdown": "```markdown\\n# Project Memory\\n\\n## Project\\n- fenced value。\\n", "context": {}}\n');
			const fencedValue = await loadMemory(healTmp);
			check("a fence-wrapped stored value is decoded", fencedValue.poisoned === true && fencedValue.text.includes("fenced value。"));

			// Historical storage shapes: fenced-json leftovers and array wrappers.
			const shapes = [
				["fenced json", 'json\n{"memory_markdown": "# Project Memory\\n\\n## Project\\n- fenced json leftover。'],
				["array wrap", '[{"memory_markdown": "# Project Memory\\n\\n## Project\\n- array wrap leftover。'],
			];
			for (const [label, shape] of shapes) {
				await writeFile(healMemory, `# Project Memory\n\n${shape}`);
				const decoded = await loadMemory(healTmp);
				check(`a stored ${label} reply is decoded`, decoded.poisoned === true && decoded.text.includes(`${label} leftover`) && !decoded.text.includes("memory_markdown"));
			}

			const prose = '# Project Memory\n\nHere is the JSON:\n{"memory_markdown": "# Project Memory\\n\\n## Project\\n- prose prefix leftover。';
			await writeFile(healMemory, prose);
			const proseRead = await loadMemory(healTmp);
			check("a prose-prefixed stored reply is decoded", proseRead.poisoned === true && proseRead.text.includes("prose prefix leftover") && (await readFile(healMemory, "utf8")) === prose);

			// The same wrapper with a value that is not a memory document stays untouched (fail-safe).
			const proseValue = '# Project Memory\n\nHere is the JSON:\n{"memory_markdown": "not a document"}';
			await writeFile(healMemory, proseValue);
			const proseValueRead = await loadMemory(healTmp);
			check("a prose prefix without a document value is left alone", proseValueRead.poisoned === false && (await readFile(healMemory, "utf8")) === proseValue);

			// The normal consolidation write path repairs the stored file and keeps the raw bytes.
			const factory = await loadDefault(`${PC}/index.ts`);
			const pi = makePi({ cwd: healTmp });
			await factory(pi);
			await writeFile(healMemory, poison);
			const ctx = makeCtx(healTmp, {
				model: { provider: "test", id: "heal-repair", maxTokens: 32768 },
				sessionManager: makeSessionManager([messageEntry("m1", "user", "hello", "2026-09-12T10:00:00.000Z")], "heal-repair"),
			});
			ctx.modelRegistry.complete = async () => ({
				content: [{ type: "text", text: JSON.stringify({ memory_markdown: "# Project Memory\n\n## Project\n- repaired memory.", context: { title: "t", summary: "s", key_points: [], open_tasks: [] } }) }],
			});
			await pi.commands.get("memory").handler("update", ctx);
			const repaired = await readFile(healMemory, "utf8");
			check("the writer replaces the stored reply with markdown", repaired.startsWith("# Project Memory") && repaired.includes("- repaired memory.") && !repaired.includes("memory_markdown"));
			const repairBackups = (await readdir(path.dirname(healMemory))).filter((name) => name.includes(".memory-backup-"));
			check("the writer keeps the raw bytes as a backup", repairBackups.length === 1 && (await readFile(path.join(path.dirname(healMemory), repairBackups[0]), "utf8")) === poison);
			const repairLog = await readFile(path.join(healTmp, ".agents/memory/errors.log"), "utf8").catch(() => "");
			check("the repair is recorded in errors.log", repairLog.includes("replaced a stored JSON reply"));

			// Two concurrent passes must not write the same memory twice (fresh instance: no dedupe cache).
			const factory2 = await loadDefault(`${PC}/index.ts`);
			const pi2 = makePi({ cwd: healTmp });
			await factory2(pi2);
			await writeFile(healMemory, poison);
			for (const name of (await readdir(path.dirname(healMemory))).filter((n) => n.includes(".memory-backup-"))) {
				await rm(path.join(path.dirname(healMemory), name), { force: true });
			}
			await rm(path.join(healTmp, ".agents/memory/errors.log"), { force: true });
			const ctx2 = makeCtx(healTmp, {
				model: { provider: "test", id: "heal-repair-2", maxTokens: 32768 },
				sessionManager: makeSessionManager([messageEntry("m1", "user", "hello", "2026-09-12T10:00:00.000Z")], "heal-repair-2"),
			});
			ctx2.modelRegistry.complete = async () => ({
				content: [{ type: "text", text: JSON.stringify({ memory_markdown: "# Project Memory\n\n## Project\n- concurrent repair.", context: { title: "t", summary: "s", key_points: [], open_tasks: [] } }) }],
			});
			await Promise.all([
				pi2.commands.get("memory").handler("update", ctx2),
				pi2.commands.get("memory").handler("update", ctx2),
			]);
			const concurrentBackups = (await readdir(path.dirname(healMemory))).filter((name) => name.includes(".memory-backup-"));
			const concurrentLog = await readFile(path.join(healTmp, ".agents/memory/errors.log"), "utf8").catch(() => "");
			check(`concurrent passes rewrite the memory once (backups=${concurrentBackups.length}, logs=${concurrentLog.split("replaced a stored JSON reply").length - 1})`, concurrentBackups.length === 1 && concurrentLog.split("replaced a stored JSON reply").length - 1 === 1);

			// A writer landing during the model call is the content the backup must capture.
			const factory3 = await loadDefault(`${PC}/index.ts`);
			const pi3 = makePi({ cwd: healTmp });
			await factory3(pi3);
			await writeFile(healMemory, "# Project Memory\n\n## Project\n- old memory.\n");
			for (const name of (await readdir(path.dirname(healMemory))).filter((n) => n.includes(".memory-backup-"))) {
				await rm(path.join(path.dirname(healMemory), name), { force: true });
			}
			await rm(path.join(healTmp, ".agents/memory/errors.log"), { force: true });
			const arrived = '# Project Memory\n\n{\n  "memory_markdown": "# Project Memory\\n\\n## Project\\n- arrived during the pass。\\n", "context": {}}\n';
			const ctx3 = makeCtx(healTmp, {
				model: { provider: "test", id: "heal-race", maxTokens: 32768 },
				sessionManager: makeSessionManager([messageEntry("m1", "user", "hello", "2026-09-12T10:00:00.000Z")], "heal-race"),
			});
			ctx3.modelRegistry.complete = async () => {
				await writeFile(healMemory, arrived);
				return {
					content: [{ type: "text", text: JSON.stringify({ memory_markdown: "# Project Memory\n\n## Project\n- post-race memory.", context: { title: "t", summary: "s", key_points: [], open_tasks: [] } }) }],
				};
			};
			await pi3.commands.get("memory").handler("update", ctx3);
			const raceBackups = (await readdir(path.dirname(healMemory))).filter((n) => n.includes(".memory-backup-"));
			const raceLog = await readFile(path.join(healTmp, ".agents/memory/errors.log"), "utf8").catch(() => "");
			// The reply was built from the pre-race memory, so it is not published: the writer's bytes
			// stay effective and the pass says so. (The poison repair itself is asserted above, where no
			// edit races the pass.)
			check(
				"a mid-call writer keeps its bytes and is backed up",
				raceBackups.length === 1
					&& (await readFile(path.join(path.dirname(healMemory), raceBackups[0]), "utf8")) === arrived
					&& (await readFile(healMemory, "utf8")) === arrived
					&& raceLog.includes("adopted an externally edited MEMORY.md")
					&& raceLog.includes("the reply was not published"),
			);

			// The backup helper fails closed when the target exists but cannot be read.
			const unreadable = path.join(healTmp, ".agents/memory/UNREADABLE.md");
			await mkdir(unreadable, { recursive: true });
			let failedClosed = false;
			try {
				await backupMemoryBeforeWrite(unreadable);
			} catch {
				failedClosed = true;
			}
			check("an unreadable memory target fails closed", failedClosed);

			// A burst of writes keeps the recent backups, so a backup named in a notice stays reviewable.
			const countBackups = async () => (await readdir(path.dirname(healMemory), { withFileTypes: true })).filter((entry) => entry.isFile() && /^MEMORY\.md\.memory-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/.test(entry.name)).length;
			const backupNames = async () => (await readdir(path.dirname(healMemory), { withFileTypes: true }))
				.filter((entry) => entry.isFile() && /^MEMORY\.md\.memory-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/.test(entry.name))
				.map((entry) => path.join(path.dirname(healMemory), entry.name));
			const beforeBurst = await countBackups();
			for (let round = 0; round < 7; round += 1) {
				await backupMemoryBeforeWrite(healMemory);
			}
			const burst = await countBackups();
			check(`a burst of writes keeps recent backups (have ${burst})`, burst === beforeBurst + 7);
			// Once they age past the floor, the prune keeps the newest five and never the one just written.
			const aged = new Date(Date.now() - 2 * 60 * 60 * 1000);
			for (const file of await backupNames()) await utimes(file, aged, aged);
			const agedWrite = await backupMemoryBeforeWrite(healMemory);
			const pruned = await countBackups();
			check(`aged backups prune down to five (have ${pruned})`, pruned === 5 && agedWrite.path !== undefined);
			for (let skew = 0; skew < 6; skew += 1) {
				const skewName = path.join(path.dirname(healMemory), `MEMORY.md.memory-backup-2099-01-0${skew + 1}T00-00-00-000Z-dead000${skew}`);
				await writeFile(skewName, "future");
				// Future-looking names with old mtimes: pruning must trust mtime, not the name.
				await utimes(skewName, new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z"));
			}
			const skewed = await backupMemoryBeforeWrite(healMemory);
			const afterSkew = await countBackups();
			check(`a skewed clock never prunes the new backup (have ${afterSkew})`, skewed.path !== undefined && (await readFile(skewed.path, "utf8").catch(() => undefined)) !== undefined && afterSkew === 5);

			// Pruning must leave files it did not generate alone, and a directory must not stop it.
			const keepMe = path.join(path.dirname(healMemory), "MEMORY.md.memory-backup-2026-01-01T00-00-00-000Z-KEEP-ME.md");
			await writeFile(keepMe, "user copy");
			const nestedName = path.join(path.dirname(healMemory), "MEMORY.md.memory-backup-keep.memory-backup-2026-01-01T00-00-00-000Z-deadbeef");
			await writeFile(nestedName, "user nested");
			const backupDirectory = path.join(path.dirname(healMemory), "MEMORY.md.memory-backup-2099-12-31T00-00-00-000Z-deadbeef");
			await mkdir(backupDirectory, { recursive: true });
			await backupMemoryBeforeWrite(healMemory);
			const afterUserFiles = await countBackups();
			check("pruning leaves user files and directories alone", (await readFile(keepMe, "utf8")) === "user copy" && (await readFile(nestedName, "utf8")) === "user nested" && (await readdir(backupDirectory)).length === 0 && afterUserFiles === 5);
		} finally {
			await rmTemp(healTmp);
		}
	}

	console.log("\n=== the memory journal is the source of truth and MEMORY.md its render ===");
	{
		const { appendMemoryOp, foldMemoryJournal, loadMemory, memoryJournalFile, readMemoryJournal, recordMemoryDocument } = await loadNamespace(`${PC}/shared/project-state.ts`);
		const journalTmp = await mkdtemp(path.join(os.tmpdir(), "pi-memory-journal-"));
		const journalMemory = path.join(journalTmp, ".agents/memory/MEMORY.md");
		const journalFile = memoryJournalFile(journalTmp);
		const aged = new Date(Date.now() - 10 * 60 * 1000);
		try {
			await mkdir(path.dirname(journalMemory), { recursive: true });
			await writeFile(journalMemory, "# Project Memory\n\n## Project\n- legacy render.\n");
			const legacy = await loadMemory(journalTmp);
			check("without a journal the render is read directly", !legacy.unreadable && legacy.text.includes("- legacy render.") && legacy.source.endsWith("MEMORY.md"));

			await recordMemoryDocument(journalTmp, "# Project Memory\n\n## Project\n- from journal.\n");
			const state = await readMemoryJournal(journalFile);
			check("the first write keeps the previous document as the journal base", state.entries.length === 2 && state.entries[0].op === "replace" && state.entries[0].text.includes("- legacy render.") && state.entries[1].text.includes("- from journal."));
			check("the render is regenerated from the journal", (await readFile(journalMemory, "utf8")).includes("- from journal."));
			await utimes(journalMemory, aged, aged);
			const read = await loadMemory(journalTmp);
			check("once the journal exists it is the source of truth", read.source === journalFile && read.text.includes("- from journal.") && !read.text.includes("- legacy render."));

			// Our own render is always newer than the journal but content-identical: it must not be
			// mistaken for an external edit, in the read path or in the write path.
			const futureStamp = new Date(Date.now() + 60_000);
			await utimes(journalMemory, futureStamp, futureStamp);
			const identical = await loadMemory(journalTmp);
			check("a content-identical render does not shadow the journal", identical.source === journalFile && identical.text.includes("- from journal."));
			const beforeAdopt = (await readMemoryJournal(journalFile)).entries.length;
			await utimes(journalMemory, futureStamp, futureStamp);
			await recordMemoryDocument(journalTmp, "# Project Memory\n\n## Project\n- second write.\n");
			const linear = await readMemoryJournal(journalFile);
			check("repeated writes add one record each without adopting our own render", linear.entries.length === beforeAdopt + 1 && linear.entries.filter((entry) => entry.text.includes("- from journal.")).length === 1);

			await appendMemoryOp(journalFile, "append", "## Added\n- appended fact.");
			await utimes(journalMemory, aged, aged);
			const appended = await loadMemory(journalTmp);
			check("append records extend the folded document", appended.text.includes("- second write.") && appended.text.includes("- appended fact."));

			// A torn last line from a crash is skipped, and the pass can report the damage.
			await writeFile(journalFile, `${(await readFile(journalFile, "utf8")).trimEnd()}\n{"op":"replace",\n`);
			await utimes(journalMemory, aged, aged);
			const torn = await loadMemory(journalTmp);
			check("a torn journal line is skipped and reported", torn.damaged === 1 && torn.text.includes("- appended fact."));

			// A journal with no usable record must fail closed, not fall back to a stale render.
			await writeFile(journalFile, "not json\n");
			const broken = await loadMemory(journalTmp);
			check("a journal with no usable record reports unreadable", broken.unreadable === true && broken.text === "");

			// A render newer than the journal is a hand edit: it is read, and the next write adopts it.
			await writeFile(journalFile, `${JSON.stringify({ ts: new Date().toISOString(), op: "replace", text: "# Project Memory\n\n## Project\n- journal doc.\n" })}\n`);
			await writeFile(journalMemory, "# Project Memory\n\n## Project\n- hand edit.\n");
			const future = new Date(Date.now() + 60_000);
			await utimes(journalMemory, future, future);
			const handEdit = await loadMemory(journalTmp);
			check("a render newer than the journal is honored", handEdit.text.includes("- hand edit.") && handEdit.source.endsWith("MEMORY.md"));
			await utimes(journalMemory, future, future);
			await recordMemoryDocument(journalTmp, "# Project Memory\n\n## Project\n- consolidated.\n");
			const adopted = await readMemoryJournal(journalFile);
			check("the next write adopts a hand edit into the journal", adopted.entries.some((entry) => entry.text.includes("- hand edit.")) && adopted.entries.at(-1).text.includes("- consolidated."));
			check("the adopted render is replaced by the new document", (await readFile(journalMemory, "utf8")).includes("- consolidated."));

			// Rotation collapses an oversized journal into one replacement, archiving the old bytes.
			await appendMemoryOp(journalFile, "append", `## Big\n- ${"x".repeat(300_000)}\n`);
			await appendMemoryOp(journalFile, "append", `## Bigger\n- ${"y".repeat(300_000)}\n`);
			const archiveAge = new Date(Date.now() - 2 * 60 * 60 * 1000);
			for (let index = 0; index < 7; index += 1) {
				const archive = path.join(path.dirname(journalFile), `memory-log-2026-01-0${(index + 1) % 10}T00-00-00-000Z-0000000${index}.jsonl`);
				await writeFile(archive, "archived\n");
				await utimes(archive, archiveAge, archiveAge);
			}
			for (const day of ["11", "12", "13", "14", "15"]) {
				const archive = path.join(path.dirname(journalFile), `memory-log-2026-01-${day}T00-00-00-000Z-000000${day}.jsonl`);
				await writeFile(archive, "young\n");
			}
			await utimes(journalMemory, aged, aged);
			await recordMemoryDocument(journalTmp, "# Project Memory\n\n## Project\n- after rotation.\n");
			const rotated = await readMemoryJournal(journalFile);
			const archives = (await readdir(path.dirname(journalFile))).filter((name) => name.startsWith("memory-log-"));
			check("rotation collapses the journal into one replacement", rotated.entries.length === 1 && rotated.entries[0].text.includes("- after rotation.") && (await stat(journalFile)).size < 10_000);
			check(`rotation archives the old bytes, prunes aged excess and keeps young ones (have ${archives.length})`, archives.length === 6
				&& ["01", "02", "03", "04", "05", "06", "07"].every((day) => !archives.some((name) => name.includes(`-2026-01-${day}T`)))
				&& ["11", "15"].every((day) => archives.some((name) => name.includes(`-2026-01-${day}T`))));
			check("the rotated render still matches the journal", foldMemoryJournal(rotated.entries) === await readFile(journalMemory, "utf8"));

			// A journal that is gone entirely must not silently revive the render it superseded:
			// rotation copies the previous bytes into `memory-log-*.jsonl`, so the archive is the
			// surviving copy of the pass's document and the read path prefers it.
			await rm(journalFile, { force: true });
			await writeFile(journalMemory, "# Project Memory\n\n## Project\n- a stale pre-pass render\n");
			const archiveName = "memory-log-2026-01-20T00-00-00-000Z-00000020.jsonl";
			const archiveFile = path.join(path.dirname(journalFile), archiveName);
			await writeFile(archiveFile, `${JSON.stringify({ ts: "2026-01-20T00:00:00.000Z", op: "replace", text: "# Project Memory\n\n## Project\n- recovered from the archive\n" })}\n`);
			// Anchor the ordering: the other archives in this fixture were written in the same second, so
			// "newest" must not depend on a clock tie or the name tie-break.
			const later = new Date(Date.now() + 60 * 60 * 1000);
			await utimes(archiveFile, later, later);
			const recovered = await loadMemory(journalTmp);
			check(
				"a missing journal is recovered from its archive, not the stale render",
				recovered.text.includes("- recovered from the archive") && !recovered.text.includes("stale pre-pass render") && recovered.source.endsWith(archiveName),
			);
		} finally {
			await rmTemp(journalTmp);
		}
	}

	console.log("\n=== memory writes fail closed and create fresh files ===");
	{
		const failureTmp = await mkdtemp(path.join(os.tmpdir(), "pi-memory-write-"));
		try {
			// A MEMORY.md that cannot be read (a directory) must abort the pass, not overwrite it.
			await mkdir(path.join(failureTmp, ".agents/memory/MEMORY.md"), { recursive: true });
			const factory = await loadDefault(`${PC}/index.ts`);
			const pi = makePi({ cwd: failureTmp });
			await factory(pi);
			const ctx = makeCtx(failureTmp, {
				model: { provider: "test", id: "write-blocked", maxTokens: 32768 },
				sessionManager: makeSessionManager([messageEntry("m1", "user", "hello", "2026-09-12T10:00:00.000Z")], "write-blocked"),
			});
			ctx.modelRegistry.complete = async () => ({
				content: [{ type: "text", text: JSON.stringify({ memory_markdown: "# Project Memory\n\n## Project\n- must not land.", context: { title: "t", summary: "s", key_points: [], open_tasks: [] } }) }],
			});
			await pi.commands.get("memory").handler("update", ctx);
			const stillDirectory = await readdir(path.join(failureTmp, ".agents/memory/MEMORY.md")).then(() => true).catch(() => false);
			const failureLog = await readFile(path.join(failureTmp, ".agents/memory/errors.log"), "utf8").catch(() => "");
			check("an unreadable memory aborts the write end to end", stillDirectory && failureLog.includes("EISDIR"));
			await pi.commands.get("memory").handler("", ctx);
			check("the memory command reports an unreadable file", ctx.notifications.some(([message]) => message.includes("cannot be read")));

			// A fresh project has no file to back up; the first write creates it without a backup.
			const freshTmp = await mkdtemp(path.join(os.tmpdir(), "pi-memory-fresh-"));
			try {
				const freshFactory = await loadDefault(`${PC}/index.ts`);
				const freshPi = makePi({ cwd: freshTmp });
				await freshFactory(freshPi);
				const freshCtx = makeCtx(freshTmp, {
					model: { provider: "test", id: "write-fresh", maxTokens: 32768 },
					sessionManager: makeSessionManager([messageEntry("m1", "user", "hello", "2026-09-12T10:00:00.000Z")], "write-fresh"),
				});
				freshCtx.modelRegistry.complete = async () => ({
					content: [{ type: "text", text: JSON.stringify({ memory_markdown: "# Project Memory\n\n## Project\n- first memory.", context: { title: "t", summary: "s", key_points: [], open_tasks: [] } }) }],
				});
				await freshPi.commands.get("memory").handler("update", freshCtx);
				const created = await readFile(path.join(freshTmp, ".agents/memory/MEMORY.md"), "utf8").catch(() => "");
				const freshBackups = (await readdir(path.join(freshTmp, ".agents/memory"))).filter((name) => name.includes(".memory-backup-"));
				check("a first write creates the memory without a backup", created.includes("- first memory.") && freshBackups.length === 0);
			} finally {
				await rmTemp(freshTmp);
			}
		} finally {
			await rmTemp(failureTmp);
		}
	}

	console.log("\n=== a context the model shapes differently is reported, not silently kept ===");
	{
		const shapeTmp = await mkdtemp(path.join(os.tmpdir(), "pi-memory-context-shape-"));
		try {
			const shapeDir = path.join(shapeTmp, ".agents/memory");
			const shapeContext = path.join(shapeDir, "CONTEXT.md");
			await mkdir(shapeDir, { recursive: true });
			const previous = "# Project Context\n\nLast updated: 2026-09-01T00:00:00Z\n\n## Summary\n- out of date.\n";
			await writeFile(shapeContext, previous);
			// Every forced pass must reach the model (the default 15s dedupe would mask a repeat).
			await writeFile(path.join(shapeDir, "project-context.json"), JSON.stringify({ forceDedupeMs: 0 }));
			const factory = await loadDefault(`${PC}/index.ts`);
			const pi = makePi({ cwd: shapeTmp });
			await factory(pi);
			const ctx = makeCtx(shapeTmp, {
				model: { provider: "test", id: "context-shape", maxTokens: 32768 },
				sessionManager: makeSessionManager([messageEntry("m1", "user", "hello", "2026-09-12T10:00:00.000Z")], "context-shape"),
			});
			let shapeCalls = 0;
			let shapePrompt = "";
			ctx.modelRegistry.complete = async (_model, context) => {
				shapeCalls += 1;
				shapePrompt = context.messages[0].content[0].text;
				// A Markdown string is what a model reaches for when the prompt does not name the keys.
				return { content: [{ type: "text", text: JSON.stringify({ memory_markdown: "# Project Memory\n\n## Project\n- shaped memory.", context: "## Summary\n- as markdown." }) }] };
			};
			await pi.commands.get("memory").handler("update", ctx);
			const shapeLog = await readFile(path.join(shapeDir, "errors.log"), "utf8").catch(() => "");
			check("an unusable context leaves the previous render in place", (await readFile(shapeContext, "utf8")) === previous);
			check("an unusable context is written to errors.log", shapeLog.includes("could not be used"));
			await pi.commands.get("memory").handler("update", ctx);
			const repeated = await readFile(path.join(shapeDir, "errors.log"), "utf8").catch(() => "");
			check("the pass really ran twice", shapeCalls === 2);
			check("the shape note is reported once per process", repeated.split("could not be used").length - 1 === 1);
			await pi.commands.get("project-context").handler("status", ctx);
			const statusText = String(ctx.notifications.at(-1)?.[0] ?? "");
			check("status names the memory source", /Memory: .*memory\.jsonl \(\d+ chars, \d+% of the \d+-char cap\)/.test(statusText));
			check("status dates the context render", /Context file: .*CONTEXT\.md — updated \d{4}-\d{2}-\d{2}T[\d:]+Z \(.+ ago\)/.test(statusText));
			// The schema drift started in the prompt: it described the context in prose only.
			check("the prompt names the context keys", shapePrompt.includes("key_points") && shapePrompt.includes("open_tasks") && shapePrompt.includes("memory_markdown"));

			// Without an existing render there is no "previous" to keep: the pass writes the placeholder,
			// and the log says so instead of claiming a render was kept.
			const emptyTmp = await mkdtemp(path.join(os.tmpdir(), "pi-memory-context-placeholder-"));
			try {
				const emptyDir = path.join(emptyTmp, ".agents/memory");
				await mkdir(emptyDir, { recursive: true });
				await writeFile(path.join(emptyDir, "project-context.json"), JSON.stringify({ forceDedupeMs: 0 }));
				const emptyFactory = await loadDefault(`${PC}/index.ts`);
				const emptyPi = makePi({ cwd: emptyTmp });
				await emptyFactory(emptyPi);
				const emptyCtx = makeCtx(emptyTmp, {
					model: { provider: "test", id: "context-placeholder", maxTokens: 32768 },
					sessionManager: makeSessionManager([messageEntry("m1", "user", "hello", "2026-09-12T10:00:00.000Z")], "context-placeholder"),
				});
				emptyCtx.modelRegistry.complete = async () => ({
					content: [{ type: "text", text: JSON.stringify({ memory_markdown: "# Project Memory\n\n## Project\n- placeholder case.", context: "## Summary\n- nope." }) }],
				});
				await emptyPi.commands.get("memory").handler("update", emptyCtx);
				const emptyLog = await readFile(path.join(emptyDir, "errors.log"), "utf8").catch(() => "");
				const placeholder = await readFile(path.join(emptyDir, "CONTEXT.md"), "utf8").catch(() => "");
				check("without a previous render the placeholder is written", placeholder.includes("## Summary") && emptyLog.includes("placeholder context was written"));
			} finally {
				await rmTemp(emptyTmp);
			}
		} finally {
			await rmTemp(shapeTmp);
		}
	}

	console.log("\n=== a reply with no context section at all is traced, not silently kept ===");
	{
		const absentTmp = await mkdtemp(path.join(os.tmpdir(), "pi-memory-context-absent-"));
		const cutTmp = await mkdtemp(path.join(os.tmpdir(), "pi-memory-context-cut-"));
		try {
			const setup = async (root) => {
				const dir = path.join(root, ".agents/memory");
				await mkdir(dir, { recursive: true });
				const previous = "# Project Context\n\nLast updated: 2026-09-01T00:00:00Z\n\n## Summary\n- out of date.\n";
				await writeFile(path.join(dir, "CONTEXT.md"), previous);
				// Every forced pass must reach the model (the default 15s dedupe would mask a repeat).
				await writeFile(path.join(dir, "project-context.json"), JSON.stringify({ forceDedupeMs: 0 }));
				return { dir, previous };
			};
			const runPass = async (root, reply) => {
				const factory = await loadDefault(`${PC}/index.ts`);
				const pi = makePi({ cwd: root });
				await factory(pi);
				const ctx = makeCtx(root, {
					model: { provider: "test", id: "context-absent", maxTokens: 32768 },
					sessionManager: makeSessionManager([messageEntry("m1", "user", "hello", "2026-09-12T10:00:00.000Z")], `absent-${path.basename(root)}`),
				});
				ctx.modelRegistry.complete = async () => ({ content: [{ type: "text", text: reply }] });
				await pi.commands.get("memory").handler("update", ctx);
				return ctx;
			};

			// A complete reply that simply omits the section: same stale CONTEXT.md, one step earlier.
			const absent = await setup(absentTmp);
			await runPass(absentTmp, JSON.stringify({ memory_markdown: "# Project Memory\n\n## Project\n- no context section." }));
			const absentLog = await readFile(path.join(absent.dir, "errors.log"), "utf8").catch(() => "");
			check("a reply without a context section keeps the previous render", (await readFile(path.join(absent.dir, "CONTEXT.md"), "utf8")) === absent.previous);
			check("the omitted context section is written to errors.log", absentLog.includes("carried no context section") && absentLog.includes("stays stale"));
			check("an omission is not reported as an unclosed reply", !absentLog.includes("never closed"));

			// The truncation variant: the memory survives, the context never made it out.
			const cut = await setup(cutTmp);
			await runPass(cutTmp, '{"memory_markdown":"# Project Memory\\n\\n## Project\\n- recovered from a cut-off reply.","context":"# Project Context","stray\\n\\n- tail"}');
			const cutLog = await readFile(path.join(cut.dir, "errors.log"), "utf8").catch(() => "");
			const cutMemory = await readFile(path.join(cut.dir, "MEMORY.md"), "utf8");
			check("the recovered memory of a cut-off reply still lands", cutMemory.includes("- recovered from a cut-off reply."));
			check("an unclosed reply says so in errors.log", cutLog.includes("carried no context section") && cutLog.includes("never closed"));
		} finally {
			await rmTemp(absentTmp);
			await rmTemp(cutTmp);
		}
	}

	console.log("\n=== an over-cap memory keeps whole lines and says what it dropped ===");
	{
		const state = await loadNamespace(`${PC}/shared/project-state.ts`);
		const line = (index) => `- convention ${index}: ` + "detail ".repeat(20).trimEnd();
		const original = Array.from({ length: 400 }, (_, index) => line(index));
		const long = `# Project Memory\n\n${original.join("\n")}`;
		check("a document inside the cap is returned untouched", state.normalizeMemoryDocument("# Project Memory\n\n## Project\n- short.") === "# Project Memory\n\n## Project\n- short.\n");
		const capped = state.normalizeMemoryDocument(long);
		check("an over-cap document is marked as truncated", state.isMemoryTruncated(capped) === true);
		check("the marker names the cap and the drop", new RegExp(`\\[memory truncated at ${state.MAX_MEMORY_CHARS} characters: \\d+ dropped\\]`).test(capped));
		const keptLines = capped.split("\n").filter((text) => text.startsWith("- "));
		check("every kept line is a complete original line", keptLines.length > 0 && keptLines.every((text) => original.includes(text)));
		// A real memory line that merely starts with the marker words is content, not a marker:
		// it must survive in place, not be moved to the end and reported as a cap.
		const lookalikeInput = "# Project Memory\n\n## Project\n- keep.\n_[memory truncated 是本周遗留问题]_\n- tail.\n";
		const lookalike = state.normalizeMemoryDocument(lookalikeInput);
		check("a look-alike line is not mistaken for the marker", lookalike === lookalikeInput && !state.isMemoryTruncated(lookalike));
		check(
			"the kept document fits the cap",
			capped.split("\n").filter((text) => !text.startsWith("_[memory truncated")).join("\n").trimEnd().length <= state.MAX_MEMORY_CHARS,
		);
		check("normalizing a capped document is idempotent", state.normalizeMemoryDocument(capped) === capped);
		check("a short memory is not marked", state.isMemoryTruncated(state.normalizeMemoryDocument("# Project Memory\n\n## Project\n- short.")) === false);
		const limited = state.normalizeMemoryDocument(long, 8_000);
		check("an explicit limit caps the document", limited.length < capped.length && limited.includes("at 8000 characters"));
		// The limit is an explicit argument, not process state: two projects cannot leak into each other.
		check("omitting the explicit limit uses the default cap", state.normalizeMemoryDocument(long) === capped);
	}

	console.log("\n=== maxMemoryChars caps the render end to end, on a line boundary ===");
	{
		const capTmp = await mkdtemp(path.join(os.tmpdir(), "pi-memory-cap-e2e-"));
		try {
			const capDir = path.join(capTmp, ".agents/memory");
			await mkdir(capDir, { recursive: true });
			await writeFile(path.join(capDir, "project-context.json"), JSON.stringify({ forceDedupeMs: 0, maxMemoryChars: 5000 }));
			await writeFile(path.join(capDir, "CONTEXT.md"), "# Project Context\n\n## Summary\n- previous.\n");
			// The model answers with a memory well past the configured cap.
			const grown = "# Project Memory\n\n" + Array.from({ length: 400 }, (_, index) => `- grown ${index}: ` + "x".repeat(60)).join("\n");
			const factory = await loadDefault(`${PC}/index.ts`);
			const pi = makePi({ cwd: capTmp });
			await factory(pi);
			const ctx = makeCtx(capTmp, {
				model: { provider: "test", id: "memory-cap", maxTokens: 32768 },
				sessionManager: makeSessionManager([messageEntry("m1", "user", "hello", "2026-09-12T10:00:00.000Z")], "memory-cap"),
			});
			ctx.modelRegistry.complete = async () => ({
				content: [{ type: "text", text: JSON.stringify({ memory_markdown: grown, context: { title: "t", summary: "s", key_points: [], open_tasks: [] } }) }],
			});
			await pi.commands.get("memory").handler("update", ctx);
			const rendered = await readFile(path.join(capDir, "MEMORY.md"), "utf8");
			const capLog = await readFile(path.join(capDir, "errors.log"), "utf8").catch(() => "");
			check("the render is capped at the configured limit", rendered.length < 5_400 && rendered.includes("at 5000 characters"));
			check("the capped render keeps only whole lines", rendered.split("\n").filter((text) => text.startsWith("- ")).every((text) => /^- grown \d+: x{60}$/.test(text)));
			check("the cap is reported to errors.log", capLog.includes("exceeded maxMemoryChars (5000)"));
			check("the command reply names the cap", String(ctx.notifications.at(-1)?.[0] ?? "").includes("maxMemoryChars cap"));
			await pi.commands.get("project-context").handler("status", ctx);
			check("status names the cap", /at the cap, so both ends were kept/.test(String(ctx.notifications.at(-1)?.[0] ?? "")));
			// The middle this cap drops is gone for good, so the unclipped reply is kept beside the memory.
			const overflow = (await readdir(capDir)).filter((name) => name.startsWith("memory-overflow-") && name.endsWith(".md"));
			check("the unclipped reply is kept locally", overflow.length === 1);
			const keptReply = overflow.length === 1 ? await readFile(path.join(capDir, overflow[0]), "utf8") : "";
			check("the local copy holds the whole reply, not the clipped render", keptReply.trim() === grown && keptReply.length > rendered.length);
			check("the local copy is gitignored", (await readFile(path.join(capDir, ".gitignore"), "utf8")).includes("memory-overflow-*.md"));
			check("errors.log names the kept copy", overflow.length === 1 && capLog.includes(overflow[0]));
		} finally {
			await rmTemp(capTmp);
		}
	}

	console.log("\n=== the reply budget matches the existing memory ===");
	{
		const budgetTmp = await mkdtemp(path.join(os.tmpdir(), "pi-memory-budget-"));
		const budgetMemory = path.join(budgetTmp, ".agents/memory/MEMORY.md");
		const budgetContext = path.join(budgetTmp, ".agents/memory/CONTEXT.md");
		try {
			await mkdir(path.dirname(budgetMemory), { recursive: true });
			const middle = "MIDDLE-应当被裁掉的中间段";
			const big = "# Project Memory\n\n## Project\nHEAD-开头段\n" + "填充。".repeat(3000) + "\n" + middle + "\n" + "补充。".repeat(3000) + "\nTAIL-末端段\n";
			const contextMiddle = "CTX-MIDDLE-应当被裁掉的中间段";
			const bigContext = "# Project Context\n\n## Summary\nCTX-HEAD-开头段\n" + "上下文。".repeat(3000) + "\n" + contextMiddle + "\n" + "继续。".repeat(3000) + "\nCTX-TAIL-末端段\n";
			let call;
			const runPass = async (model, contextText, memoryText = big) => {
				await writeFile(budgetMemory, memoryText);
				await rm(budgetContext, { force: true });
				if (contextText) await writeFile(budgetContext, contextText);
				const { consolidateProjectState } = await loadNamespace(`${PC}/memory/pass.ts`);
				const pi = makePi({ cwd: budgetTmp });
				const ctx = makeCtx(budgetTmp, {
					model,
					sessionManager: makeSessionManager([messageEntry("m1", "user", "hello", "2026-09-12T10:00:00.000Z")], `budget-${model.id}`),
				});
				ctx.modelRegistry.complete = async (_model, context, options) => {
					call = { maxTokens: options?.maxTokens, prompt: context.messages[0].content[0].text };
					return {
						content: [{
							type: "text",
							text: JSON.stringify({ memory_markdown: "# Project Memory\n\n## Project\n- trimmed.", context: { title: "t", summary: "s", key_points: [], open_tasks: [] } }),
						}],
					};
				};
				return consolidateProjectState(pi, ctx, { force: true });
			};

			const roomy = await runPass({ provider: "test", id: "cap-32k", maxTokens: 32768 });
			check("a large memory raises the output budget", call.maxTokens > 8192);
			check("a large memory is sent whole when the model allows it", roomy?.clipped === false && call.prompt.includes("HEAD-开头段") && call.prompt.includes(middle) && call.prompt.includes("TAIL-末端段"));

			const cramped = await runPass({ provider: "test", id: "cap-8k", maxTokens: 8192 });
			check("the model cap bounds the budget", call.maxTokens === 8192);
			check("a memory too large for the cap is clipped", cramped?.clipped === true && !call.prompt.includes(middle) && call.prompt.includes("HEAD-开头段") && call.prompt.includes("TAIL-末端段"));
			check("a clipped prompt tells the model to condense", call.prompt.includes("shortened to fit the output budget"));

			const both = await runPass({ provider: "test", id: "cap-8k-ctx", maxTokens: 8192 }, bigContext);
			check("a large context is budgeted too", both?.clipped === true && !call.prompt.includes(contextMiddle) && call.prompt.includes("CTX-HEAD-开头段") && call.prompt.includes("CTX-TAIL-末端段"));
			check("the context does not starve the memory", call.prompt.includes("HEAD-开头段") && call.prompt.includes("TAIL-末端段"));

			const sentLength = () => call.prompt.slice(call.prompt.indexOf("<existing-memory>"), call.prompt.indexOf("</existing-context>")).length;

			const tiny = await runPass({ provider: "test", id: "cap-tiny", maxTokens: 1400 }, bigContext);
			check("a tiny cap still sends memory content", tiny?.clipped === true && call.prompt.includes("HEAD-开头段"));
			check("a tiny cap bounds the artifacts sent", sentLength() > 0 && sentLength() <= 1400);
			check("a tiny cap does not starve the context", call.prompt.includes("CTX-HEAD-开头段"));

			const minimal = await runPass({ provider: "test", id: "cap-min", maxTokens: 1024 }, bigContext);
			check("the smallest cap still sends memory content", minimal?.clipped === true && call.prompt.includes("HEAD-开头段") && sentLength() > 0 && sentLength() <= 1024);
			check("the smallest cap does not starve the context", call.prompt.includes("CTX-HEAD-开头段"));

			const small = await runPass({ provider: "test", id: "cap-min-small", maxTokens: 1024 }, undefined, "# Project Memory\n\n## Project\nSMALL-记忆仍然保留\n");
			check("a small memory is sent whole at the smallest cap", small?.clipped === false && call.prompt.includes("SMALL-记忆仍然保留"));

			const smallContext = await runPass({ provider: "test", id: "cap-min-smallctx", maxTokens: 1024 }, bigContext, "# Project Memory\n\n## Project\nSMALL-记忆仍然保留\n");
			const sentContext = call.prompt.slice(call.prompt.indexOf("<existing-context>"), call.prompt.indexOf("</existing-context>")).length;
			check("a small memory returns its budget to the context", smallContext?.clipped === true && call.prompt.includes("SMALL-记忆仍然保留") && call.prompt.includes("CTX-HEAD-开头段") && sentContext > 300);

			// Mixed-language and uneven-density artifacts: each keeps its own rate, the split holds
			// the invariant, both stay alive, and the split does not waste the budget it was given.
			const { fitMemoryInput } = await loadNamespace(`${PC}/memory/input.ts`);
			const { replyTokenRate } = await loadNamespace(`${PC}/shared/text.ts`);
			const { reasoningReserveTokens } = await loadNamespace(`${PC}/shared/output-budget.ts`);
			const localRate = (text) => (text ? replyTokenRate(text) : 0);
			const budgetCases = [
				["small CJK memory × big ASCII context", "记".repeat(500), "a".repeat(16000) + "记".repeat(8000)],
				["big CJK memory × ASCII context", "记".repeat(7999) + "。", "a".repeat(32000)],
				["uneven head/tail density", "记".repeat(2000) + "x".repeat(50) + "记".repeat(2000), "y".repeat(28000) + "记".repeat(2000)],
				["ASCII memory × CJK context", "a".repeat(7999) + ".", "记".repeat(31999) + "。"],
				["ASCII body + CJK tail", "a".repeat(900), "b".repeat(1600) + "记".repeat(400)],
				["all-ASCII memory × dense CJK context", "a".repeat(5000), "记".repeat(12000) + "。".repeat(500)],
				["emoji-heavy memory × CJK context", "😀".repeat(400) + "a".repeat(200), "记".repeat(3000)],
				["quote-heavy memory × ASCII context", '"\\'.repeat(800) + "x".repeat(200), "y".repeat(6000)],
			];
			for (const reasoning of [false, true]) {
				for (const cap of [1024, 1400, 2048, 8192, 32768]) {
					const mode = reasoning ? " [reasoning]" : "";
					for (const [label, memoryText, contextText] of budgetCases) {
						const fitted = fitMemoryInput(memoryText, contextText, cap, { maxTokens: cap, reasoning });
						// The reserve the implementation owes: 1024 scaffolding + the reasoning share, bounded by
						// the clip floor and by half of the cap.
						const contentTokens = memoryText.length * localRate(memoryText) + contextText.length * localRate(contextText);
						// Expected from the documented constants, not from the exported helper, so a broken reserve
						// function cannot rewrite the expectation together with the implementation.
						const reasoningShare = reasoning ? Math.min(8192, Math.max(1024, Math.round(contentTokens * 0.35))) : 0;
						const desiredReserve = 1024 + reasoningShare;
						const reserved = Math.min(desiredReserve, Math.max(0, cap - 400), Math.max(1024, Math.round(cap / 2)));
						const tokens = fitted.text.length * localRate(fitted.text) + fitted.contextText.length * localRate(fitted.contextText);
						check(`budget invariant: ${label} @${cap}${mode} (${Math.round(tokens + reserved)}/${cap})`, tokens + reserved <= cap + 0.001);
						if (cap - reserved >= 800) {
							const wholeMemory = fitted.text.length === memoryText.length;
							const wholeContext = fitted.contextText.length === contextText.length;
							check(`artifact floor: ${label} @${cap}${mode} (${fitted.text.length}/${fitted.contextText.length})`, fitted.text.length >= Math.min(memoryText.length, 400) && fitted.contextText.length >= Math.min(contextText.length, 400));
							if (!(wholeMemory && wholeContext)) {
								const slack = Math.max(32, (cap - reserved) * 0.02);
								check(`budget is used, not wasted: ${label} @${cap}${mode} (${Math.round(tokens)}/${cap - reserved})`, tokens >= cap - reserved - slack);
							}
						}
					}
				}
			}
			// The retry's headroom is part of the reserve, so when the model cap binds the retry can clip
			// more than the first attempt; the reported flag follows the prompt that was actually sent.
			const retryFirst = fitMemoryInput("记".repeat(20000), "a".repeat(8000), 8192, { maxTokens: 32768, reasoning: true });
			const retryAgain = fitMemoryInput("记".repeat(20000), "a".repeat(8000), 8192, { maxTokens: 32768, reasoning: true }, 32768, 4096);
			check("a truncated retry can clip more than the first attempt (and the flag follows the sent prompt)", retryFirst.clipped === false && retryAgain.clipped === true);

			const near = await runPass({ provider: "test", id: "cap-near", maxTokens: 8192 }, undefined, "# Project Memory\n\n## Project\nNEAR-HEAD\n" + "接近。".repeat(3000) + "\nNEAR-MIDDLE\n" + "结尾。".repeat(1000) + "\nNEAR-TAIL\n");
			check("a near-budget memory keeps head and tail only", near?.clipped === true && call.prompt.includes("NEAR-HEAD") && call.prompt.includes("NEAR-TAIL") && !call.prompt.includes("NEAR-MIDDLE"));

			const { consolidateReply } = await loadNamespace(`${PC}/memory/report.ts`);
			check("a clipped reply is visible to explicit commands", consolidateReply("clipped").includes("output budget"));
			// The command reply is a third surface for the cap sentence, and it used to tell a per-item cut as
			// the document hitting its cap and point at a drop list that does not exist (review R2).
			const cutOnly = consolidateReply("updated", { repaired: false, sectionsCapped: true, entriesDropped: false, capNote: "1 entry(ies) were cut to their section's per-item cap (a cut entry may also be dropped)" });
			const didDrop = consolidateReply("updated", { repaired: false, sectionsCapped: true, entriesDropped: true, capNote: "3 whole entry(ies) were dropped from 2 section(s). Dropped, e.g. first | second | third" });
			check("a per-item cut is not told as the document reaching its cap", !cutOnly.includes("reached its character cap") && !cutOnly.includes("dropped entries are listed"));
			check("a real drop still names the cap and the drop samples", didDrop.includes("reached its character cap") && didDrop.includes("Dropped, e.g."));
			check("the reply names the dropped entries inline, not through a log pointer", didDrop.includes("Dropped, e.g. first | second | third") && !didDrop.includes(".agents/memory/errors.log"));

			// The command path runs silently; it must still report the clip and leave a trace.
			const factory = await loadDefault(`${PC}/index.ts`);
			const pi = makePi({ cwd: budgetTmp });
			await factory(pi);
			await writeFile(budgetMemory, big);
			const ctx = makeCtx(budgetTmp, {
				model: { provider: "test", id: "cap-8k-command", maxTokens: 8192 },
				sessionManager: makeSessionManager([messageEntry("m1", "user", "hello", "2026-09-12T10:00:00.000Z")], "clip-command"),
			});
			ctx.hasUI = false; // headless: notifications are a no-op, the trace must still exist
			ctx.modelRegistry.complete = async (_model, context, options) => {
				call = { maxTokens: options?.maxTokens, prompt: context.messages[0].content[0].text };
				return {
					content: [{
						type: "text",
						text: JSON.stringify({ memory_markdown: "# Project Memory\n\n## Project\n- command trimmed.", context: { title: "t", summary: "s", key_points: [], open_tasks: [] } }),
					}],
				};
			};
			await pi.commands.get("memory").handler("update", ctx);
			const trace = await readFile(path.join(budgetTmp, ".agents/memory/errors.log"), "utf8").catch(() => "");
			check("a headless clip still leaves a trace", trace.includes("shortened"));
			const clipBackups = (await readdir(path.join(budgetTmp, ".agents/memory"))).filter((name) => name.includes(".memory-backup-"));
			check("a clipped rewrite keeps a backup", clipBackups.length === 1 && (await readFile(path.join(budgetTmp, ".agents/memory", clipBackups[0]), "utf8")) === big);
		} finally {
			await rmTemp(budgetTmp);
		}
	}

	console.log("\n=== residuals: recall, rate, lock, ignore, redaction ===");
	{
		const { loadMemory, backupMemoryBeforeWrite, logError, migrateProjectState, readJsonStringField, withMemoryLock, ensureMemoryGitignore } = await loadNamespace(`${PC}/shared/project-state.ts`);
		const { fitMemoryInput } = await loadNamespace(`${PC}/memory/input.ts`);
		const { replyTokenRate, clipText } = await loadNamespace(`${PC}/shared/text.ts`);
		const { adaptiveOutputTokens } = await loadNamespace(`${PC}/shared/output-budget.ts`);
		const fixTmp = await mkdtemp(path.join(os.tmpdir(), "pi-memory-residuals-"));
		try {
			const dir = path.join(fixTmp, ".agents/memory");
			await mkdir(dir, { recursive: true });
			const memory = path.join(dir, "MEMORY.md");
			const value = "# Project Memory\n\n## Project\n- " + "记".repeat(80);

			// context-first replies decode (the first key may be either reply field).
			await writeFile(memory, `{"context": {"title": "t"}, "memory_markdown": ${JSON.stringify(value)}}`);
			const contextFirst = await loadMemory(fixTmp);
			check("a context-first stored reply is decoded", contextFirst.poisoned === true && contextFirst.text.includes("记".repeat(80)));

			// A nested field with the same name is not the reply's field.
			await writeFile(memory, `{"context": {"note": ${JSON.stringify(`{"memory_markdown": ${JSON.stringify(value)}}`)}}, "memory_markdown": "short nested baseline"}`);
			check("a nested field is not mistaken for a stored reply", (await loadMemory(fixTmp)).poisoned === false);

			// A header-less but clearly document-shaped value decodes; a short one does not.
			await writeFile(memory, `{"memory_markdown": ${JSON.stringify("## Project\n- " + "x".repeat(200))}}`);
			check("a header-less document value is decoded", (await loadMemory(fixTmp)).poisoned === true);
			await writeFile(memory, `{"memory_markdown": "not a document"}`);
			check("a header-less short value is left alone", (await loadMemory(fixTmp)).poisoned === false);

			// Backslash escapes beyond n/t/r survive the field decoder.
			const escaped = readJsonStringField('{"memory_markdown": "a\\b\\f\\u0041"}', "memory_markdown");
			check("the field decoder maps \\b and \\f", escaped?.value === "a\b\fA" && escaped.end > 0);

			// Legacy .pi sources are decoded too.
			await rm(memory, { force: true });
			await mkdir(path.join(fixTmp, ".pi"), { recursive: true });
			await writeFile(path.join(fixTmp, ".pi/MEMORY.md"), `{"memory_markdown": ${JSON.stringify(value)}}`);
			const legacy = await loadMemory(fixTmp);
			check("a legacy .pi stored reply is decoded", legacy.poisoned === true && legacy.source.includes(".pi"));

			// An unreadable legacy source is reported too, not shown as "no memory".
			await rm(path.join(fixTmp, ".pi/MEMORY.md"), { force: true });
			await mkdir(path.join(fixTmp, ".pi/MEMORY.md"), { recursive: true });
			const legacyUnreadable = await loadMemory(fixTmp);
			check("an unreadable legacy source is flagged", legacyUnreadable.unreadable === true && legacyUnreadable.source.includes(".pi"));
			await rmTemp(path.join(fixTmp, ".pi/MEMORY.md"));

			// Token rate charges every non-ASCII code point and the escape cost.
			check("non-CJK scripts are charged a full token", replyTokenRate("привет") === 1);
			check("ASCII escapes cost extra", replyTokenRate('"\\\\') > replyTokenRate("ab"));
			const emoji = "😀";
			check("an emoji never costs less than one token", emoji.length * replyTokenRate(emoji) >= 1);

			// Clipping never splits a surrogate pair, at either boundary.
			const hasLoneSurrogate = (text) => {
				for (let index = 0; index < text.length; index += 1) {
					const code = text.charCodeAt(index);
					const high = code >= 0xd800 && code <= 0xdbff;
					const low = code >= 0xdc00 && code <= 0xdfff;
					if (high && !(text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff)) return true;
					if (low && !(text.charCodeAt(index - 1) >= 0xd800 && text.charCodeAt(index - 1) <= 0xdbff)) return true;
				}
				return false;
			};
			const surrogateHead = "x".repeat(10) + "😀" + "y".repeat(100);
			const surrogateTail = "y".repeat(100) + "😀" + "x".repeat(10);
			check("clipping keeps a pair whole at the head", !hasLoneSurrogate(clipText(surrogateHead, 20)));
			check("clipping keeps a pair whole at the tail", !hasLoneSurrogate(clipText(surrogateTail, 20)));
			let split = false;
			for (let limit = 4; limit <= 40; limit += 1) {
				if (hasLoneSurrogate(clipText(surrogateHead, limit)) || hasLoneSurrogate(clipText(surrogateTail, limit))) split = true;
			}
			check("no clip limit splits a surrogate pair", !split);
			let overLimit = false;
			for (const sample of [surrogateHead, surrogateTail, "😀".repeat(60), "a".repeat(50) + "😀😀" + "b".repeat(50)]) {
				for (let limit = 0; limit <= 70; limit += 1) {
					if (clipText(sample, limit).length > limit) overLimit = true;
				}
			}
			check("clipText never exceeds its limit", !overLimit);
			// A malformed orphan low surrogate just after a valid pair must not be promoted into it.
			const malformed = "a".repeat(30) + "😀" + "\uDC00" + "b".repeat(18);
			check("clipping drops a malformed orphan rather than splitting a pair", !clipText(malformed, 50).includes("\uDC00"));

			// The adaptive cap honours the configured ceiling and the model's own limit.
			check("the adaptive cap respects the ceiling", fitMemoryInput("记".repeat(20000), "", 8192, {}, 16384).maxTokens <= 16384);
			check("a model limit wins over the ceiling", fitMemoryInput("记".repeat(20000), "", 8192, { maxTokens: 4096 }, 16384).maxTokens <= 4096);
			check("a skill-sized need raises the cap", adaptiveOutputTokens(8192, 21000, {}, 32768) === 21000);

			// The write lock serializes writers, steals stale locks, and never leaks its file.
			// Contention is deterministic rather than timed: the followers are started from inside the
			// holder's critical section, so a mutex that fails to serialize runs them right there.
			let active = 0;
			let insideLock = false;
			let overlaps = 0;
			const followers = [];
			await withMemoryLock(memory, async () => {
				insideLock = true;
				for (let index = 0; index < 2; index += 1) {
					followers.push(withMemoryLock(memory, async () => {
						active += 1;
						if (insideLock || active > 1) overlaps += 1;
						active -= 1;
					}));
				}
				// Yield across both the check and the timer phase, several turns deep: a mutex bypass that
				// defers the critical section by a few event-loop turns must still land inside this window.
				// (No in-process window can defeat an arbitrarily delaying bypass; the cross-process probe
				// below is the authority for real mutual exclusion.)
				for (let turn = 0; turn < 3; turn += 1) {
					await new Promise((resolve) => setImmediate(resolve));
					await new Promise((resolve) => setTimeout(resolve, 0));
				}
				insideLock = false;
			});
			await Promise.all(followers);
			check("the write lock serializes writers", overlaps === 0 && followers.length === 2 && !(await readdir(dir)).includes("MEMORY.md.lock"));
			const stale = path.join(dir, "MEMORY.md.lock");
			await writeFile(stale, "stale");
			await utimes(stale, new Date(Date.now() - 2 * 60 * 60 * 1000), new Date(Date.now() - 2 * 60 * 60 * 1000));
			let stole = false;
			await withMemoryLock(memory, async () => {
				stole = true;
			});
			check("a stale lock is stolen and cleaned", stole && !(await readdir(dir)).includes("MEMORY.md.lock"));

			// A stolen lock belongs to the thief: the original holder's release must not delete it.
			let releaseOriginal;
			const originalHeld = new Promise((resolve) => {
				releaseOriginal = resolve;
			});
			let originalEntered;
			const originalEnteredPromise = new Promise((resolve) => {
				originalEntered = resolve;
			});
			const originalRun = withMemoryLock(memory, async () => {
				originalEntered();
				await originalHeld;
			});
			await originalEnteredPromise;
			const stolenPath = path.join(dir, "MEMORY.md.lock");
			await utimes(stolenPath, new Date(Date.now() - 2 * 60 * 60 * 1000), new Date(Date.now() - 2 * 60 * 60 * 1000));
			let thiefEntered = false;
			let releaseThief;
			const thiefHeld = new Promise((resolve) => {
				releaseThief = resolve;
			});
			const thiefRun = withMemoryLock(memory, async () => {
				thiefEntered = true;
				await thiefHeld;
			});
			await waitUntil(() => thiefEntered, 3_000);
			releaseOriginal();
			await originalRun;
			let thirdEntered = false;
			let thirdAttempted = false;
			const thirdRun = (() => {
				thirdAttempted = true;
				return withMemoryLock(memory, async () => {
					thirdEntered = true;
				});
			})();
			await waitUntil(() => thirdAttempted, 1_000);
			// The thief still holds the lock: a few event-loop turns must not let the third run in.
			for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setImmediate(resolve));
			const thirdBlocked = !thirdEntered;
			releaseThief();
			await thiefRun;
			await thirdRun;
			check("a stolen lock is not released by its original holder", thiefEntered && thirdBlocked && thirdEntered);

			// A stale lock plus writers started inside the (just stolen) critical section: the lock must
			// not be shared with them. That a stale entry is claimed exactly once is covered by the
			// neighbouring steal tests (and the cross-process probe), not by this overlap check.
			const crashedLock = path.join(dir, "MEMORY.md.lock");
			await writeFile(crashedLock, "crashed\n");
			await utimes(crashedLock, new Date(Date.now() - 2 * 60 * 60 * 1000), new Date(Date.now() - 2 * 60 * 60 * 1000));
			let concurrent = 0;
			let insideSteal = false;
			let contendedOverlap = false;
			const contenders = [];
			await withMemoryLock(memory, async () => {
				insideSteal = true;
				for (let index = 0; index < 2; index += 1) {
					contenders.push(withMemoryLock(memory, async () => {
						concurrent += 1;
						if (insideSteal || concurrent > 1) contendedOverlap = true;
						concurrent -= 1;
					}));
				}
				for (let turn = 0; turn < 3; turn += 1) {
					await new Promise((resolve) => setImmediate(resolve));
					await new Promise((resolve) => setTimeout(resolve, 0));
				}
				insideSteal = false;
			});
			await Promise.all(contenders);
			check("writers started while a stolen lock is held never overlap", !contendedOverlap && contenders.length === 2 && !(await readdir(dir)).includes("MEMORY.md.lock"));

			// A release that cannot take the claim must leave the lock for the claimed stealer.
			const heldLock = path.join(dir, "MEMORY.md.lock");
			const heldClaim = `${heldLock}.steal`;
			let releaseHolder;
			const holderHeld = new Promise((resolve) => {
				releaseHolder = resolve;
			});
			let holderEntered;
			const holderEnteredPromise = new Promise((resolve) => {
				holderEntered = resolve;
			});
			const holderRun = withMemoryLock(memory, async () => {
				holderEntered();
				await holderHeld;
			});
			await holderEnteredPromise;
			await writeFile(heldClaim, "foreign\n");
			releaseHolder();
			await holderRun;
			check("a release without the claim leaves the lock", (await readFile(heldLock, "utf8").catch(() => "")).includes(String(process.pid)));
			await rm(heldClaim, { force: true });
			await rm(heldLock, { force: true });

			// A held claim on a stale lock must fail the waiter at its deadline, not spin past it.
			await writeFile(heldLock, "stale\n");
			const agedByClaim = new Date(Date.now() - 2 * 60 * 60 * 1000);
			await utimes(heldLock, agedByClaim, agedByClaim);
			await writeFile(heldClaim, "fresh-claim\n");
			const waitStart = Date.now();
			let deadlineHit = false;
			try {
				await withMemoryLock(memory, async () => {});
			} catch {
				deadlineHit = true;
			}
			check("a held claim cannot bypass the lock deadline", deadlineHit && Date.now() - waitStart < 8000);
			await rm(heldClaim, { force: true });
			await rm(heldLock, { force: true });

			// A stale claim left by a crashed stealer is reclaimed together with the stale lock.
			await writeFile(heldLock, "stale-lock\n");
			await writeFile(heldClaim, "stale-claim\n");
			await utimes(heldLock, agedByClaim, agedByClaim);
			await utimes(heldClaim, agedByClaim, agedByClaim);
			let claimRecovered = false;
			await withMemoryLock(memory, async () => {
				claimRecovered = true;
			});
			check("a stale claim is reclaimed with the stale lock", claimRecovered && !(await readdir(dir)).some((name) => name.startsWith("MEMORY.md.lock")));

			// The hard ceiling bounds a sustained burst and prunes the oldest, keeping the newest.
			await writeFile(memory, "# Project Memory\n\n## Project\n- cap.\n");
			const capPaths = [];
			const capBase = Date.now() - 10 * 60 * 1000;
			for (let round = 0; round < 25; round += 1) {
				const snapshot = await backupMemoryBeforeWrite(memory);
				capPaths.push(snapshot.path);
				const stamp = new Date(capBase + round * 1000);
				await utimes(snapshot.path, stamp, stamp);
			}
			const kept = new Set((await readdir(path.dirname(memory))).filter((name) => /^MEMORY\.md\.memory-backup-/.test(name)));
			check(`the backup cap keeps the newest 20 (have ${kept.size})`, kept.size === 20
				&& capPaths.slice(0, 5).every((file) => !kept.has(path.basename(file)))
				&& kept.has(path.basename(capPaths.at(-1))));

			// Equal mtimes fall back to the name, so the lexicographically newest backups survive.
			const tieDir = path.join(fixTmp, "tie", ".agents", "memory");
			await mkdir(tieDir, { recursive: true });
			await writeFile(path.join(tieDir, "MEMORY.md"), "# Project Memory\n\n## Project\n- tie.\n");
			const tieNames = [];
			for (let index = 0; index < 8; index += 1) {
				const name = `MEMORY.md.memory-backup-2026-01-01T00-00-00-000Z-0000000${index}`;
				tieNames.push(name);
				await writeFile(path.join(tieDir, name), "old\n");
				await utimes(path.join(tieDir, name), agedByClaim, agedByClaim);
			}
			await backupMemoryBeforeWrite(path.join(tieDir, "MEMORY.md"));
			const tieEntries = await readdir(tieDir);
			check("equal-mtime backups prune by name deterministically", tieNames.slice(0, 4).every((name) => !tieEntries.includes(name)) && tieNames.slice(4).every((name) => tieEntries.includes(name)));

			// Symlinks and FIFOs at the lock or claim path heal instead of freezing every write.
			const linkRoot = path.join(fixTmp, "symlink", ".agents", "memory");
			await mkdir(linkRoot, { recursive: true });
			await symlink("does-not-exist", path.join(linkRoot, "MEMORY.md.lock"));
			let healedLink = false;
			await withMemoryLock(path.join(linkRoot, "MEMORY.md"), async () => {
				healedLink = true;
			});
			check("a dangling lock symlink heals", healedLink && !(await readdir(linkRoot)).includes("MEMORY.md.lock"));
			const claimLinkTarget = path.join(fixTmp, "symlink-claim", ".agents", "memory");
			await mkdir(claimLinkTarget, { recursive: true });
			await writeFile(path.join(claimLinkTarget, "MEMORY.md.lock"), "stale\n");
			await utimes(path.join(claimLinkTarget, "MEMORY.md.lock"), agedByClaim, agedByClaim);
			await symlink("does-not-exist", path.join(claimLinkTarget, "MEMORY.md.lock.steal"));
			let healedClaimLink = false;
			await withMemoryLock(path.join(claimLinkTarget, "MEMORY.md"), async () => {
				healedClaimLink = true;
			});
			const claimLinkEntries = await readdir(claimLinkTarget);
			check("a dangling claim symlink heals", healedClaimLink && !claimLinkEntries.includes("MEMORY.md.lock") && !claimLinkEntries.includes("MEMORY.md.lock.steal"));
			const fifoRoot = path.join(fixTmp, "fifo", ".agents", "memory");
			await mkdir(fifoRoot, { recursive: true });
			const fifoPath = path.join(fifoRoot, "MEMORY.md.lock");
			let fifoAvailable = true;
			try {
				execFileSync("mkfifo", [fifoPath]);
			} catch {
				fifoAvailable = false; // No mkfifo on this platform; the probe is skipped, not passed.
			}
			if (fifoAvailable) {
				let healedFifo = false;
				await withMemoryLock(path.join(fifoRoot, "MEMORY.md"), async () => {
					healedFifo = true;
				});
				check("a FIFO at the lock path heals", healedFifo && !(await readdir(fifoRoot)).includes("MEMORY.md.lock"));
			} else {
				check("a FIFO at the lock path heals (skipped: mkfifo unavailable)", true);
			}

			// The first lock in a new project also creates the local gitignore.
			const freshMemoryDir = path.join(fixTmp, "fresh", ".agents", "memory");
			await mkdir(freshMemoryDir, { recursive: true });
			await withMemoryLock(path.join(freshMemoryDir, "MEMORY.md"), async () => {});
			check("the first lock creates the local gitignore", (await readFile(path.join(freshMemoryDir, ".gitignore"), "utf8")).includes("*.lock"));

			// Cross-process writers serialize as well (three real child processes, one shared log).
			const lockLog = path.join(fixTmp, "lock-log.txt");
			const childScript = fileURLToPath(new URL("./helpers/lock-holder.mjs", import.meta.url));
			const children = [0, 1, 2].map(() => new Promise((resolve, reject) => {
				const child = spawn(process.execPath, [childScript, memory, lockLog, "60"], { stdio: "ignore", timeout: 15_000 });
				child.on("error", reject);
				child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`lock child exited ${code}`))));
			}));
			await Promise.all(children);
			const lockLines = (await readFile(lockLog, "utf8")).trim().split("\n");
			let lockDepth = 0;
			let nested = false;
			for (const line of lockLines) {
				if (line.startsWith("enter")) {
					lockDepth += 1;
					if (lockDepth > 1) nested = true;
				} else lockDepth -= 1;
			}
			const residue = (await readdir(dir)).filter((name) => name.startsWith("MEMORY.md.lock"));
			check("cross-process writers never overlap", !nested && lockDepth === 0 && lockLines.length === 6 && residue.length === 0);

			// A directory at the lock path heals instead of freezing every later write.
			const dirLockRoot = path.join(fixTmp, "locked", ".agents", "memory");
			await mkdir(path.join(dirLockRoot, "MEMORY.md.lock"), { recursive: true });
			let lockPathHealed = false;
			await withMemoryLock(path.join(dirLockRoot, "MEMORY.md"), async () => {
				lockPathHealed = true;
			});
			check("a directory at the lock path heals", lockPathHealed && !(await readdir(dirLockRoot)).includes("MEMORY.md.lock"));

			// Stale cleanup drops an empty broken artifact but keeps one that may hold user data.
			const cleanupRoot = path.join(fixTmp, "cleanup");
			const cleanupDir = path.join(cleanupRoot, ".agents", "memory");
			await mkdir(path.join(cleanupDir, "MEMORY.md.lock.broken-1234abcd"), { recursive: true });
			await mkdir(path.join(cleanupDir, "MEMORY.md.lock.broken-deadbeef"), { recursive: true });
			await writeFile(path.join(cleanupDir, "MEMORY.md.lock.broken-deadbeef", "user.txt"), "user data");
			await mkdir(path.join(cleanupDir, "MEMORY.md.lock.broken-feedface"), { recursive: true });
			const oldStamp = new Date(Date.now() - 2 * 60 * 60 * 1000);
			for (const name of ["MEMORY.md.lock.broken-1234abcd", "MEMORY.md.lock.broken-deadbeef"]) {
				await utimes(path.join(cleanupDir, name), oldStamp, oldStamp);
			}
			await migrateProjectState(cleanupRoot);
			const cleaned = await readdir(cleanupDir);
			check("stale cleanup drops only empty broken artifacts", !cleaned.includes("MEMORY.md.lock.broken-1234abcd") && cleaned.includes("MEMORY.md.lock.broken-deadbeef") && cleaned.includes("MEMORY.md.lock.broken-feedface"));

			// Local artifacts are ignored, once, next to the memory they belong to.
			await writeFile(memory, "# Project Memory\n\n## Project\n- keep.\n");
			await backupMemoryBeforeWrite(memory);
			const ignore = await readFile(path.join(dir, ".gitignore"), "utf8");
			check("backups are gitignored next to the memory", ignore.includes("*.memory-backup-*") && ignore.includes("errors.log") && ignore.includes("memory-overflow-*.md"));
			await backupMemoryBeforeWrite(memory);
			check("the gitignore is appended only once", (await readFile(path.join(dir, ".gitignore"), "utf8")) === ignore);

			// A newer version that adds a line appends that line alone, keeping a single header.
			const header = "# project-context: local artifacts, do not commit";
			const headerCount = (text) => text.split(header).length - 1;
			const grownDir = path.join(fixTmp, "grown", ".agents", "memory");
			await mkdir(grownDir, { recursive: true });
			await writeFile(path.join(grownDir, ".gitignore"), `${header}\nmemory.jsonl\n`);
			await ensureMemoryGitignore(grownDir);
			const grown = await readFile(path.join(grownDir, ".gitignore"), "utf8");
			check("a later line joins a single header", headerCount(grown) === 1 && grown.startsWith(`${header}\nmemory.jsonl\n`) && grown.includes("handoff-session-settings.json") && grown.includes("*.lock"));

			// A hand-written ignore file gains the header once and keeps its own lines.
			const bareDir = path.join(fixTmp, "bare", ".agents", "memory");
			await mkdir(bareDir, { recursive: true });
			await writeFile(path.join(bareDir, ".gitignore"), "node_modules/\n");
			await ensureMemoryGitignore(bareDir);
			const bare = await readFile(path.join(bareDir, ".gitignore"), "utf8");
			check("a headerless ignore file gains the header once", headerCount(bare) === 1 && bare.startsWith(`node_modules/\n${header}\n`) && bare.includes("errors.log") && bare.includes("handoff-session-settings.json"));

			// A hand-written header in another capitalisation is the same comment for git, so it is
			// not duplicated by a later line being appended.
			const casedDir = path.join(fixTmp, "cased", ".agents", "memory");
			await mkdir(casedDir, { recursive: true });
			const upperHeader = header.toUpperCase();
			await writeFile(path.join(casedDir, ".gitignore"), `${upperHeader}\nmemory.jsonl\n`);
			await ensureMemoryGitignore(casedDir);
			const cased = await readFile(path.join(casedDir, ".gitignore"), "utf8");
			check("a differently cased header is not repeated", cased.startsWith(`${upperHeader}\nmemory.jsonl\n`) && !cased.includes(header) && cased.includes("errors.log"));

			// Errors are redacted before they land in the log.
			await logError(fixTmp, "test", "api_key: sk-abcdef1234567890 and ghp_abcdefghijklmnop");
			const log = await readFile(path.join(dir, "errors.log"), "utf8");
			check("credentials are redacted from errors.log", !log.includes("sk-abcdef") && !log.includes("ghp_abcdef") && log.includes("[redacted"));

			// An unreadable memory file is reported, not reported as missing.
			await rm(memory, { force: true });
			await mkdir(memory, { recursive: true });
			const unreadable = await loadMemory(fixTmp);
			check("an unreadable memory is flagged", unreadable.unreadable === true && unreadable.text === "");
		} finally {
			await rmTemp(fixTmp);
		}
	}

	console.log("\n=== structured output: the tool call, the fallback, and the gate ===");
	{
		const SECTIONS = { project: ["Structured project line"], invariants: ["Structured invariant"], pitfalls: [], index: ["docs/ — 索引"] };
		const CONTEXT = { title: "structured", summary: "summary text", key_points: ["kp"], open_tasks: ["ot"] };
		const memoryFile = (root) => path.join(root, ".agents/memory/MEMORY.md");
		const errorLog = (root) => path.join(root, ".agents/memory/errors.log");
		// A missing errors.log is a failing expectation, not a crash: the matrix runs mutate the renderer,
		// and an ENOENT would abort the file before the assertion that should have gone red could run.
		const errorLogText = (root) => readFile(errorLog(root), "utf8").catch(() => "");

		/** Register the extension over a fresh temp project whose model replies as `reply` says. */
		const project = async (name, config = {}) => {
			const root = await mkdtemp(path.join(os.tmpdir(), `pi-${name}-`));
			await mkdir(path.join(root, ".agents/memory"), { recursive: true });
			await writeFile(path.join(root, ".agents/memory/project-context.json"), `${JSON.stringify({ memoryEnabled: true, ...config })}\n`);
			const pi = makePi({ cwd: root });
			await (await loadDefault(`${PC}/index.ts`))(pi);
			return { root, pi };
		};
		/** One pass whose model answers with `reply(attempt, context)`. */
		const pass = async ({ root, pi }, reply) => {
			const ctx = makeCtx(root, {
				model: { provider: "test", id: "structured", maxTokens: 32768 },
				sessionManager: makeSessionManager([messageEntry("m1", "user", "do the thing", "2026-09-12T10:00:00.000Z")], "structured-session"),
			});
			const seen = [];
			ctx.modelRegistry.complete = async (_model, context, options) => {
				seen.push({ tools: context.tools, options });
				return reply(seen.length, context);
			};
			// The command handler notifies and returns nothing, so the reply text IS the toast; asserting on
			// a returned value would be vacuous.
			await pi.commands.get("memory").handler("update", ctx);
			return { ctx, seen, toasts: ctx.notifications.map(([message]) => message) };
		};
		const toolReply = (args, stopReason) => ({ content: [{ type: "toolCall", name: "record_memory", arguments: args }], stopReason: stopReason ?? "toolUse" });

		// 1. The tool call is the preferred entry, and it is actually offered to the route.
		{
			const handle = await project("structured-ok");
			try {
				const { seen } = await pass(handle, () => toolReply({ memory: SECTIONS, context: CONTEXT }));
				const written = await readFile(memoryFile(handle.root), "utf8");
				check("the tool path renders the four fixed sections in order", /## Project\n- Structured project line\n\n## Invariants\n- Structured invariant\n\n## Pitfalls\n\n## Index\n- docs\/ — 索引/.test(written));
				check("the tool path asks the model for the tool", seen[0].tools?.[0]?.name === "record_memory");
				check("the tool path does not retry on success", seen.length === 1);
				check("the context section is written from the same reply", (await readFile(path.join(handle.root, ".agents/memory/CONTEXT.md"), "utf8")).includes("summary text"));
			} finally {
				await rmTemp(handle.root);
			}
		}

		// 2. The parseable fallback must land byte-identical to the structured entry.
		{
			const sectionsDoc = "# Project Memory\n\n## Project\n- Structured project line\n\n## Invariants\n- Structured invariant\n\n## Pitfalls\n\n## Index\n- docs/ — 索引";
			const structured = await project("structured-byte-a");
			let structuredBytes = "";
			try {
				await pass(structured, () => toolReply({ memory: SECTIONS, context: CONTEXT }));
				structuredBytes = await readFile(memoryFile(structured.root), "utf8");
			} finally {
				await rmTemp(structured.root);
			}
			const fallback = await project("structured-byte-b");
			try {
				await pass(fallback, () => ({ content: [{ type: "text", text: JSON.stringify({ memory_markdown: sectionsDoc, context: CONTEXT }) }], stopReason: "stop" }));
				const fallbackBytes = await readFile(memoryFile(fallback.root), "utf8");
				check("the parseable fallback renders byte-identical to the tool path", fallbackBytes === structuredBytes);
			} finally {
				await rmTemp(fallback.root);
			}
		}

		// 3. Four empty sections are not a change, whatever the context does.
		{
			const handle = await project("structured-empty");
			try {
				const before = "# Project Memory\n\n## Project\n- keep me.\n";
				await writeFile(memoryFile(handle.root), before);
				const { toasts } = await pass(handle, () => toolReply({ memory: { project: [""], invariants: [" "], pitfalls: ["\u200b"], index: ["##"] }, context: CONTEXT }));
				check("an all-empty reply leaves MEMORY.md byte-identical", (await readFile(memoryFile(handle.root), "utf8")) === before);
				check("the same pass still writes the context", (await readFile(path.join(handle.root, ".agents/memory/CONTEXT.md"), "utf8")).includes("summary text"));
				check("the reply does not claim the memory was updated", !toasts.some((message) => /Memory: updated /.test(message)));
				check("the reply says the memory was kept", toasts.some((message) => message.includes("memory was kept unchanged")));
				check("no removal warning is raised for an unwritten memory", !toasts.some((message) => message.includes("no longer carries")));
				check("the gate leaves an ordinary diagnostic", (await errorLogText(handle.root)).includes("not a writable memory document"));
			} finally {
				await rmTemp(handle.root);
			}
		}

		// 4. The regression guard reports what the new memory no longer says.
		{
			const handle = await project("structured-guard");
			try {
				await writeFile(
					memoryFile(handle.root),
					"# Project Memory\n\n## Project\n- p.\n\n## Invariants\n- keep this invariant\n- drop this invariant\n\n## Pitfalls\n- keep this pitfall\n- drop this pitfall\n\n## Index\n- i\n",
				);
				const { toasts } = await pass(handle, () =>
					toolReply({ memory: { project: ["p"], invariants: ["keep this invariant"], pitfalls: ["keep this pitfall"], index: ["i"] }, context: CONTEXT }),
				);
				check("the guard counts the vanished Invariants/Pitfalls entries", (await errorLogText(handle.root)).includes("memory regression: 2"));
				check("the guard warns the user by name", toasts.some((message) => message.includes("no longer carries 2 Invariants/Pitfalls")));
				check("the guard does not block the write", (await readFile(memoryFile(handle.root), "utf8")).includes("keep this invariant"));
			} finally {
				await rmTemp(handle.root);
			}
		}

		// 4b. A free-form stored memory has nothing to compare, so the guard stays quiet.
		{
			const handle = await project("structured-guard-free");
			try {
				await writeFile(memoryFile(handle.root), "# Project Memory\n\n## Project\nProse, not bullets.\n\n## Invariants\n- a\n\n## Pitfalls\n- b\n\n## Index\n- c\n");
				const { toasts } = await pass(handle, () => toolReply({ memory: SECTIONS, context: CONTEXT }));
				check("the guard is skipped for a free-form memory", (await errorLogText(handle.root)).includes("guard skipped"));
				check("no removal warning is raised for a free-form memory", !toasts.some((message) => message.includes("no longer carries")));
			} finally {
				await rmTemp(handle.root);
			}
		}

		// 5. A document over its cap is visible through the write path, with no numeric suggestion.
		//    A section over its own share is not enough since the shares became targets: the renderer only
		//    drops entries when the whole document is full, so the fixture has to overflow the document
		//    (300 short entries against a 4000-character cap) rather than one section.
		{
			const handle = await project("structured-cap", { maxMemoryChars: 4000 });
			try {
				const flood = Array.from({ length: 300 }, (_, index) => `entry number ${index}`);
				// The condensation reply carries no text (a tool call again), so it cannot be adopted and the
				// first, capped result stands: that is the case the write path has to make visible.
				const { toasts } = await pass(handle, () => toolReply({ memory: { project: flood, invariants: [], pitfalls: [], index: [] }, context: CONTEXT }));
				const written = await readFile(memoryFile(handle.root), "utf8");
				const log = await errorLogText(handle.root);
				check("the render honours the cap", written.length <= 4000);
				check("the cap event reaches errors.log", log.includes("reached its cap"));
				// The log line names the dropped entries instead of only counting them; the notice inlines its own
				// samples and no longer depends on this line existing (review R3, tightened in R5).
				check("the log names samples of what went, not only the count", /dropped entries \(first 3\): entry number \d/.test(log));
				check("the cap event is announced to the user", toasts.some((message) => message.includes("reached its character cap")));
				check("the section path suggests no max-memory value", !toasts.some((message) => message.includes("max-memory")) && !log.includes("raise it with"));
			} finally {
				await rmTemp(handle.root);
			}
		}

		// 6. "length" wins over "we got a tool call": pi-ai repairs a truncated arguments string
		// into a shape-valid object, so accepting it would store a half-written memory.
		{
			const handle = await project("structured-truncated");
			try {
				const truncated = toolReply({ memory: { project: ["half written"], invariants: [], pitfalls: [], index: [] }, context: CONTEXT }, "length");
				const sectionsDoc = "# Project Memory\n\n## Project\n- Structured project line\n\n## Invariants\n- Structured invariant\n\n## Pitfalls\n\n## Index\n- docs/ — 索引";
				// The retry never carries tools, so it has to answer in the text shape.
				const { seen } = await pass(handle, (attempt) =>
					attempt === 1 ? truncated : { content: [{ type: "text", text: JSON.stringify({ memory_markdown: sectionsDoc, context: CONTEXT }) }], stopReason: "stop" },
				);
				check("a truncated tool call is retried", seen.length === 2);
				check("the retry does not carry tools", seen[1].tools === undefined);
				const written = await readFile(memoryFile(handle.root), "utf8");
				check("the truncated contents are not written", !written.includes("half written") && written.includes("Structured invariant"));
			} finally {
				await rmTemp(handle.root);
			}
		}

		// 7. A route that rejects `tools` falls back to the text entry and stays usable.
		{
			const handle = await project("structured-tools-rejected");
			try {
				const sectionsDoc = "# Project Memory\n\n## Project\n- Structured project line\n\n## Invariants\n- Structured invariant\n\n## Pitfalls\n\n## Index\n- docs/ — 索引";
				const { seen } = await pass(handle, (attempt) => {
					if (attempt === 1) throw new Error("tools are not supported by this endpoint");
					return { content: [{ type: "text", text: JSON.stringify({ memory_markdown: sectionsDoc, context: CONTEXT }) }], stopReason: "stop" };
				});
				check("a rejected tools call is retried without tools", seen.length === 2 && seen[1].tools === undefined);
				check("the fallback still writes the rendered sections", (await readFile(memoryFile(handle.root), "utf8")).includes("Structured invariant"));
			} finally {
				await rmTemp(handle.root);
			}
		}

		// 8. memory and context are validated apart: a broken context must not cost a good memory.
		{
			const handle = await project("structured-context-bad");
			try {
				await pass(handle, () => toolReply({ memory: SECTIONS, context: { summary: 42 } }));
				check("a valid memory survives an unusable context member", (await readFile(memoryFile(handle.root), "utf8")).includes("Structured invariant"));
				check("the unusable context is reported", (await errorLogText(handle.root)).includes("could not be used"));
			} finally {
				await rmTemp(handle.root);
			}
		}

		// 9. A heading-only reply on the opaque path must not replace a real memory with a skeleton.
		{
			const handle = await project("structured-skeleton");
			try {
				const before = "# Project Memory\n\n## Project\n- keep me.\n\n## Invariants\n- keep this too\n\n## Pitfalls\n\n## Index\n";
				await writeFile(memoryFile(handle.root), before);
				// A missing `## Index` keeps this off the section path; every line is a heading, so it carries
				// nothing and must not be written.
				const { toasts } = await pass(handle, () => ({
					content: [{ type: "text", text: "# Project Memory\n\n## Project\n\n## Invariants\n\n## Pitfalls\n" }],
					stopReason: "stop",
				}));
				check("a heading-only opaque reply leaves MEMORY.md byte-identical", (await readFile(memoryFile(handle.root), "utf8")) === before);
				check("the skeleton is reported, not silently accepted", (await errorLogText(handle.root)).includes("not a writable memory document"));
				check("the skeleton does not claim an update", !toasts.some((message) => /Memory: updated /.test(message)));
				check("the semantic-empty toast names the real reason", toasts.some((message) => message.includes("not a writable memory document")));
			} finally {
				await rmTemp(handle.root);
			}
		}

		// 10. A matched tool call with unreadable arguments and no text is an error, not an empty memory.
		{
			const handle = await project("structured-bad-tool-args");
			try {
				const before = "# Project Memory\n\n## Project\n- keep me.\n";
				await writeFile(memoryFile(handle.root), before);
				// `memory` is missing `index`, so the shape check fails; with no text there is nothing to fall
				// back to, and "" would otherwise read as an empty-but-successful reply.
				const { toasts } = await pass(handle, () => toolReply({ memory: { project: [], invariants: [], pitfalls: [] }, context: CONTEXT }));
				check("a malformed tool call leaves MEMORY.md untouched", (await readFile(memoryFile(handle.root), "utf8")) === before);
				check("a malformed tool call is reported as a failure", (await errorLogText(handle.root)).includes("unusable arguments and no text"));
				check("a malformed tool call is not reported as success", toasts.some((message) => message.includes("failed")));
			} finally {
				await rmTemp(handle.root);
			}
		}

		// 11. Prose wearing the document's own title is still prose: `# Project Memory` is what every
		// document opens with, so it cannot be the evidence that this reply is one. This is the shape of
		// the field case quoted in round 1 of this issue's review, which v0.4.7 accepted while logging
		// the guard's skip.
		{
			const handle = await project("structured-guard-opaque");
			try {
				const before = "# Project Memory\n\n## Project\n- p.\n\n## Invariants\n- an invariant\n\n## Pitfalls\n\n## Index\n- i\n";
				await writeFile(memoryFile(handle.root), before);
				const prose = "# Project Memory\n\nProject prose with no bullets at all, long enough to pass the length rule on its own.";
				await pass(handle, () => ({ content: [{ type: "text", text: prose }], stopReason: "stop" }));
				check("a titled prose reply leaves the stored memory byte-identical", (await readFile(memoryFile(handle.root), "utf8")) === before);
				check("a titled prose reply is reported as not writable", (await errorLogText(handle.root)).includes("not a writable memory document"));
				check("a titled prose reply is not reported as a guard skip", !(await errorLogText(handle.root)).includes("did not produce sections"));
			} finally {
				await rmTemp(handle.root);
			}
		}

		// 12. A fresh project has nothing to guard, so it must not log a skip on every pass.
		{
			const handle = await project("structured-guard-fresh");
			try {
				await pass(handle, () => ({ content: [{ type: "text", text: "# Project Memory\n\nFresh prose that is long enough to be written." }], stopReason: "stop" }));
				check("a fresh project logs no guard skip", !(await errorLogText(handle.root)).includes("guard skipped"));
			} finally {
				await rmTemp(handle.root);
			}
		}

		// 13. The other fence families are the same skeleton; they must be blocked too.
		{
			for (const [label, text] of [
				["an ```md fence", "```md\n# Project Memory\n\n## Project\n\n## Invariants\n\n## Pitfalls\n```"],
				["a ~~~ fence", "~~~\n# Project Memory\n\n## Project\n\n## Invariants\n~~~"],
				["a frontmatter delimiter", "---\n# Project Memory\n\n## Project\n\n## Invariants\n"],
			]) {
				const handle = await project(`structured-skeleton-${label.replace(/\W+/g, "")}`);
				try {
					const before = "# Project Memory\n\n## Project\n- keep me.\n";
					await writeFile(memoryFile(handle.root), before);
					await pass(handle, () => ({ content: [{ type: "text", text }], stopReason: "stop" }));
					check(`${label} leaves MEMORY.md byte-identical`, (await readFile(memoryFile(handle.root), "utf8")) === before);
				} finally {
					await rmTemp(handle.root);
				}
			}
		}

		// 14. The field case, byte for byte. At settle this reply was published as the whole document,
		// replacing a 29.9 KB four-section memory (v0.4.5 sandbox; the journal's 6th entry, quoted in
		// `shutdown-flush-review-round1-independent.txt` and in the review report's residual section).
		// It wears the canonical title and adds one conversational line, so it has no structure of its
		// own - and the title is what every document opens with, which is why v0.4.7's "no markdown
		// heading anywhere" test accepted the very shape it cites. The table adds the shapes round 14
		// asked for: the same line without a title, a `#.` pseudo-heading (the character class after `#`
		// is load-bearing) and the exact 40-character floor.
		{
			const FIELD_REPLY = "# Project Memory\n\nI'll review the frozen revision against the code, tests, and my own probes, then record the outcome.";
			const BOUNDARY_40 = "Plain prose with no bullet entry at all.";
			check("the boundary fixture is exactly 40 characters", BOUNDARY_40.length === 40);
			check("the field fixture keeps its canonical title", FIELD_REPLY.startsWith("# Project Memory\n\n"));
			for (const [name, label, reply] of [
				["field-title", "the field reply, with its canonical title", FIELD_REPLY],
				["field-bare", "the same line without a title", FIELD_REPLY.replace("# Project Memory\n\n", "")],
				["pseudo-heading", "a `#.` pseudo-heading plus prose", "#.Project\n\nProse that has no real heading and no bullet entry either."],
				["boundary-40", "a reply of exactly the 40-character floor", BOUNDARY_40],
			]) {
				const handle = await project(`structured-opaque-${name}`);
				try {
					const before = "# Project Memory\n\n## Project\n- keep me.\n\n## Invariants\n- and me.\n\n## Pitfalls\n- and this.\n\n## Index\n- and that.\n";
					await writeFile(memoryFile(handle.root), before);
					const replyJson = JSON.stringify({ memory_markdown: reply, context: CONTEXT });
					await pass(handle, () => ({ content: [{ type: "text", text: replyJson }], stopReason: "stop" }));
					check(`${label} leaves the stored memory byte-identical`, (await readFile(memoryFile(handle.root), "utf8")) === before);
					check(`${label} is reported as not writable`, (await errorLogText(handle.root)).includes("not a writable memory document"));
				} finally {
					await rmTemp(handle.root);
				}
			}
		}
		{
			const handle = await project("structured-opaque-document");
			try {
				const before = "# Project Memory\n\n## Project\n- keep me.\n";
				await writeFile(memoryFile(handle.root), before);
				// The fence skip must not close the door on a reply that carries a real section *and* a fenced
				// sample (round 22's positive control for `hasMemoryDocumentShape`).
				const document = JSON.stringify({ memory_markdown: "# Project Memory\n\n## Project\n- the re-emitted document.\n\n```\n## Invariants\n- a fenced sample, not an entry\n```\n", context: CONTEXT });
				await pass(handle, () => ({ content: [{ type: "text", text: document }], stopReason: "stop" }));
				check("an opaque reply that is a document is still accepted", (await readFile(memoryFile(handle.root), "utf8")).includes("the re-emitted document."))
				// The accepting path is where the guard's skip line belongs: it only runs when the pass
				// actually considered writing, and the refusal above skips before that point.
				check("the guard reports its skip on the accepting opaque path", (await errorLogText(handle.root)).includes("did not produce sections"));
			} finally {
				await rmTemp(handle.root);
			}
		}
		{
			// Round 15's R-A: the old "any heading / bullet / fence" test let a conversational reply with a
			// single bullet replace a whole memory. A reply counts as a document only when a heading carries
			// an entry under it, so every shape below is prose even though each one carries a marker.
			const before = "# Project Memory\n\n## Project\n- keep me.\n\n## Invariants\n- and me.\n\n## Pitfalls\n- and this.\n\n## Index\n- and that.\n";
			for (const [name, reply] of [
				["prose-bullet", "# Project Memory\n\nI'll do the following:\n- review\n- record"],
				["prose-star-bullet", "# Project Memory\n\nI'll do the following:\n* review"],
				["prose-plus-bullet", "# Project Memory\n\nHere is what I will do next:\n+ review the frozen revision"],
				["prose-fence", "# Project Memory\n\nI'll explain:\n```\nsome prose\n```"],
				["foreign-heading", "# Project Memory\n\n# My Notes\n\nA long sentence with no entry under a heading at all."],
				["prose-under-heading", "# Project Memory\n\n## Notes\n\nProse under a heading but still no entry."],
				// Round 19's B-1: the fence rules are CommonMark's, so a longer opener is only closed by an
				// equally long run and a closing fence may not carry an info string.
				["fence-longer-opener", "# Project Memory\n\n````\ncode\n```\n## Project\n- a sample entry here\n```\n"],
				["fence-info-string", "# Project Memory\n\n```\nprose\n```not-a-close\n## Project\n- a sample entry here\n"],
				["fence-tilde-opener", "# Project Memory\n\n~~~~\ncode\n~~~\n## Project\n- a sample entry here\n"],
				// Round 19's B-2: a bare separator is not a setext heading (nothing above it to underline).
				["bare-rule-dashes", "# Project Memory\n\n---\n- a sentence long enough to pass the floor\n"],
				["bare-rule-equals", "# Project Memory\n\n=\n- a sentence long enough to pass the floor\n"],
				["bare-rule-two-dashes", "# Project Memory\n\n--\n- a sentence long enough to pass the floor\n"],
				// Round 19's residual note: an indented `## Project` is an indented code block, not a heading.
				["indented-heading", "# Project Memory\n\n    ## Project\n    - a sample entry here\n"],
				["indented-heading-flush-entry", "# Project Memory\n\n    ## Project\n- an entry whose heading is an indented code block\n"],
				// Round 20: a blank line ends the setext candidate, an HTML heading must also start at column 0,
				// and a fence indented by up to three spaces is still a fence.
				["blank-then-bare-equals", "# Project Memory\n\nI reviewed the frozen revision and here is what I found.\n\n=\n- a sentence long enough to pass the forty character floor\n"],
				["indented-html-heading", "# Project Memory\n\n    <h2>Project</h2>\n- a sentence long enough to pass the forty character floor\n"],
				["indented-fence", "# Project Memory\n\nHere is a sample:\n ```\n## Project\n- a sample entry here\n ```\n"],
				// Round 21: the bridge to a bare `=` must not be a rule, quote, comment or code line, and a
				// fence can open inside a list item.
				["rule-before-equals", "# Project Memory\n\n---\n=\n- a sentence long enough to pass the floor\n"],
				["quote-before-equals", "# Project Memory\n\n> I reviewed the frozen revision.\n=\n- a sentence long enough to pass the floor\n"],
				["comment-before-equals", "# Project Memory\n\n<!-- note -->\n=\n- a sentence long enough to pass the floor\n"],
				["code-before-equals", "# Project Memory\n\n    code line\n=\n- a sentence long enough to pass the floor\n"],
				["fence-in-list-item", "# Project Memory\n\n## Project\n- ```\n  - a sample entry here\n  ```\n"],
				["fence-hiding-list-fence", "# Project Memory\n\nHere are my review notes for the frozen revision.\n\n```\n- ```\n## Project\n- the hidden fake entry\n```\n"],
				["entry-under-other-heading", "# Project Memory\n\n## Project\n# Notes\n- an entry that is not under a section\n"],
				["entry-under-title-again", "# Project Memory\n\n## Project\n# Project Memory\n- an entry under the document title\n"],
				["setext-between-entry", "# Project Memory\n\n## Project\n\nNotes from the review\n=====================\n- an entry under a setext heading\n"],
				["html-between-entry", "# Project Memory\n\n## Project\n<h2>Notes</h2>\n- an entry under an HTML heading\n"],
				["quoted-pseudo-document", "# Project Memory\n\nHere is a sample:\n> ```\n> ## Project\n> - a hidden entry\n> ```\n"],
				["nested-list-fence", "# Project Memory\n\n## Project\n- - ```\n  - a hidden entry\n  ```\n"],
			]) {
				const handle = await project(`structured-prose-${name}`);
				try {
					await writeFile(memoryFile(handle.root), before);
					const replyJson = JSON.stringify({ memory_markdown: reply, context: CONTEXT });
					await pass(handle, () => ({ content: [{ type: "text", text: replyJson }], stopReason: "stop" }));
					check(`${name} leaves the stored memory byte-identical`, (await readFile(memoryFile(handle.root), "utf8")) === before);
					check(`${name} is reported as not writable`, (await errorLogText(handle.root)).includes("not a writable memory document"));
				} finally {
					await rmTemp(handle.root);
				}
			}
		}
		{
			// Round 18's I-2: the scan tracks fences, so a code block that merely *contains* a heading and an
			// entry is prose - the previous regex would have read straight through the fence and published it.
			const before = "# Project Memory\n\n## Project\n- keep me.\n\n## Invariants\n- and me.\n\n## Pitfalls\n- and this.\n\n## Index\n- and that.\n";
			const handle = await project("structured-prose-fenced-document");
			try {
				await writeFile(memoryFile(handle.root), before);
				const reply = "# Project Memory\n\nHere is a sample of what I saw:\n```\n## Project\n- a sample entry\n```\n";
				await pass(handle, () => ({ content: [{ type: "text", text: JSON.stringify({ memory_markdown: reply, context: CONTEXT }) }], stopReason: "stop" }));
				check("a fenced pseudo-document is not a document", (await readFile(memoryFile(handle.root), "utf8")) === before);
			} finally {
				await rmTemp(handle.root);
			}
		}
		{
			// Round 22's route decision (owner-visible in the review report): the acceptance face is this
			// extension's own shape and nothing wider, so a reply that reaches its entries through a numbered
			// list, a setext heading or an HTML heading is *not* a writable document. Round 18's I-3 asked for
			// these to be published while the gate was a hand-rolled markdown subset; the four rounds since
			// each found another fail-open in that subset, so the refusal is now deliberate: the memory is
			// kept, the reply never overwrites it, and the diagnostic names the shape. Safe direction, and
			// the shapes below are ones this extension never writes.
			for (const [name, reply] of [
				["numbered", "# Project Memory\n\n## Project\n1. numbered entry that must be refused\n"],
				["setext", "# Project Memory\n\nProject\n=======\n- setext entry that must be refused\n"],
				["html", "# Project Memory\n\n<h2>Project</h2>\n- html entry that must be refused\n"],
				["html-trailing-space", "# Project Memory\n\n<h2>Project</h2> \n- html entry that must be refused\n"],
				["star-entry", "# Project Memory\n\n## Project\n* star entry that must be refused\n"],
				["indented-entry", "# Project Memory\n\n## Project\n  - indented entry that must be refused\n"],
				["unknown-section", "# Project Memory\n\n## Notes\n- entry under an unknown section\n"],
			]) {
				const handle = await project(`structured-prose-reverse-${name}`);
				try {
					const before = "# Project Memory\n\n## Project\n- keep me.\n\n## Invariants\n- and me.\n\n## Pitfalls\n- and this.\n\n## Index\n- and that.\n";
					await writeFile(memoryFile(handle.root), before);
					await pass(handle, () => ({ content: [{ type: "text", text: JSON.stringify({ memory_markdown: reply, context: CONTEXT }) }], stopReason: "stop" }));
					check(`${name} is refused, not published`, (await readFile(memoryFile(handle.root), "utf8")) === before);
					check(`${name} says why it was refused`, (await errorLogText(handle.root)).includes("not a writable memory document"));
				} finally {
					await rmTemp(handle.root);
				}
			}
		}
		{
			// The stored side of the same guard (the R-F2 cousin): a hand-written non-canonical memory is a
			// document too - the field's six-section file is exactly this shape - so prose must not replace
			// it either. Only a store below the floor (a fresh project, pinned above) stays open.
			const handle = await project("structured-prose-noncanonical");
			try {
				const sixSections = "# Project Memory\n\n## 权威文档\n- a\n\n## 不变量\n- b\n\n## 归属边界\n- c\n\n## 当前状态\n- d\n\n## 操作陷阱\n- e\n";
				await writeFile(memoryFile(handle.root), sixSections);
				const reply = JSON.stringify({ memory_markdown: "# Project Memory\n\nI'll review the frozen revision against the code and record the outcome.", context: CONTEXT });
				await pass(handle, () => ({ content: [{ type: "text", text: reply }], stopReason: "stop" }));
				check("a non-canonical stored memory is protected too", (await readFile(memoryFile(handle.root), "utf8")) === sixSections);
			} finally {
				await rmTemp(handle.root);
			}
		}

		{
			// 15. The other side of the same floor: below 40 characters the write is blocked by the length
			// rule in report.ts instead, so the memory is kept and the toast names the real reason.
			const BOUNDARY_39 = "Plain prose with no bullet entry at all";
			check("the 39-character fixture is exactly one short of the floor", BOUNDARY_39.length === 39);
			const handle = await project("structured-opaque-39");
			try {
				const before = "# Project Memory\n\n## Project\n- keep me.\n";
				await writeFile(memoryFile(handle.root), before);
				const reply = JSON.stringify({ memory_markdown: BOUNDARY_39, context: CONTEXT });
				const { toasts } = await pass(handle, () => ({ content: [{ type: "text", text: reply }], stopReason: "stop" }));
				check("the 39-character reply leaves the memory alone", (await readFile(memoryFile(handle.root), "utf8")) === before);
				check("the 39-character reply names the length rule, not emptiness", toasts.some((message) => message.includes("too short to be a change")));
			} finally {
				await rmTemp(handle.root);
			}
		}
		{
			// 16. A fresh project has nothing to lose, so the refusal must not block the first memory:
			// that is what `storedSections !== undefined` buys, and this pins it.
			const handle = await project("structured-opaque-fresh");
			try {
				const reply = JSON.stringify({ memory_markdown: "# Project Memory\n\nFresh prose that is long enough to be written.", context: CONTEXT });
				await pass(handle, () => ({ content: [{ type: "text", text: reply }], stopReason: "stop" }));
				check("a fresh project still writes its first memory from an opaque reply", (await readFile(memoryFile(handle.root), "utf8").catch(() => "")).includes("Fresh prose"));
			} finally {
				await rmTemp(handle.root);
			}
		}

		// 17. A reply too short to be a change must not claim a write either — and must not claim the
		// wrong reason: a short reply did carry text, so the emptiness wording would be false.
		{
			const handle = await project("structured-short-opaque");
			try {
				const before = "# Project Memory\n\n## Project\n- keep me.\n";
				await writeFile(memoryFile(handle.root), before);
				const { toasts } = await pass(handle, () => ({ content: [{ type: "text", text: JSON.stringify({ memory_markdown: "Short note.", context: CONTEXT }) }], stopReason: "stop" }));
				check("a too-short reply leaves MEMORY.md byte-identical", (await readFile(memoryFile(handle.root), "utf8")) === before);
				check("a too-short reply does not claim a memory update", !toasts.some((message) => /Memory: (updated|were updated)/.test(message)));
				check("a too-short reply says the memory was kept", toasts.some((message) => message.includes("memory was kept unchanged")));
				// The reply DID carry text, so the semantic-empty wording would be a false cause. Assert on the
				// toast, which is where the reply lands: the handler returns nothing.
				check("the short-reply toast names the real reason, not emptiness", toasts.some((message) => message.includes("too short to be a change")) && !toasts.some((message) => message.includes("carried no entries")));
			} finally {
				await rmTemp(handle.root);
			}
		}

		// 18. A condensation reply that is a DECORATED skeleton must not be adopted over the first,
		// real result: adopting it stored 91 bytes of headings and dropped everything the model wrote.
		{
			const handle = await project("structured-condense-decorated", { maxMemoryChars: 4000 });
			try {
				const real = `# Memory\n\n${Array.from({ length: 200 }, (_, index) => `- durable fact number ${index} that takes up room\n`).join("")}`;
				const decoratedSkeleton = "- # Project Memory\n- ## Project\n- ## Invariants\n- ## Pitfalls\n- ## Index\n";
				const { seen } = await pass(handle, (attempt) => ({
					content: [{ type: "text", text: JSON.stringify({ memory_markdown: attempt === 1 ? real : decoratedSkeleton, context: CONTEXT }) }],
					stopReason: "stop",
				}));
				const written = await readFile(memoryFile(handle.root), "utf8");
				check("the over-cap first result really triggered the condensation call", seen.length === 2);
				check("a decorated skeleton is not adopted as the condensed memory", !/^-\s*#\s*Project Memory/m.test(written));
				check("the first result's content is what stands", written.includes("durable fact number"));
			} finally {
				await rmTemp(handle.root);
			}
		}
	}
	console.log("\n=== shutdown fallback: which root may take the error log ===");
	// The handler's catch only runs when something escapes the pass, which no mock can make happen, so the
	// decision itself is pinned directly: `shutdownErrorRoot` is the whole of the fallback, and the
	// `.agents/memory` precision (not `.agents`) is exactly what a one-sided mutation would break.
	const { shutdownErrorRoot } = await loadNamespace(`${PC}/memory/report.ts`);
	const agentsOnly = await mkdtemp(path.join(os.tmpdir(), "pi-shutdown-root-"));
	try {
		await mkdir(path.join(agentsOnly, ".agents"), { recursive: true });
		check("a known project root is used as-is", shutdownErrorRoot("/somewhere", agentsOnly) === "/somewhere");
		check("a cwd that only has .agents is not the memory layer", shutdownErrorRoot(undefined, agentsOnly) === undefined);
		await mkdir(path.join(agentsOnly, ".agents", "memory"), { recursive: true });
		check("a cwd that already carries the memory layer takes the log", shutdownErrorRoot(undefined, agentsOnly) === agentsOnly);
	} finally {
		await rmTemp(agentsOnly);
	}
	console.log("\n=== the exit flushes without a model call (decision 1) ===");
	{
		const flushTmp = await mkdtemp(path.join(os.tmpdir(), "pi-shutdown-flush-"));
		try {
			const flushMem = path.join(flushTmp, ".agents/memory");
			await mkdir(flushMem, { recursive: true });
			const flushFactory = await loadDefault(`${PC}/index.ts`);
			const flushPi = makePi({ cwd: flushTmp });
			await flushFactory(flushPi);
			let flushCalls = 0;
			// Any call after the seeding pass is a regression: that reply would replace the whole render,
			// so its marker is what "the exit composed nothing" looks for.
			const exitReply = "PUBLISHED-AT-EXIT-9083";
			const flushEntries = Array.from({ length: 6 }, (_, index) =>
				messageEntry(`f${index}`, "user", `${marker} turn ${index}`, `2026-09-12T10:0${index}:00.000Z`));
			const flushCtx = makeCtx(flushTmp, {
				sessionManager: makeSessionManager(flushEntries, "flush-session"),
				modelRegistry: {
					hasConfiguredAuth: () => true,
					complete: async () => {
						flushCalls += 1;
						const body = flushCalls === 1
							? "# Project Memory\n\n## Project\n- Seeded before the exit."
							: `# Project Memory\n\n## Project\n- ${exitReply}`;
						return {
							content: [{
								type: "text",
								text: JSON.stringify({
									memory_markdown: body,
									context: { title: "Flush", summary: "Seeded.", key_points: [], open_tasks: [] },
								}),
							}],
						};
					},
				},
			});
			await consolidateNow(flushPi, flushCtx);
			const seededCalls = flushCalls;
			const seededJournal = await readFile(path.join(flushMem, "memory.jsonl"), "utf8");
			check("the seeding pass wrote a journal entry and a render", seededJournal.includes("Seeded before the exit.") && seededCalls === 1);

			// A hand edit newer than the journal: the exit must fold it in, compose nothing, call no model.
			const handEdit = `${(await readFile(path.join(flushMem, "MEMORY.md"), "utf8")).trimEnd()}\n- Hand-curated at exit.\n`;
			await writeFile(path.join(flushMem, "MEMORY.md"), handEdit);
			const newer = new Date(Date.now() + 5_000);
			await utimes(path.join(flushMem, "MEMORY.md"), newer, newer);

			// Past forceDedupeMs (15s): a shutdown that still ran a forced pass would reach the model for
			// real instead of being deduped against the seeding pass, so the counter below can go red.
			const realNow = Date.now;
			Date.now = () => realNow() + 60_000;
			try {
				await runHandlers(flushPi, "session_shutdown", flushCtx);
			} finally {
				Date.now = realNow;
			}

			check("the exit made no model call", flushCalls === seededCalls);
			const flushJournal = await readFile(path.join(flushMem, "memory.jsonl"), "utf8");
			check("the hand edit was adopted into the journal", flushJournal.includes("Hand-curated at exit.") && flushJournal.length > seededJournal.length);
			const flushed = await readFile(path.join(flushMem, "MEMORY.md"), "utf8");
			check("the file still carries the hand edit", flushed.includes("Hand-curated at exit."));
			const flushErrors = await readFile(path.join(flushMem, "errors.log"), "utf8").catch(() => "");
			check("the adoption left a trace", flushErrors.includes("adopted an externally edited MEMORY.md"));
			// The trade decision 1 accepts: a tail no settle pass reached stays out of the memory document.
			check("the exit composed nothing", !flushed.includes(marker) && !flushed.includes(exitReply));
			const archivedTail = await readFile(path.join(flushMem, "session-logs/flush-session/session.jsonl"), "utf8").catch(() => "");
			check("the tail is in the archive", archivedTail.includes(marker));

			// The render write-back, which this test left unpinned at first: a missing or stale render is
			// republished from the journal (remove that write and these four checks go red).
			const journalBeforeRebuild = (await readFile(path.join(flushMem, "memory.jsonl"), "utf8")).length;
			await rm(path.join(flushMem, "MEMORY.md"));
			await runHandlers(flushPi, "session_shutdown", flushCtx);
			const rebuilt = await readFile(path.join(flushMem, "MEMORY.md"), "utf8").catch(() => "");
			check("the exit republishes a missing render", rebuilt.includes("Hand-curated at exit.") && !rebuilt.includes(exitReply));
			check("republishing a missing render does not append to the journal", (await readFile(path.join(flushMem, "memory.jsonl"), "utf8")).length === journalBeforeRebuild);

			// Older than the journal and different: a torn window, or a render left by an older build.
			await writeFile(path.join(flushMem, "MEMORY.md"), "# Project Memory\n\n## Project\n- Stale render.\n");
			const stale = new Date(Date.now() - 60_000);
			await utimes(path.join(flushMem, "MEMORY.md"), stale, stale);
			await runHandlers(flushPi, "session_shutdown", flushCtx);
			const refreshed = await readFile(path.join(flushMem, "MEMORY.md"), "utf8").catch(() => "");
			check("the exit replaces a stale render with the journal's fold", !refreshed.includes("Stale render.") && refreshed.includes("Hand-curated at exit."));
			check("replacing a render backs it up first", (await readdir(flushMem)).some((name) => name.startsWith("MEMORY.md.memory-backup-")));

			// The race no ordinary fixture can produce, made deterministic by a FIFO: the writer hands the reader
			// the old bytes, and by the time the read returns the path already holds the replacement. Without the
			// consistent read the adopt journals the old key, the journal's mtime jumps past the new file, and the
			// flush then publishes the fold over it - the newer edit survives in neither place.
			const raceRoot = path.join(flushTmp, "race");
			const raceMem = path.join(raceRoot, ".agents/memory");
			await mkdir(raceMem, { recursive: true });
			await writeFile(path.join(raceMem, "memory.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), op: "replace", text: "# Project Memory\n\n## Project\n- Journal seed before the race.\n" })}\n`);
			const racePast = new Date(Date.now() - 60_000);
			await utimes(path.join(raceMem, "memory.jsonl"), racePast, racePast);
			const raceFile = path.join(raceMem, "MEMORY.md");
			execFileSync("mkfifo", [raceFile]);
			const { flushMemoryRender } = await loadNamespace(`${PC}/shared/project-state.ts`);
			const flushing = flushMemoryRender(raceRoot, 32000);
			// A blocking "w" is what makes this fixture deterministic: the write end only returns once the reader
			// holds the FIFO open, so the reader is guaranteed to take the older bytes below and only then stat
			// the replacement. The watchdog is the failure path - a missing reader would block the open forever,
			// a Promise.race cannot cancel it, and process.exit() does not end a process whose threadpool is
			// stuck in that open (measured) - so the timer uses the one signal that cannot be deferred.
			const watchdog = setTimeout(() => {
				console.error("FAIL race: the FIFO fixture never got a reader, or the flush never returned, within 30s");
				// SIGKILL cannot run the fixture's `finally`, so a failed run used to leave this tree behind
				// (~40 KB per occurrence). Clear it here, synchronously, before the signal that cannot be deferred.
				// Only this FIFO subtree: the fixture's memory artifacts live in `flushMem`, next to it, and
				// they are what a failure needs to stay diagnosable (rounds 18 N-1 / 19 N-3).
				execFileSync("rm", ["-rf", path.join(flushTmp, "race")]);
				process.kill(process.pid, "SIGKILL");
			}, 30_000);
			const fifoWriter = await open(raceFile, "w");
			await fifoWriter.writeFile("# Project Memory\n\n## Project\n- Older bytes handed to the reader.\n");
			await rm(raceFile);
			await writeFile(raceFile, "# Project Memory\n\n## Project\n- Replacement that must survive.\n");
			await fifoWriter.close();
			const raced = await flushing;
			clearTimeout(watchdog);
			check("race: the exit keeps the render and reports no write", raced?.written === false && raced?.adopted === true);
			// Self-check that the fixture really staged the replacement under the read: without it a fixture that
			// stops racing (a non-blocking open, a reader that starts late) would silently keep every assertion green.
			const raceErrors = await readFile(path.join(raceMem, "errors.log"), "utf8").catch(() => "");
			check("race: the fixture really replaced the file under the read", raceErrors.includes("a newer external edit arrived before the memory journal could record one"));
			const raceJournal = await readFile(path.join(raceMem, "memory.jsonl"), "utf8");
			check("race: the journal holds the replacement, not the older bytes", raceJournal.includes("Replacement that must survive.") && !raceJournal.includes("Older bytes handed to the reader."));
			check("race: the replacement is still the file's content", (await readFile(raceFile, "utf8")).includes("Replacement that must survive."));

			// Residual R-L1: the pure-read path must not pair an older render's bytes with a newer stat. The same
			// FIFO trick drives it - `loadMemory` reads while the path is replaced underneath - and the two possible
			// outcomes differ: pairing bytes with a separately taken stat adopts the older bytes, the consistent
			// read declines and lets the journal's fold stand. A stable file then proves adoption still happens.
			const adoptRoot = path.join(flushTmp, "adopt");
			const adoptMem = path.join(adoptRoot, ".agents/memory");
			await mkdir(adoptMem, { recursive: true });
			await writeFile(path.join(adoptMem, "memory.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), op: "replace", text: "# Project Memory\n\n## Project\n- Journal seed for the read race.\n" })}\n`);
			const adoptPast = new Date(Date.now() - 60_000);
			await utimes(path.join(adoptMem, "memory.jsonl"), adoptPast, adoptPast);
			const adoptFile = path.join(adoptMem, "MEMORY.md");
			execFileSync("mkfifo", [adoptFile]);
			const { loadMemory } = await loadNamespace(`${PC}/shared/project-state.ts`);
			const adopting = loadMemory(adoptRoot, 32000);
			const adoptWatchdog = setTimeout(() => {
				console.error("FAIL adopt: the FIFO fixture never got a reader within 30s");
				// SIGKILL cannot run the fixture's `finally`, so a failed run used to leave this tree behind
				// (~40 KB per occurrence). Clear it here, synchronously, before the signal that cannot be deferred.
				// Only the FIFO tree: the fixture's memory artifacts (and its errors.log) are what a
				// failure needs to be diagnosable, so they stay (round 18 N-1).
				execFileSync("rm", ["-rf", path.join(flushTmp, "adopt")]);
				process.kill(process.pid, "SIGKILL");
			}, 30_000);
			const adoptWriter = await open(adoptFile, "w");
			await adoptWriter.writeFile("# Project Memory\n\n## Project\n- Older bytes the read must not adopt.\n");
			await rm(adoptFile);
			await writeFile(adoptFile, "# Project Memory\n\n## Project\n- External edit newer than the journal.\n");
			await adoptWriter.close();
			const adopted = await adopting;
			clearTimeout(adoptWatchdog);
			check("read race: the journal's fold stands instead of the older bytes", adopted.source.endsWith("memory.jsonl") && adopted.text.includes("Journal seed") && !adopted.text.includes("Older bytes"));
			check("read race: the file really was replaced under the read", (await readFile(adoptFile, "utf8")).includes("External edit newer than the journal."));
			const stable = await loadMemory(adoptRoot, 32000);
			check("read race: a stable newer render is still adopted", stable.source.endsWith("MEMORY.md") && stable.text.includes("External edit newer than the journal."));

			// The borrowed-key path on a stable file: the key the write pass read before its model call can be
			// stale by the time the append runs. Journalling it would push the journal past the replacement and
			// shadow it, so a stale key has to be refused while the file's current key is still accepted.
			const borrowRoot = path.join(flushTmp, "borrow");
			const borrowMem = path.join(borrowRoot, ".agents/memory");
			await mkdir(borrowMem, { recursive: true });
			const borrowJournal = `${JSON.stringify({ ts: new Date().toISOString(), op: "replace", text: "# Project Memory\n\n## Project\n- Journal seed before the borrowed key.\n" })}\n`;
			await writeFile(path.join(borrowMem, "memory.jsonl"), borrowJournal);
			const borrowPast = new Date(Date.now() - 60_000);
			await utimes(path.join(borrowMem, "memory.jsonl"), borrowPast, borrowPast);
			const borrowFile = path.join(borrowMem, "MEMORY.md");
			const borrowText = "# Project Memory\n\n## Project\n- Replacement the borrowed key must not shadow.\n";
			await writeFile(borrowFile, borrowText);
			const { adoptExternalEdit, renderKeyOf } = await loadNamespace(`${PC}/memory/store.ts`);
			const staleAdopt = await adoptExternalEdit(borrowRoot, 32000, { renderKey: renderKeyOf("# Project Memory\n\n## Project\n- The bytes the caller read before the model call.\n", 32000) });
			check("borrowed key: a stale key is refused", staleAdopt === false);
			check("borrowed key: the journal was left alone", (await readFile(path.join(borrowMem, "memory.jsonl"), "utf8")) === borrowJournal);
			check("borrowed key: the replacement is still the file's content", (await readFile(borrowFile, "utf8")) === borrowText);
			const freshAdopt = await adoptExternalEdit(borrowRoot, 32000, { renderKey: renderKeyOf(borrowText, 32000) });
			check("borrowed key: the file's current key is still accepted", freshAdopt === true && (await readFile(path.join(borrowMem, "memory.jsonl"), "utf8")).includes("Replacement the borrowed key must not shadow."));
		} finally {
			await rmTemp(flushTmp);
		}
	}

	console.log("\n=== a stale ctx must not reject the exit handler, and a journal-less project stays untouched ===");
	{
		// decision 1 removed the model call, but the handler still reads ctx.cwd: a session replaced or
		// reloaded under it throws straight out of that getter, and a catch that read it again would
		// reject into pi's ExtensionRunner - the very chain this change was made to close.
		const staleTmp = await mkdtemp(path.join(os.tmpdir(), "pi-shutdown-stale-ctx-"));
		try {
			const staleFactory = await loadDefault(`${PC}/index.ts`);
			const stalePi = makePi({ cwd: staleTmp });
			await staleFactory(stalePi);
			const ctxFor = () => makeCtx(staleTmp, {
				sessionManager: makeSessionManager([messageEntry("s0", "user", "hello", "2026-09-12T12:00:00.000Z")], "stale-session"),
			});
			// A project that never used memory: the archive layer's own lock makes the directory, but the flush
			// must add nothing to it and must not take the memory lock (it used to, up to 5s, on every exit).
			const freshProbe = path.join(staleTmp, "fresh");
			await mkdir(freshProbe, { recursive: true });
			const { flushMemoryRender } = await loadNamespace(`${PC}/shared/project-state.ts`);
			const flushedFresh = await flushMemoryRender(freshProbe, 32000);
			check("a journal-less project flushes to nothing", flushedFresh.adopted === false && flushedFresh.written === false);
			check("a journal-less project gains no memory state", !(await stat(path.join(freshProbe, ".agents/memory/.gitignore")).catch(() => undefined))
				&& !(await stat(path.join(freshProbe, ".agents/memory/memory.jsonl")).catch(() => undefined)));

			const memoryHandler = (stalePi.handlers.get("session_shutdown") ?? []).find((handler) => handler.toString().includes("shutdown:flush"));
			check("the memory handler is registered on session_shutdown", Boolean(memoryHandler));
			const staleCtx = ctxFor();
			Object.defineProperty(staleCtx, "cwd", { get() { throw new Error("ctx.cwd: session replaced"); } });
			let rejected = false;
			await memoryHandler({}, staleCtx).catch(() => { rejected = true; });
			check("the memory exit handler does not reject when ctx.cwd throws", !rejected);
		} finally {
			await rmTemp(staleTmp);
		}
	}

	console.log("\n=== the exit flush is gated, and a damaged journal leaves a trace ===");
	{
		const gateTmp = await mkdtemp(path.join(os.tmpdir(), "pi-shutdown-gate-"));
		try {
			const gateMem = path.join(gateTmp, ".agents/memory");
			await mkdir(gateMem, { recursive: true });
			const gateFactory = await loadDefault(`${PC}/index.ts`);
			const gatePi = makePi({ cwd: gateTmp });
			await gateFactory(gatePi);
			const gateEntries = Array.from({ length: 6 }, (_, index) =>
				messageEntry(`g${index}`, "user", `${marker} gate ${index}`, `2026-09-12T13:0${index}:00.000Z`));
			const gateCtx = makeCtx(gateTmp, {
				sessionManager: makeSessionManager(gateEntries, "gate-session"),
				modelRegistry: {
					hasConfiguredAuth: () => true,
					complete: async () => ({
						content: [{
							type: "text",
							text: JSON.stringify({
								memory_markdown: "# Project Memory\n\n## Project\n- Gate seeded.",
								context: { title: "Gate", summary: "Gate.", key_points: [], open_tasks: [] },
							}),
						}],
					}),
				},
			});
			await consolidateNow(gatePi, gateCtx);

			// A hand edit newer than the journal, then memory off: the exit must leave both alone.
			const seededGate = await readFile(path.join(gateMem, "MEMORY.md"), "utf8");
			await writeFile(path.join(gateMem, "MEMORY.md"), `${seededGate.trimEnd()}\n- Written while memory was on.\n`);
			const newerGate = new Date(Date.now() + 5_000);
			await utimes(path.join(gateMem, "MEMORY.md"), newerGate, newerGate);
			const journalBeforeOff = await readFile(path.join(gateMem, "memory.jsonl"), "utf8");
			await gatePi.commands.get("memory").handler("off", gateCtx);
			await runHandlers(gatePi, "session_shutdown", gateCtx);
			check("memory off: the exit leaves the journal alone", (await readFile(path.join(gateMem, "memory.jsonl"), "utf8")) === journalBeforeOff);
			check("memory off: the exit leaves the hand edit in place", (await readFile(path.join(gateMem, "MEMORY.md"), "utf8")).includes("Written while memory was on."));

			// A journal with nothing readable: the flush must report the state, not no-op silently.
			const damagedMem = path.join(gateTmp, "damaged/.agents/memory");
			await mkdir(damagedMem, { recursive: true });
			await writeFile(path.join(damagedMem, "memory.jsonl"), "not json at all\n{\"op\":\"replace\"}\n");
			const { flushMemoryRender } = await loadNamespace(`${PC}/shared/project-state.ts`);
			const damaged = await flushMemoryRender(path.join(gateTmp, "damaged"), 32000);
			check("a fully damaged journal flushes to nothing", damaged.written === false && damaged.adopted === false);
			check("a fully damaged journal leaves a trace", (await readFile(path.join(damagedMem, "errors.log"), "utf8").catch(() => "")).includes("holds no readable entry"));

			// The write-back decision as a pure table: each ordering a concurrent writer can produce, plus the
			// boundary inputs (a render or journal whose stat failed), without needing to inject a race.
			// `keep` is the branch a render newer than the journal lands in.
			const { flushActionFor } = await loadNamespace(`${PC}/memory/store.ts`);
			check("flush decision: the file already carries the fold", flushActionFor("A", 20, 10, "A", false) === "none");
			check("flush decision: a missing render publishes the fold", flushActionFor("", undefined, 10, "F", false) === "publish");
			check("flush decision: a render newer than the journal is kept", flushActionFor("A", 20, 10, "F", false) === "keep");
			check("flush decision: an equal mtime is not newer, so the fold wins", flushActionFor("A", 10, 10, "F", false) === "publish");
			check("flush decision: an older render is superseded", flushActionFor("A", 5, 10, "F", false) === "publish");
			check("flush decision: a render that changed under the read is left alone", flushActionFor("A", 20, 10, "F", true) === "recheck");
			check("flush decision: a changed file with nothing to publish is still left alone", flushActionFor("A", 20, 10, "A", true) === "recheck");
			check("flush decision: an unstatable render is not treated as new", flushActionFor("A", undefined, 10, "F", false) === "publish");
			check("flush decision: an unstatable journal is not treated as old", flushActionFor("A", 20, undefined, "F", false) === "publish");
			check("flush decision: a key with no file behind it still publishes", flushActionFor("", 20, 10, "F", false) === "publish");
		} finally {
			await rmTemp(gateTmp);
		}
	}

	console.log("\n=== the settle pass is still the automatic writer ===");
	{
		// Decision 1 rests on this: with the exit no longer composing, the throttled settle pass is what
		// updates the memory during a session. Without this pin, "the exit is the only writer" would pass.
		const settleTmp = await mkdtemp(path.join(os.tmpdir(), "pi-settle-writes-"));
		try {
			const settleMem = path.join(settleTmp, ".agents/memory");
			await mkdir(settleMem, { recursive: true });
			const settleFactory = await loadDefault(`${PC}/index.ts`);
			const settlePi = makePi({ cwd: settleTmp });
			await settleFactory(settlePi);
			const settleEntries = Array.from({ length: 6 }, (_, index) =>
				messageEntry(`s${index}`, "user", `settle turn ${index}`, `2026-09-12T11:0${index}:00.000Z`));
			const settleCtx = makeCtx(settleTmp, {
				sessionManager: makeSessionManager(settleEntries, "settle-session"),
				modelRegistry: {
					hasConfiguredAuth: () => true,
					complete: async () => ({
						content: [{
							type: "text",
							text: JSON.stringify({
								memory_markdown: "# Project Memory\n\n## Project\n- The settle pass wrote this.",
								context: { title: "Settle", summary: "Settle wrote.", key_points: [], open_tasks: [] },
							}),
						}],
					}),
				},
			});
			// `agent_settled` fires and forgets, so wait for the write instead of assuming it landed.
			await runHandlers(settlePi, "agent_settled", settleCtx);
			const settleWritten = await waitUntil(async () => (await readFile(path.join(settleMem, "MEMORY.md"), "utf8").catch(() => "")).includes("The settle pass wrote this"), 3_000);
			check("a settle pass with the throttle satisfied still writes the memory", settleWritten);
			const settleContext = await readFile(path.join(settleMem, "CONTEXT.md"), "utf8").catch(() => "");
			check("the settle pass still writes CONTEXT.md", settleContext.includes("Settle wrote."));
		} finally {
			await rmTemp(settleTmp);
		}
	}

} finally {
	await rmTemp(tmp);
}

console.log(failures === 0 ? "\nALL OK" : `\nFAILURES: ${failures}`);
if (failures > 0) process.exitCode = 1;
