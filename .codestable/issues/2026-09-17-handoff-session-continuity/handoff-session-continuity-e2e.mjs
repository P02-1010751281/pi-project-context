import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Real-machine probe for the handoff session-continuity fix:
 *   1. set a non-default model + thinking level in the live session,
 *   2. /auto-handoff now,
 *   3. assert the replacement session inherited both (model_change / thinking_level_change),
 *   4. hand off a second time and assert parentSession points at the chain root, not at the
 *      previous handoff (tree stays two levels deep).
 *
 * Runs the dev copy through `-ne -e <repo>/extensions/project-context/index.ts`.
 */

const MODE = process.argv[2] === "old" ? "old" : "new";
const REPO = "/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context";
const DIR = `/tmp/pc-settings-e2e-${MODE}`;
const SESS = `/tmp/pc-settings-e2e-${MODE}-sessions`;
const BIG = "/tmp/pc-settings-e2e-big.txt";

if (!existsSync(BIG)) {
	writeFileSync(BIG, Array.from({ length: 900 }, (_, i) => `line ${i} ${"z".repeat(60)}`).join("\n") + "\nSETTINGS-E2E-MARKER-END\n");
}
rmSync(DIR, { recursive: true, force: true });
rmSync(SESS, { recursive: true, force: true });
mkdirSync(path.join(DIR, ".agents/memory"), { recursive: true });
mkdirSync(SESS, { recursive: true });
writeFileSync(
	path.join(DIR, ".agents/memory/project-context.json"),
	`${JSON.stringify({ handoffEnabled: true, handoffKeepTokens: 50, autoConsolidate: false, autoLearn: false, handoffLanguage: "auto" }, null, 2)}\n`,
);

const args = [
	"--mode", "rpc", "-ns", "-nt", "--tools", "read", "--thinking", "max",
	"--provider", "deepseek", "--model", "deepseek-flash", "--session-dir", SESS,
];
// "new" loads the fixed dev copy; "old" runs the settings-installed v0.1.5 build (pre-fix).
if (MODE === "new") args.push("-ne", "-e", `${REPO}/extensions/project-context/index.ts`);
console.log(`MODE=${MODE}`);

const proc = spawn("pi", args, { cwd: DIR, stdio: ["pipe", "pipe", "pipe"] });
let buffer = "";
let nextId = 0;
let settled = 0;
const pending = new Map();
const notifies = [];
proc.stdout.on("data", (chunk) => {
	buffer += chunk.toString("utf8");
	let index;
	while ((index = buffer.indexOf("\n")) >= 0) {
		let line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		if (!line.trim()) continue;
		let obj;
		try {
			obj = JSON.parse(line);
		} catch {
			continue;
		}
		if (obj.type === "response" && obj.id && pending.has(obj.id)) {
			pending.get(obj.id).resolve(obj);
			pending.delete(obj.id);
			continue;
		}
		if (obj.type === "extension_ui_request") {
			notifies.push(`NOTIFY[${obj.notifyType}]: ${obj.message}`);
			console.log(notifies.at(-1));
		} else if (obj.type === "agent_settled") {
			settled += 1;
			console.log(`EVENT: settled (#${settled})`);
		}
	}
});
proc.stderr.on("data", (chunk) => process.stderr.write(`[stderr] ${String(chunk).slice(0, 200)}`));

function send(obj) {
	const id = `req-${++nextId}`;
	proc.stdin.write(`${JSON.stringify({ id, ...obj })}\n`);
	return new Promise((resolve) => pending.set(id, { resolve }));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = async () => (await send({ type: "get_state" })).data;
async function waitSettled(target, timeoutMs = 240_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (settled >= target) return;
		await sleep(300);
	}
	throw new Error(`timeout waiting for settle #${target}`);
}
async function waitSessionChange(previous, label) {
	const deadline = Date.now() + 180_000;
	while (Date.now() < deadline) {
		const current = await state();
		if (current.sessionFile && current.sessionFile !== previous) {
			console.log(`${label} -> ${path.basename(current.sessionFile)}`);
			return current.sessionFile;
		}
		await sleep(1000);
	}
	throw new Error(`timeout waiting for ${label}`);
}
const headerOf = (file) => JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0]);
const settingsEntries = (file) => {
	const changes = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type === "model_change") changes.push({ type: entry.type, provider: entry.provider, modelId: entry.modelId });
		if (entry.type === "thinking_level_change") changes.push({ type: entry.type, thinkingLevel: entry.thinkingLevel });
	}
	return changes;
};
const lastModelChange = (changes) => changes.filter((entry) => entry.type === "model_change").at(-1);
const lastThinkingChange = (changes) => changes.filter((entry) => entry.type === "thinking_level_change").at(-1);
const marker = path.join(DIR, ".agents/memory/handoff-session-settings.json");
const results = [];
const check = (label, value) => {
	results.push([label, value]);
	console.log(`${value ? "OK  " : "FAIL"} ${label}`);
};

