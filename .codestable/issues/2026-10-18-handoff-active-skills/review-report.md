# Review report: handoff active skills (2026-10-18)

## Round table

| round | revision | verdict | blocking | important | nature |
|---|---|---|---|---|---|
| R1 | active-skills slice (pre-ordering fix) | PASSED | 0 | 1 | `collectActiveSkills` claimed "most recent" for alphabetically sorted prompt/compaction lists, so the 8-cap could evict the active skill |
| R2 | active-skills slice after the ordering fix | PASSED | 0 | 0 | source priority verified, mutation matrix and the live field probe reproduced; wording nits and one follow-up |
| R3 | cleanup batch (intermediate closing + baseline test nits) | PASSED | 0 | 0 | byte-exact 0ca14ba closing, suffix interaction understood, accumulation fixture mutation-sensitive |
| R4 | `/skill:` block detection | CHANGES-REQUESTED | 0 | 1 | docs re-claimed recency for the index sources; fixed in R5, plus three nits and three test suggestions |
| R5 | `/skill:` source after the R4 fixes | PASSED | 0 | 0 | docs wording exact, real pi parser, mutation matrix 5/3/1/1/3, no model call |

## R1 (transcript: `review-round1-independent.txt`)

- **I-1 (important, fixed)**: `read` calls are chronological, but a prompt's `<read-files>` and a
  compaction's `readFiles` are pi-sorted file indexes; treating their line order as recency let an
  alphabetical list outrank a real read and could evict the active skill at the 8-cap. Fix: source
  priority (`read` 3 > prompt 2 > compaction 1), then recency within the source; docs now say the
  read-call source is recency-ordered and the file-list sources keep their block order. Tests pin
  a read outranking a later prompt list and the cap keeping the read plus seven prompt entries.
- **N-1 (nit, fixed)**: the `fromHook` skip and the 8-cap were mutation-invisible; tests now cover
  a hook compaction (ignored) and nine reads (oldest dropped).
- **N-2 (nit, fixed)**: a draft-added `- ` list marker in `<read-files>` produced a corrupted path;
  stripped and pinned.
- **N-3 (nit, residual)**: a codemode script's `nestedCalls` reads are not scanned (same as
  `collectFileOps`); recorded in `fix-note.md`.
- **N-4 (nit, residual)**: `branch_summary` entries also carry `details.readFiles`, but only
  `compaction` is scanned (same as `collectFileOps`); recorded in `fix-note.md`.
- **Residual risks**: a skill read for reference is listed (the section says "if one set an active
  mode"); `bash`/`cat` and codemode `nestedCalls` reads are undetectable (a `/skill:` invocation is
  detected as of R4); the 8-cap can drop an old mode; a compaction inside the successor drops the stored prompt, so a mode not re-read at
  hop 1 is lost at hop 2; the successor may still ignore the instruction.
- **Praise**: the `fromHook` guard mirrors pi, the import graph is safe (type-only edge), the
  wording says "loaded" not "active", and the field check against the live v0.4.10 successor prompt
  returned both review skills.

## R2 (transcript: `review-round2-independent.txt`)

**VERDICT: PASSED**. No blocking or important findings. The reviewer traced every comparator edge
(the weaker source after a stronger one, the same file in several sources, a prompt after a read,
within-block order), confirmed pi sorts `readFiles`, and reproduced the full mutation matrix
(4/1/1/1/1/2/1/1 FAIL, each reddening only its own pin). The live `01a14ddb` JSONL still yields the
two review skills from its stored v0.4.10 prompt. Zero-write held.

Post-PASS corrections (comments and docs only; no behavior change):

- **N-A/N-B (fixed)**: the fix-note and `file-ops.ts` comments said prompt/compaction lists "keep
  their own order"; the render reverses the block (an index has no activity order). Wording now says
  the read-sourced head is recency-ordered and index entries fill the slots reads leave.
- **N-C (fixed)**: the cap residual now covers a prompt-only list (last 8 block lines, arbitrary
  index order), not only read-sourced lists.
- **N-D (fixed)**: docs no longer say a mode can never disappear; the 8-cap and a compaction inside
  the successor remain named residual shapes.
- **R-B (recorded)**: a draft-mode handoff that stores an edited prompt plus an appended answer
  fails `isHandoffPromptText` at hop 2; only a successor re-read survives. Added to the residuals.

**S-1 (fixed in the R3 cleanup)**: the intermediate 0ca14ba `closingContinue` (the restatement-only
text, en/zh) is now in `HANDOFF_PROMPT_CLOSINGS`. The R3 reviewer byte-compared both strings against
`git show 0ca14ba:...`; the English line is load-bearing, while the Chinese line is redundant today
because the intermediate and current zh closings both end with the legacy `"从上次中断处继续。"`
suffix. Fixtures pin the legacy zh and both intermediate closings, with an inequality so a future
wording drift cannot make them re-test the current prompt.

## R3 (transcript: `review-round3-cleanup-independent.txt`)

**VERDICT: PASSED**. Focused on the two-file cleanup diff (intermediate closings plus baseline
test/comment nits). Byte-level exactness of the 0ca14ba strings, no new false-positive class, the
legacy-zh suffix interaction, the 5e-b accumulation fixture (drop path traced; `+=` -> `=` reddens
exactly that check, mutated baseline 20,965), and the 5b comment all verified. One test-comment
number (20,967 -> 20,965, C's bound) and the issue-record dispositions were corrected after the
verdict; no production behavior changed.

## R4 (`/skill:` block detection; transcript: `review-round4-skill-source-independent.txt`)

**VERDICT: CHANGES-REQUESTED**. The parser integration, block shape, priority, dedupe and the
3/1/1 mutations were verified against installed pi. One important docs finding: docs/handoff.md and
CHANGELOG said "同一级按最近出现排序" after naming the index sources, re-claiming recency for
prompt/compaction lists (the R1/I-1 claim class). Nits: the bound comment still said "read-sourced
head"; the fix-note verification omitted the non-SKILL guard and the R4 mutation rows; a standalone
`.md` skill is invisible (residual). Suggestions: pin both-order dedupe, the strict-gate negatives,
and a `/skill:` entry surviving the 8-cap.

## R5 (`/skill:` source after the R4 fixes; transcript: `review-round5-skill-source-independent.txt`)

**VERDICT: PASSED**. Docs now state per-source recency for `/skill:` and `read` and reverse-block
filler for the index sources; no user-facing "同一级"/cross-source "most recent" claim remains.
Mutation matrix measured: scan removed 5 FAIL, priority 2 3 FAIL, `isSkillFile` guard 1 FAIL,
priority guard `!==` 1 FAIL, cap removed 3 FAIL. The 8-cap test is the true priority-ladder pin.
Post-PASS nits fixed: the three fix-note mutation counts, the bound comment ("each explicit source
keeps its recency order within itself"), the cap-residual wording, and the three-entry no-downgrade
test.

Residual risks remain as disclosed: a prompt-sourced hop-1 mode can be evicted by eight newer
reads; a compaction inside the successor drops the stored prompt; `bash`/`cat` and codemode
`nestedCalls` reads are invisible; a `branch_summary` file list is not scanned (its files belong to
the abandoned branch); a standalone `.md` skill is invisible to every source; the successor may
still ignore the instruction.
