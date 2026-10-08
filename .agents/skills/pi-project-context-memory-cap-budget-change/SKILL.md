---
name: pi-project-context-memory-cap-budget-change
description: "Inspect or change pi-project-context's memory budget: section targets, clipping, condensation, and diagnosing entries the renderer drops."
---

<!-- autolearn-generated: this skill may be superseded by a later autolearn pass -->

# Memory character budget in pi-project-context

## When to use

Changing anything about the memory character budget in `pi-project-context`: `maxMemoryChars`, truncation markers, the consolidation prompt's size wording, or condensation-on-overflow. Do this instead of hand-patching one call site — the cap has to stay consistent across journal, render, comparison, and legacy-read paths. Steps 7 and 9–11 also cover a rendered `.agents/memory/MEMORY.md` that sits near the cap and keeps losing entries or reverting a hand-restored rule.

## Procedure

1. **Find every carrier first.**
   ```bash
   grep -rn "MAX_MEMORY_CHARS\|maxMemoryChars\|memory truncated\|exceedsMemoryCap" extensions/ tests/ docs/ README.md
   ```
   A shared budget constant/formula change must sweep docs (plain text + LaTeX + bullets + examples), code comments, test section comments, and mark superseded `.codestable` fits as historical, in one pass.

2. **Thread the limit explicitly.** Pass the limit through normalization, folding, loading, comparison, and recording. Do **not** add a process-level mutable/global limit — an earlier version did and independent review flagged it as cross-project bleed; callers must own and pass the value.

3. **Clip on whole lines + strict marker.** Truncation keeps whole lines and only cuts inside a single over-long line, appending the exact marker shape `_[memory truncated at N characters: M dropped]_`. `normalizeMemoryDocument` must be idempotent: strip the marker before measuring (`exceedsMemoryCap`), re-append only the exact marker, and never treat a normal line that merely starts with the marker words as a real cap event.

4. **Tell the prompt the truth.** Pass the real hard cap (`maxMemoryChars`) and the current character count into `memory/prompt.ts`, and forbid omission/truncation markers in model output. Remove ineffective word-count wording like "below 6000 words" from prompts.

5. **Overflow = one bounded condensation call.** If a reply to consolidate overflows the document's `maxMemoryChars`, make exactly one condensation call that tells the model to keep every still-true fact, merge duplicates, deduplicate across sections, then condense wording until the whole document fits the cap; a deletion is allowed only for an entry that is superseded or already covered elsewhere. Adopt it only if `renderMemoryDocument` reports nothing dropped (its counts are now the document-full signal, not a per-section one); otherwise keep the original reply and let the cap report speak. Silent tail-dropping is not acceptable. The per-section shares are **targets**: the renderer pools what the under-target sections leave and hands it to the over-target ones, so a section may exceed its share while the document still fits — do not "fix" a section over its share by deleting entries. Aim the prompt's compression wording at those per-section targets, both in the main rule and in the `<existing-memory>` caption; the condensation-retry sentence in `pass.ts` must say the same thing (a "remove the least durable entries" retry line is the opposite instruction and silently loses facts).

5b. **The pool is the document's real body, not the sum of the targets.** Any allocation that lets one section spend another's leftover must measure the budget as `cap - memoryStructureOverheadChars()` (header + `## H` lines + the separators between sections), not as the sum of `memorySectionBudgets`. The schema overhead is deliberately conservative and the targets are floored, so `Σtargets` is a little smaller than the cap; charging the pool from it drops entries while the document still has spare room. Pin it with a fixture whose canonical document fits the cap but exceeds `Σtargets`.

6. **Wire diagnostics, not silence.** The `errors.log` entry, non-silent pass warning, `/memory update` command reply, and `/project-context status` should all name the cap and what was dropped. Update `docs/architecture.md` if a new shared module was added.

