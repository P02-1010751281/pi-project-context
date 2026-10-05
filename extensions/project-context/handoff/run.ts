/**
 * The handoff transaction and its triggers: the runner, the automatic trigger, the command
 * registration and the status receipt.
 */

import path from "node:path";
import { type AgentMessage } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, buildContextEntries, estimateTokens, findCutPoint, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { MAX_KEEP_RECENT_TOKENS, MIN_SUMMARIZE_TOKENS, setFeature } from "../shared/config.ts";
import { completeSubValues, completeValues, completeVerbs } from "../shared/complete.ts";
import { errorText, getProjectRoot, logError, memoryDir, notify, safeSessionId, writeAtomic } from "../shared/project-state.ts";
import { resolveHandoffParentSession } from "./session-lineage.ts";
import { clearHandoffSessionSettings, stageHandoffSessionSettings } from "./session-settings.ts";
import { collectFileOps, computeFileLists, formatFileOperations } from "./file-ops.ts";
import { fmtPct, fmtTokens } from "./format.ts";
import { languageMessagesFor, resolveLanguage } from "./language.ts";
import { buildHandoffDocument, buildHandoffPrompt } from "./prompt.ts";
import { findPendingQuestion } from "./question.ts";
import { config, getConfigRoot, handoffEnabled, parseRatio, parseTokenCount, saveConfig, setConfigRoot, setFlagEnabled, syncConfig, usageText } from "./settings.ts";
import { FAILURE_BACKOFF_MS, RETRIGGER_COOLDOWN_MS, armHandoffCooldown, armHandoffFailureBackoff, handoffCooldownUntil, handoffFailureBackoffUntil, handoffInFlight, setHandoffInFlight } from "./state.ts";
import { replayEntries, replayMessagesFor } from "./text.ts";
import { type Threshold, capSuffix, resolveThreshold, thresholdOverrideText, thresholdRefusal, thresholdRefusalText } from "./threshold.ts";

/** Exported so tests can read the status receipt without going through the command registration. */
export function handoffStatusLine(ctx: ExtensionContext): string {
	const keep = config.handoffBudgetRecentTokens > 0 ? `~${fmtTokens(config.handoffBudgetRecentTokens)} recent carried` : "no recent carry-over";
	const usage = ctx.getContextUsage();
	let thresholdLabel = config.handoffThresholdAuto ? "auto" : fmtPct(config.handoffThresholdRatio * 100);
	let threshold: Threshold | undefined;
	if (usage && usage.tokens !== null) {
		threshold = resolveThreshold(ctx, usage);
		if (threshold) {
			thresholdLabel = threshold.label + capSuffix(threshold.bound);
			// A manual target the guardrail landed below must be named, not silently ignored: a user who
			// raised it and sees the same trigger has been sent to a control that does nothing.
			if (threshold.override) thresholdLabel += ` · ${thresholdOverrideText(threshold.override, usage.contextWindow)}`;
		} else if (config.handoffThresholdAuto) {
			// Never render every refusal as a claim about the window: name the term that refused.
			const refusal = thresholdRefusal(ctx, usage);
			thresholdLabel = refusal === undefined ? "auto" : thresholdRefusalText(refusal, ctx, usage);
		}
	}
	// With a usable threshold the status reports the projected prefix after caps, so a cap cannot be
	// misread as the configured minimum; the real cut can only be shorter. Without usage it echoes the
	// configured target.
	const target = config.handoffThresholdAuto
		? threshold?.dropTokens !== undefined
			? ` · drop ${fmtTokens(threshold.dropTokens)}`
			: ` · drop budget ${fmtTokens(config.handoffBudgetSummaryTokens)}`
		: "";
	const language = config.handoffLang === "auto"
		? `auto (${resolveLanguage(buildContextEntries(ctx.sessionManager.getBranch(), ctx.sessionManager.getLeafId()).flatMap(sessionEntryToContextMessages), config.handoffLang)})`
		: config.handoffLang;
	return `Handoff ${handoffEnabled() ? "ON" : "OFF"} · threshold ${thresholdLabel}${target} · ${keep} · mode ${config.handoffMode} · guard ${config.handoffGuard} · lang ${language} · context ${usageText(ctx)}`;
}

