---
name: pi-project-context-command-surface-audit
description: "Audit pi-project-context's slash-command surface for duplication: map verbs, check docs vs registrations, diff status formatters, and treat usage as unmeasurable."
---

## When to use

The owner asks which slash commands overlap, should be merged or retired, or you just changed a command name/verb/flag and need to re-verify the documented surface. Also run the doc-side half after any edit to `docs/configuration.md` or to command registration in `extensions/project-context/index.ts`.

## 1. Enumerate the registered surface (code is truth)

- Read command registration and verb dispatch in `extensions/project-context/index.ts`; feature commands also carry their own handlers in `handoff/*` and `autolearn/*`.
- Expected six (re-read the registrations; this list rots with every release): `/project-context` (status, `on|off <archive|memory|autolearn|handoff|all>`, model, max-tokens, max-memory), `/handoff` (status, on, off, auto, keep, target, thinking, send, draft, guard, lang, now), `/autolearn` (run now, list, approve, reject, on, off), `/memory` (bare status, update), `/session-log` (write now, `import <path>`), `/context` (bare, prints three paths).
- Confirm all six are registered for argument completion, and that the `docs/configuration.md` command table is set-equal to the registrations (no extra row, no missing row). Record the comparison, not a memory of it.

## 2. Keep the status rendering shared

Memory status was formatted twice and had drifted (the umbrella line lacked the journal-unreadable branch);
v0.2.2 moved the wording into `memory/status.ts::memoryStatusMessage()` — plus `memoryStatusLevel()` for
`warning`/`info` — called by `/project-context status` (prefix `Memory: `) and `/memory` (prefix
`Project memory: `). The guard is the branch-equality block in `tests/memory-ops-test.mjs`: six fixtures
(normal, empty, at the cap, poisoned, journal unreadable, file unreadable) with both bodies byte-identical.
Re-inlining a branch into either command turns that red, so change the shared formatter and re-run the test
rather than adding a second copy; the end-to-end pin is a single-sided mutation (make only one entry point
print a different body and confirm exactly the equality assertions fail). Full procedure: the
`status-renderer-dedup` skill.

## 3. Classify the rest as design, not defects

- Feature toggles are duplicate *surface* only: `/project-context on|off`, `/handoff on|off` and `/autolearn on|off` all end in `setFeature()` in `shared/config.ts`. Deleting any entry point is a destructive user-surface change, not a cleanup.
- `/context` overlaps `/project-context status` in exactly one place (measured: status 6 lines / 761 chars, `/context` 3 lines / 379 chars): the context file path. The umbrella prints it as `Context file: <path> — updated <ts>`, `/context` prints the same `Context file:` line without the age; the session index and the session-logs directory appear only in `/context`. So it is not a strict subset, and retiring it would lose those two paths. One fact keeps one name (v0.2.3): the umbrella's first line is `Features:`, never a second `Project context:` meaning.
- Asymmetry worth recording: the umbrella toggles four features (archive, memory, autolearn, handoff) but only handoff and autolearn have their own `on|off`; memory and archive do not.

## 4. Usage is not measurable on this machine (do not skip)

pi's `session.jsonl` stores expanded user/assistant/toolResult messages: it contains no literal `/cmd` token and no notify/status text. Scanning four repos' session-logs for the seven command names plus nine feedback strings returned 0 hits, so "nobody uses command X" cannot be grounded, and a `nobody uses it` removal is not justified. Removal of a user-facing verb needs a design doc plus a field fact.

Search cost gotcha: a Projects-wide `find | grep` across all session-logs timed out at 600 s (one consumer repo's session-logs is multi-GB). Search per repo with `rg --max-filesize ...` instead.

## 5. Close out

- Code dedup under `extensions/` -> new tag, `~/.pi` pin bump, pi restart (see the release/pin skill); run `node tests/run-all.mjs` and keep the suite green.
- Docs-only "entry point relationship" paragraph (umbrella is the canonical toggle place, `/context` is a cheap path lookup) needs no tag.
- Surface convergence (folding `on|off` verbs or `/context` into the umbrella) is destructive with no usage evidence: open an issue and leave the decision with the owner, do not implement.
