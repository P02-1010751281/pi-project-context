---
name: pi-project-context-reply-shape-gate
description: "Change or diagnose pi-project-context's reply-shape acceptance gate (what a consolidation reply may publish): accepted shape, fence reader, fail-closed fixtures."
---

<!-- autolearn-generated: this skill may be superseded by a later autolearn pass -->

# Reply-shape gate in pi-project-context

Use when changing what a consolidation reply is allowed to publish over a stored `MEMORY.md` (the
opaque-reply refusal, `replyHasStructure`), when a field report says a stored memory was replaced by
prose, or when review rounds keep finding new edge cases in the acceptance rule and you must decide
whether to keep patching or shrink the accepted surface.

Run from the project root: `cd "$(git rev-parse --show-toplevel)"`

## 1. Locate the three separate concerns

```bash
grep -rn 'replyHasStructure\|isHeadingOnlyDocument\|sectionsFromMarkdown\|memoryComparisonKey' \
  extensions/project-context/ tests/ | head -40
```

Keep them separate and say which one you touched:

1. **shape acceptance** of the model reply (is this a document at all?);
2. **the publish/fold decision** in `memory/store.ts` (basisKey recheck, `read.changed`, the journal's
   fold standing);
3. **the section vocabulary** in `memory/sections.ts` (`sectionsFromMarkdown`, `isHeadingOnlyDocument`).
   Reuse its names; a second hardcoded section list is the drift this repo keeps re-finding.

## 2. Acceptance = this extension's own document shape

- Strip the canonical `# Project Memory` title **first**, then test the remaining body. Testing the whole
  reply lets a prose reply that merely re-echoes the title pass.
- Accept only the shapes the renderer itself writes: a column-0 `## <known section>` heading and column-0
  `- ` bullets. A heading-like line at column 0 inside an indented or quoted block is not a heading.
- Skip fenced blocks through **one shared fence reader** used by every acceptance site: an opener is a run
  of at least three backticks or tildes (an info string is allowed); a closer is the same character, at
  least as long, with nothing but whitespace after it. A second, weaker fence rule copied into one call
  site is how a mirrored half-rule hole appears.
- Keep the failure direction **fail-closed**: a refused reply keeps the stored memory, journals one
  diagnostic line, and runs nothing publish-side (no removal warning, no toast, no overflow copy), and the
  model call is not re-run.
- Keeping acceptance loose in the other direction (accept more shapes) is a *behavior* decision: it
  re-admits setext/HTML/numbered/indented prose. Record which shapes are refused and why the direction is
  safe, so a later reader does not read it as an omission.

## 3. Fixtures from field strings, never paraphrases

- One fixture per shape class, written as the **byte-exact string** the field reported (an `errors.log`
  line, a session record, a probe transcript) — a re-typed paraphrase silently stops reproducing the case.
- Cover the variants that slipped through once: canonical title present but prose below, no title at all,
  a pseudo heading (`#.`), replies one character either side of the length floor, and a fresh project with
  no memory file yet.
- Each guard needs a mutation: invert that guard alone and confirm exactly its own assertions go red (in
  this repo a load-bearing guard reddens a handful of named checks) and give the fixture a positive control
  so a suite that fails for another reason is not read as proof. See
  `pi-project-context-gate-probe-mutation-check`.
- Run `node tests/run-all.mjs` and repeat a green run before freezing; a single green pass after editing a
  guard is not evidence the fixture still pins it.

## 4. Stop patching when each round opens an adjacent hole

If successive review rounds each fix one edge class and open another (in this repo: fence parity, then a
bare separator, then blank/indented/HTML headings, then list-item fences and candidate-line bridges), treat
it as an acceptance-surface problem rather than a code detail, and shrink acceptance to this extension's own
shape. That removes the need for the setext/HTML/indented/numbered rules entirely instead of adding a fifth.

State the cost in the same change: the now-refused shapes are non-destructive (memory kept plus a
diagnostic), but it is a behavior change, so it needs its own version entry in `CHANGELOG.md` and a fresh
review round on the frozen revision — not a re-pointed tag. Release mechanics live in
`pi-project-context-release-tag-and-pin-sync`.

## 5. Report honestly

Name what the change does **not** close: a length-floored refusal (a very short reply is rejected by the
length rule, never by the shape test), a project whose stored memory is not this document shape (the gate
has nothing to protect yet), and any unforceable concurrent window you accepted from the reviewer's probe.
Say plainly when a shipped revision carries mutation evidence but no independent PASS.
