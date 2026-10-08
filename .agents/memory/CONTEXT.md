# Project Context

Last updated: 2026-10-08T08:45:00.000Z

## Summary

The shutdown-coupling issue (2026-10-06-handoff-shutdown-coupling) is closed out: v0.4.6 is tagged, pushed to both remotes and pinned, the memory render was curated, and the two registered nits were fixed and re-reviewed. The review chain has no PASS after round 6 - rounds 7-13 all returned CHANGES-REQUESTED with no code-layer finding, and the chain was stopped by the repo's stop rule with the reason and unclosed items written into the review report's close-out note.

## Key points

- Shipped content of v0.4.6: session_shutdown no longer consolidates - the exit is a model-free flush that only adopts a hand-edited MEMORY.md into the journal and conditionally republishes the fold; errors.log key is shutdown:flush.
- Tag v0.4.6 = tag object dbf381f, peeled dbddb52; both push URLs (forgejo and the github mirror) report refs/tags/v0.4.6 = dbf381f; CHANGELOG's dated v0.4.6 section was written before the tag.
- Pin bump: ~/.pi commit d82656e updates both agent/settings.json and README.md to pi-project-context@v0.4.6 (backup /tmp/settings.json.before-v0.4.6-1791385774); pushed to the pi-config remote.
- pi update --extensions moved the installed clone to dbddb52 = describe v0.4.6, clean working tree; installed-tree markers verified (store.ts:122 append-time recheck comment, SIGKILL watchdog in tests/consolidation-test.mjs, STOP_CHARS x3 in tests/run-all.mjs) and the installed handoff-test.mjs passes.
- Real-settings probe in /tmp/probe-v046-1791448188 (default settings, no -ne/-np): the extension loads and writes .agents/memory/ archive artifacts and CONTEXT.md, leaves no errors.log, and - correctly - no MEMORY.md and no journal, because automatic consolidation needs >=6 turns AND >=5 min while pi -p is one-shot and the model-free exit flush is a no-op in a project with no memory files.
- Release evidence committed as 6488e4c (.codestable/issues/2026-10-06-handoff-shutdown-coupling/release-v0.4.6-evidence.md: tag object, peeled commit, both remotes, pin commit, installed clone HEAD/describe, installed-tree markers, probe outcome and what the probe did not cover) and pushed; master == both remotes.
- Nits fixed: the FIFO fixture's failure path is bounded again by restoring the blocking "w" open (it is the scheduling barrier) plus a 30 s SIGKILL watchdog, and the readRenderWithMtime comment now scopes journal-side guard (append-time recheck) versus publish-side (changed).
- Post-fix mutation checks: removing the pre-append recheck reddens seven checks (race fixture four, borrowed-key three), the race case asserts the race happened and that the exit reports adopted=true/written=false, and the borrowed-key case has a positive control; suite green 3x in a row.
- Review chain state: rounds 1-6 chased one TOCTOU class to a PASS on c212fcf; round 7 blocked on the fixture's scheduling barrier, round 8 on the curation, rounds 9-13 on record details; rounds 7-13 produced no code-layer finding (code unchanged since 7285eb2) and the chain was stopped by the stop rule on 2026-10-08.
- Memory curation: MEMORY.md measures 30209 characters by memoryDocumentChars (30210 raw), i.e. 1791 under the cap; this pass retired the skill-homed process rules (the sandbox/probe pitfall set moved into pi-project-context-headless-runs §Gotchas, which keeps them and the routing entry in the render points at the skill), retired the render's duplicate tests/run-all.mjs entry and two entries already carried by release-tag-and-pin-sync and curated-surface-hygiene §12, and re-added the two durable rules this render had dropped: the process-rule routing and readRenderWithMtime's accepted mtime+size residual. The journal's last op equals the committed bytes.
- What the curation restored: the nine durable rules the model render had dropped, including the RENAMED_KEYS re-scan method and the regression-guard-is-only-a-detector rule (neither has another home), plus a truncated phrase; the missing removed-line classification rule went into curated-surface-hygiene §12.
- The two remaining review nits (S3-style comment scoping and FIFO failure-path hygiene) are fixed; the residuals kept are non-write-path: R-L1 (loadMemory's pure-read sites), the mtime+size heuristic in readRenderWithMtime, the SIGKILL path skipping temp-dir cleanup, and CHANGELOG.md:33 at 191 characters (the 160-character rule covers docs/*.md only).

## Open tasks

- Owner: restart pi so the running host loads the installed v0.4.6 - the clone is updated but modules are not hot-swapped, so mixed-version noise in errors.log persists until then.
- Owner: the retirement pass ran (2026-10-08): the render sits 1791 characters under the cap after moving the sandbox/probe pitfall set into pi-project-context-headless-runs §Gotchas; a future render that drifts back under ~2000 characters of headroom should retire the next skill-homed cluster rather than compress wording.
- Owner: open the settle-path finding as its own issue - a settle pass can replace the whole curated render with a conversational reply (field-observed in a sandbox under the installed v0.4.5).
- Owner: decide whether to open a fresh review round on the final frozen revision (no PASS since round 6) or accept the stop-rule closure whose reason and unclosed items are recorded in the review report.
- Follow-ups recorded in the review report, not blocking: converge loadMemory's read site (residual R-L1), note the mtime+size heuristic at readRenderWithMtime, and treat the SIGKILL failure path's leftover temp directories as a hygiene item.
- Owner: decide whether to implement the autolearn B1' layering on the shape evidence alone or wait for a cost fact; the reopen condition is already recorded.
- Sibling consumer repos (their call): test a pi-rendered MEMORY.md against HEAD before committing or merging it, merge back UniField's dropped curated block, decide on their unpushed local commits.
- Next session: record the prefix-cache measurement in the prefix-cache skill (a same-session hand edit did not collapse cacheRead).

<!-- latest-session-title: v0.4.6 released and pinned, memory curated at the cap, the two nits fixed; the review chain closed by the stop rule without a final PASS -->
