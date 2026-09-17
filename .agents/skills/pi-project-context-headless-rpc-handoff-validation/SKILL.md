---
name: pi-project-context-headless-rpc-handoff-validation
description: "Validate pi-project-context handoff/compaction end-to-end with a headless pi RPC run against a throwaway sandbox project, then inspect the resulting HANDOFF.md and memory artifacts instead of trusting unit tests."
---

## When to use

After changing handoff code (`handoff.ts`), compaction-prompt handling, `handoffKeepTokens`/`handoffLanguage` logic, or memory write paths in `pi-project-context`, run a real headless `pi` session to prove the feature works end-to-end before declaring the fix done. Unit tests in `tests/*.mjs` do not exercise pi's real prompt/turn alignment.

## Preconditions

- Extension entry point: `extensions/project-context/index.ts` in the repo root.
- Use a throwaway project directory (e.g. `mktemp -d`) so `.agents/memory/` artifacts do not pollute the repo.
- Old `pi` processes must be exited first; a stale process holding `MEMORY.md.lock` will stall writes.

## Procedure

1. Create a sandbox project and drive pi in RPC mode with extensions/skills/prompt-templates disabled except the extension under test:

   ```bash
   sandbox=$(mktemp -d)
   cd "$sandbox"
   pi --mode rpc -ne -ns -nt --thinking off \
     -e <repo>/extensions/project-context/index.ts -- <prompt-file-or-stdin>
   ```

   `-ne`/`-ns`/`-nt` disable extensions, skills, prompt templates so only the `-e` extension loads; `--thinking off` keeps output deterministic.

2. Drive the session far enough to cross the handoff threshold (or temporarily lower `handoffKeepTokens` in `.agents/memory/project-context.json` in the sandbox) so `runHandoff` actually fires.

3. Inspect the artifacts in `$sandbox/.agents/memory/`:
   - `HANDOFF.md` — check headers/language match the configured `handoffLanguage` (`auto`|`zh`|`en`), and that old handoff prompts appear as the one-line `[handoff prompt omitted]` marker rather than being deleted.
   - `MEMORY.md` + `memory.jsonl` — confirm a `replace` record was appended, not an overwrite outside the journal.
   - `memory-log-*.jsonl` / `MEMORY.md.memory-backup-*` — confirm backups were taken when a write occurred.
   - `errors.log` — confirm no unparseable-model-reply or lock errors.

4. For language resolution, send a short Chinese user turn and repeat: the handoff doc headings should render in Chinese when `handoffLanguage: auto` resolves to `zh`.

## Gotchas

- Replay blocks must not open with `assistant(toolCall)` — Anthropic/Gemini routes reject it with 400. Verify the omitted-marker substitution preserved `findCutPoint` slicing and toolCall/toolResult pairing.
- `session_shutdown` always runs a forced silent consolidation pass, so replacing a session produces extra `MEMORY.md` + backup writes — that is expected, not a bug.
- Known pre-existing gap: when the whole session fits in `handoffKeepTokens`, `runHandoff` returns before any notify and the user sees a silent no-op. Do not mistake that for a failure of your change.
- The keep budget is an upper bound; do not back-fill old prompts to "use" the budget — refilling breaks turn alignment.
