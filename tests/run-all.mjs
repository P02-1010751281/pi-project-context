import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Run every test file in this directory (except the harness) and report a summary. */
const here = path.dirname(fileURLToPath(import.meta.url));
const tests = readdirSync(here)
	.filter((file) => file.endsWith(".mjs") && file !== "run-all.mjs" && file !== "harness.mjs")
	.sort();

let failed = 0;

// A file ending in a blank line is invisible in a diff read and fails the release gate (`git diff --check`);
// two release rounds in a row shipped one, so fail the suite instead of relying on a proofreader.
const repoRoot = path.resolve(here, "..");
const tracked = spawnSync("git", ["ls-files"], { encoding: "utf8", cwd: repoRoot });
let hygieneFailed = false;
if (tracked.status !== 0) {
	// Not a git checkout (a tarball run, say): say so rather than letting the gate vanish silently.
	console.log("== repo hygiene (no trailing blank line) ... skipped (git ls-files unavailable)");
}
if (tracked.status === 0) {
	// Every tracked file, not just the common text extensions: `LICENSE` has no suffix, and a binary is
	// skipped by its NUL byte rather than by guessing from the name.
	const offenders = tracked.stdout
		.split("\n")
		.filter(Boolean)
		.filter((file) => {
			try {
				const bytes = readFileSync(path.join(repoRoot, file));
				if (bytes.includes(0)) return false;
				// `\n\n` misses a CRLF blank tail and a whitespace-only last line, both of which
				// `git diff --check` reports just the same.
				return /\r?\n[ \t]*\r?\n$/.test(bytes.toString("utf8"));
			} catch {
				return false;
			}
		});
	if (offenders.length > 0) {
		hygieneFailed = true;
		console.log("== repo hygiene (no trailing blank line) ... FAILED");
		for (const file of offenders) console.log(`   ${file}`);
	} else {
		console.log("== repo hygiene (no trailing blank line) ... ok");
	}
}

// A render bullet truncated mid-sentence (a replace that dropped the rest of the line) survives every token
// check, so the two rendered surfaces get their own gate: each `- ` line must end in terminal punctuation.
let renderFailed = false;
if (tracked.status !== 0) {
	console.log("== repo hygiene (render bullets end in punctuation) ... skipped (git ls-files unavailable)");
}
if (tracked.status === 0) {
	const bad = [];
	for (const file of [".agents/memory/MEMORY.md", ".agents/memory/CONTEXT.md"]) {
		let text;
		try {
			text = readFileSync(path.join(repoRoot, file), "utf8");
		} catch {
			continue;
		}
		for (const line of text.split("\n")) {
			if (/^\s*[-*+] /.test(line) && !/[.!?;:`)"'\]。））」』”’…]$/.test(line.trim())) bad.push(`${file}: ${line.slice(0, 80)}`);
		}
	}
	if (bad.length > 0) {
		renderFailed = true;
		console.log("== repo hygiene (render bullets end in punctuation) ... FAILED");
		for (const line of bad) console.log(`   ${line}`);
	} else {
		console.log("== repo hygiene (render bullets end in punctuation) ... ok");
	}
}

for (const test of tests) {
	process.stdout.write(`== ${test} ... `);
	// A hung test must fail the run instead of blocking CI forever.
	const result = spawnSync(process.execPath, [path.join(here, test)], { encoding: "utf8", timeout: 60_000 });
	if (result.status === 0) {
		console.log("ok");
	} else {
		failed += 1;
		console.log("FAILED");
		console.log(result.stdout);
		console.error(result.stderr);
	}
}
if (failed > 0) console.log(`\n${failed} of ${tests.length} tests failed.`);
else if (hygieneFailed || renderFailed) console.log(`\nAll ${tests.length} tests passed, but a repo hygiene check failed.`);
else console.log(`\nAll ${tests.length} tests passed.`);
process.exit(failed === 0 && !hygieneFailed && !renderFailed ? 0 : 1);
