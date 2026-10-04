---
name: pi-project-context-sibling-repo-memory-sync
description: "Reconcile a consuming repo's .agents/memory with HEAD: back up first, char-not-byte checks, restore-vs-merge, stale locks, errors.log. Use for sibling repos."
---

## When to use

After pi-project-context is upgraded, or after a poison/truncation episode, when a consuming repo next to this one still holds `.agents/memory/` written by an older version and its `MEMORY.md`/`CONTEXT.md` need reconciling or cleanup. Also use when asked "记忆/项目上下文需要同步吗？" for repos other than the extension repo itself, and when such a repo's render has **diverged** — worktree vs `HEAD` vs a protected `/tmp` backup, worktree dirty (` M`), the repo's own guard test failing — which this skill covers as the restore-vs-merge call in section 3.

Work only on files you can back up, and leave git commits in the consumer repos to the owner unless explicitly asked. Pair with `pi-project-context-memory-recovery` for a poisoned or truncated memory body.

## 1. Back up working-tree bytes first

Sibling `MEMORY.md`/`CONTEXT.md` are often already dirty (` M`) before you arrive. Never `git checkout --` over them.

```bash
cp .agents/memory/CONTEXT.md /tmp/<Repo>-CONTEXT.md.before-sync-$(date +%Y%m%d-%H%M%S)
cp .agents/memory/MEMORY.md /tmp/<Repo>-MEMORY.md.before-sync-$(date +%Y%m%d-%H%M%S)
```

## 2. Pin the invariant for files you must not touch

If you claim you did not modify the memory body, prove it: record the **character** count of `MEMORY.md` before and after and report identical numbers. The cap counts characters, never bytes (`text.length`), so `wc -c` is not cap evidence — CJK-heavy files run roughly 1.6x larger in bytes. In the recorded runs both sibling memories stayed stable while only `CONTEXT.md` changed.

## 3. Diverged render: restore vs merge

Do not begin by restoring the "richer" version — in the recorded runs that plan was wrong and was corrected only after this audit.

### 3a. Kill the byte/char artifact first

Probe character length, not `wc -c`:

```bash
python3 - <<'PY'
from pathlib import Path
for p in [".../<RepoA>/.agents/memory/MEMORY.md",
          ".../<RepoB>/.agents/memory/MEMORY.md"]:
    print(p, len(Path(p).read_text(encoding="utf-8")), "chars")
PY
```

In the recorded runs both renders sat far under their own caps, so the alarmed "over cap" was a byte artifact and no truncation had occurred. Do not cite byte counts as cap evidence again.

### 3b. Bidirectional coverage, not `ratio()`

Both sides carry unique content; a one-sided "missing N lines" diff is wrong. Build a candidate with the richer version as base and containment matching for current-only lines (replacement when a current line rewrites a rich line, append when genuinely new). Then require ~100% retention of distinctive features from BOTH sides.

- `difflib.SequenceMatcher.ratio()` alone is wrong: it scores contained rewrites as new and inflates sizes, and in the failed attempts the ratio-based classifier dropped over a hundred distinctive tokens on one side. Reject any candidate below ~100% bidirectional token coverage.
- Extract distinctive tokens per side (numbers, identifiers, section labels, term groups), compute the candidate's coverage of each set, and only accept ~100%.
- Verify the preamble/front section survives: a naive section parser silently dropped one repo's preamble, which is the file's own recovery procedure.

### 3c. The repo's own guard test is the owner-authored oracle

Run each repo's fence/guard test against current and candidate before choosing a winner. In one recorded repo `python3 -m pytest tests/test_memory_index_guard.py` FAILed on the current render (a curated marker was gone) while the guarded version passed.

- The guard's docstring says to restore rather than widen; never raise its numbers to make a merge fit.
- A protected copy that is byte-identical (md5) to a `/tmp` backup is owner-authored confirmation of the "good" version; prefer that over inference.

### 3d. Let the capacity wall decide

Compare the lossless merge character count against the repo's self-imposed fence/cap, including headroom. In the recorded runs one repo's passing version sat a couple of characters under its fence, so ANY merge turned the guard red; the other repo's lossless merge ran past its cap.

When the fence has no headroom, stop merging. Restore the version the guard passes and hand the other side's unique facts to the owner as a separate list — they do not fit memory. Keep merged renders on the opaque (non-schema) path; do not push custom multi-section memory through the fixed 4-section schema.

### 3e. Check the journal before restoring (restores may not stick)

