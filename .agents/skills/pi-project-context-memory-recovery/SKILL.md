---
name: pi-project-context-memory-recovery
description: "Diagnose and repair poisoned/corrupted .agents/memory state in pi-project-context (or codex-project-context) projects: inspect MEMORY.md/memory.jsonl, fold journal state, repair poisoned stored replies with backups, and verify via the node test harness."
---

## When to use

A project's `.agents/memory/MEMORY.md` looks like a raw model reply (JSON envelope, `memory_markdown` key, fences), pi warns like `consolidation reply was not a usable JSON object`, `/memory` reports poison/damage, or a sibling project (`../UniField`, `../Quantum_Matrix`) has suspect memory. Use for repair/verification, not for normal consolidation tuning.

## 1. Triage the on-disk state

Memory root is `<project>/.agents/memory/`. Relevant files:

- `MEMORY.md` — derived render (human + injection text)
- `memory.jsonl` — append-only journal (`replace`/`append` records), source of truth once present
- `memory-log-*.jsonl` — archived journal segments (rotation), evidence if `memory.jsonl` is unusable
- `MEMORY.md.memory-backup-<stamp>-<rand>` — pre-write backups
- `errors.log` — redacted failure traces (JSON decode failures log the raw reply head)

Inspect before touching anything:

```sh
cd <project>/.agents/memory
ls -la
head -c 600 MEMORY.md; echo
wc -l memory.jsonl 2>/dev/null
tail -5 errors.log
```

Signals: `MEMORY.md` starting with `{"memory_markdown":` (or an unterminated string / fence / short preamble) is poison, not memory. A journal with damaged/skipped lines shows up as `damaged` counts in `errors.log` and `/memory`; zero usable records is the fail-closed state.

## 2. Read through the real paths (do not hand-edit)

`loadMemory()` in `extensions/project-context/project-state.ts` is the single shared read path (injection, consolidation, autolearn). It folds `memory.jsonl` in order, falls back to the legacy `MEMORY.md` read when no journal exists (so old projects need no migration), and returns `{ text, source, poisoned, unreadable, damaged, ... }` — ENOENT is distinguished from unreadable. With a journal present, `source` is the journal path, not `MEMORY.md`.

Poison decode (owner-approved heal-mode B) is read-only: the stored reply is decoded on read with no write side effect; the on-disk poison is repaired by the next normal consolidation write, which first takes a `.poison-backup-*` of the raw file. Never add a heuristic repair write inside the read path.

To validate decoder behavior without guessing, copy raw bytes into a scratch memory root and call `loadMemory` there:

```sh
mkdir -p /tmp/pc-mem/.agents/memory
cp <project>/.agents/memory/MEMORY.md /tmp/pc-mem/.agents/memory/MEMORY.md
```

Then call `loadMemory` from the harness against `/tmp/pc-mem` and check `poisoned`/`text`.

## 3. Repair procedure

1. Copy the poisoned `MEMORY.md` aside as a `.poison-backup-*`-style file (or rely on the automatic pre-write backup) before any repair write.
2. If `memory.jsonl` has usable records, the folded journal is the truth: delete or move the poisoned `MEMORY.md` and let the next write re-render from the journal. Rebuild a damaged render with `recordMemoryDocument` semantics rather than by editing text.
3. If the journal has zero usable records, `/memory` instructs the user to delete `memory.jsonl` to rebuild from `MEMORY.md`, or restore from `memory-log-*.jsonl`. Reconstruct `MEMORY.md` from the most credible source (journal archive first, then a backup render) and delete the unusable journal so the first write adopts the render as the new journal baseline.
4. Before overwriting `MEMORY.md`, confirm `backupMemoryBeforeWrite()` will run: it reads current bytes, names backups `MEMORY.md.memory-backup-<stamp>-<rand>`, fails closed when the target exists but can't be read, keeps 5 by mtime but never prunes backups younger than 1 hour, and hard-caps at 20 total.
5. Never delete backups or a newer memory render of a sibling project without explicit owner confirmation (Quantum_Matrix's newer memory vs HEAD was an open decision in this project).

All `MEMORY.md` writes run under the cross-process lock `MEMORY.md.lock`. Do not bypass it; `stealStaleLock` renames non-regular lock entries aside (`.broken-<8hex>`) and self-heals, and `cleanStaleTemps` only reclaims over-age empty broken directories.

## 4. Verify with the local harness

The plain-`node` harness is `tests/harness.mjs` (exposes `loadNamespace`, `PC`), per-module tests are `.mjs`, and `tests/run-all.mjs` aggregates them.

```sh
cd /run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context
node tests/run-all.mjs        # expect 8/8 passing in the current tree
```

Cross-process lock behavior is probed by `tests/helpers/lock-holder.mjs`; use it when a repair touches lock or rotation code. Confirm `git status` is clean except intended edits, and that memory `.tmp`/`.broken-*` artifacts were not committed.

## 5. Code-side rules to respect while fixing

- Parse model JSON only via `llm.ts::parseJsonObject`; shared field decoding is `project-state.ts::readJsonStringField` (tolerates unterminated strings, maps `\b`/`\f`).
- Consolidation must fail closed: never write an unparseable model reply as memory — prefer a failed pass, and let `errors.log` capture the raw reply head (≤4000 chars) while the UI shows only the first line.
- External edits are detected with `memoryComparisonKey` in both `recordMemoryDocument` and `loadMemory`: content-equal renders are never adopted even with a newer mtime; a genuine external edit (different content + newer mtime) is folded as a `replace` record on the next write with an `errors.log` note.
- Journal rotation at >512KB uses temp → archive → replace with rollback; the temp file name is `memory.jsonl.<epoch-ms>.<uuid>.tmp` so it matches both the memory gitignore and `cleanStaleTemps`.
