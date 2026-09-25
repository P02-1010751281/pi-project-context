/**
 * The handoff transaction and its triggers: the runner, the automatic trigger, the command
 * registration and the status receipt.
 */

import path from "node:path";
import { type AgentMessage } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, buildContextEntries, estimateTokens, findCutPoint, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { MAX_KEEP_RECENT_TOKENS, MIN_SUMMARIZE_TOKENS, setFeature } from "../shared/config.ts";
import { resolveAuxModel } from "../shared/llm.ts";
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
import { generateHandoffSummary } from "./summary.ts";
import { replayEntries, replayMessagesFor } from "./text.ts";
import { type Threshold, capSuffix, resolveThreshold, thresholdRefusal, thresholdRefusalText } from "./threshold.ts";

/** Exported so tests can read the status receipt without going through the command registration. */
export function statusText(ctx: ExtensionContext): string {
	const keep = config.handoffKeepTokens > 0 ? `~${fmtTokens(config.handoffKeepTokens)} recent kept` : "summary only";
	const usage = ctx.getContextUsage();
	let thresholdLabel = config.handoffAdaptive ? "auto" : fmtPct(config.handoffThresholdRatio * 100);
	let threshold: Threshold | undefined;
	if (usage && usage.tokens !== null) {
		threshold = resolveThreshold(ctx, usage, resolveAuxModel(ctx, config));
		if (threshold) thresholdLabel = threshold.label + capSuffix(threshold.bound);
		else if (config.handoffAdaptive) {
			// Never render every refusal as a claim about the window: name the term that refused.
			const refusal = thresholdRefusal(ctx, usage, resolveAuxModel(ctx, config));
			thresholdLabel = refusal === undefined ? "auto" : thresholdRefusalText(refusal, ctx, usage);
		}
	}
	// With a usable threshold the status reports the projected prefix after caps, so a cap cannot be
	// misread as the configured minimum; the real cut can only be shorter. Without usage it echoes the
	// configured target.
	const target = config.handoffAdaptive
		? threshold?.summarizeTokens !== undefined
			? ` · summarize ${fmtTokens(threshold.summarizeTokens)}`
			: ` · target ${fmtTokens(config.handoffTargetTokens)}`
		: "";
	const language = config.handoffLanguage === "auto"
		? `auto (${resolveLanguage(buildContextEntries(ctx.sessionManager.getBranch(), ctx.sessionManager.getLeafId()).flatMap(sessionEntryToContextMessages), config.handoffLanguage)})`
		: config.handoffLanguage;
	return `Auto handoff ${handoffEnabled() ? "ON" : "OFF"} · threshold ${thresholdLabel}${target} · ${keep} · mode ${config.handoffMode} · guard ${config.handoffGuard} · lang ${language} · context ${usageText(ctx)}`;
}

/**
 * Summarize the older context and continue in a fresh session.
 * Must run with an ExtensionCommandContext, because newSession() is command-only.
 */
