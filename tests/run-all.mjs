import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Run every test file in this directory (except the harness) and report a summary. */
const here = path.dirname(fileURLToPath(import.meta.url));
const tests = readdirSync(here)
	.filter((file) => file.endsWith(".mjs") && file !== "run-all.mjs" && file !== "harness.mjs")
	.sort();

let failed = 0;
for (const test of tests) {
	process.stdout.write(`== ${test} ... `);
	const result = spawnSync(process.execPath, [path.join(here, test)], { encoding: "utf8" });
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
