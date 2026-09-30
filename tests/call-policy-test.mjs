import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadDefault, loadNamespace, makeCtx, makePi, makeSessionManager, messageEntry, PC, runHandlers, waitUntil } from "./harness.mjs";

/**
 * Auxiliary-call failure policy: classification, the per-project cooldown, and the wiring that
 * stops a failing pass from retrying on every settle. The autolearn burst (one provider outage →
 * a call per agent_settled) and the repeated memory toasts are the behaviors under test.
 */

const tmpDirs = [];
let failures = 0;
function check(label, value) {
	console.log(`${value ? "OK  " : "FAIL"} ${label}`);
	if (!value) failures += 1;
}

/** A clock the tests advance on purpose; the extension reads the same `Date.now`. */
const realNow = Date.now;
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;

try {
	console.log("=== classification ===");
	const policy = await loadNamespace(`${PC}/shared/call-policy.ts`);
	check("402 insufficient balance is quota", policy.classifyModelFailure(new Error("model call error: 402: Insufficient Balance")) === "quota");
	check("429 usage limit is quota", policy.classifyModelFailure(new Error("model call error: 429: You've reached your 5-hour usage limit")) === "quota");
	check("403 authentication is auth", policy.classifyModelFailure(new Error("model call error: 403: Authentication failed. Please check your credentials.")) === "auth");
	check("connection error is transient", policy.classifyModelFailure(new Error("model call error: Connection error.")) === "transient");
	check("request timeout is transient", policy.classifyModelFailure(new Error("model call error: Request timed out.")) === "transient");
	check("a refused JSON reply is shape, not an outage", policy.classifyModelFailure(new Error("consolidation reply was not a usable JSON object\n{...}")) === "shape");
	check("an unknown message is other", policy.classifyModelFailure(new Error("something else")) === "other");

	console.log("\n=== cooldown, backoff and the session park ===");
	{
		const root = "/tmp/call-policy-unit";
		const first = policy.noteModelFailure("memory", root, new Error("Connection error."));
		check("the first transient failure is the one surfaced", first.failures === 1 && first.firstSinceSuccess === true);
		check("the first transient cooldown is the base", first.cooldownMs === policy.TRANSIENT_BASE_COOLDOWN_MS);
		const second = policy.noteModelFailure("memory", root, new Error("Connection error."));
		check("a consecutive transient failure doubles the cooldown", second.cooldownMs === policy.TRANSIENT_BASE_COOLDOWN_MS * 2 && second.firstSinceSuccess === false);
		check("the pass is parked while the cooldown runs", policy.modelBlocked("memory", root) === true);
		clockOffset = second.cooldownMs + 1;
		check("the park lifts when the cooldown elapses", policy.modelBlocked("memory", root) === false);
		clockOffset = 0;
		// A high failure count still caps, instead of parking for days.
		for (let i = 0; i < 20; i += 1) policy.noteModelFailure("capped", root, new Error("Connection error."));
		check("the transient cooldown has a ceiling", policy.modelCooldownRemaining("capped", root) <= policy.TRANSIENT_MAX_COOLDOWN_MS);
		check("repeated provider failures disable the automatic pass", policy.modelAutoDisabled("capped", root) === true && policy.modelBlocked("capped", root) === true);
		policy.noteModelSuccess("capped", root);
		check("a success clears the episode and the park", policy.modelBlocked("capped", root) === false && policy.modelAutoDisabled("capped", root) === false);

		const auth = policy.noteModelFailure("auth-scope", root, new Error("403: Authentication failed"));
		check("auth parks for the auth cooldown", auth.cooldownMs === policy.AUTH_COOLDOWN_MS);
		const quota = policy.noteModelFailure("quota-scope", root, new Error("429: usage limit"));
		check("quota parks for the quota cooldown", quota.cooldownMs === policy.QUOTA_COOLDOWN_MS);
		const shape = policy.noteModelFailure("shape-scope", root, new Error("not a usable JSON object"));
		check("a shape failure does not park a healthy route", shape.cooldownMs === 0 && policy.modelBlocked("shape-scope", root) === false);
	}

	console.log("\n=== autolearn: a failed pass does not retry on the next settle ===");
	{
		const autoTmp = await mkdtemp(path.join(os.tmpdir(), "pi-call-policy-auto-"));
		tmpDirs.push(autoTmp);
		const logs = path.join(autoTmp, ".agents/memory/session-logs");
		await mkdir(path.join(logs, "sess-a"), { recursive: true });
		await writeFile(path.join(logs, "sess-a/session.jsonl"), `${JSON.stringify(messageEntry("s1", "user", "hello", "2026-09-12T10:00:00.000Z"))}\n`);
		await writeFile(path.join(autoTmp, ".agents/memory/MEMORY.md"), "# Project Memory\n\n## Project\n- Auto project.\n");
		await writeFile(path.join(autoTmp, ".agents/memory/CONTEXT.md"), "# Project Context\n\n## Summary\n\nAuto project.\n");
		await writeFile(path.join(autoTmp, ".agents/memory/project-context.json"), `${JSON.stringify({ autoLearn: true, autolearnAt: 0, autoConsolidate: false, handoffEnabled: false })}\n`);
		const pi = makePi({ cwd: autoTmp });
		await (await loadDefault(`${PC}/index.ts`))(pi);
		const ctx = makeCtx(autoTmp, { sessionManager: makeSessionManager([messageEntry("m1", "user", "hi", "2026-09-12T10:00:00.000Z")], "auto-session") });
		let calls = 0;
		ctx.modelRegistry.complete = async () => {
			calls += 1;
			throw new Error("model call error: Connection error.");
		};
		await runHandlers(pi, "agent_settled", ctx);
		const errorsFile = path.join(autoTmp, ".agents/memory/errors.log");
		check("the automatic pass reached the model once", await waitUntil(async () => calls === 1 && (await readFile(errorsFile, "utf8").catch(() => "")).includes("autolearn")));
		await runHandlers(pi, "agent_settled", ctx);
		// No model-side effect to await: give the (blocked) pass a bound, then assert none ran.
		await new Promise((resolve) => setTimeout(resolve, 250));
		check("a failed autolearn pass is parked on the next settle", calls === 1);
	}

	console.log("\n=== memory: repeated failures back off instead of toasting every settle ===");
	{
		const memTmp = await mkdtemp(path.join(os.tmpdir(), "pi-call-policy-mem-"));
		tmpDirs.push(memTmp);
		await mkdir(path.join(memTmp, ".agents/memory"), { recursive: true });
		const memoryFile = path.join(memTmp, ".agents/memory/MEMORY.md");
		const previous = "# Project Memory\n\n## Project\n- Old memory.\n";
		await writeFile(memoryFile, previous);
		await writeFile(path.join(memTmp, ".agents/memory/project-context.json"), `${JSON.stringify({ autoConsolidate: true, autoLearn: false, handoffEnabled: false, consolidateTurns: 1 })}\n`);
		const pi = makePi({ cwd: memTmp });
		await (await loadDefault(`${PC}/index.ts`))(pi);
		const ctx = makeCtx(memTmp, { sessionManager: makeSessionManager([messageEntry("m1", "user", "hello", "2026-09-12T10:00:00.000Z")], "mem-session") });
		let calls = 0;
		ctx.modelRegistry.complete = async () => {
			calls += 1;
			throw new Error("model call error: Connection error.");
		};
		const failureToasts = () => ctx.notifications.filter(([message]) => String(message).includes("memory update"));
		// Each pass runs on a new user turn; without one the throttle's turn gate parks it too, and the
		// probe would prove the wrong gate.
		const nextTurn = (id) => ctx.sessionManager.entries.push(messageEntry(id, "user", "more", "2026-09-12T10:01:00.000Z"));
		nextTurn("t1");
		await runHandlers(pi, "agent_settled", ctx);
		check("the first failure is surfaced", await waitUntil(() => failureToasts().length === 1, 3_000));
		check("the transient toast names the backoff", String(failureToasts()[0][0]).includes("retry with backoff"));
		check("MEMORY.md is left untouched", (await readFile(memoryFile, "utf8")) === previous);

		// Past the 5-minute memory throttle: a second attempt fails and doubles the cooldown.
		clockOffset = policy.TRANSIENT_BASE_COOLDOWN_MS + 60_000;
		nextTurn("t2");
		await runHandlers(pi, "agent_settled", ctx);
		check("the policy lets the next attempt through after the first cooldown", await waitUntil(() => calls === 2, 3_000));
		// Inside the doubled cooldown (12 min), while the 5-minute throttle has expired: parked.
		clockOffset = policy.TRANSIENT_BASE_COOLDOWN_MS * 2 + 60_000;
		nextTurn("t3");
		await runHandlers(pi, "agent_settled", ctx);
		await new Promise((resolve) => setTimeout(resolve, 250));
		check("the doubled cooldown, not the throttle, parks the pass", calls === 2 && failureToasts().length === 2);
		clockOffset = 0;
	}
} finally {
	Date.now = realNow;
	for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL OK" : `\nFAILURES: ${failures}`);
if (failures > 0) process.exitCode = 1;
