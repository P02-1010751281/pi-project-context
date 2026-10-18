# Fix note: handoff baseline ratchet on successor sessions (2026-10-18)

## Report

Owner field report: on a relay (中转站), the adaptive knee "fails" and `/handoff` shows an abnormal
threshold; after a handoff the successor does not restate the last round, so the user cannot tell what
it is continuing.

## Field evidence (consumer sessions, read-only)

All three sessions are handoff successors (the session header carries `parentSession`); their first
assistant record is the predecessor's replayed usage record. The "shipped" columns are the v0.4.10
`measureContext` snapshot taken when the report was filed; the "fixed" columns re-ran unchanged on the
same files after the fix. Threshold numbers use the defaults `handoffBudgetRecentTokens=20,000`,
`MIN_DROP_TOKENS=8,000`.

| session | model / window | pi usage | shipped baseline → floor → result | fixed baseline → floor → result |
|---|---|---|---|---|
| StegoMark `2026-10-17T05-01-53-171Z_01a1483c-e693-70f3-a754-cf7cb978c32a` | deepseek-flash / 1,000,000 | 302,539 (30.3%) | 135,141 → 163,141 → **refused, below-quality-knee** | 51,525 → 79,525 → auto 157,000, drop 85,475 |
| UniField `2026-10-17T07-21-48-277Z_01a148bc-fff5-71ee-90eb-714123b0a3d8` | vankit-openai gpt-6.1-sol / 272,000 | 268,086 (98.6%) | 228,991 → 256,991 → **refused, below-usable-window** | 103,171 → 131,171 → auto 251,616, drop 128,445 |
| Quantum_Matrix `2026-10-17T13-42-20-992Z_01a14a19-6640-723c-83c0-895b2da30f8b` | vankit-openai gpt-6.1-sol / 272,000 | 177,740 (65.3%) | 149,636 → 177,636 → auto 251,616, drop 81,980 | 86,058 → 114,058 → auto 251,616, drop 145,558 |

The first two are the field failures: the successor cannot hand off again at 30% of a declared 1M
window / at 98.6% of a 272K window. The third shows the same over-read without crossing the floor yet.

Shape of the prompt accounting in these sessions:

- StegoMark persists its thinking (`reasoning > 0` with non-empty thinking is absent); it has 10
  browser-screenshot image blocks. Every re-anchor interval was an image interval: `Δprompt ≈ 800`,
  `Δchars ≈ 120-430` (the images are excluded from `chars` by design).
- UniField has 145 assistant records with `reasoning > 0` and an **empty persisted thinking block**
  (255 assistant records in total); Quantum has 95 of 122. Their per-turn prompt growth is ~800-1,600
  tokens while the branch text grows by tens of characters (empty thinking, one-line tool calls).

## Root cause

1. The density bound `prompt_r - chars_r/8` over-reads the baseline by `chars_r * (1/r - 1/8)`. On this
   repo's CJK/tool-output content `r ≈ 2.8`, so at 386k chars the over-read is ~87k tokens.
2. The design-§14 re-anchor (`prompt_r - prompt_p > 2 * (chars_r - chars_p)`) resets the minimum to the
   **current** record's bound. It was meant for the injected block refreshing inside a session. But two
   field shapes produce the same signal without a baseline increase:
   - hidden reasoning on a relay reasoning route: the provider bills it into the next prompt, the persisted
     assistant message has an empty thinking block, so `chars` does not grow;
   - an image block: `chars` excludes it on purpose, so its ~800 tokens look like prompt growth.
   Each turn fires the reset, and each reset re-adds the whole text over-read. The baseline ratchets
   monotonically (the field walks show 10 re-anchors in StegoMark and a climb from 69k to 229k in
   UniField) until the floor crosses the knee or the usable window and auto handoff goes silent.
3. In a successor the first local sample is the only tight anchor; the inherited predecessor record has a
   huge prompt and a small `chars`. It did not win the minimum by itself (the first local bound is lower),
   but the false re-anchors discarded that local sample, so the successor lost its anchor.

## Fix

`extensions/project-context/handoff/threshold.ts`:

- `ContextSample.unreported = max(0, usage.output - messageTokens(record entry))`: output the provider
  billed that the persisted text does not carry (hidden reasoning, tool-call markup the estimate rounds
  down).
