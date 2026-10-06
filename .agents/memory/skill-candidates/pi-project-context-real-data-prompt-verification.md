---
name: pi-project-context-real-data-prompt-verification
description: "Verify a prompt-builder change in pi-project-context by rebuilding the changed prompt from the real session's own data and diffing it against the live artifact, not a mock."
candidate: true
---

<!-- evidence: 01a10c44-70f7-707e-a185-5763cedd2706 — Rebuilding a changed prompt through the real code path and diffing against the recorded artifact is the repo's acceptance method for prompt-text edits; a mock-based rebuild would have hidden the extra scaffolding the real path inserts. -->

## When to use

- A change to a prompt-builder's *text* (`handoff/prompt.ts`, `memory/prompt.ts`, scaffolding/preamble prose) where the risk is not that it fails to compile but that the rendered result differs from what you claimed.
- Before reporting an "effect size" for a prose trim/rewrite, or before citing the new prompt as evidence in a design doc or CHANGELOG entry.
- When a mock-based test would pass while the real render would not (assembled strings, injected sections, conditional scaffolding).

## Principle

Rebuild the prompt through the **real code path** and diff it against the prompt that the live session actually sent/recorded. A diff of two real renders is the proof; a hand-written expected string is not.

## Procedure

1. Load the module the same way the extension loads it — via the test harness namespace loader rather than a hand-rolled import:
   - `tests/harness.mjs` exposes `loadNamespace(...)`; drive the builder (e.g. `buildHandoffPrompt`) through it so plugin-side wiring is present.
2. Feed it **this session's real inputs**, not fixtures: the real summary/pending question, the real session id, the real JSONL path, and the real config values. Take them from the live artifacts (`.agents/memory/HANDOFF.md`, the session JSONL, `.agents/memory/project-context.json`).
3. Write the rebuilt text to a temp file, then diff it against the prompt recovered from the session JSONL:
   - `diff <(rebuilt) <(recorded)` and read the line/char counts from both sides.
   - Confirm which lines were removed and which added; state the exact count (e.g. `N lines/N chars -> M lines/M chars`).
4. Prove the *stable* part is untouched: byte-compare the unchanged block (for handoff, the nine-section summary body) and report it identical, so the diff is attributable to the edit and nothing else.
5. Report the effect size honestly: a prose trim that removes repeated sentences is **not** a token saving unless it removes tokens from the re-sent block; say so instead of implying a budget win.
6. Update the test assertion in the same change to a **single-sided pin** — assert the removed line's *absence* (re-adding it must redden the test) rather than a two-sided equality that also breaks on unrelated wording edits.
7. Run `node tests/run-all.mjs` and report the green count.

## Gotchas

- A rebuild that uses a mock/echoed summary can look correct while the real path inserts extra scaffolding; always drive the exported builder.
- Keep the temp rebuilt text only as scratch evidence; do not commit it into the repo or paste the whole re-sent block into memory.
- Do not back-fill or "use up" the handoff keep budget while rebuilding — refilling changes turn alignment and invalidates the comparison.
- If the trim trades a string for a new boolean branch (e.g. merging two carry flags), it is not a simplification; decline it and say why rather than reporting a character win.