/**
 * Drop the older context, carry the recent tail into a fresh session and point the successor at the
 * session log that still holds everything dropped.
 * Must run with an ExtensionCommandContext, because newSession() is command-only.
 */
async function runHandoff(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const trigger = args.trim();
	const force = trigger === "force" || trigger === "force-auto";
	// "force-auto" marks the scheduled agent_settled trigger; only it applies the
	// pending-question guard, so /handoff now keeps the configured mode.
	const autoTriggered = trigger === "force-auto";
	try {
		if (!ctx.isIdle()) {
			notify(ctx, "Handoff: skipped — the agent is busy.", "warning");
			return;
		}
		// The threshold uses the session model's window and pricing tier. The handoff itself needs no
		// model call: the replacement gets the carried tail plus a pointer to the session log.
		const usage = ctx.getContextUsage();
		let threshold: Threshold | undefined;
		if (!force) {
			if (!handoffEnabled()) return;
			if (!usage || usage.tokens === null || usage.percent === null) return;
			threshold = resolveThreshold(ctx, usage);
			if (!threshold || usage.tokens < threshold.tokens) return;
		}

		const allEntries = buildContextEntries(ctx.sessionManager.getBranch(), ctx.sessionManager.getLeafId());
		if (allEntries.length === 0) {
			notify(ctx, "Handoff: skipped — this session has no messages yet.", "warning");
			return;
		}

		// Older context is dropped; the recent tail is carried over verbatim, and the dropped part stays
		// reachable through the session log the continuation points at.
		let firstKeptIndex = allEntries.length;
		// pi reports the turn start of a mid-turn cut; the successor cannot do without that message and
		// nothing carries it as prose, so its opening is anchored into the kept tail below. -1 means the
		// cut starts a turn.
		let splitTurnStart = -1;
		if (config.handoffBudgetRecentTokens > 0) {
			// Cut where the keep budget runs out, mid-turn included: pi cuts at conversation
			// boundaries and never at a tool result, so the replay stays parseable — a result whose call
			// was summarized is folded into the summary, and a slice opening on an assistant message is
			// marked by SPLIT_TURN_MARKER.
			const cut = findCutPoint(allEntries, 0, allEntries.length, config.handoffBudgetRecentTokens);
			firstKeptIndex = cut.firstKeptEntryIndex;
			splitTurnStart = cut.isSplitTurn ? cut.turnStartIndex : -1;
		}
		// A split turn exists only when that turn alone overruns the keep window, so keeping it whole
		// always overshoots the budget. Snap to its start while the overshoot stays inside one extra window
		// and the older side still holds something to drop; snapping unconditionally is what used to
		// leave nothing older to drop and block a handoff whose session was a single turn.
		if (splitTurnStart >= 0) {
			const prefixTokens = allEntries
				.slice(splitTurnStart, firstKeptIndex)
				.flatMap(sessionEntryToContextMessages)
				.reduce((sum, message) => sum + estimateTokens(message), 0);
			const olderHasContent = allEntries
				.slice(0, splitTurnStart)
				.flatMap(sessionEntryToContextMessages)
				.some((message) => message.role === "user" || message.role === "assistant");
			if (prefixTokens <= config.handoffBudgetRecentTokens && olderHasContent) firstKeptIndex = splitTurnStart;
		}
		// Stale continuation prompts are replaced by a marker on replay: verbatim they read as a
		// fresh instruction and open the new session with an already-superseded state.
		// When the turn cannot be kept whole, anchor its opening message ahead of the kept tail: nothing
		// else carries it and the successor needs what was asked verbatim. The middle stays in the dropped
		// prefix, reachable through the session log whose file list the continuation carries.
		const anchorEntry = splitTurnStart >= 0 && splitTurnStart < firstKeptIndex ? allEntries[splitTurnStart] : undefined;
		const keptSlice = anchorEntry ? [anchorEntry, ...allEntries.slice(firstKeptIndex)] : allEntries.slice(firstKeptIndex);
		const olderEntries = allEntries.slice(0, firstKeptIndex);
		// Language sampling sees the raw slice (prompts included; `languageSamples` filters them
		// itself), while the replay and its token budget use the marker-substituted messages.
		const carriedMessages = keptSlice.flatMap(sessionEntryToContextMessages);
		// A result whose call is not in the slice cannot be replayed. It stays in the raw carried slice
		// for accounting (usage held it), while `olderTokens` counts the prefix only, so the subtraction
		// below never double-counts it.
		const droppedOrphans: AgentMessage[] = [];
		const keptMessages = replayMessagesFor(keptSlice, droppedOrphans);
		const olderPrefixMessages = olderEntries.filter((entry) => entry.type !== "compaction").flatMap(sessionEntryToContextMessages);
		const olderMessages = [...olderPrefixMessages, ...droppedOrphans];

		// Skip when there is nothing real to drop (e.g. only a previous compaction entry, or a
		// session that already fits the keep window). The command path is
		// user-initiated, so say why instead of returning silently.
		if (!olderMessages.some((message) => message.role === "user" || message.role === "assistant")) {
			// Auto can land here on every settle while the session fits the keep window; back off
			// so the warning does not repeat with each turn.
			if (autoTriggered) armHandoffCooldown(RETRIGGER_COOLDOWN_MS);
			notify(ctx, "Handoff: skipped — nothing older than the recent window to drop.", "warning");
			return;
		}

		const olderTokens = olderPrefixMessages.reduce((sum, message) => sum + estimateTokens(message), 0);
		// The anchor is already counted by `olderTokens` (it sits in the dropped prefix), so the usage
		// baseline subtracts only the raw kept tail and never counts it twice.
		const sliceTokens = allEntries
			.slice(firstKeptIndex)
			.flatMap(sessionEntryToContextMessages)
			.reduce((sum, message) => sum + estimateTokens(message), 0);
		const keptTokens = keptMessages.reduce((sum, message) => sum + estimateTokens(message), 0);
		// Floor: below this dropping the prefix saves too little and loses too much detail.
		if (!force && olderTokens < MIN_SUMMARIZE_TOKENS) return;

		// Pending-question guard: only automatic handoffs consult it, so an explicit
		// /handoff keeps the configured mode. "skip" leaves the session as-is
		// until the user answers; "draft" is applied further below.
		const pendingQuestion = findPendingQuestion(allEntries);
		const guardApplies = autoTriggered && pendingQuestion !== undefined;
		if (guardApplies && config.handoffGuard === "skip") {
			armHandoffCooldown(RETRIGGER_COOLDOWN_MS);
			notify(ctx, "Handoff: skipped — the session is waiting for your answer (guard=skip).", "warning");
			return;
		}

		notify(ctx, `Handoff: dropping ~${fmtTokens(olderTokens)} of context, carrying ~${fmtTokens(keptTokens)} recent...`, "info");

		const language = resolveLanguage(languageMessagesFor(olderMessages, carriedMessages), config.handoffLang);

		const { readFiles, modifiedFiles } = computeFileLists(collectFileOps(olderEntries));
		const fileOperations = formatFileOperations(readFiles, modifiedFiles);

		// "wait" (default) keeps the continuation automatic but hands the open
		// question to the new session with a do-not-answer instruction; "draft"
		// additionally leaves the prompt in the editor for review.
		const guardWaiting = guardApplies && config.handoffGuard !== "send";
		const guardDraft = guardWaiting && config.handoffGuard === "draft";
		const useDraft = config.handoffMode === "draft" || guardDraft;
		const percentText = usage && usage.percent !== null ? fmtPct(usage.percent) : "over threshold";
		const previousSessionId = ctx.sessionManager.getSessionId();
		const previousSessionFile = ctx.sessionManager.getSessionFile();
		const handoffPrompt = buildHandoffPrompt({
			language,
			percent: usage && usage.percent !== null ? usage.percent : null,
			keptTokens,
			guardWaiting,
			pendingQuestion,
			fileOperations,
			previousSessionId,
			previousSessionFile: previousSessionFile || undefined,
		});
		// The prompt is built before the guardrail so its own length is what the estimate counts.
		const promptTokens = Math.ceil(handoffPrompt.length / 4);
		if (!force && usage && usage.tokens !== null && threshold) {
			// Baseline = system prompt, tool schemas, and injected memory/context. The stale prompts
			// replaced by markers are still part of the measured usage, so subtract the raw slice.
			const baselineNow = Math.max(0, usage.tokens - olderTokens - sliceTokens);
			const estimatedAfter = baselineNow + keptTokens + promptTokens + 1_500;
			if (estimatedAfter >= threshold.tokens) {
				notify(
					ctx,
					`Handoff: skipped — the fresh session would start at ~${fmtTokens(estimatedAfter)}, too close to the ${threshold.label} threshold to help.`,
					"warning",
				);
				return;
			}
		}

		// A new prompt can arrive while the handoff is being prepared.
		// Replacing the session now would abort that run and leave its user message
		// unanswered (and the TUI stuck on "Working"), so skip and let the next
		// agent_settled retrigger once the session is idle again.
		if (!ctx.isIdle()) {
			armHandoffCooldown(RETRIGGER_COOLDOWN_MS);
			notify(ctx, "Handoff: skipped — the agent became busy while preparing the replacement. It will retry when idle.", "warning");
			return;
		}

		// Archive the handoff document next to the project memory (the fresh session
		// carries a copy, but the file keeps it reachable after the fact).
		const handoffRoot = await getProjectRoot(pi, ctx.cwd).catch(() => undefined);
		if (handoffRoot) {
			try {
				const logRel = path.posix.join(".agents/memory/session-logs", safeSessionId(previousSessionId), "session.md");
				const document = buildHandoffDocument({
					language,
					previousSessionId,
					projectRoot: handoffRoot,
					sessionLogRel: logRel,
					fileOperations,
				});
				await writeAtomic(path.join(memoryDir(handoffRoot), "HANDOFF.md"), document);
			} catch {
				// Persisting the handoff document must never block the session switch.
			}
		}

		const parentSession = ctx.sessionManager.getSessionFile();
		const handoffParent = await resolveHandoffParentSession(parentSession);
		if (handoffRoot && parentSession) {
			// `newSession` resolves the replacement's model/thinking from pi's defaults; stage ours
			// so its `session_start` can restore them before the continuation prompt is sent.
			let thinkingLevel = ctx.thinkingLevel;
			if (thinkingLevel === undefined) {
				try {
					thinkingLevel = pi.getThinkingLevel();
				} catch {
					// Modes without a session thinking level simply restore the model.
				}
			}
			await stageHandoffSessionSettings(handoffRoot, {
				previousSessionFile: parentSession,
				model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
				thinkingLevel,
				at: Date.now(),
			}).catch((error: unknown) => logError(handoffRoot, "handoff:stage-session-settings", error));
			// `ctx.model` is documented as possibly undefined. Without it the replacement keeps pi's
			// default model (thinking would still be restored) and nothing else would ever say so.
			if (!ctx.model) {
				await logError(
					handoffRoot,
					"handoff:stage-session-settings",
					"the command context reported no current model, so only the thinking level travels to the replacement session; it will start on pi's default model",
				).catch(() => {});
			}
		}
		const result = await ctx
			.newSession({
				parentSession: handoffParent,
				setup: async (sessionManager) => {
					replayEntries(sessionManager, keptSlice);
				},
				withSession: async (replacementCtx) => {
					try {
						if (useDraft) {
							replacementCtx.ui.setEditorText(handoffPrompt);
							notify(
								replacementCtx,
								guardDraft
									? `Handoff: fresh session prepared, but left for your review because the previous session was waiting on your answer (${percentText} full). Answer in the prompt, then press Enter.`
									: `Handoff: fresh session prepared (previous was ${percentText} full). Review the prompt, then press Enter to continue.`,
								"info",
							);
						} else {
							await replacementCtx.sendUserMessage(handoffPrompt);
							notify(
								replacementCtx,
								guardWaiting
									? `Handoff: continued in a fresh session (previous was ${percentText} full); the open question was carried over and the agent will wait for your answer.`
									: `Handoff: continued in a fresh session (previous was ${percentText} full, kept ~${fmtTokens(keptTokens)} recent; the dropped prefix stays in its session log).`,
								"info",
							);
						}
					} catch (error) {
						notify(replacementCtx, `Handoff: failed to start the continuation — ${errorText(error)}`, "error");
					}
				},
			})
			.catch(async (error: unknown) => {
				// A switch that threw never created a replacement, so its stage must not outlive it.
				if (handoffRoot) await clearHandoffSessionSettings(handoffRoot).catch(() => {});
				throw error;
			});
		if (result.cancelled) {
			if (handoffRoot) await clearHandoffSessionSettings(handoffRoot).catch(() => {});
			notify(ctx, "Handoff: cancelled by another extension.", "warning");
			return;
		}
		armHandoffCooldown(RETRIGGER_COOLDOWN_MS);
	} catch (error) {
		armHandoffFailureBackoff(FAILURE_BACKOFF_MS);
		notify(ctx, `Handoff: failed — ${errorText(error)}. Staying in this session.`, "error");
	} finally {
		setHandoffInFlight(false);
	}
}

