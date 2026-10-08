---
name: pi-project-context-memory-recovery
description: "Diagnose and repair .agents/memory: stale old-code writer, truncation vs poison, which path clipped it, dropped tails, backups, tests. Use when MEMORY.md lost content."
---

<!-- autolearn-generated: this skill may be superseded by a later autolearn pass -->

## When to use

`MEMORY.md` looks like a raw model reply (JSON envelope, `memory_markdown` key, fences), ends mid-word/mid-sentence (e.g. `…buildTreePre~`) or silently drops trailing bullets, pi warns like `consolidation reply was not a usable JSON object`, `/memory` reports poison/damage, or a sibling project that installs this extension has suspect memory. Use for repair/verification, not for normal consolidation tuning.

A silent trim of the middle of the document (typically inside Invariants/Pitfalls), or a cap warning / `memory-overflow-*.md` file, is the same family: name the clipping path in section 1b before proposing a fix or a release.
The same skill covers the reverse direction: a curated render that asserts what a mechanism did in the field (rotation, pruning, a log key) must be checked against that mechanism's artifacts before the entry is kept or committed (section 5).

## 0. Rule out a live old-code writer first

Editing `extensions/project-context/*` changes nothing for already-running sessions: they execute the version installed in `~/.pi` (pin tracked in the separate `pi-config` repo), and a live old-code process rewrites `.agents/memory/` on `agent_settled` / `session_shutdown` consolidation. Your own current session is a candidate writer.

1. Find writers and start times: `ps -eo pid,tty,lstart,cmd | grep -E '[p]i( |$)'`.
2. Timestamp artifacts against the fix/install time: `ls -la --time-style=full-iso .agents/memory/MEMORY.md* .agents/memory/CONTEXT.md`. A write newer than the fix means an old process did it.
3. Compare installed vs working tree: `git log --oneline -3` in the project, plus the installed pin/tag in `~/.pi` / `pi-config`.
4. Record the PIDs, restart those sessions, install and re-pin the new version, then confirm a fresh process writes with the new marker/cap before re-testing the fix.
5. Expect mixed-version noise: the already-running host keeps executing pre-fix modules after the install, so `errors.log` keeps receiving lines from it until a restart. Date each line against the install/restart time and classify it there before calling a fix failed or new.

Never conclude "the fix failed" while an old-code writer is alive: the artifact timestamp is the discriminator, and `node tests/run-all.mjs` proves working-tree behavior only. Keep the damaged render as evidence before repairing.