Both journals showed the same shape: an adoption record immediately followed by a write of the other version, tens to hundreds of milliseconds apart. `errors.log` logged `adopted an externally edited MEMORY.md into the memory journal` at the later record's millisecond, and `MEMORY.md` mtime/length matched the later record. (Two appends that close together are one `recordMemoryDocument` call appending twice — adoption plus this pass's render — and are byte-identical; they are not evidence of concurrent writers.)

Interpretation stays ambiguous (owner deliberately shrank vs adoption was overwritten), but the repo's guard failing on the current render and passing on the guarded one biases toward the overwrite reading. Treat a restore as provisional until the adoption-vs-write ordering is fixed with a reproducible script; file that issue first, then restore.

## 4. Reconcile MEMORY.md against HEAD before committing a repaired render

A repaired/poison-recovered render can be richer and still be missing curated HEAD lines. Diff line sets both ways and list what HEAD has that the worktree lacks:

```bash
git show HEAD:.agents/memory/MEMORY.md > /tmp/head-memory.md
# compare line sets; print lines present in HEAD but absent now
```

If the missing lines are substantive lessons/conclusions (experiment verdicts, reusable heuristics), do not pick a side: merge them back into the current render, then present merge-vs-restore-vs-commit-as-is to the owner as an explicit choice. Also compare decoded backup copies (poisoned JSON or older `MEMORY.md` backups) against the current memory by keyword coverage; "no verbatim line match" usually means the same fact was rewritten, not lost.

## 5. Rewrite CONTEXT.md in the current renderer format

Current format starts `# Project Context` followed by `Last updated: <ISO-8601>`. The old `# Context` heading and hand-written `Last updated: <date> (agent 重建…)` style are stale.

- Budget: keep the file under `MAX_CONTEXT_CHARS = 32000` (`extensions/project-context/shared/project-state.ts`; `MAX_SUMMARY_CHARS = 6000`, `MAX_LIST_ITEM_CHARS = 800`). ~2.5K chars is a healthy target.
- Source content from the repo's current `MEMORY.md` **plus** live repo evidence (HEAD, docs, result files).
- Drop already-executed plan items: if the memory still says a migration/decision is pending but HEAD shows it landed, write the completed state instead of repeating the stale conclusion.

## 6. Clean stale locks only with proof

The general lock/backup model lives in `pi-project-context-memory-recovery`; the sibling-specific residue check is:

```bash
find .agents -name '*.lock' -printf '%s %TY-%Tm-%Td %p\n'
```

Assert every candidate is **0 bytes** and has an mtime older than today before deleting; keep non-empty or fresh locks. Typical residue after an old-version run: `.agents/memory/.index.lock` and `session-logs/<id>/.lock`. After cleanup, the `.lock` count in each repo should be 0. A filename that merely looks lock-like is not proof of ownership: check which code can open that path (the zero-byte files under `session-logs/<id>/` came from the Codex port's `fcntl.flock`, not from `shared/lock.ts`).

## 7. Archive, do not delete, errors.log

```bash
mv .agents/memory/errors.log .agents/memory/errors.log.<YYYY-MM-DD>-<episode>
```

It is the only on-disk proof that consolidation failed closed (last line typically `consolidation reply was not a usable JSON object`).

## 8. Do not hand-create memory.jsonl

`memory.jsonl` being absent is legal; the new code writes the journal baseline on the next normal write. Treat "no journal yet" as expected, not as missing state to migrate.

## 9. Verify with the real read path

Reload through `loadMemory()` or the extension's probe and confirm `poisoned=false`, `unreadable=false`, a clean Markdown body, and `source === memory.jsonl` where a journal exists. Note that `memory_markdown` keyword hits may be legitimate curated content (e.g. a warning bullet), not corruption.

## 10. Tag/installed-copy consistency

Annotated tags cannot be amended: to move a tag, delete and recreate it locally, force-push the tag to **both** remotes, then re-run `pi update --extensions` so the installed clone matches the tag commit (a docs-only re-point is harmless). New code only takes effect in a **restarted** process; a live session keeps running the old installed version. Full release/pin/verify procedure: `pi-project-context-release-tag-and-pin-sync`.

## Non-destructive rules

- Back up both worktree files to `/tmp` before any probe; never `git checkout --` over dirty sibling memory.
- Prove untouched files with identical character counts (not bytes).
- Leave sibling-repo commits to the owner; record the decision plus the unique-fact list in `.codestable` instead of writing into the sibling repos.
