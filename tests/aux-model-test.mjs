import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadDefault, loadNamespace, makeCtx, makePi, makeSessionManager, messageEntry, PC } from "./harness.mjs";

/**
 * Auxiliary-call routing: `provider`/`model` replaces the session model for the JSON passes,
 * `maxTokens` caps those calls, and a half-configured or unresolvable route falls back to the
 * session model with one warning. The handoff summary routes the same way but keeps its reserve.
 */

const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-aux-model-"));
let failures = 0;
function check(label, value) {
	console.log(`${value ? "OK  " : "FAIL"} ${label}`);
	if (!value) failures += 1;
}
const configPath = path.join(tmp, ".agents/memory/project-context.json");
const readConfig = () => readFile(configPath, "utf8").then((raw) => JSON.parse(raw)).catch(() => undefined);

try {
	await mkdir(path.join(tmp, ".agents/memory"), { recursive: true });

	console.log("=== config parsing ===");
	// A fresh module instance per case: getConfig caches per project root.
	const parseConfig = async (raw) => {
		await writeFile(configPath, JSON.stringify(raw));
		return (await loadNamespace(`${PC}/shared/config.ts`)).getConfig(tmp);
	};
	const configured = await parseConfig({ provider: "prov", model: "mid", maxTokens: 4096 });
	check("route and cap load from the flat config", configured.provider === "prov" && configured.model === "mid" && configured.maxTokens === 4096);
	const half = await parseConfig({ provider: "prov" });
	check("a half-configured route is ignored", half.provider === "" && half.model === "");
	const low = await parseConfig({ maxTokens: 10 });
	check("maxTokens below 256 falls back to the default", low.maxTokens === 8192);
	const defaults = await parseConfig({});
	check("defaults match dsh", defaults.maxTokens === 8192 && defaults.provider === "" && defaults.model === "");

	console.log("\n=== resolveAuxModel ===");
	const { resolveAuxModel, completeText } = await loadNamespace(`${PC}/shared/llm.ts`);
	const auxModel = { provider: "aux", id: "small" };
	const sessionModel = { provider: "session", id: "big" };
	const notifications = [];
	const ctx = makeCtx(tmp, {
		model: sessionModel,
		notifications,
		modelRegistry: {
			hasConfiguredAuth: () => true,
			find: (provider, id) => (provider === "aux" && id === "small" ? auxModel : undefined),
			complete: async () => ({ content: [{ type: "text", text: "{}" }] }),
		},
	});
	check("a configured route wins over the session model", resolveAuxModel(ctx, { provider: "aux", model: "small" }) === auxModel);
	check("an empty route uses the session model", resolveAuxModel(ctx, { provider: "", model: "" }) === sessionModel);
	check("an unresolvable route falls back to the session model", resolveAuxModel(ctx, { provider: "nope", model: "x" }) === sessionModel);
	check("the fallback warns once", notifications.length === 1);
	resolveAuxModel(ctx, { provider: "nope", model: "x" });
	check("the fallback does not warn again", notifications.length === 1);
	check("an unauthorized session model resolves to nothing", resolveAuxModel(makeCtx(tmp, { modelRegistry: { hasConfiguredAuth: () => false, find: () => undefined, complete: async () => ({ content: [] }) } }), { provider: "", model: "" }) === undefined);

	let call;
	ctx.modelRegistry.complete = async (model, _context, options) => {
		call = { model, maxTokens: options?.maxTokens };
		return { content: [{ type: "text", text: "ok" }] };
	};
	const text = await completeText(ctx, "hi", { model: auxModel, maxTokens: 4096 });
	check("completeText uses the passed model and cap", text === "ok" && call.model === auxModel && call.maxTokens === 4096);

	console.log("\n=== /project-context verbs ===");
	const factory = await loadDefault(`${PC}/index.ts`);
	const pi = makePi({ cwd: tmp });
	await factory(pi);
	const command = pi.commands.get("project-context");
	const commandCtx = makeCtx(tmp, {
		sessionManager: makeSessionManager([messageEntry("m1", "user", "hello", "2026-09-12T10:00:00.000Z")], "aux-session"),
	});
	const lastNotification = () => String(commandCtx.notifications.at(-1)?.[0] ?? "");

	await command.handler("model acme/small-1", commandCtx);
	const routed = await readConfig();
	check("model verb persists provider and model", routed.provider === "acme" && routed.model === "small-1");
	await command.handler("status", commandCtx);
	check("status shows the route", lastNotification().includes("Auxiliary calls: acme/small-1, max 8192 tokens"));
	await command.handler("max-tokens 4096", commandCtx);
	check("max-tokens verb persists", (await readConfig()).maxTokens === 4096);
	await command.handler("max-tokens 10", commandCtx);
	check("a below-floor cap is rejected", (await readConfig()).maxTokens === 4096);
	await command.handler("model acme", commandCtx);
	check("a model id without provider is rejected", (await readConfig()).provider === "acme");
	await command.handler("model off", commandCtx);
	check("model off clears the route", (await readConfig()).provider === "" && (await readConfig()).model === "");

	console.log("\n=== consolidation uses the routed model and cap ===");
	await command.handler("model aux/small", commandCtx);
	await command.handler("max-tokens 2048", commandCtx);
	commandCtx.modelRegistry = {
		hasConfiguredAuth: () => true,
		find: (provider, id) => (provider === "aux" && id === "small" ? auxModel : undefined),
		complete: async (model, _context, options) => {
			call = { model, maxTokens: options?.maxTokens };
			return {
				content: [{
					type: "text",
					text: JSON.stringify({ memory_markdown: "# Project Memory\n\n## Project\n- routed auxiliary model memory.", context: { title: "t", summary: "s", key_points: [], open_tasks: [] } }),
				}],
			};
		},
	};
	await pi.commands.get("memory-learn").handler("", commandCtx);
	const memory = await readFile(path.join(tmp, ".agents/memory/MEMORY.md"), "utf8").catch(() => "");
	check("the pass used the routed model", call?.model === auxModel);
	check("the pass used the configured cap", call?.maxTokens === 2048);
	check("the pass wrote the memory", memory.includes("- routed auxiliary model memory."));
} finally {
	await rm(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL OK" : `\nFAILURES: ${failures}`);
if (failures > 0) process.exitCode = 1;
