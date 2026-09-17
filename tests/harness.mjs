import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shared test harness: locates the pi package, loads extension modules through pi's
 * own jiti loader (same aliases, `moduleCache: false`), and builds mock `pi`/`ctx`
 * objects. Tests never touch a real project or the user's global config.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/** pi package root; override with PI_PKG when it is not in the global npm root. */
export function findPiPackage() {
	if (process.env.PI_PKG) return process.env.PI_PKG;
	const candidates = [];
	try {
		const root = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		if (root) candidates.push(path.join(root, "@earendil-works/pi-coding-agent"));
	} catch {
		// npm may be unavailable; fall through to the known location.
	}
	candidates.push("/home/user/.local/lib/node_modules/@earendil-works/pi-coding-agent");
	for (const candidate of candidates) {
		if (existsSync(path.join(candidate, "dist/index.js"))) return candidate;
	}
	throw new Error("pi package not found; set PI_PKG to its install directory");
}

export const PI = findPiPackage();
/** Extensions directory of this repository (tests run against it, not ~/.pi). */
export const EXT = path.resolve(here, "../extensions");
export const PC = path.join(EXT, "project-context");

const alias = {
	"@earendil-works/pi-coding-agent": `${PI}/dist/index.js`,
	"@earendil-works/pi-ai": `${PI}/node_modules/@earendil-works/pi-ai/dist/compat.js`,
	// Extensions that register tools import typebox; pi resolves it from its own deps.
	typebox: `${PI}/node_modules/typebox/build/index.mjs`,
};
const loaderUrl = `${PI}/dist/core/extensions/loader.js`;

let jitiModule;
async function loadJiti(aliases) {
	if (!jitiModule) jitiModule = await import(`${PI}/node_modules/jiti/lib/jiti-static.mjs`);
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
