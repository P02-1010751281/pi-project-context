import { appendFile, cp, mkdir, readFile, readdir, rename, rmdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Shared project-state infrastructure for the global memory extensions.
 *
 * Storage layout (nothing is written to `~/.pi` or a project `.pi`):
 *
 *   <project>/.agents/skills/<name>/SKILL.md              learned project skills (standard location)
 *   <project>/.agents/memory/MEMORY.md                    durable project memory
 *   <project>/.agents/memory/CONTEXT.md                   recent session summary + session index
 *   <project>/.agents/memory/session-index.md             archive-layer session index (no LLM)
 *   <project>/.agents/memory/autolearn.json               autolearn throttle/enabled state
 *   <project>/.agents/memory/session-logs/<session-id>/   session.jsonl (raw) + session.md (rendered)
 *
 * Legacy data is migrated on session start:
 *   <project>/.pi/{MEMORY.md,CONTEXT.md,session-logs,skills}
 *   <project>/.agents/memory/skills          (short-lived intermediate layout)
 *   ~/.omp/agent/memories/<encoded-project>/ (read-only import, OMP keeps its copy)
 */

export const AGENTS_DIR = ".agents";
export const LEGACY_DIR = ".pi";
export const MEMORY_SUBDIR = "memory";
export const SKILLS_SUBDIR = "skills";
export const SESSION_LOGS_SUBDIR = "session-logs";

export const MAX_MEMORY_CHARS = 24000;
export const MAX_CONTEXT_CHARS = 32000;
export const MAX_CONVERSATION_CHARS = 50000;
export const MAX_SKILL_BODY_CHARS = 20000;
export const MAX_SUMMARY_CHARS = 6000;
export const MAX_LIST_ITEM_CHARS = 800;

const projectRootCache = new Map<string, string>();

export async function getProjectRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
	const key = path.resolve(cwd);
	const cached = projectRootCache.get(key);
	if (cached) return cached;

	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: key, timeout: 3000 }).catch(() => undefined);
	const root = result && result.code === 0 && result.stdout.trim() ? path.resolve(result.stdout.trim()) : key;
	projectRootCache.set(key, root);
	return root;
}

export function memoryDir(projectRoot: string): string {
	return path.join(projectRoot, AGENTS_DIR, MEMORY_SUBDIR);
}

/** Standard project skills directory, discovered natively by pi and other harnesses. */
export function skillsDir(projectRoot: string): string {
	return path.join(projectRoot, AGENTS_DIR, SKILLS_SUBDIR);
}

/** User-level skills directory (shared with other harnesses), used for autolearn dedupe. */
export function globalSkillsDir(): string {
	return path.join(homedir(), AGENTS_DIR, SKILLS_SUBDIR);
}

export function memoryFile(projectRoot: string): string {
	return path.join(memoryDir(projectRoot), "MEMORY.md");
}

export function contextFile(projectRoot: string): string {
	return path.join(memoryDir(projectRoot), "CONTEXT.md");
}

/** Session index maintained by the archive layer (session-context, no LLM). */
export function sessionIndexFile(projectRoot: string): string {
	return path.join(memoryDir(projectRoot), "session-index.md");
}

export function logsDir(projectRoot: string): string {
	return path.join(memoryDir(projectRoot), SESSION_LOGS_SUBDIR);
}

export function legacyPiDir(projectRoot: string): string {
	return path.join(projectRoot, LEGACY_DIR);
}

export function legacyOmpDir(projectRoot: string): string {
	const encoded = `--${projectRoot.replaceAll(path.sep, "-")}--`;
	return path.join(homedir(), ".omp", "agent", "memories", encoded);
}

export function safeSessionId(sessionId: string): string {
	return sessionId.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 128) || "ephemeral";
}

export function validSkillName(name: string): boolean {
	return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name);
}

export function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	try {
		if (ctx.hasUI) ctx.ui.notify(message, type);
	} catch {
		// Notifications must never break a handler; the UI may already be tearing down.
	}
}

/** Append a swallowed failure to `<project>/.agents/memory/errors.log` so it is diagnosable later. */
export async function logError(projectRoot: string, scope: string, error: unknown): Promise<void> {
	try {
		const file = path.join(memoryDir(projectRoot), "errors.log");
		await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
		const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
		await appendFile(file, `${new Date().toISOString()} [${scope}] ${detail}\n`, { encoding: "utf8", mode: 0o600 });
	} catch {
		// Diagnostics must never throw.
	}
}

export async function readOptional(file: string): Promise<string> {
	try {
		return await readFile(file, "utf8");
	} catch {
		return "";
	}
}

export async function pathExists(target: string): Promise<boolean> {
	try {
		await stat(target);
		return true;
	} catch {
		return false;
	}
}