async function runHandoff(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const trigger = args.trim();
	const force = trigger === "force" || trigger === "force-auto";
	// "force-auto" marks the scheduled agent_settled trigger; only it applies the
	// pending-question guard, so /auto-handoff now keeps the configured mode.
	const autoTriggered = trigger === "force-auto";
	try {
		if (!ctx.isIdle()) {
			notify(ctx, "Auto handoff skipped: the agent is busy.", "warning");
			return;
		}
		// The threshold uses the session model's window/pricing tier and caps the summarized prefix
		// against the configured auxiliary route's window.
		const model = resolveAuxModel(ctx, config);
		if (!model) {
			notify(ctx, "Auto handoff skipped: no authenticated model available.", "warning");
			return;
		}

		const usage = ctx.getContextUsage();
		let threshold: Threshold | undefined;
		if (!force) {
			if (!handoffEnabled()) return;
			if (!usage || usage.tokens === null || usage.percent === null) return;
			threshold = resolveThreshold(ctx, usage, model);
			if (!threshold || usage.tokens < threshold.tokens) return;
		}

		const allEntries = buildContextEntries(ctx.sessionManager.getBranch(), ctx.sessionManager.getLeafId());
		if (allEntries.length === 0) {
			notify(ctx, "Auto handoff skipped: this session has no messages yet.", "warning");
			return;
		}

		// Older context gets summarized; the recent tail is carried over verbatim.
		let firstKeptIndex = allEntries.length;
		if (config.handoffKeepTokens > 0) {
			// Cut where the keep budget runs out, mid-turn included: pi cuts at conversation
			// boundaries and never at a tool result, so the replay stays parseable — a result whose call
			// was summarized is folded into the summary, and a slice opening on an assistant message is
			// marked by SPLIT_TURN_MARKER. Backing the cut up to the turn start instead (the old
			// behavior) kept the whole turn, which left nothing older to summarize whenever one turn
			// exceeded the keep window and blocked the handoff entirely.
			const cut = findCutPoint(allEntries, 0, allEntries.length, config.handoffKeepTokens);
			firstKeptIndex = cut.firstKeptEntryIndex;
		}
		// Stale continuation prompts are replaced by a marker on replay: verbatim they read as a
		// fresh instruction and open the new session with an already-superseded state.
		const keptSlice = allEntries.slice(firstKeptIndex);
		const olderEntries = allEntries.slice(0, firstKeptIndex);
		// If the older span starts with a previous compaction, let the summarizer update it
		// instead of feeding the old summary in as ordinary conversation.
		const previousCompaction = [...olderEntries].reverse().find((entry) => entry.type === "compaction");
		// Language sampling sees the raw slice (prompts included; `languageSamples` filters them
		// itself), while the replay and its token budget use the marker-substituted messages.
		const carriedMessages = keptSlice.flatMap(sessionEntryToContextMessages);
		// A result whose call was summarized cannot be replayed; the summary takes it over so the
		// content is not lost. It stays in the raw carried slice for accounting (usage held it), while
		// `olderTokens` counts the prefix only, so the subtraction below never double-counts it.
		const droppedOrphans: AgentMessage[] = [];
		const keptMessages = replayMessagesFor(keptSlice, droppedOrphans);
		const olderPrefixMessages = olderEntries.filter((entry) => entry.type !== "compaction").flatMap(sessionEntryToContextMessages);
		const olderMessages = [...olderPrefixMessages, ...droppedOrphans];

		// Skip when there is nothing real to summarize (e.g. only a previous compaction summary,
		// or a session that already fits the keep window). The command path is
		// user-initiated, so say why instead of returning silently.
		if (!olderMessages.some((message) => message.role === "user" || message.role === "assistant")) {
			// Auto can land here on every settle while the session fits the keep window; back off
			// so the warning does not repeat with each turn.
			if (autoTriggered) armHandoffCooldown(RETRIGGER_COOLDOWN_MS);
			notify(ctx, "Auto handoff skipped: nothing older than the recent window to summarize.", "warning");
			return;
		}

		const olderTokens = olderPrefixMessages.reduce((sum, message) => sum + estimateTokens(message), 0);
		const sliceTokens = carriedMessages.reduce((sum, message) => sum + estimateTokens(message), 0);
		const keptTokens = keptMessages.reduce((sum, message) => sum + estimateTokens(message), 0);
		// Floor: below this the summary saves too little and drops too much detail.
		if (!force && olderTokens < MIN_SUMMARIZE_TOKENS) return;

		// Pending-question guard: only automatic handoffs consult it, so an explicit
		// /auto-handoff keeps the configured mode. "skip" leaves the session as-is
		// until the user answers; "draft" is applied further below.
		const pendingQuestion = findPendingQuestion(allEntries);
		const guardApplies = autoTriggered && pendingQuestion !== undefined;
		if (guardApplies && config.handoffGuard === "skip") {
			armHandoffCooldown(RETRIGGER_COOLDOWN_MS);
			notify(ctx, "Auto handoff skipped: the session is waiting for your answer (guard=skip).", "warning");
			return;
		}

		notify(ctx, `Auto handoff: summarizing ~${fmtTokens(olderTokens)} of context, keeping ~${fmtTokens(keptTokens)} recent...`, "info");

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			notify(ctx, `Auto handoff skipped: ${auth.error}`, "error");
			return;
		}
		const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;

		const language = resolveLanguage(languageMessagesFor(olderMessages, carriedMessages), config.handoffLanguage);
		const summary = await generateHandoffSummary(ctx, requestModel, auth, olderMessages, previousCompaction?.summary, language);

		const { readFiles, modifiedFiles } = computeFileLists(collectFileOps(olderEntries));
		const summaryWithIndex = `${summary}${formatFileOperations(readFiles, modifiedFiles)}`;
		const summaryTokens = Math.ceil(summaryWithIndex.length / 4);
		if (!force && usage && usage.tokens !== null && threshold) {
			// Baseline = system prompt, tool schemas, and injected memory/context. The stale prompts
			// replaced by markers are still part of the measured usage, so subtract the raw slice.
			const baselineNow = Math.max(0, usage.tokens - olderTokens - sliceTokens);
			const estimatedAfter = baselineNow + keptTokens + summaryTokens + 1_500;
			if (estimatedAfter >= threshold.tokens) {
				notify(
					ctx,
					`Auto handoff skipped: the fresh session would start at ~${fmtTokens(estimatedAfter)}, too close to the ${threshold.label} threshold to help.`,
					"warning",
				);
				return;
			}
		}

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
			summaryWithIndex,
			previousSessionId,
			previousSessionFile: previousSessionFile || undefined,
		});

		// A new prompt can arrive while the handoff summary is being generated.
		// Replacing the session now would abort that run and leave its user message
		// unanswered (and the TUI stuck on "Working"), so skip and let the next
		// agent_settled retrigger once the session is idle again.
		if (!ctx.isIdle()) {
			armHandoffCooldown(RETRIGGER_COOLDOWN_MS);
			notify(ctx, "Auto handoff skipped: the agent became busy while summarizing. It will retry when idle.", "warning");
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
					summaryWithIndex,
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
									? `Auto handoff: fresh session prepared, but left for your review because the previous session was waiting on your answer (${percentText} full). Answer in the prompt, then press Enter.`
									: `Auto handoff: fresh session prepared (previous was ${percentText} full). Review the prompt, then press Enter to continue.`,
								"info",
							);
						} else {
							await replacementCtx.sendUserMessage(handoffPrompt);
							notify(
								replacementCtx,
								guardWaiting
									? `Auto handoff: continued in a fresh session (previous was ${percentText} full); the open question was carried over and the agent will wait for your answer.`
									: `Auto handoff: continued in a fresh session (previous was ${percentText} full, summary ~${fmtTokens(summaryTokens)}, kept ~${fmtTokens(keptTokens)} recent).`,
								"info",
							);
						}
					} catch (error) {
						notify(replacementCtx, `Auto handoff: failed to start the continuation — ${errorText(error)}`, "error");
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
			notify(ctx, "Auto handoff cancelled by another extension.", "warning");
			return;
		}
		armHandoffCooldown(RETRIGGER_COOLDOWN_MS);
	} catch (error) {
		armHandoffFailureBackoff(FAILURE_BACKOFF_MS);
		notify(ctx, `Auto handoff failed: ${errorText(error)}. Staying in this session; pi auto-compaction still applies.`, "error");
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
	const threshold = resolveThreshold(ctx, usage, resolveAuxModel(ctx, config));
	if (!threshold || usage.tokens < threshold.tokens) return;

	setHandoffInFlight(true);
	// Defer past agent_settled bookkeeping before the session is replaced.
	setTimeout(() => {
		try {
			// Extension commands execute immediately and get the command context needed for newSession().
			pi.sendUserMessage("/auto-handoff force-auto", { expandPromptTemplates: true });
		} catch (error) {
			setHandoffInFlight(false);
			notify(ctx, `Auto handoff trigger failed: ${errorText(error)}`, "error");
		}
	}, 0);
}