function maybeTrigger(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!handoffEnabled() || handoffInFlight()) return;
	if (ctx.mode !== "tui") return;
	if (!ctx.isIdle()) return;
	const now = Date.now();
	if (now < handoffCooldownUntil() || now < handoffFailureBackoffUntil()) return;

	const usage = ctx.getContextUsage();
	if (!usage || usage.tokens === null) return;
	const threshold = resolveThreshold(ctx, usage);
	if (!threshold || usage.tokens < threshold.tokens) return;

	setHandoffInFlight(true);
	// Defer past agent_settled bookkeeping before the session is replaced.
	setTimeout(() => {
		try {
			// Extension commands execute immediately and get the command context needed for newSession().
			pi.sendUserMessage("/handoff force-auto", { expandPromptTemplates: true });
		} catch (error) {
			setHandoffInFlight(false);
			notify(ctx, `Handoff: trigger failed — ${errorText(error)}`, "error");
		}
	}, 0);
}

export function registerHandoff(pi: ExtensionAPI): void {
	pi.registerFlag("handoff-ratio", {
		type: "string",
		description: "Handoff threshold: fixed ratio (0.4, 40%), auto, or off",
	});
	pi.registerFlag("no-auto-handoff", {
		type: "boolean",
		default: false,
		description: "Disable automatic fresh-session handoff",
	});

	// Flags are applied after extension load, so read them once the session is up.
	pi.on("session_start", async (_event, ctx) => {
		await syncConfig(await getProjectRoot(pi, ctx.cwd).catch(() => undefined));
		setFlagEnabled(true);
		const ratioFlag = pi.getFlag("handoff-ratio");
		if (typeof ratioFlag === "string") {
			const flag = ratioFlag.trim().toLowerCase();
			if (flag === "auto") config.handoffThresholdAuto = true;
			else if (flag === "off") setFlagEnabled(false);
			else {
				const ratio = parseRatio(flag);
				if (ratio !== undefined) {
					config.handoffThresholdAuto = false;
					config.handoffThresholdRatio = ratio;
				}
			}
		}
		if (pi.getFlag("no-auto-handoff") === true) setFlagEnabled(false);
	});

	pi.on("agent_settled", (_event, ctx) => {
		maybeTrigger(pi, ctx);
	});

	pi.registerCommand("handoff", {
		description: "Fresh session when context hits the threshold (status|on|off|threshold|budget|thinking|mode|guard|lang|now)",
		getArgumentCompletions: (prefix) => {
			const verbs = completeVerbs(prefix, HANDOFF_VERBS);
			if (verbs) return verbs;
			for (const { head, values } of HANDOFF_VALUE_COMPLETIONS) {
				const items = completeValues(prefix, head, values);
				if (items) return items;
			}
			// The deepest argument (`budget recent off`) has no second-level table of its own.
			return completeSubValues(prefix, "budget", "recent", [{ value: "off", description: "carry no recent messages" }]);
		},
		handler: async (args, ctx) => {
			if (!getConfigRoot()) await syncConfig(await getProjectRoot(pi, ctx.cwd).catch(() => undefined));
			const arg = args.trim().toLowerCase();
			const [head, value, extra] = arg.split(/\s+/);
			if (!head || head === "status") {
				notify(ctx, handoffStatusLine(ctx));
				return;
			}
			if (head === "budget") {
				// The two token amounts are different quantities, so each name says what it sizes: the summary
				// the pass asks for, and the recent window carried over verbatim.
				if (value === "summary") {
					const tokens = parseTokenCount(extra ?? "");
					if (tokens === undefined || tokens < MIN_SUMMARIZE_TOKENS || tokens > MAX_KEEP_RECENT_TOKENS) {
						notify(ctx, "Usage: /handoff budget summary <tokens> (e.g. budget summary 64k)", "warning");
						return;
					}
					config.handoffBudgetSummaryTokens = tokens;
					await saveConfig();
					notify(ctx, `Handoff: summary budget ~${fmtTokens(tokens)} per handoff before caps (the physical floor stays at ${fmtTokens(MIN_SUMMARIZE_TOKENS)}).`);
					return;
				}
				if (value === "recent") {
					if (extra === "off") {
						config.handoffBudgetRecentTokens = 0;
					} else {
						const tokens = parseTokenCount(extra ?? "");
						if (tokens === undefined || tokens > MAX_KEEP_RECENT_TOKENS) {
							notify(ctx, "Usage: /handoff budget recent <tokens|off> (e.g. budget recent 20k)", "warning");
							return;
						}
						config.handoffBudgetRecentTokens = tokens;
					}
					await saveConfig();
					notify(
						ctx,
						config.handoffBudgetRecentTokens > 0
							? `Handoff: will carry ~${fmtTokens(config.handoffBudgetRecentTokens)} recent tokens verbatim.`
							: "Handoff: summary only, no recent carry-over.",
					);
					return;
				}
				notify(ctx, "Usage: /handoff budget summary <tokens> | budget recent <tokens|off>", "warning");
				return;
			}
			if (head === "thinking") {
				if (value !== "off" && value !== "session") {
					notify(ctx, "Usage: /handoff thinking off|session", "warning");
					return;
				}
				config.handoffThinking = value;
				await saveConfig();
				notify(
					ctx,
					value === "off"
						? "Handoff summaries will run without thinking (faster, avoids the shared token cap)."
						: "Handoff summaries will use the session thinking level (may hit the shared token cap).",
				);
				return;
			}
			if (head === "threshold") {
				// One verb for both modes: `auto` keeps the adaptive threshold, a ratio pins a fixed share.
				if (value === "auto") {
					config.handoffThresholdAuto = true;
					await saveConfig();
					if (extra) {
						notify(ctx, "Handoff: adaptive mode takes no ratio; use /handoff threshold 0.4 for a fixed share.", "warning");
						return;
					}
					notify(ctx, handoffStatusLine(ctx));
					return;
				}
				const ratio = parseRatio(value ?? "");
				if (ratio === undefined) {
					notify(ctx, "Usage: /handoff threshold <auto|0.1-0.95|10-95%> (e.g. threshold 0.6)", "warning");
					return;
				}
				config.handoffThresholdAuto = false;
				config.handoffThresholdRatio = ratio;
				await saveConfig();
				notify(ctx, `Handoff: threshold ${fmtPct(ratio * 100)} of the window.`);
				return;
			}
			if (head === "on" || head === "off") {
				if (!getConfigRoot()) setConfigRoot(await getProjectRoot(pi, ctx.cwd).catch(() => undefined));
				const root = getConfigRoot();
				if (root) await setFeature(root, "handoff", head === "on");
				notify(ctx, head === "on" ? handoffStatusLine(ctx) : "Handoff: disabled.");
				return;
			}
			if (head === "mode") {
				if (value !== "send" && value !== "draft") {
					notify(ctx, "Usage: /handoff mode send|draft", "warning");
					return;
				}
				config.handoffMode = value;
				await saveConfig();
				notify(ctx, `Handoff: mode ${value}.`);
				return;
			}
			if (head === "guard") {
				if (value !== "wait" && value !== "draft" && value !== "send" && value !== "skip") {
					notify(ctx, "Usage: /handoff guard wait|draft|send|skip", "warning");
					return;
				}
				config.handoffGuard = value;
				await saveConfig();
				notify(
					ctx,
					value === "wait"
						? "Pending-question guard: automatic handoffs continue, and the agent waits for your answer."
						: value === "draft"
							? "Pending-question guard: automatic handoffs wait for your review in the editor."
							: value === "send"
								? "Pending-question guard: automatic handoffs continue without waiting for your answer."
								: "Pending-question guard: automatic handoffs are skipped until the question is answered.",
				);
				return;
			}
			if (head === "lang" || head === "language") {
				if (value !== "auto" && value !== "zh" && value !== "en") {
					notify(ctx, "Usage: /handoff lang auto|zh|en", "warning");
					return;
				}
				config.handoffLang = value;
				await saveConfig();
				notify(
					ctx,
					value === "auto"
						? "Handoff scaffolding language: auto (follows the conversation)."
						: `Handoff scaffolding language: ${value}.`,
				);
				return;
			}
			if (head === "now" || head === "run" || head === "force") {
				await runHandoff(pi, "force", ctx);
				return;
			}
			if (head === "force-auto") {
				await runHandoff(pi, "force-auto", ctx);
				return;
			}
			notify(ctx, `Unknown option "${arg}". Usage: /handoff [status|on|off|threshold <auto|ratio>|budget summary <tokens>|budget recent <tokens|off>|thinking off|session|mode send|draft|guard <wait|draft|send|skip>|lang <auto|zh|en>|now]`, "warning");
		},
	});
}

