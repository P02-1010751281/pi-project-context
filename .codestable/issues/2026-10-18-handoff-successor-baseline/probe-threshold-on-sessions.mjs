/**
 * Read-only probe: what /handoff status would resolve on a recorded session, through the repo's own
 * measureContext/resolveThreshold (not a reimplementation).
 *
 * Usage: node probe-threshold-on-sessions.mjs <session.jsonl> [...]
 * It prints the branch model/window, pi's usage.tokens, the measured baseline, floor and the resolved
 * threshold or refusal. No file is written. Run it from the repo root; the session paths are the
 * consumer repos' archived transcripts.
 */
import { readFileSync } from "node:fs";
import { loadNamespace, PI } from "/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/tests/harness.mjs";
import { pathToFileURL } from "node:url";
const piEntry = pathToFileURL(`${PI}/dist/index.js`).href;
const pi = await import(piEntry);

const PC = new URL("../../../extensions/project-context", import.meta.url).pathname;
const threshold = await loadNamespace(`${PC}/handoff/threshold.ts`);

const store = JSON.parse(readFileSync("/home/user/.pi/agent/models-store.json", "utf8"));
const modelInfo = (provider, id) => (store[provider]?.models ?? []).find((m) => m.id === id);

function usageLike(entries, leafId) {
	const { buildSessionProjection, calculateContextTokens, estimateTokens } = pi;
	const projection = buildSessionProjection(entries);
	const messages = projection.messages;
	let last = null;
	for (let i = 0; i < messages.length; i += 1) {
		const m = messages[i];
		if (m.role !== "assistant" || m.stopReason === "aborted" || m.stopReason === "error") continue;
		if (calculateContextTokens(m.usage) > 0) last = { usage: m.usage, index: i };
	}
	if (!last) {
		let tokens = 0;
		for (const m of messages) tokens += estimateTokens(m);
		return { tokens, usageTokens: 0, trailingTokens: tokens };
	}
	let trailing = 0;
	for (let i = last.index + 1; i < messages.length; i += 1) trailing += estimateTokens(messages[i]);
	return {
		tokens: calculateContextTokens(last.usage) + trailing,
		usageTokens: calculateContextTokens(last.usage),
		trailingTokens: trailing,
		usage: last.usage,
	};
}

globalThis.__pi = pi;

for (const file of process.argv.slice(2)) {
	const entries = pi.parseSessionEntries(readFileSync(file, "utf8")).filter((e) => e.type !== "session");
	const leafId = entries.at(-1)?.id ?? null;
	const branch = pi.buildContextEntries(entries, leafId);
	const assistants = branch.filter((e) => e.type === "message" && e.message?.role === "assistant" && e.message.model);
	const lastModel = assistants.at(-1)?.message;
	const usage = usageLike(entries, leafId);
	const info = modelInfo(lastModel?.provider, lastModel?.model);
	const window = info?.contextWindow ?? 0;
	const ctx = {
		model: { provider: lastModel?.provider, id: lastModel?.model, cost: info?.cost ?? { input: 0, output: 0 } },
		sessionManager: { getBranch: () => entries, getLeafId: () => leafId, getSessionId: () => "probe", getSessionFile: () => file },
	};
	const usageArg = { tokens: usage.tokens, contextWindow: window, percent: window ? (usage.tokens / window) * 100 : null };
	const measure = threshold.measureContext(ctx, usageArg);
	const resolved = threshold.resolveThreshold(ctx, usageArg);
	const refusal = threshold.thresholdRefusal(ctx, usageArg);
	const floor = measure.baseline + 20000 + 8000;
	console.log("\n===", file.split("/").slice(-2).join("/"));
	console.log("model", lastModel?.provider, lastModel?.model, "window", window, "entries", entries.length, "assistant", assistants.length);
	console.log("last usage", JSON.stringify(usage.usage), "usageTokens", usage.usageTokens, "trailing", usage.trailingTokens);
	console.log("pi usage.tokens", usage.tokens, "percent", usageArg.percent?.toFixed(1));
	console.log("measure", JSON.stringify({ ...measure }));
	console.log("floor", floor, "knee", threshold && window ? Math.round(window - (window - 157000) / (1 + Math.exp(-Math.log(window / 450000) / 0.04))) : "n/a");
	console.log("resolved", JSON.stringify(resolved), "refusal", refusal);
}