## 1. Triage: truncation or poison?

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
tail -c 600 MEMORY.md | cat -A | tail -20
wc -c MEMORY.md; wc -l memory.jsonl 2>/dev/null
tail -5 errors.log
cat project-context.json   # maxMemoryChars, default 32000, range 4000-200000
```

- Mid-word cut **without** a marker → older/installed code path (a bare `.slice(0, 24000)` while claiming "keeping every line") or a poisoned reply.
- `_[memory truncated at N characters: M dropped]_` → the current whole-line cap; a render at/above `maxMemoryChars` (CJK bytes ≈ 3× characters) is cap truncation, not corruption.
- `MEMORY.md` starting with `{"memory_markdown":` (or an unterminated string/fence/short preamble) is poison, not memory. Truncation and JSON-poison are different failure modes: never copy a poisoned blob into a valid render.
- Check the truncation logic on disk: `grep -rn "normalizeMemoryDocument\|maxMemoryChars\|truncated at" extensions/project-context/`. The limit must be passed explicitly through normalization, folding, loading, comparison, and recording; a process-global limit or bare `.slice(0, N)` is pre-fix code.
- A journal with damaged/skipped lines shows as `damaged` counts in `errors.log` and `/memory`; zero usable records is the fail-closed state.

## 1b. Which path clipped it (sectioned drop vs byte clip)

Before proposing a fix, decide **which write path did the clipping** — name it from the code, not from the symptom.

`extensions/project-context/memory/pass.ts` → `resolveReply` classifies every reply into one of three kinds:

- `structured` — the model called the `record_memory` tool.
- `fallback-sections` — the plain-text reply was accepted by the Markdown extractor (exactly the four known sections).
- `fallback-opaque` — everything else.

Paths 1–2 go through `renderMemoryDocument`: whole entries are dropped per section and reported via `sectionDropped` / `itemTruncated` — counted, never arbitrary byte loss. Path 3 is the only byte-lossy one: over-cap replies hit `exceedsMemoryCap` → `clipToLineBoundaryBothEnds` (head ~60% + tail ~40%; the middle disappears permanently, leaving only a marker).

```bash
grep -rn 'sectionDropped\|itemTruncated\|clipToLineBoundaryBothEnds\|exceedsMemoryCap' extensions/project-context/
ls -lt .agents/memory/memory-overflow-*.md | head
grep -n 'overflow\|cap\|clip' .agents/memory/errors.log | tail -20
```

If only `sectionDropped`/`itemTruncated` fire, nothing was silently destroyed — read the counts and the section names before touching code.

**Recover the pre-clip text.** Since `1f0672c` (D2; `v0.2.0` predates it) the reply's **uncut** text is persisted to `.agents/memory/memory-overflow-<timestamp>.md`; the write is best-effort, the log line and the toast name that file, and the pattern is added to the memory dir's local `.gitignore`. Seed `MEMORY.md` back from that file rather than from the head/tail fragments.

**Timing (changed by `00bf797`, the external-edit fix).** The copy is written **after** a successful publish, and only then: the file holds pre-clip *content*, but disk *order* is `MEMORY.md` first, copy second. A pass whose publish was refused (an external edit won — see `the reply was not published` in `errors.log`) writes **no copy at all**, because that reply has no `MEMORY.md` to point at. So a missing copy means one of three things, and the log distinguishes them: the build predates `1f0672c`, the publish was refused, or the process died between the two writes (`report.ts`, the overflow-copy block; design residual R-13).

If no such file exists for the incident, verify the actual loaded code instead of assuming: check the pin at `~/.pi/agent/settings.json` and the installed clone's tag (`git -C ~/.pi/agent/git/git.lentech.site/<org>/pi-project-context describe --tags`) and grep the clone for the marker function.

**Do not expect the over-cap retry to fix it.** The condense retry in `pass.ts` asks the model for a `memory_markdown` string plus a `context` object and is issued with tools disabled — i.e. it steers the reply toward the **opaque** shape. Adoption only tests `!exceedsMemoryCap(condensedText, limit)`, not that sections exist. A retry can therefore come back still opaque; the retry does not migrate output into the sectioned renderer.

**Constraint to state before proposing "migrate it to sections".** Semantic migration of prose into Project/Invariants/Pitfalls requires a model call: the extractor deliberately refuses that guess, because silently misattributing durable facts is worse than clipping. Two legal shapes:

- **M** — re-ask with a sectioned target: prefer the `record_memory` tool; when the sticky no-tools switch is on, require exactly the four sections the Markdown extractor (`sectionsFromMarkdown`) accepts.
- **N** — migrate only the clipping granularity: drop whole blocks (paragraph/bullet/heading) with counts, no section semantics. This makes the opaque path lossless and makes D1 (section-aware clipping) redundant.

Keep the overflow file (D2) as the safety net in either case.

**Label hygiene in write-ups.** "D2" is ambiguous in this repo. In the post-v0.2.0 follow-up list: D1 = section-aware clipping, D2 = persist the over-cap reply, D3 = session-log retention, D4 = strict-mode end-to-end. But `.codestable/issues/*/structured-consolidation-output/implementation-note.md` carries an unrelated D2 (`toolsAttempted` set before the call). Cite the file plus label, never the label alone.

## 2. Read through the real paths (do not hand-edit)

`loadMemory()` in `extensions/project-context/shared/project-state.ts` is the single shared read path (injection, consolidation, autolearn). It folds `memory.jsonl` in order, falls back to the legacy `MEMORY.md` read when no journal exists (old projects need no migration), and returns `{ text, source, poisoned, unreadable, damaged, ... }` — ENOENT is distinguished from unreadable. With a journal present, `source` is the journal path, not `MEMORY.md`.

Poison decode (owner-approved heal-mode B) is read-only: the stored reply is decoded on read with no write side effect; the on-disk poison is repaired by the next normal consolidation write, which first takes a `.poison-backup-*` of the raw file. Never add a heuristic repair write inside the read path.

To validate decoder behavior without guessing, copy raw bytes into a scratch memory root and call `loadMemory` there:

```sh
mkdir -p /tmp/pc-mem/.agents/memory
cp <project>/.agents/memory/MEMORY.md /tmp/pc-mem/.agents/memory/MEMORY.md
```

Then call `loadMemory` from the harness against `/tmp/pc-mem` and check `poisoned`/`text`.

## 3. Recover, then repair

1. Copy the damaged `MEMORY.md` aside as a `.poison-backup-*`-style file (or rely on the automatic pre-write backup) before any repair write.
2. If `memory.jsonl` has usable records, the folded journal is the truth: delete or move the damaged `MEMORY.md` and let the next write re-render from the journal. Rebuild a damaged render with `recordMemoryDocument` semantics rather than by editing text. Never hand-edit `memory.jsonl`.
3. If the journal has zero usable records, `/memory` instructs the user to delete `memory.jsonl` to rebuild from `MEMORY.md`, or restore from `memory-log-*.jsonl`. Reconstruct `MEMORY.md` from the most credible source (journal archive first, then a backup render or `git show <old-commit>:.agents/memory/MEMORY.md`) and delete the unusable journal so the first write adopts the render as the new journal baseline.
4. Recover a dropped tail (cap truncation) the same way: fold the journal, list `MEMORY.md.memory-backup-*`, and diff against HEAD's blob. Re-add missing bullets by editing `MEMORY.md` externally — adoption happens only when the normalized render differs from the folded journal and is newer than the journal; content-equal renders are never re-journaled.
5. Fix forward for a cap: raise `maxMemoryChars` in `.agents/memory/project-context.json`, restart pi, run one consolidation, then re-tail `MEMORY.md` and confirm the marker is gone. The warning can recur until the installed package is updated and the process restarted; one bounded retry only mitigates the output-budget mismatch. Check the same output-budget mismatch cannot starve `CONTEXT.md`: a reply cut before the context member keeps the previous `CONTEXT.md`, so inspect `errors.log` for the "object never closed"/recovered trace.
6. Do not fix by hand-editing multiple stores at once: repair the render, then let the next normal write journal and back up.
7. Before overwriting `MEMORY.md`, confirm `backupMemoryBeforeWrite()` will run: it reads current bytes, names backups `MEMORY.md.memory-backup-<stamp>-<rand>`, fails closed when the target exists but can't be read, keeps 5 by mtime but never prunes backups younger than 1 hour, and hard-caps at 20 total.
8. Never delete backups or a newer memory render of a sibling project without explicit owner confirmation.
9. A repair pass that re-adds facts the model render dropped must be mechanical, not an eyeball pass: classify the removed lines against the previous render, restore every durable rule that lost its only home, and let the render's removed-line and punctuation checks (the truncation/punctuation gate) pass before committing.

All `MEMORY.md` writes run under the cross-process lock `MEMORY.md.lock`. Do not bypass it; `stealStaleLock` renames non-regular lock entries aside (`.broken-<8hex>`) and self-heals, and `cleanStaleTemps` only reclaims over-age empty broken directories. For changing lock/claim/backup code itself, use `pi-project-context-write-lock-hardening`.

## 4. Verify with the local harness

The plain-`node` harness is `tests/harness.mjs` (exposes `loadNamespace`, `PC`), per-module tests are `.mjs`, and `tests/run-all.mjs` aggregates them.

```sh
cd "$(git rev-parse --show-toplevel)"
node tests/run-all.mjs        # expect the whole suite green
```

Cross-process lock behavior is probed by `tests/helpers/lock-holder.mjs`; use it when a repair touches lock or rotation code. A repair of a read/append race is proved with a probe that carries a positive control (a stable file still gets a newer external edit adopted) and a mutation check (reverting the guard reddens only the checks that pin it). Confirm `git status` is clean except intended edits, and that memory `.tmp`/`.broken-*` artifacts were not committed. A fixture killed by its SIGKILL watchdog can leave its temp project root behind: the leftover is cosmetic (tens of KB), so clean it under `/tmp` rather than treating it as a leak in the memory dir.

## 5. Code-side rules to respect while fixing

- Parse model JSON only via `llm.ts::parseJsonObject`; shared field decoding is `project-state.ts::readJsonStringField` (tolerates unterminated strings, maps `\b`/`\f`).
- Consolidation must fail closed: never write an unparseable model reply as memory — prefer a failed pass, and let `errors.log` capture the raw reply head (≤4000 chars) while the UI shows only the first line.
- External edits are detected with `memoryComparisonKey` in both `recordMemoryDocument` and `loadMemory`: content-equal renders are never adopted even with a newer mtime; a genuine external edit (different content + newer mtime) is folded as a `replace` record on the next write with an `errors.log` note.
- Journal rotation at >512KB uses temp → archive → replace with rollback; the temp file name is `memory.jsonl.<epoch-ms>.<uuid>.tmp` so it matches both the memory gitignore and `cleanStaleTemps`.
- Nothing prunes the `memory-log-*.jsonl` archives by count - only a duplicate archive from a crash after the copy is removed -
  so they accumulate with use, each about the size of the journal that crossed the threshold. They are also the second net under
  the rotation window (a deleted `memory.jsonl` rebuilds from them), so trimming them is a retention decision, never routine hygiene.
- Rotation archives sit at or above the 512KB threshold, not about it: the journal keeps growing between checks, so an archive noticeably larger than the threshold is normal and is not evidence of a second bug.
- Prove a mechanism fired before keeping a claim that it never did. List that mechanism's own artifacts, e.g. `ls -lt --time-style=full-iso .agents/memory/memory-log-*.jsonl` plus `wc -c` on each: several archives at or above the threshold with mtimes spread over weeks is the evidence rotation ran in the field. Likewise check a log-key claim by grepping its call site (`grep -rn "shutdown:flush" extensions/project-context/`) and a rename-count claim against the constant plus the CHANGELOG list, where a key retired after the rename explains a smaller count. A curated entry asserting a field outcome is suspect until its artifacts are listed, and a false one is corrected in the render (own `docs(memory):` commit), not kept.
- For changing the cap or budget wording itself, use `pi-project-context-memory-cap-budget-change`.