7. **Verify.**
   ```bash
   node tests/run-all.mjs        # all suites must pass
   git diff --check
   ```
   Add/extend `tests/memory-budget-test.mjs` with cases that pin exact numeric values and label strings. Run the mutation matrix (each guard's mutation must redden only that probe, plus a positive control) per `pi-project-context-gate-probe-mutation-check`.

   Measure a live document with the cap's own gauge, not `wc -c` — the two differ slightly and the cap compares the gauge:
   ```bash
   PC="$(git rev-parse --show-toplevel)/extensions/project-context"
   node --input-type=module -e "
   import { loadNamespace } from './tests/harness.mjs';
   import { readFileSync } from 'node:fs';
   const { memoryDocumentChars } = await loadNamespace('$PC/memory/document.ts');
   const t = readFileSync('.agents/memory/MEMORY.md', 'utf8');
   console.log('gauge', memoryDocumentChars(t), 'raw', t.length);
   "
   ```
   `tests/harness.mjs` loads modules the way production does, so a gauge taken through it is authoritative (run it from the repo root).

   Prompt-wording assertions only prove the wording shipped; real acceptance is a render fact. Take it on the **first pass after restart with the new tag installed**:
   - count the `memory exceeded a section budget` lines in `.agents/memory/errors.log` before and after — the count must not rise;
   - count the entries (`grep -c '^- ' .agents/memory/MEMORY.md`) before and after — it must not fall.
   Do **not** accept on `memory regression:` lines: they are computed before the renderer clips, so they stay green while the render still loses entries.

8. **Review + rollout.** Protocol/boundary changes (prompt contract, marker semantics, message strings) go through `pi-project-context-independent-review`; keep user-visible strings and numbers identical when refactoring shared helpers. Running pi sessions use the installed clone — they will not see the change until rebuild/reinstall and restart.

## 9. Attribute a lost entry before rewriting the prompt

Symptom: the committed render is missing entries the model reply did contain, or bullets you hand-restored vanish again on the next pass. Two mechanisms look identical from the file — the model deleting them, or `renderMemoryDocument` clipping whole entries against the per-section budgets — and the cure differs, so measure first.

```bash
PC="$(git rev-parse --show-toplevel)/extensions/project-context"
node --input-type=module -e "
import { loadNamespace } from './tests/harness.mjs';
import { readFileSync } from 'node:fs';
const { renderMemoryDocument } = await loadNamespace('$PC/memory/document.ts');
const t = readFileSync('.agents/memory/MEMORY.md', 'utf8');
console.log(renderMemoryDocument(t, Number(process.env.CAP)));
"
```

Feed the **complete** document (the version that still holds the entries, e.g. the committed one), with `CAP` = `maxMemoryChars` from `.agents/memory/project-context.json`; check `renderMemoryDocument`'s signature in `memory/document.ts` first if the call shape has moved. If the returned drop accounting (`sectionDropped`, `droppedItems`) reproduces exactly the set missing from the rendered file, the renderer's clip is the cause and the model is innocent. Then note the loop: a hand-restored document that itself exceeds a section share is re-clipped on every pass, so re-restoring the bullets cannot converge.

Land the cure in the prompt layer (`memory/prompt.ts`) and in the condensation-retry sentence (`pass.ts`): keep every still-true entry, compress wording and merge duplicates inside the section, deduplicate across sections, delete only superseded/already-covered entries, and keep the adoption condition `sectionDropped === 0`. An independent reviewer overturning your stated root cause is a normal outcome of this probe — re-run it yourself before defending the story, and correct the audit/issue text when the probe disagrees with you.

## 10. A section's leftover is not a loan

`memorySectionBudgets` are targets: an over-target section loses whole entries even while the document as a whole is under `maxMemoryChars`, and an under-target section lends nothing to it. When that asymmetry is what keeps dropping entries, the options are (a) accept it and record the decision, (b) rebalance the targets against the observed content distribution, or (c) allow borrowing between sections — a mechanism change with its own design and review round, not a prompt tweak. Never bring a section under its target by deleting entries.

## 11. Make a hand-curated render survive the next fold

A model render drawn from the session's own context can revert a fact you corrected by hand (the shutdown/flush wording came back repeatedly). Editing `MEMORY.md` alone does not stick; seed the journal with the curated text in the extension's own op shape `{ts, op:"replace", text}`:

```bash
python3 - <<'PY'
import json, datetime, pathlib
text = pathlib.Path('.agents/memory/MEMORY.md').read_text(encoding='utf-8')
op = {"ts": datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z'),
      "op": "replace", "text": text}
with open('.agents/memory/memory.jsonl', 'a', encoding='utf-8') as fh:
    fh.write(json.dumps(op, ensure_ascii=False) + "\n")
PY
```

Then assert the seed is the last replace op and byte-identical to the committed render, before committing anything:

```bash
python3 - <<'PY'
import json
ops = [json.loads(l) for l in open('.agents/memory/memory.jsonl', encoding='utf-8') if l.strip()]
last = [o for o in ops if o.get('op') == 'replace'][-1]['text']
assert last == open('.agents/memory/MEMORY.md', encoding='utf-8').read(), 'journal seed != committed render'
print('journal seed matches the committed render')
PY
```

Keep the seed in the render's own commit (`docs(memory): refresh the memory render`), and re-run the render checks in `pi-project-context-curated-surface-hygiene` §12 after the pass: the render is regenerated from the session context as well as the journal, so a hand-cleaned or hand-restored line needs re-checking on every render.

## Gotchas

- A copied marker on a short reply previously produced a false "hit the cap" warning and a stale self-describing line; `exceedsMemoryCap` exists to stop that.
- When a shared cap-warning helper or size label is extracted, prove same strings/numbers so tests do not silently weaken.
- `shape` (JSON shape/truncation) failures are not provider outages; never let them drive route cooldown.
- A section-budget drop is not a model failure and not a provider issue: read `sectionDropped`/`droppedItems` before blaming or rewording the consolidation prompt.
- Prompt-layer changes are not live in a running session: a wording change means a new tag, a `~/.pi` pin bump and a restart, and its acceptance only starts at the first pass afterwards.
