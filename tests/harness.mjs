import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shared test harness: locates the pi package, loads extension modules through pi's
 * own jiti loader (same aliases, `moduleCache: false`), and builds mock `pi`/`ctx`
 * objects. Tests never touch a real project or the user's global config.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/** pi package root; override with PI_PKG when it is not in a known install root. */
export function findPiPackage() {
	if (process.env.PI_PKG) return process.env.PI_PKG;
	const candidates = [];
	try {
		const root = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		if (root) candidates.push(path.join(root, "@earendil-works/pi-coding-agent"));
	} catch {
		// npm may be unavailable; fall through to the known locations.
	}
	// Managed self-install (pi >= 1.0.2): <agent dir>/install/releases/<version>/node_modules/...
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(process.env.HOME ?? "", ".pi/agent");
	try {
		const release = readFileSync(path.join(agentDir, "install/current-version"), "utf8").trim();
		if (release) {
			candidates.push(path.join(agentDir, "install/releases", release, "node_modules/@earendil-works/pi-coding-agent"));
		}
	} catch {
		// No managed install on this machine; the candidates below may still hit.
	}
	// Legacy npm-global location.
	candidates.push(path.join(process.env.HOME ?? "", ".local/lib/node_modules/@earendil-works/pi-coding-agent"));
	for (const candidate of candidates) {
		if (existsSync(path.join(candidate, "dist/index.js"))) return candidate;
	}
	throw new Error("pi package not found; set PI_PKG to its install directory");
}

export const PI = findPiPackage();

/**
 * A dependency of the pi package. npm may hoist it ABOVE the package directory (the managed
 * self-install does: `<release>/node_modules/jiti`, not `<pi>/node_modules/jiti`), so walk up.
 */
function findDep(pkg) {
	for (let dir = PI; ; dir = path.dirname(dir)) {
		const candidate = path.join(dir, "node_modules", pkg);
		if (existsSync(candidate)) return candidate;
		if (path.dirname(dir) === dir) break;
	}
	throw new Error(`cannot locate ${pkg}; checked node_modules up from ${PI}`);
}

/** pi-ai dist, for tests that import pi's own helpers. */
export const PI_AI_DIST = path.join(findDep("@earendil-works/pi-ai"), "dist");
/** Extensions directory of this repository (tests run against it, not ~/.pi). */
export const EXT = path.resolve(here, "../extensions");
export const PC = path.join(EXT, "project-context");

const alias = {
	"@earendil-works/pi-coding-agent": `${PI}/dist/index.js`,
	"@earendil-works/pi-ai": `${PI_AI_DIST}/compat.js`,
	// Extensions that register tools import typebox; pi resolves it from its own deps.
	typebox: `${findDep("typebox")}/build/index.mjs`,
};
const loaderUrl = `${PI}/dist/core/extensions/loader.js`;
const jitiEntry = `${findDep("jiti")}/lib/jiti-static.mjs`;

let jitiModule;
async function loadJiti(aliases) {
	if (!jitiModule) jitiModule = await import(jitiEntry);
	return jitiModule.createJiti(loaderUrl, { moduleCache: false, alias: aliases ? { ...alias, ...aliases } : alias });
}

export async function loadDefault(file, aliases) {
	const jiti = await loadJiti(aliases);
	return jiti.import(file, { default: true });
}

export async function loadNamespace(file, aliases) {
	const jiti = await loadJiti(aliases);
	return jiti.import(file);
}

/**
 * Load several modules through ONE jiti instance so they share a module registry.
 *
 * `loadNamespace` builds a fresh loader per call (`moduleCache: false`), so two calls give two
 * independent copies: a test that wants to observe module-level state from another module (the
 * failure policy behind `callAux`, say) has to load both together.
 */
