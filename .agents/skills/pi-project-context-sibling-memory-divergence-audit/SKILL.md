---
name: pi-project-context-sibling-memory-divergence-audit
description: "Choose restore vs merge for a diverged sibling-repo MEMORY.md. Use when a consumer repo's memory file diverges from HEAD."
---

## When to use

Sibling repos that consume pi-project-context (e.g. `Quantum_Matrix`, `UniField`) hold `.agents/memory/MEMORY.md` renders that have diverged: worktree vs `HEAD` vs a protected `/tmp` backup, worktree dirty (` M`), and the repo's own guard failing. Use this to decide restore / merge / leave-alone. Pair with `pi-project-context-sibling-repo-memory-sync` (backup, lock/errors cleanup) and `pi-project-context-memory-recovery`. Do not begin by restoring the "richer" version — in the recorded runs that plan was wrong and was corrected only after this audit.

## Step 1 — kill the byte/char artifact first

The cap counts characters (`text.length`), never bytes. Probe char length, not `wc -c`.

```bash
python3 - <<'PY'
from pathlib import Path
for p in [".../Quantum_Matrix/.agents/memory/MEMORY.md",
          ".../UniField/.agents/memory/MEMORY.md"]:
    print(p, len(Path(p).read_text(encoding="utf-8")), "chars")
PY
```

Recorded run: two sibling renders were both far under their own caps, so the alarmed "over cap" was a byte artifact and no truncation had occurred. Do not cite byte counts as cap evidence again.

## Step 2 — bidirectional feature-coverage audit (do not trust ratio())

Both sides carry unique content; a one-sided "missing N lines" diff is wrong. Build a candidate with the richer version as base and containment matching for current-only lines (replacement when a current line rewrites a rich line, append when genuinely new). Then require ~100% retention of distinctive features from BOTH sides.

- `difflib.SequenceMatcher.ratio()` alone is wrong: it scores contained rewrites as new and inflates sizes (QM 27479 / UF 55285 in the failed attempts), and the ratio-based classifier dropped 42 (QM) / 145 (UF) distinctive tokens. Reject any candidate below ~100% bidirectional token coverage.
- Extract distinctive tokens per side (numbers, identifiers, section labels, term groups), compute the candidate's coverage of each set, and only accept ~100%.
- Verify the preamble/front section survives: a naive section parser silently dropped QM's preamble, which is the file's own recovery procedure.

## Step 3 — the repo's own guard test is the owner-authored oracle

Run each repo's fence/guard test against current and candidate before choosing a winner.

- QM: `python3 -m pytest tests/test_memory_index_guard.py` — current render FAILs (a curated marker is gone), the guarded version passes 2/2.
- The guard's docstring says to restore rather than widen; never raise its numbers to make a merge fit.
- A protected copy that is byte-identical (md5) to a `/tmp` backup is owner-authored confirmation of the "good" version; prefer that over inference.

## Step 4 — let the capacity wall decide

Compare the lossless merge char count against the repo's self-imposed fence/cap, including headroom:

- QM good = 17998 chars vs fence 18000 chars / 100 lines -> 2 chars headroom, so ANY merge turns the guard red.
- UF good = 34994 < cap 36000, but the merge is ~38100 > cap (worst case higher).

When the fence has no headroom, stop merging. Restore the version the guard passes and hand the other side's unique facts to the owner as a separate list — they do not fit memory. Keep merged renders on the opaque (non-schema) path; do not push custom multi-section memory through the fixed 4-section schema.

## Step 5 — check the journal before restoring (restores may not stick)

Both journals showed an adoption immediately followed by a write of the other version:

- Both journals showed the same shape: an adoption record immediately followed by a write of the other version, tens to hundreds of milliseconds apart.
- `errors.log` logged `adopted an externally edited MEMORY.md into the memory journal` at the later record's millisecond, and `MEMORY.md` mtime/length match the later record.

Interpretation stays ambiguous (owner deliberately shrank vs adoption was overwritten), but the repo's guard failing on the current render and passing on the guarded one biases toward the overwrite reading. Treat a restore as provisional until the adoption-vs-write ordering is fixed with a reproducible script; file that issue first, then restore.

## Non-destructive rules

- Back up both worktree files to `/tmp` before any probe; never `git checkout --` over dirty sibling memory.
- Prove untouched files with identical character counts (not bytes).
- Leave sibling-repo commits to the owner; record the decision plus the unique-fact list in `.codestable` instead of writing into the sibling repos.