/** Verbs the `handoff` command accepts, for argument completion (mirrors the handler's branches). */
const HANDOFF_VERBS = [
	{ value: "status" },
	{ value: "on" },
	{ value: "off" },
	{ value: "threshold", description: "adaptive, or a fixed share of the window" },
	{ value: "budget", description: "token amounts: the summary budget and the recent window" },
	{ value: "thinking", description: "thinking level for the summary" },
	{ value: "mode", description: "dismiss the handoff into a new session, or leave it in the editor" },
	{ value: "guard", description: "what to do while a question is pending" },
	{ value: "lang", description: "handoff scaffolding language" },
	{ value: "now", description: "hand off immediately" },
];

/** Second-argument completions, keyed by the verb that takes them. */
const HANDOFF_VALUE_COMPLETIONS = [
	{ head: "threshold", values: [{ value: "auto", description: "adaptive threshold (the default)" }] },
	{ head: "budget", values: [{ value: "summary", description: "summary budget tokens before caps" }, { value: "recent", description: "recent tokens carried over verbatim" }] },
	{ head: "thinking", values: [{ value: "off" }, { value: "session" }] },
	{ head: "mode", values: [{ value: "send" }, { value: "draft" }] },
	{ head: "guard", values: [{ value: "wait" }, { value: "draft" }, { value: "send" }, { value: "skip" }] },
	{ head: "lang", values: [{ value: "auto" }, { value: "zh" }, { value: "en" }] },
];