export async function loadShared(files) {
	// Its own loader with the module cache ON: `loadJiti` deliberately disables it so each test file
	// starts clean, but that also means two `loadNamespace` calls never share module state.
	if (!jitiModule) jitiModule = await import(jitiEntry);
	const jiti = jitiModule.createJiti(loaderUrl, { alias });
	const loaded = [];
	for (const file of files) loaded.push(await jiti.import(file));
	return loaded;
}

/**
 * Assert a tool schema survives pi-ai's strict JSON-schema conversion.
 *
 * `makeStrictJsonSchema(schema, () => false)` alone is NOT enough: that callback *is* the
 * provider-specific check, so passing an always-false one disables exactly the keywords a provider
 * would refuse (Anthropic rejects `maxItems`, which pi-ai's own base table allows). This asserts the
 * strict-ready checklist on the union of both tables, which is what makes the check non-vacuous.
 *
 * Throws on the first violation, so a test can simply await it.
 */
export async function assertStrictReady(schema) {
	const sampling = await import(`${PI_AI_DIST}/api/constrained-sampling.js`);
	// The base-table verdict, including the nested object/array-union rule.
	sampling.makeStrictJsonSchema(schema);

	const readTable = (file, name) => {
		const source = readFileSync(file, "utf8");
		const match = new RegExp(`${name}[^=]*=\\s*(?:new Set\\()?\\[([\\s\\S]*?)\\]`).exec(source);
		if (!match) throw new Error(`cannot read ${name} from ${file}`);
		return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
	};
	const base = readTable(`${PI_AI_DIST}/api/constrained-sampling.js`, "UNSUPPORTED_STRICT_SCHEMA_KEYS");
	const anthropic = readTable(`${PI_AI_DIST}/api/anthropic-messages.js`, "ANTHROPIC_STRICT_UNSUPPORTED_KEYWORDS");
	const formats = readTable(`${PI_AI_DIST}/api/anthropic-messages.js`, "ANTHROPIC_STRICT_STRING_FORMATS");
	// Pin the sizes: if pi-ai's tables change, these tests must be re-read, not silently weakened.
	if (base.length !== 16) throw new Error(`pi-ai base unsupported-key table changed size: ${base.length}`);
	if (anthropic.length !== 11) throw new Error(`Anthropic unsupported-key table changed size: ${anthropic.length}`);

	const forbidden = new Set([...base, ...anthropic]);
	const problems = [];
	const walk = (node, path) => {
		if (Array.isArray(node)) {
			node.forEach((item, index) => walk(item, `${path}[${index}]`));
			return;
		}
		if (typeof node !== "object" || node === null) return;
		for (const [key, value] of Object.entries(node)) {
			if (key === "required") continue;
			if (forbidden.has(key)) problems.push(`${path} uses the unsupported keyword ${key}`);
			if (key === "minItems" && value !== 0 && value !== 1) problems.push(`${path} uses minItems ${value} (only 0 and 1 are accepted)`);
			if (key === "format" && !formats.includes(value)) problems.push(`${path} uses the unsupported format ${value}`);
			walk(value, `${path}.${key}`);
		}
		if (node.type === "object") {
			if (node.additionalProperties !== false) problems.push(`${path} must set additionalProperties: false`);
			const missing = Object.keys(node.properties ?? {}).filter((key) => !(node.required ?? []).includes(key));
			if (missing.length > 0) problems.push(`${path} does not require ${missing.join(", ")}`);
		}
	};
	walk(schema, "root");
	if (problems.length > 0) throw new Error(`schema is not strict-ready: ${problems.join("; ")}`);
}

/**
 * Remove a test's temp directory.
 *
 * The extension starts work it does not await (`agent_settled` consolidation, the session-log
 * archive's write chain), so a writer can still be inside the directory while a test tears it
 * down. `fs.rm`'s recursive walk lists a directory and then removes it, so a file that lands in
 * between makes `rmdir` fail with ENOTEMPTY — and `maxRetries` defaults to 0, turning a harmless
 * teardown race into a spurious red test.
 */
export async function rmTemp(target) {
	await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
}

