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
if (tracked.status === 0) {
	const text = /\.(md|ts|mjs|json|ya?ml|txt|sh|gitignore)$/;
	const offenders = tracked.stdout
		.split("\n")
		.filter((file) => file && text.test(file))
		.filter((file) => {
			try {
				return readFileSync(path.join(repoRoot, file), "utf8").endsWith("\n\n");
			} catch {
				return false;
			}
		});
	if (offenders.length > 0) {
		failed += 1;
		console.log("== repo hygiene (no trailing blank line) ... FAILED");
		for (const file of offenders) console.log(`   ${file}`);
	} else {
		console.log("== repo hygiene (no trailing blank line) ... ok");
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
console.log(failed === 0 ? `\nAll ${tests.length} tests passed.` : `\n${failed} of ${tests.length} tests failed.`);
process.exit(failed === 0 ? 0 : 1);
