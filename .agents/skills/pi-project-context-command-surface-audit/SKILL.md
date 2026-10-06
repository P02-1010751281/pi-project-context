---
name: pi-project-context-command-surface-audit
description: "Audit this project's command surface, or retire/rename/relocate a verb: registrations vs docs, shared renderers, what the cut costs, line-level pins."
---

<!-- autolearn-generated: this skill may be superseded by a later autolearn pass -->

## When to use

The owner asks which slash commands overlap, should be merged or retired; you just changed a command name, verb or flag; or you are
planning a removal / rename / relocation (retiring `/context`, moving `max-memory` to `/memory`). Run the audit before a design doc is
frozen, because the ground rules below decide whether the change is allowed at all.

## 1. Enumerate the registered surface (code is truth)

- Registration and verb dispatch: `extensions/project-context/index.ts` for the umbrella, `handoff/run.ts`, `autolearn/pass.ts`,
  `archive/archive.ts` and `memory/report.ts` for the layer commands.
- The surface rot is fast (v0.3.0 moved four verbs between commands), so re-read the registrations instead of trusting any list —
  including this one. Compare three things and **record** the comparison: `pi.commands` keys, each command's `getArgumentCompletions`
  output, and the `docs/configuration.md` command table (set-equal: no extra row, no missing row).
- Layer shape (v0.3.0): one command per data-flow layer, and the umbrella holds only what two or more layers share — `status`,
  `model`, `max-tokens`, plus the target-less four-feature `on|off` batch. `/memory`, `/session-log`, `/handoff` and `/autolearn` each
  own their `on|off`; there is no extension switch in the command surface (`--no-project-context` is a run-level flag).

## 2. One fact keeps one name — and one renderer

- Shared wording lives in a module, not in the callers: `memory/status.ts::memoryStatusLine()` (+ `memoryStatusLevel()`) renders the
  memory status line for `/project-context status` (prefix `Memory: `) and `/memory` (prefix `Project memory: `);
  `contextStatusLine()` renders the CONTEXT.md line for those same two.
- The guard is the branch-equality block in `tests/memory-ops-test.mjs` (six fixtures: normal, empty, at the cap, poisoned, journal
  unreadable, file unreadable). Re-inlining a branch into either command turns it red.
- Pin style matters:
  - Whole-block equality only when neither side is timestamped.
  - Where one side carries a timestamp, assert **line by line** (the `/context` split is accepted over its three path lines, never as
    block equality, because the umbrella's context-file line renders an updated timestamp).
  - Every equality pin needs a **single-sided** mutation: change one label on one side only and require exactly that assertion to fail.
    Editing the shared function moves both sides and the pin stays silently green — that is not a valid control.
  - When a second line joins an existing notification (e.g. `/memory` gaining `Context file:`), it must ride **in the same notification,
    after** the first line: `tests/memory-ops-test.mjs`'s `both()` reads the notification's first element. Compare the first line only.

## 3. A removal needs a machine-checkable ground

Command usage is not measurable from this repo's artifacts, so "nobody uses it" is never a valid ground. Legal grounds are (a) a field
fact (an owner-reported confusion counts — quote it) or (b) the successor's output is **byte-identical** to the doomed command's unique
output. Build (b) first, and split the work so the destructive half has proof before it lands:

- **Stage 1 (additive):** add the successor path and make it print exactly the lines the doomed command printed — copied verbatim, no
  re-wording. For `/context` the successors were the bare `/memory` (context-file line) and the bare `/session-log` (the two session
  paths), not a new umbrella verb and not an overloaded `status` (its contract is the fixed overview).
- **Stage 2 (destructive):** delete the `registerCommand` call, add one line to the rename/retire note in `docs/configuration.md`, and
  move its assertions in `tests/registration-test.mjs`. Rollback is restoring the registration line; no data is affected.
- Deleting a *feature toggle* entry point is different: `/project-context on|off`, `/handoff on|off` and `/autolearn on|off` all end in
  `setFeature()` in `shared/config.ts`, so that duplication is surface, not logic. Removing one is a destructive user-surface change.

## 4. A rename is a hard cut — there is no alias

pi's `RegisteredCommand` exposes only `name`, `description`, `getArgumentCompletions`, `handler` (read it in the managed install tree:
`~/.pi/agent/install/releases/$(cat ~/.pi/agent/install/current-version)/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`).
There is no alias field, so keeping the old name means a *second* `registerCommand` call — a larger surface. Repo policy is no alias and
no notice. Pre-existing synonyms that tests already pin (`/handoff` `language`→`lang`, `run|force`→`now`) are legacy behavior: leave them
alone, never cite them as precedent for a new alias.

Price the rename before proposing it:

```bash
cd <repo>
grep -rn 'commands.get("project-context")' tests/ | wc -l   # 12 call sites / 5 test files for the umbrella
grep -c '' docs/configuration.md                            # plus the command table and the prose paragraph
node tests/run-all.mjs                                      # 15 tests must stay green
```

Compare that with the real benefit. Once `/context` retired, no second command carried the word `context`, so the umbrella's actual
confusion source was already gone — which is why keeping the name and rewriting only its registration description won 3-to-12 sites.

## 5. Usage is not measurable on this machine (do not skip)

pi's `session.jsonl` stores expanded user/assistant/toolResult messages: no literal `/cmd` token, no notify/status text. Scanning four
repos' session-logs for the command names plus feedback strings returned 0 hits, so "nobody uses command X" cannot be grounded.

Search gotcha: a Projects-wide `find | grep` across all session-logs timed out at 600 s (one consumer repo's session-logs is multi-GB).
Search per repo with `rg --max-filesize …` instead.

## 6. Close out

- Code changes under `extensions/` need a tag, the `~/.pi` pin bump and a pi restart (see the release/pin skill); a single new verb is a
  poor reason to cut a release, so bundle it with the next extension change.
- Docs-only relationship paragraph: no tag needed.
- Commit with explicit pathspecs (never `git add -A`): a pending `.agents/memory` render must not ride along.
- A command's own length is not its cost: `/session-log` is 11 characters with one verb, and its volume lives in the archives it writes
  — that is a retention design with its own field facts.
- Recorded non-goals, so the same ground is not re-litigated: do not fold the feature `on|off` entry points or the layer commands back
  into the umbrella; do not touch the verb count of an untouched command in the same pass.