export function registerHandoff(pi: ExtensionAPI): void {
	pi.registerFlag("handoff-ratio", {
		type: "string",
		description: "Auto handoff threshold: fixed ratio (0.4, 40%), auto, or off",
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
			if (flag === "auto") config.handoffAdaptive = true;
			else if (flag === "off") setFlagEnabled(false);
			else {
				const ratio = parseRatio(flag);
				if (ratio !== undefined) {
					config.handoffAdaptive = false;
					config.handoffThresholdRatio = ratio;
				}
			}
		}
		if (pi.getFlag("no-auto-handoff") === true) setFlagEnabled(false);
	});

	pi.on("agent_settled", (_event, ctx) => {
		maybeTrigger(pi, ctx);
	});

	pi.registerCommand("auto-handoff", {
		description: "Fresh session when context hits the threshold (status|on|off|auto|<ratio>|target|keep|thinking|send|draft|guard|lang|now)",
		handler: async (args, ctx) => {
			if (!getConfigRoot()) await syncConfig(await getProjectRoot(pi, ctx.cwd).catch(() => undefined));
			const arg = args.trim().toLowerCase();
			const [head, value] = arg.split(/\s+/);
			if (!head || head === "status") {
				notify(ctx, statusText(ctx));
				return;
			}
			if (head === "keep") {
				if (value === "off") {
					config.handoffKeepTokens = 0;
				} else {
					const tokens = parseTokenCount(value ?? "");
					if (tokens === undefined || tokens > MAX_KEEP_RECENT_TOKENS) {
						notify(ctx, "Usage: /auto-handoff keep <tokens|off> (e.g. keep 20k)", "warning");
						return;
					}
					config.handoffKeepTokens = tokens;
				}
				await saveConfig();
				notify(
					ctx,
					config.handoffKeepTokens > 0
						? `Auto handoff will keep ~${fmtTokens(config.handoffKeepTokens)} recent tokens verbatim.`
						: "Auto handoff will use summary only (no recent carry-over).",
				);
				return;
			}
			if (head === "target") {
				const tokens = parseTokenCount(value ?? "");
				if (tokens === undefined || tokens < MIN_SUMMARIZE_TOKENS || tokens > MAX_KEEP_RECENT_TOKENS) {
					notify(ctx, "Usage: /auto-handoff target <tokens> (e.g. target 64k)", "warning");
					return;
				}
				config.handoffTargetTokens = tokens;
				await saveConfig();
				notify(ctx, `Auto summarize target: ~${fmtTokens(tokens)} per handoff before caps (the physical floor stays at ${fmtTokens(MIN_SUMMARIZE_TOKENS)}).`);
				return;
			}
			if (head === "thinking") {
				if (value !== "off" && value !== "session") {
					notify(ctx, "Usage: /auto-handoff thinking off|session", "warning");
					return;
				}
				config.handoffSummaryThinking = value;
				await saveConfig();
				notify(
					ctx,
					value === "off"
						? "Handoff summaries will run without thinking (faster, avoids the shared token cap)."
						: "Handoff summaries will use the session thinking level (may hit the shared token cap).",
				);
				return;
			}
			if (head === "auto") {
				config.handoffAdaptive = true;
				await saveConfig();
				if (value) {
					notify(ctx, "Adaptive mode takes no ratio; use /auto-handoff 0.6 for a fixed share.", "warning");
				}
				notify(ctx, statusText(ctx));
				return;
			}
			if (head === "on" || head === "off") {
				if (!getConfigRoot()) setConfigRoot(await getProjectRoot(pi, ctx.cwd).catch(() => undefined));
				const root = getConfigRoot();
				if (root) await setFeature(root, "handoff", head === "on");
				notify(ctx, head === "on" ? statusText(ctx) : "Auto handoff disabled.");
				return;
			}
			if (head === "send" || head === "draft") {
				config.handoffMode = head;
				await saveConfig();
				notify(ctx, `Auto handoff mode: ${head}.`);
				return;
			}
			if (head === "guard") {
				if (value !== "wait" && value !== "draft" && value !== "send" && value !== "skip") {
					notify(ctx, "Usage: /auto-handoff guard wait|draft|send|skip", "warning");
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
					notify(ctx, "Usage: /auto-handoff lang auto|zh|en", "warning");
					return;
				}
				config.handoffLanguage = value;
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
			const ratio = parseRatio(head);
			if (ratio !== undefined) {
				config.handoffAdaptive = false;
				config.handoffThresholdRatio = ratio;
				await saveConfig();
				notify(ctx, `Auto handoff threshold set to ${fmtPct(ratio * 100)} of the window.`);
				return;
			}
			notify(ctx, `Unknown option "${arg}". Usage: /auto-handoff [on|off|auto|<ratio>|target <tokens>|keep <tokens>|thinking off|session|send|draft|guard <wait|draft|send|skip>|lang <auto|zh|en>|now|status]`, "warning");
		},
	});
}