- `imageAllowance`: image blocks added since the previous sample, each at pi's own per-image budget
  (`ESTIMATED_IMAGE_CHARS / 4 = 1,200` tokens), plus the same `unreported` value of a record the sampler
  drops (self-density, interval consistency or zero prompt): the dropped reply is still in every later
  prompt, so its hidden output has to reach the next comparison (review round 1, I-1).
- The re-anchor test becomes
  `prompt_r - prompt_p > 2 * (chars_r - chars_p) + previous.unreported + imageAllowance`.
  A real injected-block refresh still exceeds this bound (the existing 5b fixture, +30,000 tokens, still
  re-anchors at 52,767); an image at or under 1,200 tokens and hidden reasoning no longer reset it.

`extensions/project-context/handoff/prompt.ts` and `language.ts`:

- `closingContinue` now asks the successor to restate the last request and current state in one or two
  sentences before continuing.
- `HANDOFF_PROMPT_CLOSINGS` keeps the two pre-v0.4.11 closings, so a prompt written before this change is
  still recognized and replaced by `[handoff prompt omitted]` on replay.

## Verification

- New fixtures in `tests/handoff-test.mjs`:
  - `hidden reasoning does not reset the baseline every turn` (10 turns, `output=1,001`, 8 chars of text
    per turn): baseline stays at the first bound 17,767; without the allowance it reads the last turn's
    bound.
  - `an image within pi's budget does not reset the baseline` (3 images, +801 each): baseline stays
    17,766; without the allowance each shot resets it.
  - `a dropped record's hidden output is carried to the next comparison` (interval-consistency drop with
    `output=2,001`): baseline stays 17,766; without the carry it resets to C's bound.
  - `the image allowance boundary is exact` (1,200 billed tokens: no reset; 1,201: reset, baseline
    18,967), and `an image in a split interval is not credited after the split sample` (the allowance
    resets at the split sample; the next 1,200-token increase re-anchors at 20,165).
  - The closing assertions pin the restatement line in both languages; the legacy-English prompt fixture
    still passes `isHandoffPromptText`.
- Mutation matrix (each mutation applied to a copy, then restored; `node tests/handoff-test.mjs`):
  - whole `+ allowance` removed -> 4 FAIL: 5c, 5d, 5e, 5f.
  - only `previous.unreported` removed -> 1 FAIL: 5c.
  - only `imageAllowance` removed -> 3 FAIL: 5d, 5e, 5f (5e's dropped hidden value is carried through
    the same pending slot).
  - dropped-record carry removed from all three drop paths -> 1 FAIL: 5e.
  - `IMAGE_CONTENT_TOKENS` halved -> 5d + 5f; doubled -> 5f (the exact boundary).
  - `imageAllowance = entryImages` changed to `+=` -> 1 FAIL: 5g (the split reset).
- Full suite: `node tests/run-all.mjs` → `All 15 tests passed.`
- Real sessions: the patched module resolves the thresholds in the table above (the same probe loads the
  repo's `threshold.ts`; see `probe-threshold-on-sessions.mjs`).

## Residuals / trade

- An image at or under the 1,200-token allowance no longer enters the baseline; the floor under-reads by
  its true cost (fail-open, bounded per image). This replaces the previous per-image ratchet. An image
  above the budget still fires the reset, and the whole image cost (plus the re-added text over-read) enters the
  baseline (fail-closed).
- A provider that bills hidden reasoning but does **not** echo it into the next prompt makes the
  allowance under-read the baseline by that reply's hidden output (bounded by the reply).
- The inherited predecessor record remains a sample (the existing `a predecessor-only prefix reads the
  predecessor's bound, high` contract is unchanged). It is harmless once a local record is accepted; an
  explicit header-timestamp exclusion was evaluated and left out to keep this slice minimal.
- The ② detector remains a heuristic: a genuine refresh smaller than the allowance in an interval that
  also contains an image, or smaller than a huge reply's unreported output, is missed; the reading is then
  low by that increase (bounded).
- On dense CJK replies `output - chars/4` over-credits the reply's text-estimate gap (real tokens can be
  near `chars`, the estimate is `chars/4`), so `unreported` can be larger than the hidden part by up to
  ~0.7 x chars per reply; direction fail-open, bounded by the reply.
- An assistant-generated image is credited twice (once through `unreported`, once through the 1,200
  image allowance); rare shape, bounded per reply.
