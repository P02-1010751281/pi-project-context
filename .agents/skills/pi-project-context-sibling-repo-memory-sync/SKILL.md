---
name: pi-project-context-sibling-repo-memory-sync
description: "Reconcile .agents/memory state across sibling repos that consume pi-project-context (MEMORY.md vs HEAD diff, CONTEXT.md rewrite in renderer format, stale lock cleanup, errors.log archive) without losing curated lines."
---

## When to use

After pi-project-context is upgraded, or after a poison/truncation episode, when sibling repos (e.g. `UniField`, `Quantum_Matrix`) still hold `.agents/memory/` written by an older version and their `MEMORY.md`/`CONTEXT.md` need reconciling or cleanup. Also use when asked "记忆/项目上下文需要同步吗？" for repos other than the extension repo itself.

Work only on files you can back up, and leave git commits in sibling repos to the owner unless explicitly asked.

## 1. Back up working-tree bytes first

Sibling `MEMORY.md`/`CONTEXT.md` are often already dirty (` M`) before you arrive. Never `git checkout --` over them.

```bash
cp .agents/memory/CONTEXT.md /tmp/<Repo>-CONTEXT.md.before-sync-$(date +%Y%m%d-%H%M%S)
cp .agents/memory/MEMORY.md /tmp/<Repo>-MEMORY.md.before-sync-$(date +%Y%m%d-%H%M%S)
```

## 2. Pin the invariant for files you must not touch

If you claim you did not modify the memory body, prove it: record the char/byte count of `MEMORY.md` before and after (e.g. `wc -c`, or a text-length probe) and report identical numbers. In the recorded runs both sibling memories stayed byte-stable while only `CONTEXT.md` changed.

## 3. Reconcile MEMORY.md against HEAD before committing a repaired render

A repaired/poison-recovered render can be richer and still be missing curated HEAD lines. Diff line sets both ways and list what HEAD has that the worktree lacks:

```bash
git show HEAD:.agents/memory/MEMORY.md > /tmp/head-memory.md
# compare line sets; print lines present in HEAD but absent now
```

If the missing lines are substantive lessons/conclusions (e.g. experiment verdicts, reusable heuristics), do not pick a side: merge them back into the current render, then present merge-vs-restore-vs-commit-as-is to the owner as an explicit choice. Also compare decoded backup copies (poisoned JSON or older `MEMORY.md` backups) against the current memory by keyword coverage; "no verbatim line match" usually means the same fact was rewritten, not lost.

## 4. Rewrite CONTEXT.md in the current renderer format

Current format starts `# Project Context` followed by `Last updated: <ISO-8601>`. The old `# Context` heading and hand-written `Last updated: <date> (agent 重建…)` style are stale.

- Budget: keep the file under `MAX_CONTEXT_CHARS = 32000` (`extensions/project-context/project-state.ts`; `MAX_SUMMARY_CHARS = 6000`, `MAX_LIST_ITEM_CHARS = 800`). ~2.5K chars is a healthy target.
- Source content from the repo's current `MEMORY.md` **plus** live repo evidence (HEAD, docs, result files).
- Drop already-executed plan items: if the memory still says a migration/decision is pending but HEAD shows it landed (e.g. `docs/discussion-log.md` + `DiscussionLog/` at `f33da15`), write the completed state instead of repeating the stale conclusion.

## 5. Clean stale locks only with proof

General lock/backup model lives in `pi-project-context-memory-recovery`;
the sibling-specific residue check is:

```bash
find .agents -name '*.lock' -printf '%s %TY-%Tm-%Td %p\n'
```

Assert every candidate is **0 bytes** and has an mtime older than today before deleting; keep non-empty or fresh locks. Typical residue after an old-version run: `.agents/memory/.index.lock` and `session-logs/<id>/.lock` (69 such files across two repos in the recorded run). After cleanup, the `.lock` count in each repo should be 0.

## 6. Archive, do not delete, errors.log

```bash
mv .agents/memory/errors.log .agents/memory/errors.log.<YYYY-MM-DD>-<episode>
```

It is the only on-disk proof that consolidation failed closed (last line typically `consolidation reply was not a usable JSON object`).

## 7. Do not hand-create memory.jsonl

`memory.jsonl` being absent is legal; the new code writes the journal baseline on the next normal write. Treat "no journal yet" as expected, not as missing state to migrate.

## 8. Verify with the real read path

Reload through `loadMemory()` (or the extension's probe) and confirm `poisoned=false`, `unreadable=false`, clean Markdown body, and `source === memory.jsonl` where a journal exists. Note that `memory_markdown` keyword hits may be legitimate curated content (e.g. a warning bullet), not corruption.

## 9. Tag/installed-copy consistency

Annotated tags cannot be amended: to move a tag, delete and recreate it locally, force-push the tag to **both** remotes, then re-run `pi update --extensions` so the installed clone matches the tag commit (docs-only re-point is harmless). New code only takes effect in a **restarted** process; a live session keeps running the old installed version. Full release/pin/verify procedure: `pi-project-context-release-tag-and-pin-sync`.