/** Poll until a condition holds (bounded); waits in this suite never sleep a fixed slice.
 * Async predicates are supported so file effects can be awaited without a fixed delay. */
export async function waitUntil(predicate, timeoutMs = 2_000, stepMs = 10) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, stepMs));
	}
	return await predicate();
}

/** Minimal pi API mock: records hooks/commands/flags and answers flags from `flags`. */
export function makePi(options = {}) {
	const handlers = new Map();
	const commands = new Map();
	const flags = options.flags ?? {};
	const pi = {
		handlers,
		commands,
		sentMessages: [],
		on: (event, fn) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(fn);
		},
		registerCommand: (name, opts) => commands.set(name, opts),
		registerFlag: (name) => {
			if (!(name in flags)) flags[name] = undefined;
		},
		registerShortcut: () => {},
		registerTool: () => {},
		getFlag: (name) => flags[name],
		exec: async () => ({ code: 0, stdout: `${options.cwd ?? process.cwd()}\n` }),
		sendUserMessage: (text) => pi.sentMessages.push(text),
		// Settings applied at session start (handoff carry-over); observable in tests.
		modelCalls: [],
		thinkingCalls: [],
		setModel: async (model) => {
			pi.modelCalls.push(model);
			return options.setModelResult ?? true;
		},
		getThinkingLevel: () => options.thinkingLevel ?? "off",
		setThinkingLevel: (level) => {
			pi.thinkingCalls.push(level);
		},
	};
	return pi;
}

export function makeSessionManager(entries, id = "test-session") {
	return {
		entries,
		getBranch: () => entries,
		buildContextEntries: () => entries,
		getSessionId: () => id,
		getHeader: () => ({ type: "session", id, timestamp: "2026-09-12T00:00:00.000Z" }),
		getEntries: () => entries,
		getSessionFile: () => "",
		getLeafId: () => entries.at(-1)?.id ?? null,
		// Handoff's replay appends into the replacement session; keep it observable in tests.
		appendMessage: (message) => {
			entries.push(message);
			return message?.id ?? String(entries.length);
		},
	};
}

export function makeCtx(cwd, options = {}) {
	const sessionManager = options.sessionManager ?? makeSessionManager([], "test-session");
	const notifications = options.notifications ?? [];
	return {
		notifications,
		cwd,
		hasUI: true,
		ui: { notify: (message, type) => notifications.push([message, type ?? "info"]) },
		mode: options.mode ?? "tui",
		isIdle: options.isIdle ?? (() => true),
		getContextUsage: options.getContextUsage ?? (() => undefined),
		thinkingLevel: options.thinkingLevel ?? "off",
		model: options.model ?? { provider: "test", id: "fake" },
		modelRegistry: options.modelRegistry ?? {
			hasConfiguredAuth: () => true,
			find: () => undefined,
			complete: async () => {
				throw new Error("no fake model configured");
			},
		},
		sessionManager,
	};
}

/** Run every handler registered for an event, in registration order (like one extension). */
export async function runHandlers(pi, event, ctx, eventArg = {}) {
	const results = [];
	for (const handler of pi.handlers.get(event) ?? []) {
		results.push(await handler(eventArg, ctx));
	}
	return results;
}

/** Minimal valid session entries for projection tests. */
export function messageEntry(id, role, text, timestamp) {
	return contentEntry(id, role, [{ type: "text", text }], timestamp);
}

/** Session entry with explicit content blocks (tool calls, tool results, images, ...). */
export function contentEntry(id, role, content, timestamp, parentId = null) {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role,
			content,
			timestamp: Date.parse(timestamp),
		},
	};
}

/** Session entry for a tool result; `toolCallId` must match the assistant's tool call. */
export function toolResultEntry(id, toolCallId, text, timestamp, parentId = null) {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: { role: "toolResult", toolCallId, content: [{ type: "text", text }], timestamp: Date.parse(timestamp) },
	};
}
