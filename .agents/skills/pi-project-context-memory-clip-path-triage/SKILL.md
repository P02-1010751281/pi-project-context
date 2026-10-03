---
name: pi-project-context-memory-clip-path-triage
description: "Triage lost/trimmed MEMORY.md content in pi-project-context by naming which of the three consolidation write paths clipped it (sectioned drop vs byte clip), recovering the pre-clip reply, and knowing why an over-cap retry does not migrate output to the sectioned renderer."
---

# Memory clip-path triage (pi-project-context)

## When to use
A consuming repo's `MEMORY.md` lost durable facts (typically mid-document: the middle of Invariants/Pitfalls), or a cap warning / `memory-overflow-*.md` file appeared, and you must decide **which write path did the clipping** before proposing a fix or a release.

## 1. Name the path from the code, not from the symptom
`extensions/project-context/memory/pass.ts` → `resolveReply` classifies every reply into one of three kinds:

- `structured` — the model called the `record_memory` tool.
- `fallback-sections` — the plain-text reply was accepted by the Markdown extractor (exactly the four known sections).
- `fallback-opaque` — everything else.

Paths 1–2 go through `renderMemoryDocument`: whole entries are dropped per section and reported via `sectionDropped` / `itemTruncated` — counted, never arbitrary byte loss.
Path 3 is the only byte-lossy one: over-cap replies hit `exceedsMemoryCap` → `clipToLineBoundaryBothEnds` (head ~60% + tail ~40%; the middle disappears permanently, leaving only a marker).

```bash
grep -rn 'sectionDropped\|itemTruncated\|clipToLineBoundaryBothEnds\|exceedsMemoryCap' extensions/project-context/
ls -lt .agents/memory/memory-overflow-*.md | head
grep -n 'overflow\|cap\|clip' .agents/memory/errors.log | tail -20
```

If only `sectionDropped`/`itemTruncated` fire, nothing was silently destroyed — read the counts and the section names before touching code.

## 2. Recover the pre-clip text
Since `1f0672c` (D2; `v0.2.0` predates it) the reply's **uncut** text is persisted to `.agents/memory/memory-overflow-<timestamp>.md`; the write is best-effort, the log line and the toast name that file, and the pattern is added to the memory dir's local `.gitignore`. Seed `MEMORY.md` back from that file rather than from the head/tail fragments.

**Timing (changed by `00bf797`, the external-edit fix).** The copy is written **after** a successful publish, and only then: the file holds pre-clip *content*, but disk *order* is `MEMORY.md` first, copy second. A pass whose publish was refused (an external edit won — see `the reply was not published` in `errors.log`) writes **no copy at all**, because that reply has no `MEMORY.md` to point at. So a missing copy means one of three things, and the log distinguishes them: the build predates `1f0672c`, the publish was refused, or the process died between the two writes (`report.ts:179-185`; design residual R-13).

If no such file exists for the incident, verify the actual loaded code instead of assuming: check the pin at `~/.pi/agent/settings.json` and the installed clone's tag (`git -C ~/.pi/agent/git/git.lentech.site/<org>/pi-project-context describe --tags`) and grep the clone for the marker function.

## 3. Do not expect the over-cap retry to fix it
The condense retry in `pass.ts:248` asks the model for a `memory_markdown` string plus a `context` object and is issued with tools disabled — i.e. it steers the reply toward the **opaque** shape. Adoption only tests `!exceedsMemoryCap(condensedText, limit)`, not that sections exist. A retry can therefore come back still opaque; the retry does not migrate output into the sectioned renderer.

## 4. Constraint to state before proposing "migrate it to sections"
Semantic migration of prose into Project/Invariants/Pitfalls requires a model call: the extractor deliberately refuses that guess, because silently misattributing durable facts is worse than clipping. Two legal shapes:

- **M** — re-ask with a sectioned target: prefer the `record_memory` tool; when the sticky no-tools switch is on, require exactly the four sections the Markdown extractor (`sectionsFromMarkdown`) accepts.
- **N** — migrate only the clipping granularity: drop whole blocks (paragraph/bullet/heading) with counts, no section semantics. This makes the opaque path lossless and makes D1 (section-aware clipping) redundant.

Keep the overflow file (D2) as the safety net in either case.

## 5. Label hygiene in write-ups
"D2" is ambiguous in this repo. In the post-v0.2.0 follow-up list: D1 = section-aware clipping, D2 = persist the over-cap reply, D3 = session-log retention, D4 = strict-mode end-to-end. But `.codestable/issues/*/structured-consolidation-output/implementation-note.md:53` carries an unrelated D2 (`toolsAttempted` set before the call). Cite the file plus label, never the label alone.
