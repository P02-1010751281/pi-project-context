/**
 * 复现：外部编辑被「采纳」后，被同一次写入里的 pass 回复顶掉。
 *
 * 结论先行（脚本会实测并打印）：`memory/store.ts` 的 `recordMemoryDocument` 是**一次调用两次 append**——
 *   :68  append(adopted external bytes)      ← 外部编辑进入 journal
 *   :70  logError("adopted an externally edited MEMORY.md into the memory journal")
 *   :77  append(this pass's own render)      ← 本次 pass 的回复
 *   :80  writeAtomic(MEMORY.md, this pass's render)
 * 所以「采纳」只意味着**进入历史**，不意味着**生效**：同一次调用里 pass 的回复立刻占据生效位置。
 * 兄弟仓库 journal 里那对「一次采纳紧接一次另一版写入、间隔 70–450 ms」就是这两次 append，
 * 不需要第二个进程、也不需要第二次模型调用。
 *
 * 运行：node .codestable/issues/2026-10-03-external-edit-adoption-overwritten/repro-write-ordering.mjs
 * 退出码 0 = 复现成功（外部编辑被顶掉）；1 = 未复现（说明该行为已被修掉或代码已变）。
 */

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadNamespace, PC, rmTemp } from "../../../tests/harness.mjs";

const doc = (label) => `# Project Memory\n\n## Project\n- ${label}.\n- A durable invariant that must not disappear.\n`;

const A = doc("A: the render this session started from");
const B = doc("B: EXTERNAL EDIT by the owner (git checkout of the good version)");
const C = doc("C: this pass's fresh model reply");

const { recordMemoryDocument, loadMemory } = await loadNamespace(`${PC}/memory/store.ts`);
const { readMemoryJournal } = await loadNamespace(`${PC}/memory/journal.ts`);

async function scenario(name, passReply) {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-write-order-"));
	const memoryDir = path.join(root, ".agents/memory");
	const journalFile = path.join(memoryDir, "memory.jsonl");
	const renderFile = path.join(memoryDir, "MEMORY.md");
	const logFile = path.join(memoryDir, "errors.log");

	// 1. 正常一轮：journal 从 A 起家。
	await recordMemoryDocument(root, A);
	// 2. 模拟外部编辑：MEMORY.md 直接变成 B（`git checkout HEAD --` 的同义动作），mtime 天然更新。
	await new Promise((resolve) => setTimeout(resolve, 25));
	await writeFile(renderFile, B);
	// 3. 下一次 pass：采纳检测应当认领 B，然后写入它自己的回复。
	await recordMemoryDocument(root, passReply);

	const raw = (await readFile(journalFile, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const render = await readFile(renderFile, "utf8");
	const log = (await readFile(logFile, "utf8").catch(() => "")).trim();
	const loaded = await loadMemory(root);

	const label = (text) => (text.includes("A:") ? "A" : text.includes("B:") ? "B" : text.includes("C:") ? "C" : "?");
	console.log(`\n=== ${name} ===`);
	console.log(`journal 记录顺序： ${raw.map((entry) => label(entry.text)).join(" → ")}   （每条长度 ${raw.map((entry) => entry.text.length).join("/")}）`);
	if (raw.length >= 2) {
		const gap = Date.parse(raw[raw.length - 1].ts) - Date.parse(raw[raw.length - 2].ts);
		console.log(`最后两条记录间隔： ${gap} ms   （同一函数两次 append 的开销）`);
	}
	console.log(`MEMORY.md 现在生效的是： ${label(render)}`);
	console.log(`loadMemory() 返回的是： ${label(loaded.text)}`);
	console.log(`errors.log 末行： ${log.split("\n").at(-1)?.slice(0, 120) ?? "(空)"}`);

	const adopted = raw.some((entry) => entry.text.includes("B:"));
	const bEffective = render.includes("B:");
	const logClaimsAdoption = log.includes("adopted an externally edited");
	console.log(`采纳记录进入 journal： ${adopted}`);
	console.log(`外部编辑仍然生效：   ${bEffective}`);
	console.log(`errors.log 声称已采纳： ${logClaimsAdoption}`);

	await rmTemp(root);
	return { adopted, bEffective, logClaimsAdoption };
}

const fresh = await scenario("S1：pass 产出新回复（C）", C);
const stale = await scenario("S2：pass 产出编辑前的旧内容（A）——兄弟仓库的实际形态", A);

const reproduced = fresh.adopted && !fresh.bEffective && stale.adopted && !stale.bEffective;
console.log(`\n判定：${reproduced ? "已复现——外部编辑被采纳进历史，但在同一次调用里被顶掉，没有生效" : "未复现（行为已变，需重新阅读代码）"}`);
process.exit(reproduced ? 0 : 1);
