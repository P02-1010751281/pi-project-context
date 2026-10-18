# Review report: handoff successor baseline (2026-10-18)

## Round table

| round | revision | verdict | blocking | important | nature |
|---|---|---|---|---|---|
| R1 | v0.4.11 candidate (round-1 sandbox) | CHANGES-REQUESTED | 0 | 2 | correctness: a dropped record's hidden output was lost; docs inverted the fail-open direction |
| R2 | v0.4.11 candidate after the R1 fixes | PASSED | 0 | 0 | validation: I-1/I-2 fixed, matrix and field columns reproduce; three test/doc nits left as follow-ups |
| R3 | cleanup batch (legacy-zh, accumulation fixture, 5b comment) | PASSED | 0 | 0 | no production threshold change; all three R2 nits closed and mutation-checked |

## R1 (transcript: `review-round1-independent.txt`)

- **I-1 (important, fixed)**: a record dropped by the interval-consistency or self-density rule kept its
  reply in every later prompt, but the next comparison did not receive its `unreported`/hidden output, so
  it could falsely re-anchor (probe: 20,117 vs the 17,766 control). Fix: carry
  `unreportedOutput(record, tokens)` on the drop paths; test `a dropped record's hidden output is carried
  to the next comparison` (5e). The zero-prompt path got the same carry for completeness.
- **I-2 (important, fixed)**: the threshold.ts doc block said an *under-counted* allowance reads the
  baseline low. It is an *over-counted* allowance (a provider that bills reasoning but does not echo it)
  that misses resets; an under-counted allowance only makes the detector fire more, which raises the
  reading. Reworded; the fix note already had the right direction.
- **N-1 (nit, fixed)**: an over-budget image admits the whole image cost (plus the re-added text
  over-read), not just the excess. docs/handoff.md and threshold.ts now say that.
- **N-2 (nit, fixed)**: CHANGELOG's over-read is `chars x (1/r - 1/8)`, not `chars/8`.
- **N-3 (nit, fixed)**: the 5c mutation comment now says 26,780 (ten turns), not 27,767.
- **N-4 (nit, fixed)**: the Quantum shipped drop is 81,980 (251,616 - 149,636 - 20,000), not 82,180.
- **N-5 (nit, kept; disposition corrected by R2)**: the legacy zh closing "从上次中断处继续。" is a suffix of
  the new zh closing, but `isHandoffPromptText` uses `endsWith`, so the new (longer) closing does **not**
  match an old zh prompt; the legacy zh entry is load-bearing, not self-documentation. R2 confirmed this by
  removing the entry and watching a legacy zh prompt stop being recognized while the suite stayed green
  (only legacy **en** is pinned). A legacy-zh recognition fixture is a follow-up.
- **Suggestions (done)**: added the exact image-budget boundary fixture (1,200 vs 1,201) and a split-interval
  fixture proving the allowance resets at a split sample.
- **Residual risks (documented)**: dense-CJK over-credit of `output - chars/4`; assistant-generated images
  credited twice; a huge reply's allowance can mask a small refresh. All are named in `fix-note.md`.

## R2 (transcript: `review-round2-independent.txt`)

**VERDICT: PASSED** on the fixed revision. No blocking or important findings. The reviewer independently
re-ran the mutation matrix (all seven rows match `fix-note.md`), the three field-session probes (fixed
columns and the mutated shipped columns match), and adversarial probes of the zero-prompt and
self-density carries (each flips 19,778 <-> 17,766 when removed). It confirmed no double-count, no leak
across a split, and no negative/overflow path.

Post-PASS nits (closed in the R3 cleanup; tests/comments only, no production threshold change):

- **N-1 (fixed)**: a legacy-zh recognition fixture mirrors the legacy-en one, and it is now the only
  pin proving the legacy zh entry is load-bearing (removing that entry reddens it).
- **N-2 (fixed)**: a two-pending-contribution fixture (a user image plus a dropped record's hidden
  output) pins the `+=` accumulation; changing the drop path to `=` reddens exactly that check
  (mutated baseline 20,965).
- **N-3 (fixed)**: the 5b comment now states the detector with the allowance term and notes the
  allowance is 0 in that fixture.

## R3 (transcript: `review-round3-cleanup-independent.txt`)

**VERDICT: PASSED** on the cleanup diff. No production threshold change; the three nits above are
closed, the legacy-zh suffix subtlety is recorded, and the new accumulation fixture is mutation-
sensitive. One test-comment number was corrected after the verdict (20,967 -> 20,965, C's bound).

The PASS covers the frozen revision (the current working tree's code/tests); the only changes after it are
this report and the round transcript, both under the issue dir.
