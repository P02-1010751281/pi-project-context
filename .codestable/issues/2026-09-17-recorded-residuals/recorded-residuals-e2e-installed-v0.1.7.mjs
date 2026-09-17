import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Release probe for v0.1.7, run against the settings-installed package (no `-ne`/`-e`, so the
 * pinned copy is what loads):
 *   - `Memory: <source> (<n> chars)` must name the journal-backed memory and its size,
 *   - `Context: <path> — updated <ISO> (<age> ago)` must date CONTEXT.md,
 * i.e. the two status lines added in this release are live in a real process.
 */

const DIR = "/tmp/pc-v017-probe";
const SESS = "/tmp/pc-v017-probe-sessions";
rmSync(DIR, { recursive: true, force: true });
rmSync(SESS, { recursive: true, force: true });
mkdirSync(path.join(DIR, ".agents/memory"), { recursive: true });
mkdirSync(SESS, { recursive: true });
writeFileSync(path.join(DIR, ".agents/memory/MEMORY.md"), "# Project Memory\n\n## Project\n- probe seed line.\n");
writeFileSync(path.join(DIR, ".agents/memory/CONTEXT.md"), "# Project Context\n\n## Summary\n- seeded context.\n");
writeFileSync(path.join(DIR, ".agents/memory/project-context.json"), `${JSON.stringify({ autoConsolidate: false, autoLearn: false }, null, 2)}\n`);
const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
utimesSync(path.join(DIR, ".agents/memory/CONTEXT.md"), twoHoursAgo, twoHoursAgo);

const proc = spawn(
	"pi",
	["--mode", "rpc", "-ns", "-nt", "--tools", "read", "--thinking", "off", "--provider", "deepseek", "--model", "deepseek-flash", "--session-dir", SESS],
	{ cwd: DIR, stdio: ["pipe", "pipe", "pipe"] },
);
let buffer = "";
let nextId = 0;
const pending = new Map();
const lines = [];
proc.stdout.on("data", (chunk) => {
	buffer += chunk.toString("utf8");
	let index;
	while ((index = buffer.indexOf("\n")) >= 0) {
		let line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		if (!line.trim()) continue;
		lines.push(line);
		let obj;
		try {
			obj = JSON.parse(line);
		} catch {
			continue;
		}
		if (obj.type === "response" && obj.id && pending.has(obj.id)) {
			pending.get(obj.id).resolve(obj);
			pending.delete(obj.id);
		}
	}
});
proc.stderr.on("data", (chunk) => process.stderr.write(`[stderr] ${String(chunk).slice(0, 300)}`));
const send = (obj) => {
	const id = `req-${++nextId}`;
	proc.stdin.write(`${JSON.stringify({ id, ...obj })}\n`);
	return new Promise((resolve) => pending.set(id, { resolve }));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await sleep(2500);
const state = (await send({ type: "get_state" })).data;
console.log(`installed build: ${readFileSync("/home/user/.pi/agent/settings.json", "utf8").match(/pi-project-context\.git@v[\d.]+/)?.[0]}`);
console.log(`session: ${path.basename(state.sessionFile ?? "none")}`);

await send({ type: "prompt", message: "/project-context status" });
await sleep(4000);

const text = lines.join("\n");
const memory = text.match(/Memory:[^"\\]*/)?.[0];
const context = text.match(/Context:[^"\\]*/)?.[0];
// The journal is the source of truth once it exists: seed it with the same document the render
// holds (equal content, so the render is not adopted as an external edit) and ask again.
writeFileSync(
	path.join(DIR, ".agents/memory/memory.jsonl"),
	`${JSON.stringify({ ts: new Date().toISOString(), op: "replace", text: "# Project Memory\n\n## Project\n- probe seed line.\n" })}\n`,
);
lines.length = 0;
await send({ type: "prompt", message: "/project-context status" });
await sleep(4000);
const journalText = lines.join("\n");
const journalMemory = journalText.match(/Memory:[^"\\]*/)?.[0];
const checks = [
	["status names the legacy render when no journal exists", Boolean(memory && /MEMORY\.md \(\d+ chars\)/.test(memory))],
	["status dates CONTEXT.md", Boolean(context && /updated .+ ago\)/.test(context))],
	["context age reflects the two-hour-old render", Boolean(context && /\(2 h ago\)/.test(context))],
	["status switches to the journal once it exists", Boolean(journalMemory && /memory\.jsonl/.test(journalMemory))],
];
for (const [label, ok] of checks) console.log(`${ok ? "OK  " : "FAIL"} ${label}`);
console.log(`--- status output (no journal) ---\n${memory ?? "(no Memory: line)"}\n${context ?? "(no Context: line)"}`);
console.log(`--- status output (journal present) ---\n${journalMemory ?? "(no Memory: line)"}`);

proc.kill("SIGTERM");
await sleep(500);
const failures = checks.filter(([, ok]) => !ok).length;
console.log(`FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
