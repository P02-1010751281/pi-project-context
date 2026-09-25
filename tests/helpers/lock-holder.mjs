import { appendFile } from "node:fs/promises";
import { loadNamespace, PC } from "../harness.mjs";

/** Hold the memory write lock in a child process so the suite can assert cross-process exclusion. */
const [target, log, delay] = process.argv.slice(2);
const { withMemoryLock } = await loadNamespace(`${PC}/shared/project-state.ts`);
await withMemoryLock(target, async () => {
	await appendFile(log, `enter ${process.pid}\n`);
	await new Promise((resolve) => setTimeout(resolve, Number(delay)));
	await appendFile(log, `exit ${process.pid}\n`);
});
