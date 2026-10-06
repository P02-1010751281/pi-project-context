---
name: pi-project-context-memory-cap-budget-change
description: "Change the memory cap safely: thread maxMemoryChars through every read/write path, keep clipping idempotent, pin with tests. Use for cap or budget edits."
---

<!-- autolearn-generated: this skill may be superseded by a later autolearn pass -->

## When to use

Changing anything about the memory character budget in `pi-project-context`: `maxMemoryChars`, truncation markers, the consolidation prompt's size wording, or condensation-on-overflow. Do this instead of hand-patching one call site — the cap has to stay consistent across journal, render, comparison, and legacy-read paths.

## Procedure

1. **Find every carrier first.**
   ```bash
   grep -rn "MAX_MEMORY_CHARS\|maxMemoryChars\|memory truncated\|exceedsMemoryCap" extensions/ tests/ docs/ README.md
   ```
   A shared budget constant/formula change must sweep docs (plain text + LaTeX + bullets + examples), code comments, test section comments, and mark superseded `.codestable` fits as historical, in one pass.

2. **Thread the limit explicitly.** Pass the limit through normalization, folding, loading, comparison, and recording. Do **not** add a process-level mutable/global limit — an earlier version did and independent review flagged it as cross-project bleed; callers must own and pass the value.

3. **Clip on whole lines + strict marker.** Truncation keeps whole lines and only cuts inside a single over-long line, appending the exact marker shape `_[memory truncated at N characters: M dropped]_`. `normalizeMemoryDocument` must be idempotent: strip the marker before measuring (`exceedsMemoryCap`), re-append only the exact marker, and never treat a normal line that merely starts with the marker words as a real cap event.

4. **Tell the prompt the truth.** Pass the real hard cap (`maxMemoryChars`) and the current character count into `memory/prompt.ts`, and forbid omission/truncation markers in model output. Remove ineffective word-count wording like "below 6000 words" from prompts.

5. **Overflow = one bounded condensation call.** If a reply to consolidate overflows the document's `maxMemoryChars`, make exactly one condensation call that tells the model to keep every still-true fact, merge duplicates, deduplicate across sections, then condense wording until the whole document fits the cap; a deletion is allowed only for an entry that is superseded or already covered elsewhere. Adopt it only if `renderMemoryDocument` reports nothing dropped (its counts are now the document-full signal, not a per-section one); otherwise keep the original reply and let the cap report speak. Silent tail-dropping is not acceptable. The per-section shares are **targets**: the renderer pools what the under-target sections leave and hands it to the over-target ones, so a section may exceed its share while the document still fits — do not "fix" a section over its share by deleting entries.

5b. **The pool is the document's real body, not the sum of the targets.** Any allocation that lets one section
   spend another's leftover must measure the budget as `cap - memoryStructureOverheadChars()` (header + `## H` lines
   + the separators between sections = 67 at this schema), not as the sum of `memorySectionBudgets`. The schema
   overhead is deliberately conservative (76) and the targets are floored, so `Σtargets` is 11 characters smaller
   than the cap; charging the pool from it dropped three entries on this repo's own memory on 2026-10-06 while the
   document still had 7 characters spare. Pin it with a fixture whose canonical document fits the cap but exceeds
   `Σtargets`.

6. **Wire diagnostics, not silence.** The `errors.log` entry, non-silent pass warning, `/memory update` command reply, and `/project-context status` should all name the cap and what was dropped. Update `docs/architecture.md` if a new shared module was added.

7. **Verify.**
   ```bash
   node tests/run-all.mjs        # all suites must pass
   git diff --check
   ```
   Add/extend `tests/memory-budget-test.mjs` with cases that pin exact numeric values and label strings. Run the mutation matrix (each guard's mutation must redden only that probe, plus a positive control) per `pi-project-context-gate-probe-mutation-check`.

8. **Review + rollout.** Protocol/boundary changes (prompt contract, marker semantics, message strings) go through `pi-project-context-independent-review`; keep user-visible strings and numbers identical when refactoring shared helpers. Running pi sessions use the installed clone — they will not see the change until rebuild/reinstall and restart.

## Gotchas

- A copied marker on a short reply previously produced a false "hit the cap" warning and a stale self-describing line; `exceedsMemoryCap` exists to stop that.
- When a shared cap-warning helper or size label is extracted, prove same strings/numbers so tests do not silently weaken.
- `shape` (JSON shape/truncation) failures are not provider outages; never let them drive route cooldown.
