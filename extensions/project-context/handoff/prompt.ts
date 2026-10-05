/**
 * The two texts a handoff emits: the continuation prompt and the archived document, both localized
 * through the scaffolding. Neither carries a generated summary: the replacement session gets the last
 * turns verbatim, the file list, and a pointer to the previous session's log, which holds every detail
 * the dropped prefix had.
 */

import { fmtPct } from "./format.ts";
import { type HandoffLanguage } from "./language.ts";

/** Localized scaffolding for the continuation prompt and the archived handoff document. */
interface HandoffScaffolding {
	preamble: (percentText: string) => string;
	percentUnknown: string;
	carryKept: string;
	carryNothing: string;
	verify: string;
	detailsHeading: string;
	detailSessionId: (sessionId: string) => string;
	detailTranscript: (file: string) => string;
	detailLookup: string;
	pendingHeading: string;
	closingContinue: string;
	closingPaused: string;
	documentTitle: (sessionId: string) => string;
	documentCreated: (iso: string) => string;
	documentProject: (root: string) => string;
	documentLog: (rel: string) => string;
	documentIndex: string;
}

export const SCAFFOLDING: Record<HandoffLanguage, HandoffScaffolding> = {
	en: {
		preamble: (percentText) => `This session continues work handed off from a previous session (${percentText} of its context window had been used).`,
		percentUnknown: "over threshold",
		carryKept: "The most recent messages of that session were carried over verbatim.",
		carryNothing: "No message of that session was carried over; every detail is in the session log.",
		verify: "Verify the current state of files with tools before re-applying changes, and do not redo completed work.",
		detailsHeading: "## Previous session details",
		detailSessionId: (sessionId) => `- Previous session id: ${sessionId}`,
		detailTranscript: (file) => `- Raw transcript (JSONL): ${file}`,
		detailLookup: "- A detail that is not in this session must be looked up in the session log linked by .agents/memory/session-logs/INDEX.md (grep; do not load whole files); a fact you are not sure of must not be answered from memory.",
		pendingHeading: "## Pending question (waiting for the user)",
		closingContinue: "Continue the task from where it left off.",
		closingPaused: "The task is paused on the pending question above. Do not choose an option or start work on the user's behalf; wait for their answer.",
		documentTitle: (sessionId) => `# Handoff from pi session ${sessionId}`,
		documentCreated: (iso) => `- Created: ${iso}`,
		documentProject: (root) => `- Project: ${root}`,
		documentLog: (rel) => `- Session log: ${rel}`,
		documentIndex: "- Session index: .agents/memory/session-logs/INDEX.md",
	},
	zh: {
		preamble: (percentText) => `本会话接手上一会话（其上下文窗口已用 ${percentText}）。`,
		percentUnknown: "阈值以上",
		carryKept: "上一会话最近的消息已原文带入本会话。",
		carryNothing: "上一会话没有原文带入本会话，细节都在它的会话日志里。",
		verify: "动手前先用工具核对文件当前状态，不要重做已完成的工作。",
		detailsHeading: "## 上一会话信息",
		detailSessionId: (sessionId) => `- 上一会话 id：${sessionId}`,
		detailTranscript: (file) => `- 原始记录（JSONL）：${file}`,
		detailLookup: "- 本会话里没有的细节，必须在 .agents/memory/session-logs/INDEX.md 指向的会话日志里查（用 grep，不要把整个文件读进来）；不确定的事实不得凭印象作答。",
		pendingHeading: "## 待用户回答的问题",
		closingContinue: "从上次中断处继续。",
		closingPaused: "任务停在上面的问题上。不要替用户选选项或开工，等用户回答。",
		documentTitle: (sessionId) => `# pi 会话 ${sessionId} 的交接文档`,
		documentCreated: (iso) => `- 生成时间：${iso}`,
		documentProject: (root) => `- 项目：${root}`,
		documentLog: (rel) => `- 会话日志：${rel}`,
		documentIndex: "- 会话索引：.agents/memory/session-logs/INDEX.md",
	},
};

export interface HandoffPromptParts {
	language: HandoffLanguage;
	percent: number | null;
	keptTokens: number;
	guardWaiting: boolean;
	pendingQuestion?: string;
	fileOperations: string;
	previousSessionId: string;
	previousSessionFile?: string;
}

/** Assemble the user message that opens the replacement session (pure; unit-tested). */
export function buildHandoffPrompt(parts: HandoffPromptParts): string {
	const text = SCAFFOLDING[parts.language];
	const percentText = parts.percent === null ? text.percentUnknown : fmtPct(parts.percent);
	const detailLines = [
		text.detailSessionId(parts.previousSessionId),
		...(parts.previousSessionFile ? [text.detailTranscript(parts.previousSessionFile)] : []),
		text.detailLookup,
	];
	const body = [
		text.preamble(percentText),
		parts.keptTokens > 0 ? text.carryKept : text.carryNothing,
		text.verify,
		"",
		text.detailsHeading,
		"",
		...detailLines,
	];
	const files = parts.fileOperations.trim();
	if (files) body.push("", files);
	if (parts.guardWaiting) body.push("", text.pendingHeading, "", parts.pendingQuestion ?? "", "");
	body.push(parts.guardWaiting ? text.closingPaused : text.closingContinue);
	return body.join("\n");
}

export interface HandoffDocumentParts {
	language: HandoffLanguage;
	previousSessionId: string;
	projectRoot: string;
	sessionLogRel: string;
	fileOperations: string;
	createdAt?: string;
}

/** The archived `.agents/memory/HANDOFF.md` document (pure; unit-tested). */
export function buildHandoffDocument(parts: HandoffDocumentParts): string {
	const doc = SCAFFOLDING[parts.language];
	const body = [
		doc.documentTitle(parts.previousSessionId),
		"",
		doc.documentCreated(parts.createdAt ?? new Date().toISOString()),
		doc.documentProject(parts.projectRoot),
		doc.documentLog(parts.sessionLogRel),
		doc.documentIndex,
	];
	const files = parts.fileOperations.trim();
	if (files) body.push("", files);
	body.push("");
	return body.join("\n");
}
