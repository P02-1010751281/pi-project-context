---
name: pi-project-context-consolidation-prompt-rule
description: "Change a consolidation rule in memory/prompt.ts: placement, prompt-content assertions with mutation, render-based acceptance. Use for cross-repo boundary leaks."
---

<!-- autolearn-generated: this skill may be superseded by a later autolearn pass -->

# Consolidation prompt rules (extensions/project-context/memory/prompt.ts)

**When to use** — you need to add or change a rule sentence in `buildPrompt()`, e.g. blocking another repo's state or measurements from re-entering this repo's `MEMORY.md`/`CONTEXT.md`, or the same class of rule in the autolearn prompt (`autolearn/prompt.ts` asks for shapes, not measurements, and for one short description line).

## Why the prompt layer is the only durable lever
- `buildPrompt()` sends `<recent-conversation>` together with `<existing-memory>` and regenerates the whole document; the current bytes of `MEMORY.md` do not participate in the call.
- Hand-cleaned external state therefore comes back from the session context (observed three times; each time a consumer repo's measurements re-entered the render).
- Rule: never paste the offending numbers anywhere — not into a skill body, a doc, or an assertion. They are consumer state; the lesson is the *shape* of the leak.
- The external-edit adoption / basisKey gate only protects a user's edit from being overwritten; it does not stop the model writing state back. So the prompt is the only place a durable fix can sit.

## Two-layer placement (do both)
1. **Rule sentence** in the rules list next to the secrets/credentials rule (~§39). Wording that worked:
   > Write only durable facts about this project itself. Never copy another repository's state or measurements (commit distances, file sizes, research values, key counts); name another project only to record who owns an open item.
2. **Injection-point note**: first line of the `<recent-conversation>` block. Foreign-repo text enters the prompt through that block, so a note at the entry point beats a sentence buried in the rule list.

Before adding, re-read the rule list: it already bans secrets, credentials, generic advice, session filler, truncation markers, and pointer-first duplication, but carried no cross-repo boundary rule — that gap is this rule.

## Pin it with tests
- `tests/memory-budget-test.mjs` and `tests/context-schema-test.mjs` already call `buildPrompt`; add "the prompt contains the rule sentence" and "the prompt contains the injection note" as assertions there.
- `node tests/run-all.mjs` must stay at 15/15.
- Mutation matrix, applied single-sided: delete the rule sentence → exactly the rule assertions FAIL; delete the injection-point note line → exactly the note assertions FAIL; restore → 0 FAIL. Red anywhere else means the assertion is not pinned to its own guard.

## Acceptance — state the limit honestly
- Prompt-content assertions prove the words are in the prompt, never that the model obeys. Do not report the behavior as fixed on their strength.
- Real acceptance: run the boundary grep after several later renders and require 0 hits in `.agents/memory/MEMORY.md` and `.agents/memory/CONTEXT.md`:
  `grep -nE '[0-9]{2,3},[0-9]{3} char|commit[s]? (behind|ahead)' .agents/memory/MEMORY.md .agents/memory/CONTEXT.md`
  (a shape pattern, so the guard survives the numbers changing; this check runs after every render anyway).
- Gotcha: do not paste literal example measurements into skill bodies or docs — they are consumer state and they trip your own scanner. Use a shape placeholder such as `<N>,<NNN> chars`.

## Ship it
An `extensions/` change is release-visible: new tag, dual-remote push, `~/.pi` pin bump, `pi update --extensions`, restart. v0.2.3 shipped the two boundary layers this way. Follow the release-tag-and-pin-sync procedure and record the prompt cost in the release evidence.

## Non-goals (recorded, do not rebuild)
- Filtering foreign-repo content in `shared/conversation.ts`: kills the motivation evidence (a sibling render dropping a curated line is a lesson this repo must keep).
- A pre-publish gate for "new measurement lines": needs a maintainable foreign-name list and false-positives on legitimate numbers (module counts, line counts, fitted thresholds).
- Switching the render from whole-document regeneration to merge: fixes loss, not boundary, and is a new mechanism needing its own design.
