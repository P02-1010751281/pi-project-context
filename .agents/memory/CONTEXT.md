# Project Context

Last updated: 2026-10-04T12:36:41.194Z

## Summary

This session finished a full-tree quality sweep and then answered the owner's question about which of the extension's six slash commands need consolidating. The sweep's fixes (dead pre-split module paths in the skills; the memory render with the external-state boundary re-applied) are committed and pushed to both push URLs, tree clean, tests 15/15, and extensions/ is still byte-identical to v0.2.1, so no tag is warranted. The command investigation found one genuine duplication - memory status is formatted twice (index.ts memoryStatusLine for /project-context status versus memory/report.ts for /memory) and the two wordings have already drifted - plus three overlaps that are design rather than defects, and one asymmetry (handoff and autolearn carry their own on|off, memory and archive do not). Command usage turned out to be unmeasurable from the artifacts, so no command or verb removal is evidence-backed; the owner still has to decide on the formatter dedup (code change, new tag) and on a docs-only 'which command is canonical' paragraph.

## Key points

- Sweep fixes landed and pushed to both push URLs; per the last check HEAD is 6d49e2c, tree clean, tests 15/15, extensions/ byte-identical to v0.2.1 so no new tag.
- Command surface mapped: /project-context umbrella (status, on|off <archive|memory|autolearn|handoff|all>, model, max-tokens, max-memory); /handoff 12 verbs (status, on, off, auto, keep, target, thinking, send, draft, guard, lang, now); /autolearn (run now, list, approve, reject, on, off); /memory (status, update); /session-log (write now, import); /context (three paths). docs/configuration.md documents all six and all six are registered for argument completion.
- Real duplication: memory status has two implementations that have already drifted - the /memory wording (memory/report.ts) has a journal-unreadable branch ('delete it to rebuild from MEMORY.md, or restore from memory-log-*.jsonl') that the umbrella status line (index.ts memoryStatusLine) lacks, and the other branches are worded differently ('No project memory yet: X' versus a bare source plus size).
- Toggles: /project-context on|off, /handoff on|off and /autolearn on|off all end in setFeature (shared/config.ts), so there is no logic duplication, only surface duplication; the asymmetry is that the umbrella covers four features while only handoff and autolearn have their own on|off.
- /context versus /project-context status is not a subset relationship: the umbrella prints Config plus memory/context status lines, /context prints the context file, session index and session-logs paths, so retiring /context would lose those paths.
- Evidence boundary: pi's session.jsonl stores expanded user/assistant/toolResult messages with no literal /cmd token and no notify text; searching four repos' session-logs for seven command names and nine notify/status strings returned 0 hits, so 'which command is unused' is not measurable on this machine and cannot ground a removal.
- Search cost: a Projects-wide find|grep over all session-logs timed out at 600s (one consumer repo's session-logs is multi-GB); the workable form is rg per repo with --max-filesize.
- No code or doc change was made in this phase; the deliverable was the analysis itself, which is the reason the phase produced no commit.
- Recommended set given to the owner: do the shared memory-status formatter (code change under extensions/ -> new tag, pin bump, restart; test both entry points agree on every branch and that the journal-unreadable case is covered); optionally add a docs-only paragraph on entry-point relationships; do not converge the user surface without evidence.

## Open tasks

- Owner decision: dedupe the memory status formatter into one helper used by /project-context status and /memory, carrying the journal-unreadable branch into the umbrella line; code change under extensions/ so it needs a new tag, pin bump and pi restart; ready to open as an issue with a test asserting both entry points print identical status for every branch.
- Owner decision: add a docs-only 'entry point relationship' note to docs/configuration.md (the umbrella is the canonical toggle place; /context is a cheap path lookup; feature-level on|off kept for muscle memory) - no tag needed; offered, awaiting go-ahead.
- Owner decision: whether to open an issue (not implement) for converging the user surface - folding the feature-level on|off verbs and /context into the umbrella - since that is a destructive surface change needing a design doc plus usage evidence that does not exist today.
- Owner decision: a boundary instruction in the consolidation prompt (memory/prompt.ts) so a render cannot re-introduce external state - a code change under extensions/, needing a new tag, pin bump and restart.
- Restart the two pi processes older than the v0.2.1 install so the refusal fix actually loads; `pi update --extensions` only replaces on-disk code.
- Owner review of the accumulated audit findings (stop knob growth, legacy compat retirement window, handoff/memory shutdown coupling, D2 dead export, D4 per-session migration cost, lock hygiene, the corrected D7 attribution).
- Sibling repos (their call, handed back): UF's quantified block dropped by the new render needs merging back again; a consumer render must be tested against HEAD before it is committed or merged; both repos still hold an uncommitted pi-rendered MEMORY.md plus unpushed local commits, and UF's memory file sits over its own maxMemoryChars so its cap path can clip the tail.
- CipherCat's remaining stale .lock sweep: handed to that repo.
- Parked: option M (retarget the over-cap condensation retry at record_memory) and option N (rejected), plus whether D1 becomes wontfix.
- Note: the ~/.pi repo still carries another session's dirty files (agent/custom-providers/scnet/models.json plus a .bak) that the v0.2.1 pin commit deliberately did not touch.

<!-- latest-session-title: Full-tree sweep closed; command-surface consolidation triaged (one real dedup, no usage telemetry) -->
