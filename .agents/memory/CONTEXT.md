# Project Context

Last updated: 2026-10-04T11:15:53.320Z

## Summary

This session ran a full-tree sweep (375 tracked files, six dimensions: dead pointers, machine-bound paths, stale claims, external-repo state, listing/defensive density, command consistency) after the owner challenged the previous pass for reaching outside the project. The curated surfaces held 5 dead pre-split module references in four skills (handoff.ts, project-state.ts) - fixed, and every extensions/... reference under .agents/skills resolves now (12/12); the 89 dead references across 54 files under .codestable/ are frozen records and were deliberately left. The sweep also caught a third re-leak of sibling measurements into CONTEXT.md, which had been re-bundled into a skills commit by my own `git add -A`, and an anomalously tracked autolearn candidate. Fixes landed as ad78038 (skills module paths) and 6d49e2c (memory render + boundary re-applied), both pushed to forgejo and the github mirror, working tree clean, tests 15/15, extensions/ still byte-identical to v0.2.1 so no new tag.

## Key points

- Curated-surface dead pointers: 5, all in four skills naming pre-split extensions/project-context/handoff.ts and project-state.ts; corrected to handoff/run.ts and shared/project-state.ts, rechecked 12/12 valid.
- .codestable/ dead pointers: 89 across 54 files, expected frozen history - rewriting them would falsify the evidence they preserve, so they stay.
- Machine-bound paths judged: HANDOFF.md's absolute repo paths are pi-generated session state, tests/handoff-test.mjs's /home/user/.pi/... strings are fixture strings, tests/harness.mjs's legacy pi path is an intentional fallback - none is a defect.
- Stale-claim check: test-count claims match reality (15 tests / 15/15), the old pi bundle path survives only inside .codestable history where it was accurate at the time.
- External-state check: the curated surfaces hold only the allowed form (naming a repo plus who owns the open item); the 193 sibling mentions live in .codestable as evidence.
- Third re-leak: the 10:54:28 render rewrote CONTEXT.md with the sibling commit distances and the two renders' character counts that had just been removed - hand cleanup is only good until the next pass.
- Process slip disclosed: commit 015b025 staged with `git add -A` and swept that render churn (plus a MEMORY.md path fix) into a docs(skills) commit, violating the render-gets-its-own-commit invariant; 6d49e2c re-applies the boundary and the discipline is now explicit pathspecs only.
- Anomaly found: .agents/memory/skill-candidates/pi-project-context-consumer-alert-triage.md is tracked although candidates are otherwise untracked, and it is already superseded by the promoted auxiliary-alert-storm-triage skill; its hard-coded sibling repo names were removed this pass.
- Commits ad78038 and 6d49e2c are identical on forgejo and the github mirror; HEAD 6d49e2c, 0 dirty, tests 15/15.
- extensions/ is byte-identical to v0.2.1 across these commits, so no release tag is warranted; a prompt-level boundary line would change that.

## Open tasks

- Owner decision: add a boundary instruction to the consolidation prompt (memory/prompt.ts) so a render cannot re-introduce external state - a code change under extensions/, which would require a new tag, a pin bump and a session restart; ready to open as an issue with a test.
- Owner decision: the tracked autolearn candidate pi-project-context-consumer-alert-triage.md - keep it tracked, untrack it, or delete it now that its skill is promoted.
- Restart the two pi processes older than the v0.2.1 install so the refusal fix actually loads; `pi update --extensions` only replaces on-disk code.
- Owner review of the accumulated audit findings (stop knob growth, legacy compat retirement window, handoff/memory shutdown coupling, D2 dead export, D4 per-session migration cost, lock hygiene, the corrected D7 attribution).
- Sibling repos (their call, handed back): UF's quantified block dropped by the new render needs merging back again; a consumer render must be tested against HEAD before it is committed or merged; both repos still hold an uncommitted pi-rendered MEMORY.md plus unpushed local commits, and UF's memory file sits over its own maxMemoryChars so its cap path can clip the tail.
- CipherCat's remaining stale .lock sweep: handed to that repo.
- Parked: option M (retarget the over-cap condensation retry at record_memory) and option N (rejected), plus whether D1 becomes wontfix.
- Note: the ~/.pi repo still carries another session's dirty files (agent/custom-providers/scnet/models.json plus a .bak) that the v0.2.1 pin commit deliberately did not touch.

<!-- latest-session-title: Full-tree sweep: dead pointers fixed, render re-leak caught a third time, boundary re-applied -->
