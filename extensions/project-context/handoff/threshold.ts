/**
 * The trigger: the conservative quality knee, the physical floor, the pricing-tier cap, and the receipt
 * that names which term bound.
 */

import { type ContextUsage, type ExtensionContext, buildContextEntries, estimateTokens, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { MAX_THRESHOLD_RATIO, MIN_DROP_TOKENS } from "../shared/config.ts";
import { fmtPct, fmtTokens } from "./format.ts";
import { config } from "./settings.ts";

/** pi's default compaction reserve; window headroom used by the threshold math. */
const WINDOW_RESERVE_TOKENS = 16_384;

/** Stay this far below a cost tier edge so streaming growth cannot cross it. */
const TIER_EDGE_MARGIN = 4_000;

/**
 * Conservative quality knee of long-context models, fitted to MRCR 8-needle data (GDM-MRCRv2 /
 * Context Arena population + vendor reports, 2026-09):
 *   knee(W) = W - (W - K) * sigmoid(ln(W / Wc) / s)
 * Observed honest windows (≤ ~400K: Codex 272K/400K, Claude 200K) keep their own boundary. The
 * transition starts at Wc = 450K because every 500K+ declaration measured so far is inflated —
 * grok-4.5/4.6 declare 500K while the family knee is ~195K, and DeepSeek-V4.1-Flash / GLM-5.3 /
 * Qwen3.8 declare 1M with measured knees of 130–170K. Beyond the transition the knee saturates at
 * K = 157K, the population median (46 models ≥ 1M: p25 127K / p50 157K / p75 190K). Deliberately
 * conservative: strong 1M models (GPT-5.6 ~250K, Gemini 3.7 ~450K, GPT-6 ≥ 512K) trigger earlier
 * than their own knee. The previous fit anchored K at 273K (GPT-5.6 / OpenAI's first tier) with
 * Wc = 650K, which let inflated declarations run 2–3× past their knee.
 */
const KNEE_ASYMPTOTE_TOKENS = 157_000;

const KNEE_TRANSITION_TOKENS = 450_000;

const KNEE_TRANSITION_STEEPNESS = 0.04;

/** Fitted knee curve: the share of the window that is still reliable. */
function kneeTokens(window: number): number {
	const z = Math.log(window / KNEE_TRANSITION_TOKENS) / KNEE_TRANSITION_STEEPNESS;
	return Math.round(window - (window - KNEE_ASYMPTOTE_TOKENS) / (1 + Math.exp(-z)));
}

/**
 * Which guardrail produced the final value: the adaptive guardrail (`adaptive` — the lower of the
 * conservative knee curve and the last usable point) or the first pricing tier (`tier`). Only
 * informative: the number is the contract, this says what to raise when it looks low.
 */
export type ThresholdBound = "adaptive" | "tier";

export interface Threshold {
	tokens: number;
	label: string;
	bound?: ThresholdBound;
	/** Projected dropped prefix after the guardrails: `tokens - baseline - keep`. The cut at handoff time can only be shorter (a single turn can hold the whole window), never longer. */
	dropTokens?: number;
	/** A manually configured `handoffBudgetSummaryTokens` the guardrail landed below, when there is one. */
	override?: ThresholdOverride;
}

/**
 * A manually-set `handoffBudgetSummaryTokens` that the guardrail overrode, and the term that bound below it.
 *
 * The trigger has two sources — what the model actually supports (the knee curve, then the usable
 * window) and what the user set by hand (`/handoff threshold 0.6`) — and the guardrail owns the trigger.
 * A manual setting it cannot honour must therefore be **named**: a user who raises the target and sees
 * nothing change has been sent to a control that does nothing.
 */
export interface ThresholdOverride {
	/** The threshold the configured target asked for: `baseline + keep + handoffBudgetSummaryTokens`. */
	asked: number;
	/** What the guardrail resolved instead. */
	tokens: number;
	/** The term that bound the trigger below `asked`. */
	by: "quality" | "window" | "tier";
}

/** Chars-per-token values a delta may calibrate to, and the band the message content is assumed to sit in. The
 * lower bound accepts tokenizers that split CJK near one token per character (a pure-CJK message can sit below
 * 1.5); above the upper bound the delta is not a content delta (`cache` accounting, an unrelated request), so it
 * is not a sample. `RATE_MAX` carries the second job too: at 8 chars per token the sparsest allowed content
 * still costs `chars / RATE_MAX` tokens, which is the lower bound the physical floor's baseline is built on and
 * the limit the interval rule enforces on every accepted delta (which is why the rate filter needs only its
 * lower half). */
const RATE_MIN = 1.0;
const RATE_MAX = 8.0;
/** Calibration deltas the rate's median is taken over, so one odd request cannot move it. */
const RATE_PAIRS = 5;

/** Prompt components of a persisted assistant usage: what the provider billed for the context it was sent. */
interface MessageUsage {
	input?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

type PiMessage = Parameters<typeof estimateTokens>[0];

/** A copy of `message` without its image blocks, or the message itself when it carries none. */
function withoutImages(message: PiMessage): PiMessage {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return message;
	const blocks = content as { type?: unknown }[];
	if (!blocks.some((block) => block?.type === "image")) return message;
	return { ...message, content: blocks.filter((block) => block?.type !== "image") } as PiMessage;
}

/**
 * pi's estimate for a message with its image blocks removed: the **text-only** basis every number here is built
 * on. pi charges each image a fixed `ESTIMATED_IMAGE_CHARS` (4,800), and that budget is a token estimate, not
 * text: on a small image - a screenshot thumbnail, a low-detail view at ~100 tokens - it exceeds the provider's
 * real charge several times over, so carrying it into `chars` pushed the bound below the truth and won the
 * minimum (independent review round 3, I-1). With images out of both `chars` and `estimated`, a branch's image
 * tokens are read as baseline overhead instead: the floor is then exactly `text tokens + baseline`, and the
 * baseline over-reads by those tokens - the fail-closed side of the trade.
 */
function textEstimate(message: PiMessage): number {
	return estimateTokens(withoutImages(message));
}

/**
 * True for a message pi's `convertToLlm` drops before the request: interactive `!!cmd` output is persisted as a
 * `bashExecution` message carrying `excludeFromContext`, so the provider never sees it. Counting it charged
 * `chars` and `estimated` for text that was never in the prompt, which read the baseline low (independent review
 * round 6, I-1: 13,264 against 17,766, and a large enough output dropped the record altogether).
 */
function isExcluded(message: PiMessage): boolean {
	return (
		(message as { role?: string }).role === "bashExecution" &&
		(message as { excludeFromContext?: boolean }).excludeFromContext === true
	);
}

/** The text-only token estimate of a message list; system messages are pi's own components, not content. */
function messageTokens(messages: readonly PiMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		if ((message as { role?: string }).role === "system") continue;
		if (isExcluded(message)) continue;
		tokens += textEstimate(message);
	}
	return tokens;
}

/**
 * pi's own `projectContextEntry` (its `session-manager.js`): the messages a `context_edit` leaves behind.
 * The projection this mirrors is what the provider is actually sent (`buildSessionProjection`), so the
 * characters a record is charged with have to follow it rather than the raw entry list.
 */
function editedMessages(messages: readonly PiMessage[], replacement: { content?: unknown } | null): PiMessage[] {
	if (replacement === null) return [];
	return messages.map((message) => {
		const role = (message as { role?: string }).role;
		if (role !== "user" && role !== "assistant" && role !== "toolResult" && role !== "custom") return message;
		const content =
			(role === "assistant" || role === "toolResult") && typeof replacement.content === "string"
				? [{ type: "text", text: replacement.content }]
				: replacement.content;
		return { ...message, content } as PiMessage;
	});
}

/** One assistant usage record on the branch, paired with the message content that precedes it. */
interface ContextSample {
	/** Provider-billed prompt tokens: `input + cacheRead + cacheWrite`. The reply's output is not context. */
	prompt: number;
	/** **Text** characters before this record (`4 * plain`): the unit the allowed band is expressed in. Image
	 * payloads are excluded - see `textEstimate` - so `chars` is never charged a budget the provider did not
	 * bill. */
	chars: number;
	/** The same estimate at pi's `chars/4`, kept so deltas between two records calibrate the rate. */
	plain: number;
	/** Estimated tokens added since the previous record. */
	added: number;
	/** A context boundary (compaction / context_edit / model change) sits between the two records. */
	split: boolean;
}

/**
 * What {@link measureContext} read off the session's own usage records.
 *
 * `baseline` is the measurement the physical floor uses and `estimated` is what it was subtracted from, so a
 * reading can be checked against `estimated + baseline` without re-deriving it from the session file.
 */
export interface ContextMeasure {
	/** The tightest sampled density bound, `prompt - chars/8` over the branch's usage records: the measured
	 * non-conversation baseline. It is an upper bound on the baseline **as of the record that set it**. */
	baseline: number;
	/** Chars per token from this session's own usage deltas; pi's assumed 4 when no delta was usable. */
	rate: number;
	/** Usage records usable as samples; 0 means the fallback formula decided the baseline. */
	samples: number;
	/** Which sample produced the baseline (0 = the oldest sampled record); -1 without samples. */
	sampleIndex: number;
	/** True when `rate` came from a real delta pair rather than pi's default. */
	calibrated: boolean;
	/** Estimated tokens of the branch's messages at `rate`, text only. Neither the system message nor an image
	 * block is part of it: see `measureContext`. */
	estimated: number;
}

/**
 * Measure the non-conversation baseline (system prompt, tool schemas, injected memory/context) from the
 * session's own usage records.
 *
 * Each record couples an exactly-known number with an estimated one: `prompt_r = B + T_r`, where `B` is the
 * baseline and `T_r` the true tokens of the messages before that record. `prompt_r` is the provider's own count
 * for the whole prompt (`usage.input + cacheRead + cacheWrite`; the reply's output is not context), `T_r` is
 * only known through pi's `chars/4`. The allowed content band bounds it instead of estimating it:
 *
 *   `chars_r / RATE_MAX <= T_r <= chars_r`  =>  `prompt_r - chars_r / RATE_MAX >= B >= prompt_r - chars_r`
 *
 * so the densest reading is an **upper** bound on `B` while the sparsest is a lower one. The baseline is the
 * smallest of those upper bounds over the records. It cannot read below `B` **as of the record that set it**,
 * and because each later record's bound grows (`T_r` grows while the correction per added character is
 * `r / RATE_MAX < 1`) the value is set by the emptiest record and does not grow as the branch fills (issue
 * 2026-10-09-handoff-baseline-residual). It is not a blanket "never low": the injected block growing inside a
 * session is invisible to it, because the minimum is taken over records whose prompts were billed earlier -
 * that is residual ② in the issue's design §9, and it is why the status line names the record count instead of
 * promising a floor that holds at the current prompt.
 *
 * Four properties of that formulation are load-bearing:
 * - The **system message is not part of `T`**. pi's own `estimateTokens` covers a system message's content, its
 *   sections and `toolsAdded`, so counting it here subtracted the tool schemas and the system prompt from the
 *   baseline: the reading came out short by that amount (measured 9,881 on the probe sandbox `01a1331c` and
 *   25,823 on a live session, against `probe-true-baseline.md`'s provider truth of 17,753). Only messages are
 *   counted, which is also what makes the extension's own injected block readable at all: pi's estimate of the
 *   system message cannot see it (the two sandboxes' system estimates differ by 1 token while their truths
 *   differ by the 6,745-token block).
 * - A record whose own densest reading still exceeds its prompt (`prompt_r <= chars_r / RATE_MAX`) does not
 *   describe its branch at all, so it is not a measurement and never enters the minimum. The opposite case - a
 *   handoff successor's replayed predecessor record, a whole predecessor prompt against a nearly empty branch -
 *   simply never wins the minimum, which is why those need no explicit exclusion.
 * - `chars` and `estimated` count **text only**. pi's per-image budget is a token estimate for a
 *   provider-specific cost, so on a small image it exceeds the real charge several times over; images therefore
 *   stay out of both and their own tokens land in the baseline (round 3's I-1, which read 502 low on a
 *   100-token image). The floor stays exact where it matters: `estimated + baseline` is text tokens + the whole
 *   baseline, so nothing is counted twice.
 * - A record measures an interval only when that interval is consistent with a constant baseline: given
 *   `B_p <= B_r`, `prompt_r - prompt_p = (B_r - B_p) + (T_r - T_p) >= chars_r / RATE_MAX - chars_p`. A record
 *   whose text grew faster than a **non-shrinking** prompt cannot have had that text billed (a replay inserted
 *   before it, a non-text block heavier than the band allows) and is dropped rather than clamped (round 3's
 *   I-2, whose fixture read 12,016 where the truth is 17,766). A **shrinking** prompt is left alone on
 *   purpose: a handoff successor's predecessor record carries the whole predecessor prompt and the next local
 *   record a much smaller one, and dropping that local record would pin the baseline at the predecessor's
 *   (150k in the test, 131k live) - the silent disable this issue is about. The price is a region the file
 *   cannot judge: a *stale* local record whose prompt was billed before a replay landed, sitting behind a
 *   larger predecessor prompt, still reads low (review round 4's I-1; residual ⑤ in the issue's design §10).
 * - `chars` follows pi's **projection**, not the raw entry list: a `context_edit` rewrites its target's
 *   messages (or drops them) and the provider is sent the edited text, so a message a user shortened or
 *   deleted must stop counting (round 4's I-2: the un-edited prefix read 5,267 where the baseline is 17,766).
 *   Records billed before the edit keep the old text, because the edit is applied where it appears.
 *
 * The cost is the emptiest record's own slack: the reading can sit up to `chars * (1/r - 1/RATE_MAX)` above the
 * truth, bounded by that record's content and no longer growing with the branch. That is the fail-closed side of
 * a floor that is a **refusal gate** (a floor reading low fires a handoff early), and it is the trade a single
 * session rate cannot make: scaling the whole prefix by it misreads any branch whose script changes (review
 * round 2's I-1 - an ASCII opening block followed by CJK turns read 3,736 and then 106 where the truth was
 * 17,766). The rate is still reported, because the handoff receipt and its split-turn budget describe slices in
 * the session's own chars-per-token; a session with no usable record keeps the historical formula (there the
 * conversion is the identity, so it is `usage.tokens` minus the chars/4 message estimate).
 *
 * Text sparser than the band (>8 chars/token: long whitespace or repetition runs) breaks the premise the other
 * way, and an **anchor** record made of it still reads low (residual ④ in design §9): an interval of it is caught
 * by the consistency rule above, but nothing in the file can catch it in the first sampled record.
 */
export function measureContext(ctx: ExtensionContext, usage: ContextUsage): ContextMeasure {
	const entries = buildContextEntries(ctx.sessionManager.getBranch(), ctx.sessionManager.getLeafId());
	const samples: ContextSample[] = [];
	/** pi's own estimate of the messages seen so far, text only: the unit `estimated`, `chars` and the rate
	 * deltas are all built on (see `textEstimate`). */
	let plain = 0;
	let split = false;
	/** Each entry's raw messages, their projected ones and their contribution to `plain`, so a `context_edit`
	 * can rewrite them in place. `raw` is kept because pi applies the *last* edit of a target to its original
	 * messages: a `null` deletion followed by a replacement restores the target rather than editing nothing. */
	const seen = new Map<string, { raw: PiMessage[]; messages: PiMessage[]; tokens: number }>();
	for (const [index, entry] of entries.entries()) {
		if (entry.type === "context_edit") {
			// The provider saw the target's *edited* messages, so a message a user shortened or deleted must stop
			// inflating `chars`: carrying the raw text read 5,267 where the baseline is 17,766 (review round 4, I-2).
			// The edit is applied where it appears in the branch, so records billed before it keep the old text.
			const target = seen.get(entry.targetId);
			if (target) {
				const messages = editedMessages(target.raw, entry.replacement);
				const tokens = messageTokens(messages);
				plain += tokens - target.tokens;
				seen.set(entry.targetId, { raw: target.raw, messages, tokens });
			}
			// The prompt content changed under records that were billed before this edit, so a chars->tokens
			// delta across it is not a content delta.
			split = true;
			continue;
		}
		const messages = [...sessionEntryToContextMessages(entry)] as PiMessage[];
		// pi's projection sends the newest compaction's summary only: a compaction entry at a later index
		// contributes no messages (its own `buildSessionProjection` maps those to `[]`).
		const tokens = entry.type === "compaction" && index > 0 ? 0 : messageTokens(messages);
		if (entry.type !== "message") {
			// A compaction / branch summary / custom message is prompt content: the historical formula counted it,
			// and skipping it here would push its tokens into the baseline and raise the floor. A compaction entry
			// can also carry pi's `systemMessage`, which is a prompt component, not content (see the doc block).
			plain += tokens;
			seen.set(entry.id, { raw: messages, messages, tokens });
			// A compaction, context edit or model change invalidates a chars->tokens delta across it.
			split = true;
			continue;
		}
		// A record's prompt holds everything *before* that record's own message, so its estimate must too:
		// counting the record's own reply would subtract tokens the provider never billed for it.
		const plainBefore = plain;
		let record: MessageUsage | undefined;
		for (const message of messages) record = (message as { usage?: MessageUsage }).usage ?? record;
		plain += tokens;
		seen.set(entry.id, { raw: messages, messages, tokens });
		if (!record) continue;
		const prompt = (record.input ?? 0) + (record.cacheRead ?? 0) + (record.cacheWrite ?? 0);
		if (prompt <= 0) continue;
		const chars = 4 * plainBefore;
		// A record that does not hold even the densest reading of its own preceding content is not a
		// measurement of this branch (see the doc block); it must not be clamped into a low reading.
		if (prompt <= Math.ceil(chars / RATE_MAX)) continue;
		// The interval since the last measurement must be consistent with a constant baseline, or this
		// record's characters include content its prompt never held (see the doc block).
		const previous = samples.at(-1);
		if (previous && !split && prompt >= previous.prompt) {
			if (chars - previous.chars > (prompt - previous.prompt) * RATE_MAX) continue;
		}
		samples.push({
			prompt,
			chars,
			plain: plainBefore,
			added: plainBefore - (previous?.plain ?? 0),
			split,
		});
		split = false;
	}
	// chars = 4 * plain tokens, so a delta implies rate = 4 * dPlain / dPrompt. The latest deltas describe the
	// content that is in the branch now; older ones described prefixes that compaction may have dropped.
	const rates: number[] = [];
	for (let i = 1; i < samples.length; i += 1) {
		const newer = samples[i];
		if (newer.split) continue;
		const deltaPrompt = newer.prompt - samples[i - 1].prompt;
		if (deltaPrompt <= 0) continue;
		const rate = (4 * newer.added) / deltaPrompt;
		// Only the lower half needs checking: an accepted pair already passed the interval rule, which forces
		// `4 * added <= deltaPrompt * RATE_MAX`, so `rate > RATE_MAX` cannot be reached through the sampler
		// (review round 4, N-1: the upper half was unreachable and unpinned).
		if (rate < RATE_MIN) continue;
		rates.push(rate);
	}
	const recent = rates.slice(-RATE_PAIRS).sort((a, b) => a - b);
	const rate = recent.length > 0 ? recent[Math.floor(recent.length / 2)] : 4;
	const atRate = (tokens: number): number => Math.ceil((tokens * 4) / rate);
	const estimated = atRate(plain);
	if (samples.length === 0) {
		// No usable record (first turn, or every record dropped by a compaction): keep the historical formula
		// byte-for-byte, so a session without samples behaves exactly as it did before the sampler existed.
		return {
			baseline: Math.max(0, (usage.tokens ?? estimated) - estimated),
			rate,
			samples: 0,
			sampleIndex: -1,
			calibrated: false,
			estimated,
		};
	}
	let baseline = 0;
	let sampleIndex = 0;
	for (let i = 0; i < samples.length; i += 1) {
		const sample = samples[i];
		// The densest content the band allows is a lower bound on that record's message tokens, so this bound
		// sits above the baseline whose prompt produced it; later accepted records only produce larger ones
		// (the doc block, including what it does not cover: the injected block growing inside the session).
		const bound = sample.prompt - Math.ceil(sample.chars / RATE_MAX);
		if (i === 0 || bound < baseline) {
			baseline = bound;
			sampleIndex = i;
		}
	}
	return { baseline, rate, samples: samples.length, sampleIndex, calibrated: rates.length > 0, estimated };
}

/** The measured non-conversation baseline (system prompt, tool schemas, injected memory/context).
 * Exported so tests can pin the physical-floor boundary exactly. */
export function baselineTokens(ctx: ExtensionContext, usage: ContextUsage): number {
	return measureContext(ctx, usage).baseline;
}

/**
 * Rate-aware replacement for `Σ estimateTokens(...)`: the handoff receipt and its split-turn budget must speak
 * the session's own chars-per-token, or they describe a drop that is not the drop (issue
 * 2026-10-09-handoff-baseline-residual, second consumer).
 */
export function contextTokensAtRate(
	messages: Iterable<Parameters<typeof estimateTokens>[0]>,
	rate: number,
): number {
	let tokens = 0;
	for (const message of messages) {
		// The same exclusion the sampler makes: content the provider is never sent (a `!!cmd`'s output) costs
		// nothing in the slice this describes, so reporting it would over-state the drop and the carry-over.
		if (isExcluded(message as PiMessage)) continue;
		tokens += Math.ceil((estimateTokens(message) * 4) / rate);
	}
	return tokens;
}

/**
 * Status suffix that makes a baseline reading self-explaining: the number, how it was measured, and how many
 * samples it rests on. Without a sample the number is pi's `chars/4` estimate, which reads high on this repo's
 * content - the status line says so instead of sending the user to "a smaller baseline" as if it were a lever.
 */
export function baselineSuffix(measure: ContextMeasure): string {
	if (measure.samples === 0) return ` · baseline ${fmtTokens(measure.baseline)} (chars/4, no usable record)`;
	// The baseline itself no longer comes from the rate (it is the chars/8 bound), so naming the rate here would
	// describe the receipt, not this number. Say which conversion the receipt got instead - a fallback 4.0 is not
	// a measured rate, and printing it beside the baseline is how the status line used to claim one.
	const receipt = measure.calibrated ? `${measure.rate.toFixed(1)} c/t` : "chars/4, no usable delta";
	return ` · baseline ${fmtTokens(measure.baseline)} (chars/8 bound over ${measure.samples} records; receipt at ${receipt})`;
}

/** First request-wide pricing tier edge, e.g. a long-context surcharge. Model metadata. */
function firstCostTierEdge(model: NonNullable<ExtensionContext["model"]>): number | undefined {
	const edges = (model.cost?.tiers ?? [])
		.map((tier) => tier.inputTokensAbove)
		.filter((edge): edge is number => typeof edge === "number" && edge > 0)
		.sort((a, b) => a - b);
	return edges[0];
}

/**
 * Resolve the trigger threshold from model info and measured usage:
 * - fixed: ratio * contextWindow, refused below the same physical floor the adaptive branch uses.
 * - adaptive: `min(knee(window), usable - TIER_EDGE_MARGIN)` — the quality knee and the last usable
 *   point, two terms only — lowered further by the first cost tier so no surcharge is crossed.
 *   `handoffBudgetSummaryTokens` does **not** take
 *   part: a manual preference must not lift the trigger above the honest knee, because distrusting a
 *   declared window is what the curve is for. When the guardrail lands below what the target asked
 *   for, the returned `override` says so and the status line names it.
 */
/** Exported so tests can pin the threshold math without a live session. */
export function resolveThreshold(
	ctx: ExtensionContext,
	usage: ContextUsage,
): Threshold | undefined {
	const window = usage.contextWindow;
	if (window <= 0) return undefined;
	if (!config.handoffThresholdAuto) {
		const tokens = Math.min(Math.round(config.handoffThresholdRatio * window), window - TIER_EDGE_MARGIN);
		if (tokens <= 0) return undefined;
		// The physical floor is a refusal gate in fixed mode too: below it a handoff would drop less than
		// `MIN_DROP_TOKENS`, replacing context without buying anything. It needs no model - only the measured
		// baseline and the carried-window budget - so both modes agree on what counts as worthwhile.
		if (tokens < baselineTokens(ctx, usage) + config.handoffBudgetRecentTokens + MIN_DROP_TOKENS) return undefined;
		return { tokens, label: `${fmtPct(config.handoffThresholdRatio * 100)} of window` };
	}
	const model = ctx.model;
	if (!model || usage.tokens === null) return undefined;

	const baseline = baselineTokens(ctx, usage);
	const keep = config.handoffBudgetRecentTokens;
	const floor = baseline + keep + MIN_DROP_TOKENS;
	const usable = window - WINDOW_RESERVE_TOKENS;
	if (usable <= floor) return undefined; // window too small for this configuration

	// Auto hands off at the guardrail alone: the lower of the model's conservative quality knee (honest
	// windows keep their own boundary, large ones saturate at the population-median knee) and the last
	// usable point before pi's own compaction reserve, minus the tier margin. `handoffBudgetSummaryTokens` is a
	// **manual request**, not a term on this line: a local preference must not lift the trigger above the
	// honest knee. What the request asked for is reported instead (`override`) so the status line can
	// name it. `handoffThresholdRatio` belongs to fixed mode.
	const knee = kneeTokens(window);
	const windowRoom = usable - TIER_EDGE_MARGIN;
	const qualityBinds = knee <= windowRoom;
	let tokens = qualityBinds ? knee : windowRoom;
	let bound: ThresholdBound = "adaptive";
	const asked = baseline + keep + config.handoffBudgetSummaryTokens;
	// A cap only takes over when it really is lower; recording which one decided is what lets the
	// status line explain an apparently low threshold instead of contradicting the floor.
	const cap = (value: number, name: ThresholdBound): void => {
		if (value < tokens) {
			tokens = value;
			bound = name;
		}
	};
	const tierEdge = firstCostTierEdge(model);
	if (tierEdge !== undefined) {
		// The first pricing tier is the other surcharge guard. It can only bind at or above the
		// physical floor; below that a handoff that both drops a prefix and stays in the cheap tier is
		// impossible, so fail closed instead of silently crossing the paid boundary (the old
		// `tierEdge > floor + margin` gate skipped the cap exactly in that case).
		if (tierEdge - TIER_EDGE_MARGIN < floor) return undefined;
		cap(tierEdge - TIER_EDGE_MARGIN, "tier");
	}
	// The physical floor is a **refusal gate, not a lift**. Below it a handoff would replace less than a
	// worthwhile drop, and raising the trigger to the floor is exactly the `max(boundary, targetValue)`
	// the quality layer forbids (see `resolveThreshold`'s doc block).
	if (tokens < floor) return undefined;
	// The status line reports the projected dropped prefix after caps, not the configured minimum: the
	// cut at handoff time can only be shorter (a single huge turn can hold the whole window), never
	// longer. The tier cap can leave less than `handoffBudgetSummaryTokens` droppable.
	return {
		tokens,
		label: `auto ${fmtTokens(tokens)} (${fmtPct((tokens / window) * 100)})`,
		bound,
		dropTokens: tokens - baseline - keep,
		override: asked > tokens
			? { asked, tokens, by: bound === "adaptive" ? (qualityBinds ? "quality" : "window") : bound }
			: undefined,
	};
}

/**
 * Why {@link resolveThreshold} returned `undefined`, named as the term that actually decided.
 *
 * The receipt used to render every refusal as "auto (no room at this window)" — an assertion about
 * the window. Only one of these causes is about the window; the others are an unknown window/unknown
 * model or usage, a fixed ratio that rounds to zero or lands below the physical floor, a **pricing tier**
 * that would be crossed, and the adaptive guardrail itself sitting below the floor a worthwhile drop needs
 * (the knee, or the window's last tier margin). Sending a user to change the model or the target when the cause is
 * billing (or when nothing is known yet) is the misattribution this names away.
 */
export type ThresholdRefusal =
	| "no-window"
	| "fixed-ratio-rounds-to-zero"
	| "no-model-or-usage"
	| "window-too-small"
	| "below-first-tier"
	| "below-quality-knee"
	| "below-usable-window"
	| "fixed-below-floor";

/**
 * The refusal cause behind `resolveThreshold(...) === undefined`, or `undefined` when it resolves.
 * Read-only companion: it replays the same terms in the same order and only reports a cause once the
 * real function has refused, so the diagnosis cannot drift from the formula it mirrors.
 */
export function thresholdRefusal(
	ctx: ExtensionContext,
	usage: ContextUsage,
): ThresholdRefusal | undefined {
	if (resolveThreshold(ctx, usage) !== undefined) return undefined;
	const window = usage.contextWindow;
	if (window <= 0) return "no-window";
	if (!config.handoffThresholdAuto) {
		const tokens = Math.min(Math.round(config.handoffThresholdRatio * window), window - TIER_EDGE_MARGIN);
		return tokens <= 0 ? "fixed-ratio-rounds-to-zero" : "fixed-below-floor";
	}
	const model = ctx.model;
	if (!model || usage.tokens === null) return "no-model-or-usage";
	const floor = baselineTokens(ctx, usage) + config.handoffBudgetRecentTokens + MIN_DROP_TOKENS;
	const usable = window - WINDOW_RESERVE_TOKENS;
	if (usable <= floor) return "window-too-small";
	const tierEdge = firstCostTierEdge(model);
	if (tierEdge !== undefined && tierEdge - TIER_EDGE_MARGIN < floor) return "below-first-tier";
	// The adaptive guardrail itself sits below the floor: either the model's knee says the window is not
	// reliable that far, or the window's last tier margin leaves too little. Name which, composing the
	// two terms exactly as `resolveThreshold` does. No cap can cause this: the only cap left is the tier
	// edge, which is gated above the floor.
	return kneeTokens(window) <= usable - TIER_EDGE_MARGIN ? "below-quality-knee" : "below-usable-window";
}

/**
 * The refusal sentence for the status line. Each cause names the comparison that failed, so the
 * receipt cannot attribute one refusal to another.
 */
export function thresholdRefusalText(reason: ThresholdRefusal, ctx: ExtensionContext, usage: ContextUsage): string {
	const window = usage.contextWindow;
	const floor = baselineTokens(ctx, usage) + config.handoffBudgetRecentTokens + MIN_DROP_TOKENS;
	const usable = window - WINDOW_RESERVE_TOKENS;
	switch (reason) {
		case "no-window":
			return config.handoffThresholdAuto
				? "auto (the context window is not known yet)"
				: `fixed ${fmtPct(config.handoffThresholdRatio * 100)} (the context window is not known yet)`;
		case "fixed-ratio-rounds-to-zero":
			return `fixed ${fmtPct(config.handoffThresholdRatio * 100)} (this ratio resolves to no positive threshold at a ${fmtTokens(window)}-token window)`;
		case "fixed-below-floor":
			// Name a lever that actually works with these numbers: when even the largest legal ratio cannot
			// clear the floor, raising it is not a lever and only the carried-window budget is.
			const largestThreshold = Math.min(Math.round(MAX_THRESHOLD_RATIO * window), window - TIER_EDGE_MARGIN);
			const lever = largestThreshold >= floor
				? "raise /handoff threshold or lower /handoff budget recent"
				: "lower /handoff budget recent (no ratio fits this window at this baseline)";
			const shown = Math.min(Math.round(config.handoffThresholdRatio * window), window - TIER_EDGE_MARGIN);
			// `fmtTokens` rounds to 0.1k, so within ~100 tokens of the floor both numbers would read the
			// same and the sentence would call a number below itself. Use the exact integers then.
			const collide = fmtTokens(shown) === fmtTokens(floor);
			const thresholdText = collide ? `${shown}` : fmtTokens(shown);
			const floorText = collide ? `${floor}` : fmtTokens(floor);
			return `fixed ${fmtPct(config.handoffThresholdRatio * 100)} (the ${thresholdText}-token threshold is below the ${floorText}-token floor a worthwhile handoff needs at this baseline; ${lever})`;
		case "no-model-or-usage":
			return "auto (the session model or its token usage is not known yet)";
		case "window-too-small":
			return `auto (window too small: ${usable} usable tokens after the ${WINDOW_RESERVE_TOKENS} reserve, below the ${floor} floor)`;
		case "below-first-tier":
			return "auto (crossing the first pricing tier would not leave room for a worthwhile handoff, so the handoff is skipped rather than billed)";
		case "below-quality-knee":
			return `auto (the model's quality knee of ${fmtTokens(kneeTokens(window))} is below the ${fmtTokens(floor)} floor a worthwhile handoff needs at this window, so the handoff is skipped rather than run past the knee; a smaller keep is the lever, not the baseline - that is a measurement, not a setting)`;
		case "below-usable-window":
		default:
			return `auto (the last ${TIER_EDGE_MARGIN} tokens of the ${usable}-token usable window leave ${fmtTokens(usable - TIER_EDGE_MARGIN)}, below the ${fmtTokens(floor)} floor a worthwhile handoff needs; a larger window is the lever, not a larger target)`;
	}
}

/** Status suffix for a threshold that a cap decided, so a low value never looks unexplained. */
export function capSuffix(bound: Threshold["bound"]): string {
	if (bound === "tier") return " · capped by the first pricing tier";
	return "";
}

/**
 * The status-line warning for a manual target the guardrail overrode. Both numbers and the lever are
 * named, so the receipt cannot send the user back to the same ineffective control.
 */
export function thresholdOverrideText(override: ThresholdOverride, window: number): string {
	const guardrail = override.by === "quality"
		? `the model's quality knee allows ${fmtTokens(override.tokens)} at this window`
		: override.by === "window"
			? `only ${fmtTokens(override.tokens)} tokens fit this ${fmtTokens(window)}-token window after the ${WINDOW_RESERVE_TOKENS}-token request reserve and the ${TIER_EDGE_MARGIN}-token tier margin`
			: `the first pricing tier leaves ${fmtTokens(override.tokens)}`;
	return `handoff budget summary ${fmtTokens(config.handoffBudgetSummaryTokens)} is not applied in full: it needs a ${fmtTokens(override.asked)}-token threshold and ${guardrail}, so the auto guardrail decides — lower /handoff budget summary`;
}
