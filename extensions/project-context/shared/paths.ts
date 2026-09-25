/**
 * Where a project's `.agents` state lives, and the project root itself (with its cache): every
 * path helper plus the two name validators.
 */

import { homedir } from "node:os";
import path from "node:path";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const AGENTS_DIR = ".agents";

export const LEGACY_DIR = ".pi";

export const MEMORY_SUBDIR = "memory";

export const SKILLS_SUBDIR = "skills";

export const SESSION_LOGS_SUBDIR = "session-logs";

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

/** Append-only source of truth for the consolidated memory; `MEMORY.md` is its derived render. */
export function memoryJournalFile(projectRoot: string): string {
	return path.join(memoryDir(projectRoot), "memory.jsonl");
}

export function contextFile(projectRoot: string): string {
	return path.join(memoryDir(projectRoot), "CONTEXT.md");
}

/** Mechanical session index maintained by the archive layer, next to the logs it points at. */
export function sessionIndexFile(projectRoot: string): string {
	return path.join(logsDir(projectRoot), "INDEX.md");
}

/** Older index location (`<memory>/session-index.md`); read once during migration. */
export function legacySessionIndexFile(projectRoot: string): string {
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
