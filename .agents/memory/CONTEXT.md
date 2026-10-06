# Project Context

Last updated: 2026-10-06T14:16:13.502Z

## Summary

Adjudicated the open decision items against measurements rather than asking again: enumerated the live undecided items out of .codestable, attached a field fact to each and computed what the evidence implies. Measurements this pass: errors.log spans 191 lines (2026-09-16 -> 2026-10-06) and the teardownCurrent -> newSession stack appears once (2026-09-22) with no recurrence after the guard; of 18 project skills 6 are >= 8000 chars (largest 13584) while the local inventory is under its 8000 injection cap, so the layering has a shape trigger but no measured cost fact; handoffThinking is fully retired with tests pinning non-resurrection, so it is not open; the regression guard's logged counts (3/12/8/24) over-report against net changes of -1..-8; the v0.4.5 evidence file still carries three stale `待 owner` lines although the cap decision (hand-curate, do not raise maxMemoryChars) was executed in 8ffe467. Also confirmed the clip question from earlier: the fold and the hand-written file matched byte-for-byte in 8/8 repos measured, so no clipper work is warranted. Produced a decision table plus a suggested execution order (one skill-doc edit, one record fix, the shutdown disposition, the pin bump) and asked the owner only for the shutdown choice.

## Key points

- Shutdown coupling: one occurrence (2026-09-22), none since the guard, and the guard wraps the whole session_shutdown handler, so the evidence supports option 3 (accept and record) with an explicit reopen condition (a new errors.log line carrying that stack).
- Layering (autolearn B1'): the shape trigger is real - 6 of 18 project skills are >= 8000 chars, largest 13584 - but the local inventory (about 3810 chars) is well under the 8000 injection cap and no session has been hurt by pulling a large body, so by the repo rule the missing fact is a cost fact, not a shape fact.
- Regression guard: keep it a detector, do not add a refuse-to-publish path - the logged missing-entry counts over-report what the pass actually loses because rewrites and merges count as deletions.
- handoffThinking is already fully retired (v0.4.2) with tests pinning that a retired name is not resurrected, so the design-doc line that reads like an open item is stale, not live.
- The v0.4.5 evidence file's three `待 owner` lines are stale records: the owner decided hand-curation instead of raising maxMemoryChars and 8ffe467 executed it.
- Cache finding stands: a same-session hand edit of MEMORY.md did not collapse cacheRead (2048 -> 2432), so the handoff's drop comes from the successor's divergent message list, and the prefix-cache skill's suggested actions should be closed by recording that measurement.
- Headroom is a watch item with a numeric trigger, not a decision: curate again when the render's headroom falls below roughly 2,000 characters.
- Mixed-version adoptions (10:48 and 11:06) trace to sessions still running the previous tag's modules, so the pin bump plus restart removes that noise source.

## Open tasks

- Owner: approve the shutdown-coupling disposition (option 3, accept and record, with the reopen condition) or pick another; only this item still needs a decision from the table.
- Owner: decide whether to implement the autolearn layering (B1') on the shape evidence alone or wait for a measured cost fact, and whether the fork 4/5/6 answers should be written into the design doc.
- Then execute the four cheap items if approved: record the cache measurement in the prefix-cache skill, mark the v0.4.5 evidence file's stale `待 owner` lines as decided, write the shutdown disposition into the issue brief, and bump the host pin to v0.4.5 with a restart.
- Owner: decide whether to overturn the zero-model-call handoff rule to build a turn-prefix summary, or retire section 7 of handoff-last-turn-design.md as history.
- Watch the curated headroom (about 1,777 chars) against the under-2,000 curate-again trigger, and note the fold can still drop index entries from the injected projection.
- Sibling consumer repos (their call): test a pi-rendered MEMORY.md against HEAD before committing or merging it, merge back UniField's dropped curated block, decide on their unpushed local commits.

<!-- latest-session-title: Turned the open decision list into evidence-backed decisions and narrowed it to one owner question -->
