# Project Memory

## Project
- **pi-project-context** is a TypeScript/ESM pi coding-agent extension suite providing durable project memory, session context, archiving, autolearn, and handoff summaries.
- Stack: Node.js, `fs/promises`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`; tests use plain `.mjs` files through `tests/run-all.mjs`.
- Main code is under `extensions/project-context/`; rendered state is under each project's `.agents/memory/`.
- `.codestable/` stores issue reports, reviews, fix notes, and release evidence. Preserve the parallel Codex port under `.codestable/features/2026-09-15-codex-project-context-port/`.

## Documentation
- `README.md` is a concise entry point covering purpose, installation, feature overview, minimal configuration, verification, and links.
- Detailed documentation lives under `docs/`: `README.md` index, `architecture.md`, `configuration.md`, and `handoff.md`.
- `docs/handoff.md` contains plain-text formulas plus LaTeX equivalents; readers must not assume every Markdown renderer supports LaTeX.
- User preference: keep detailed architecture, formulas, configuration, and operational evidence out of README and organize them in a docs体系.

## Durable memory and context
- `.agents/memory/memory.jsonl` is the append-only source of truth; `MEMORY.md` is the derived human-readable render and external-edit entry point. Records are `replace` or `append`.
- `loadMemory()` is the shared read path and distinguishes missing, unreadable, damaged, poisoned, and journal-backed memory. Consolidation fails closed on unparseable model replies.
- External `MEMORY.md` edits are adopted only when normalized content differs from the folded journal and the render is newer than the journal. Content-equal renders are never re-journaled.
- Poisoned legacy JSON is decoded on read without side effects; the next normal write backs up and repairs it. Heuristic repair during reads is forbidden.
- Journal damage is tolerated with diagnostics; a journal with no usable records fails closed. Rotation archives old journals while preserving rollback safety.
- Writes use `.agents/memory/MEMORY.md.lock` with cross-process ownership, stale-lock recovery, backups, and atomic replacement. `errors.log` is append-only and redacts credential-shaped strings.
- Memory rendering defaults to `MAX_MEMORY_CHARS = 32000`, configurable through `maxMemoryChars` from 4000–200000. Truncation keeps whole lines and appends a strict marker; the limit is passed explicitly through normalization, folding, loading, comparison, and recording.
- Consolidation context must be an object with `summary` string, `title` string, and `key_points`/`open_tasks` arrays of strings. Missing or unusable context is logged and the previous `CONTEXT.md` is retained.
- Consolidation's primary failure mode is protocol/容量 mismatch rather than retry absence: a model must rewrite potentially large memory and context inside one JSON response, while provider output limits and dense CJK tokenization can truncate the response before closing quotes/braces or produce schema-invalid output. The bounded retry is only mitigation; durable improvements would require truncation/finish-reason diagnostics, structured-output support, or smaller independent/incremental updates.

## Handoff
- Handoff uses `ctx.newSession()` and stages settings in `handoff-session-settings.json`; successor startup restores the outgoing model and thinking level only for the matching predecessor, then consumes the staged file.
- Handoff language supports `auto`, `zh`, and `en`; replay filters old handoff prompts, allows in-turn cut points, preserves valid roles, and excludes orphan tool results from replay.
- Adaptive thresholds account for baseline, kept tail, older summary target, summarizer capacity, pricing tiers, and usable window. Status identifies the binding cap.
- If `ctx.model` is missing while staging a handoff, only thinking settings can be carried and an explicit diagnostic is written.

## Configuration and operation
- Configuration is in `.agents/memory/project-context.json` or the project root. Important keys include `autoConsolidate`, `autoLearn`, `maxTokens`, `maxOutputTokens`, `maxMemoryChars`, `handoffKeepTokens`, `handoffAdaptive`, `handoffThresholdRatio`, `handoffTargetTokens`, and `handoffLanguage`.
- Auxiliary models honor configured provider/model and otherwise use the authorized session model. Unresolved routes warn once per process.
- `session_shutdown` always performs a forced silent consolidation; `agent_settled` consolidation is conditional and fire-and-forget.
- `--no-project-context` disables project-context features for a run.

## Repository and release conventions
- Release procedure: commit, annotated tag, push tag and `master` to both remotes, bump the pin in the separate `pi-config` repository, verify installed tagged blobs, run a real settings-installed probe, record evidence, then commit release documentation separately.
- Memory render changes are tracked and normally committed as `docs(memory): refresh the memory render`.
- Full test suite currently passes 9/9. Real provider RPC validation was previously blocked by external quota/credit errors and does not count as successful handoff validation.
- Version `v0.1.8` is released and installed in `~/.pi`; the retry fix and related documentation are complete. Future protocol-level hardening is not yet implemented.