try {
	await sleep(2500);
	const initial = await state();
	const session1 = initial.sessionFile;
	console.log(`initial=${path.basename(session1)} model=${initial.model?.provider}/${initial.model?.id} thinking=${initial.thinkingLevel}`);

	await send({ type: "prompt", message: `请用 read 工具读取 ${BIG}，然后只回复 done。` });
	await waitSettled(1);
	await send({ type: "prompt", message: "再说一句 ok。" });
	await waitSettled(2);

	const models = (await send({ type: "get_available_models" })).data.models;
	console.log(`available: ${models.map((m) => `${m.provider}/${m.id}`).join(", ")}`);
	const target =
		models.find((m) => m.provider === "deepseek" && m.id !== "deepseek-flash") ?? models.find((m) => m.provider === "openai-codex");
	if (!target) throw new Error("no second authenticated model available");
	const setModel = await send({ type: "set_model", provider: target.provider, modelId: target.id });
	console.log(`set_model ${target.provider}/${target.id} -> ${JSON.stringify(setModel).slice(0, 160)}`);
	await send({ type: "set_thinking_level", level: "low" });
	const configured = await state();
	console.log(`live session now model=${configured.model?.provider}/${configured.model?.id} thinking=${configured.thinkingLevel}`);

	await send({ type: "prompt", message: "/auto-handoff now" });
	const session2 = await waitSessionChange(session1, "handoff 1");
	await sleep(4000);
	await waitSettled(3);

	const header2 = headerOf(session2);
	const entries2 = settingsEntries(session2);
	console.log(`session2 parent=${header2.parentSession ? path.basename(header2.parentSession) : "(none)"}`);
	console.log(`session2 settings=${JSON.stringify(entries2)}`);
	check("handoff 1 switched sessions", session2 !== session1);
	check("handoff 1 restored the model", lastModelChange(entries2)?.provider === target.provider && lastModelChange(entries2)?.modelId === target.id);
	check("handoff 1 restored the thinking level", lastThinkingChange(entries2)?.thinkingLevel === "low");
	check("handoff 1 parented the replacement to the original session", header2.parentSession === session1);
	check("handoff 1 consumed its staged settings", !existsSync(marker));
	check("the replacement runs on the restored settings", (await state()).model?.id === target.id && (await state()).thinkingLevel === "low");

	await send({ type: "prompt", message: "再说一句 ok2。" });
	await waitSettled(4);
	await send({ type: "prompt", message: "/auto-handoff now" });
	const session3 = await waitSessionChange(session2, "handoff 2");
	await sleep(4000);
	await waitSettled(5);

	const header3 = headerOf(session3);
	const entries3 = settingsEntries(session3);
	console.log(`session3 parent=${header3.parentSession ? path.basename(header3.parentSession) : "(none)"}`);
	console.log(`session3 settings=${JSON.stringify(entries3)}`);
	check("handoff 2 kept the tree root as parent", header3.parentSession === session1);
	check("handoff 2 did not chain onto the previous handoff", header3.parentSession !== session2);
	check("handoff 2 restored the model again", lastModelChange(entries3)?.provider === target.provider && lastModelChange(entries3)?.modelId === target.id);
	check("handoff 2 restored the thinking level again", lastThinkingChange(entries3)?.thinkingLevel === "low");
	check("handoff 2 consumed its staged settings", !existsSync(marker));

	console.log("SESSIONS:");
	for (const file of readdirSync(SESS).sort()) {
		const full = path.join(SESS, file);
		const header = headerOf(full);
		console.log(
			`  ${file} parent=${header.parentSession ? path.basename(header.parentSession) : "(none)"} bytes=${readFileSync(full, "utf8").length}`,
		);
	}
	console.log(`NOTIFIES:\n${notifies.join("\n")}`);
	const failed = results.filter(([, ok]) => !ok);
	console.log(`RESULT: ${results.length - failed.length}/${results.length} checks passed`);
	if (failed.length) process.exitCode = 1;
} catch (error) {
	console.error(`FAILED: ${error.message}`);
	process.exitCode = 1;
} finally {
	proc.stdin.end();
	setTimeout(() => proc.kill("SIGTERM"), 1500);
	await new Promise((resolve) => proc.once("exit", resolve));
}
