/**
 * The handoff subsystem's public surface.
 *
 * The implementation lives in the sibling modules — `threshold` (the trigger and the receipt
 * that names the binding term), `language` / `prompt` / `text` (what the continuation says and
 * carries), `summary` (the one model call), `file-ops`, `question`, `settings`, `state` — and
 * this module re-exports what the extension entry and the tests address by name.
 */

export { detectHandoffLanguage, isHandoffPromptText, languageMessagesFor, resolveLanguage } from "./language.ts";
export type { HandoffLanguage } from "./language.ts";
export { buildHandoffDocument, buildHandoffPrompt, localizeSummaryHeadings } from "./prompt.ts";
export type { HandoffDocumentParts, HandoffPromptParts } from "./prompt.ts";
export { registerHandoff, statusText } from "./run.ts";
export { REPLAY_MARKER, SPLIT_TURN_MARKER, replayMessagesFor } from "./text.ts";
export { resolveThreshold, thresholdRefusal, thresholdRefusalText } from "./threshold.ts";
export type { Threshold, ThresholdRefusal } from "./threshold.ts";