export async function writeAtomic(file: string, content: string): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${process.pid}.tmp`;
	await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, file);
}

async function movePath(source: string, destination: string): Promise<void> {
	await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
	try {
		await rename(source, destination);
	} catch {
		await cp(source, destination, { recursive: true, force: false, errorOnExist: false });
		await rm(source, { recursive: true, force: true });
	}
}

/** Merge legacy artifacts into the new location; newest content wins, then the legacy path is removed. */
async function mergePath(source: string, destination: string): Promise<boolean> {
	if (!await pathExists(source)) return false;
	if (!await pathExists(destination)) {
		await movePath(source, destination);
		return true;
	}

	const sourceStat = await stat(source);
	const destinationStat = await stat(destination);
	if (sourceStat.isDirectory() && destinationStat.isDirectory()) {
		for (const entry of await readdir(source, { withFileTypes: true })) {
			await mergePath(path.join(source, entry.name), path.join(destination, entry.name));
		}
		await rm(source, { recursive: true, force: true });
		return true;
	}

	if (sourceStat.isDirectory()) {
		// Directory vs file conflict cannot be merged automatically; keep the new location.
		await rm(source, { recursive: true, force: true });
		return true;
	}

	if (sourceStat.mtimeMs > destinationStat.mtimeMs) {
		await cp(source, destination, { force: true });
	}
	await rm(source, { force: true });
	return true;
}

/** Remove leftover `<name>.<pid>.tmp` files from interrupted atomic writes. */
async function cleanStaleTemps(directory: string): Promise<void> {
	let entries: Awaited<ReturnType<typeof readdir>>;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return;
	}
	const cutoff = Date.now() - 60 * 60 * 1000;
	for (const entry of entries) {
		if (!entry.isFile() || !/\.\d+\.tmp$/.test(entry.name)) continue;
		const file = path.join(directory, entry.name);
		try {
			if ((await stat(file)).mtimeMs < cutoff) await rm(file, { force: true });
		} catch {
			// Best effort.
		}
	}
}

function normalizeSkillDocument(name: string, raw: string): string {
	if (raw.startsWith("---")) return `${raw.trimEnd()}\n`;
	const description = raw.split("\n")[0].trim().slice(0, 1024);
	return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${raw.trim()}\n`;
}

async function importSkillDirs(sourceDir: string, targetDir: string, options: { remove?: boolean } = {}): Promise<number> {
	let entries: Awaited<ReturnType<typeof readdir>>;
	try {
		entries = await readdir(sourceDir, { withFileTypes: true });
	} catch {
		return 0;
	}

	let imported = 0;
	for (const entry of entries) {
		if (!entry.isDirectory() || !validSkillName(entry.name)) continue;
		const source = path.join(sourceDir, entry.name);
		const raw = (await readOptional(path.join(source, "SKILL.md"))).trim();
		if (!raw) continue;
		const destination = path.join(targetDir, entry.name, "SKILL.md");
		if (await readOptional(destination)) {
			if (options.remove) await rm(source, { recursive: true, force: true });
			continue;
		}
		await writeAtomic(destination, normalizeSkillDocument(entry.name, raw));
		if (options.remove) await rm(source, { recursive: true, force: true });
		imported += 1;
	}
	if (options.remove) await rmdir(sourceDir).catch(() => undefined);
	return imported;
}

export type MigrationResult = {
	moved: string[];
	importedSkills: number;
	importedMemory: boolean;
};

/** Consolidate legacy memory, context, logs and skills into the `.agents/` layout. */
export async function migrateProjectState(projectRoot: string): Promise<MigrationResult> {
	const moved: string[] = [];
	const legacyPi = legacyPiDir(projectRoot);
	const moves: Array<[string, string]> = [
		[path.join(legacyPi, "MEMORY.md"), memoryFile(projectRoot)],
		[path.join(legacyPi, "CONTEXT.md"), contextFile(projectRoot)],
		[path.join(legacyPi, SESSION_LOGS_SUBDIR), logsDir(projectRoot)],
	];
	for (const [source, destination] of moves) {
		if (await mergePath(source, destination)) moved.push(path.relative(projectRoot, destination) || destination);
	}

	const importedSkills =
		await importSkillDirs(path.join(legacyPi, SKILLS_SUBDIR), skillsDir(projectRoot), { remove: true }) +
		await importSkillDirs(path.join(memoryDir(projectRoot), SKILLS_SUBDIR), skillsDir(projectRoot), { remove: true }) +
		await importSkillDirs(path.join(legacyOmpDir(projectRoot), SKILLS_SUBDIR), skillsDir(projectRoot));

	let importedMemory = false;
	if (!await pathExists(memoryFile(projectRoot))) {
		for (const name of ["MEMORY.md", "memory_summary.md", "learned.md"]) {
			const source = path.join(legacyOmpDir(projectRoot), name);
			const text = (await readOptional(source)).trim();
			if (!text) continue;
			await writeAtomic(memoryFile(projectRoot), text.endsWith("\n") ? text : `${text}\n`);
			importedMemory = true;
			break;
		}
	}

	await cleanStaleTemps(legacyPi);
	await cleanStaleTemps(memoryDir(projectRoot));
	// Drop the legacy directory when migration emptied it; pi recreates it if ever needed.
	await rmdir(legacyPi).catch(() => undefined);

	return { moved, importedSkills, importedMemory };
}

export async function loadMemory(projectRoot: string): Promise<{ text: string; source: string }> {
	const target = memoryFile(projectRoot);
	const current = (await readOptional(target)).trim();
	if (current) return { text: current.slice(0, MAX_MEMORY_CHARS), source: target };

	const legacyPi = path.join(legacyPiDir(projectRoot), "MEMORY.md");
	const fromPi = (await readOptional(legacyPi)).trim();
	if (fromPi) return { text: fromPi.slice(0, MAX_MEMORY_CHARS), source: legacyPi };

	for (const name of ["MEMORY.md", "memory_summary.md", "learned.md"]) {
		const fallback = path.join(legacyOmpDir(projectRoot), name);
		const text = (await readOptional(fallback)).trim();
		if (text) return { text: text.slice(0, MAX_MEMORY_CHARS), source: fallback };
	}

	return { text: "", source: target };
}
