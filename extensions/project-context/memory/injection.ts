/**
 * The keep/index split for the two documents injected every turn.
 *
 * MEMORY.md keeps its behavioural gates and its lessons: those are the sections where a wrong answer is a
 * violation or a repeat of a fixed bug. Its map of the repo is worth a read only when a question turns on
 * it. CONTEXT.md keeps what the predecessor learned and left open; its narrative summary is the cheapest
 * section to look up.
 *
 * The read-first sentence is not decoration: the 2026-10-05 probe showed a bare pointer leaves a
 * non-reading model answering confidently and wrongly, while the same pointer with this sentence makes it
 * read. Both specs are exported so tests can check them against the render schemas they name.
 */

import { renderProgressiveBody, type InjectionSpec } from "../shared/inject.ts";
import { documentLanguage } from "../shared/lang.ts";

/** Shown to the reader; rendered against the project root so the reader's `read` resolves it from any cwd. */
const MEMORY_INJECTION_PATH = ".agents/memory/MEMORY.md";
const CONTEXT_INJECTION_PATH = ".agents/memory/CONTEXT.md";

export const MEMORY_INJECTION: InjectionSpec = {
	keep: ["Invariants", "Pitfalls"],
	pointers: {
		Project: {
			zh: "模块布局与发布模型；需要结构性背景时读它。",
			en: "module layout and release model; read it when you need structural background.",
		},
		Index: {
			zh: "文件→职责；定位「某功能在哪个文件」时读它。",
			en: "file → responsibility; read it to locate where a feature lives.",
		},
	},
	heading: { zh: "其余小节在 `{path}`：", en: "The remaining sections are in `{path}`:" },
	instruction: {
		zh: "凡涉及本项目的具体事实（字段名、路径、阈值、约束）而你不确定时，必须先 read 该文件再回答，不得凭印象作答。",
		en: "When a project fact (a field name, a path, a threshold, a constraint) decides the answer and you are not certain of it, read that file before answering instead of answering from impression.",
	},
	path: MEMORY_INJECTION_PATH,
};

export const CONTEXT_INJECTION: InjectionSpec = {
	keep: ["Key points", "Open tasks"],
	pointers: {
		Summary: {
			zh: "本会话进程摘要；需要「之前发生过什么」时读它。",
			en: "what this session is about and where it stands; read it for what happened before this.",
		},
	},
	heading: { zh: "其余小节在 `{path}`：", en: "The remaining sections are in `{path}`:" },
	instruction: {
		zh: "凡涉及本项目或本会话的具体事实（字段名、路径、阈值、约束）而你不确定时，必须先 read 该文件再回答，不得凭印象作答。",
		en: "When a project or session fact (a field name, a path, a threshold, a constraint) decides the answer and you are not certain of it, read that file before answering instead of answering from impression.",
	},
	path: CONTEXT_INJECTION_PATH,
};

/**
 * MEMORY.md as it enters the system prompt: kept sections inline, the rest behind one read-first pointer.
 * `projectRoot` makes the pointer an absolute path, which is what the reader's `read` tool can resolve.
 */
export function buildMemoryInjection(text: string, projectRoot?: string): string {
	return renderProgressiveBody(text, MEMORY_INJECTION, documentLanguage(text), projectRoot);
}

/** CONTEXT.md as it enters the system prompt, same shape as the memory injection. */
export function buildContextInjection(text: string, projectRoot?: string): string {
	return renderProgressiveBody(text, CONTEXT_INJECTION, documentLanguage(text), projectRoot);
}
