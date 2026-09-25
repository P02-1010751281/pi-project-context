/**
 * The two texts a handoff emits: the summarizer prompt and the continuation document, both
 * localized through the scaffolding.
 */

import { fmtPct } from "./format.ts";
import { type HandoffLanguage } from "./language.ts";

/**
 * pi's summarization prompt demands an EXACT section format, so models keep copying its English
 * headings even when the focus line asks for another language (observed on deepseek-flash). Map the
 * fixed heading set deterministically instead of relying on the model to translate the template.
 */
const SUMMARY_HEADINGS: Record<HandoffLanguage, Record<string, string>> = {
	zh: {
		"## Goal": "## 目标",
		"## Constraints & Preferences": "## 约束与偏好",
		"## Progress": "## 进展",
		"### Done": "### 已完成",
		"### In Progress": "### 进行中",
		"### Blocked": "### 受阻",
		"## Key Decisions": "## 关键决策",
		"## Next Steps": "## 下一步",
		"## Critical Context": "## 关键上下文",
	},
	en: {
		"## 目标": "## Goal",
		"## 约束与偏好": "## Constraints & Preferences",
		"## 进展": "## Progress",
		// Model-side translations observed in real summaries (TUI run, 2026-09-16).
		"## 进度": "## Progress",
		"### 已完成": "### Done",
		"### 进行中": "### In Progress",
		"### 受阻": "### Blocked",
		"### 阻塞": "### Blocked",
		"## 关键决策": "## Key Decisions",
		"## 下一步": "## Next Steps",
		"## 关键上下文": "## Critical Context",
	},
};

/** Localize the headings pi's template prescribes; only exact heading lines outside code fences are touched. */
export function localizeSummaryHeadings(text: string, language: HandoffLanguage): string {
	const headings = SUMMARY_HEADINGS[language];
	let fence: string | undefined;
	return text
		.split("\n")
		.map((line) => {
			const trimmed = line.trim();
			const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
			if (fenceMatch) {
				// Track fenced code blocks so heading-shaped lines inside them stay untouched.
				if (fence === undefined) fence = fenceMatch[1][0];
				else if (trimmed.startsWith(fence)) fence = undefined;
				return line;
			}
			if (fence !== undefined) return line;
			const mapped = headings[trimmed];
			if (!mapped) return line;
			const indent = line.slice(0, line.indexOf(trimmed));
			return `${indent}${mapped}`;
		})
		.join("\n");
}

/** Localized scaffolding for the continuation prompt and the archived handoff document. */
interface HandoffScaffolding {
	preamble: (percentText: string) => string;
	percentUnknown: string;
	carryKept: string;
	carrySummaryOnly: string;
	verify: string;
	guardWaiting: string;
	summaryHeading: string;
	detailsHeading: string;
	detailSessionId: (sessionId: string) => string;
	detailTranscript: (file: string) => string;
	detailIndex: string;
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
		carryKept: "The handoff summary below covers the earlier part of that session; its most recent messages were carried over verbatim.",
		carrySummaryOnly: "The handoff summary below is the only context carried from that session.",
		verify: "Verify the current state of files with tools before re-applying changes, and do not redo completed work.",
		guardWaiting: "The previous session stopped while waiting for the user's answer, so the decision is still open.",
		summaryHeading: "## Handoff Summary",
		detailsHeading: "## Previous session details",
		detailSessionId: (sessionId) => `- Previous session id: ${sessionId}`,
		detailTranscript: (file) => `- Raw transcript (JSONL): ${file}`,
		detailIndex: "- The project session index (.agents/memory/session-logs/INDEX.md) links the Markdown log for that id.",
		detailLookup: "If a needed detail is missing from this summary, look it up there (grep, do not load whole files).",
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
		carryKept: "下面的交接摘要覆盖上一会话较早的部分；其最近的消息已原文带入本会话。",
		carrySummaryOnly: "上一会话只留下下面的交接摘要，没有原文带入。",
		verify: "动手前先用工具核对文件当前状态，不要重做已完成的工作。",
		guardWaiting: "上一会话停在等你回答的问题上，这个决定仍未决。",
		summaryHeading: "## 交接摘要",
		detailsHeading: "## 上一会话信息",
		detailSessionId: (sessionId) => `- 上一会话 id：${sessionId}`,
		detailTranscript: (file) => `- 原始记录（JSONL）：${file}`,
		detailIndex: "- 项目会话索引 .agents/memory/session-logs/INDEX.md 里有该 id 的 Markdown 日志。",
		detailLookup: "摘要里缺的细节去那里查（用 grep，不要把整个文件读进来）。",
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
	summaryWithIndex: string;
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
		text.detailIndex,
		text.detailLookup,
	];
	const pendingLines = parts.guardWaiting ? ["", text.pendingHeading, "", parts.pendingQuestion ?? "", ""] : [];
	return [
		text.preamble(percentText),
		parts.keptTokens > 0 ? text.carryKept : text.carrySummaryOnly,
		text.verify,
		...(parts.guardWaiting ? [text.guardWaiting] : []),
		"",
		text.summaryHeading,
		"",
		parts.summaryWithIndex,
		"",
		text.detailsHeading,
		...detailLines,
		...pendingLines,
		parts.guardWaiting ? text.closingPaused : text.closingContinue,
	].join("\n");
}

export interface HandoffDocumentParts {
	language: HandoffLanguage;
	previousSessionId: string;
	projectRoot: string;
	sessionLogRel: string;
	summaryWithIndex: string;
	createdAt?: string;
}

/** The archived `.agents/memory/HANDOFF.md` document (pure; unit-tested). */
export function buildHandoffDocument(parts: HandoffDocumentParts): string {
	const doc = SCAFFOLDING[parts.language];
	return [
		doc.documentTitle(parts.previousSessionId),
		"",
		doc.documentCreated(parts.createdAt ?? new Date().toISOString()),
		doc.documentProject(parts.projectRoot),
		doc.documentLog(parts.sessionLogRel),
		doc.documentIndex,
		"",
		parts.summaryWithIndex.trim(),
		"",
	].join("\n");
}
