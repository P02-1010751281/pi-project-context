# Project Context

Last updated: 2026-10-07T07:59:34.134Z

## Summary

Closed the open decision list by measurement instead of asking again, then executed the four cheap follow-ups the owner approved and answered the one remaining question from code facts. Landed: (778d38c) a second hand-curation of the curated render - nine tightenings that each keep the rule and drop one-off counts or a rotted line number, including the retraction of the disproven 'an older build adopts its own render' claim - taking 108 entries / 29,551 characters against the 32,000 cap, headroom 1,548 -> 2,449; (1760564) the four dispositions: the handoff design's section 7 is now history with section 8.4's end-to-end item closed on the field run plus this session's own handoff, the regression guard stays a detector with no refuse-to-publish path, the autolearn layering waits for a cost fact with the fork 4/5/6 answer recorded as the reopen plan, and the headroom rule now records its own execution; (94f3212) attention.md's current state line; (e953b09) the session-context settle render. All pushed to both push URLs. Then answered the owner's question about option 1 for the shutdown coupling: today the exit-time forced pass, not the throttled agent_settled pass, is what guarantees a session's tail reaches MEMORY.md, so making shutdown flush-only loses that guarantee and leaves up to six turns or five minutes of conversation in the session-logs archives only. The owner picked option 1 (the model-free exit flush); it is implemented and has been through five review rounds.

## Key points

- The shutdown-coupling issue now reads as disposed: accept and record, one occurrence (2026-09-22), none since the guard, reopen condition is a new errors.log line carrying that stack; the guard wraps the whole session_shutdown handler.
- Confirmed from report.ts that the four update points exist and that only the settle pass runs a model: agent_settled is throttled by consolidateTurns 6 AND consolidateIntervalMs 5min, the exit flush (v0.4.6) makes no call at all, and forceDedupeMs 15s dedupes repeated forced passes, so the automatic path can lag six turns or five minutes behind the conversation.
- Consequence for option 1 (flush-only shutdown): the exit-time contribution to MEMORY.md disappears; the tail stays in session-logs archives, which the model does not read back on its own; keeping 'clean on exit' without a teardown model call would require either accepting the gap or lowering the throttle (more aux calls).
- Investigated whether 'memory regression' is another source of loss: it is not - errors.log records it only as a count (3/12/8/24) from an exact-match comparison, which counts a rewrite or a merge as a deletion, against net changes of -1..-8; keep it as a detector.
- Headroom after curation is 2,449 characters (108 entries / 29,551 characters); the threshold rule is 余量 < ~2,000 -> curate again by hand, never raise maxMemoryChars, and it now records its own execution in the evidence file and attention.md.
- v0.4.5..HEAD touches no extensions/ or tests/ file, so the v0.4.5 tag covers all code and the release item is closed.
- The autolearn B1' layering has a shape fact (6 of 18 project skills >= 8,000 characters, largest 13,584) but no cost fact; the local inventory is 3,810 against the 8,000 injection cap, so nothing has been hurt by pulling a large body yet.
- The clip-shape probe closed the clipper question: the fold and the hand-written file matched byte-for-byte in 8 of 8 repos measured, so no clipper work is warranted; the same build writes identical bytes to the file and the journal op, with only an order difference.
- The falsified 'old build adopts its own render' mechanism was still written into attention.md's project fragment knowledge and into the v0.4.5 evidence file (from 6774b48); both are corrected now.

## Open tasks

- Owner: option 1 is decided and implemented (v0.4.6 semantics: no merge at exit), through four review rounds; what is left for the owner is only the middle route - lowering the settle throttle, which costs more auxiliary calls.
- Next session: the flush is landed and reviewed (rounds 1-4, all dispositions closed); the loop should stop once a round returns nits only. Watch two things: the local journal re-rendering older shutdown facts, and the entry path (adoptExternalEdit's consistent read) staying in step with the flush's.
- Next session: bump the host pin to v0.4.5 and restart, so live sessions stop running the previous tag's modules - the pin lag is the source of mixed-version adoption noise in the journal.
- Next session: record the cache measurement in the prefix-cache skill (a same-session hand edit did not collapse cacheRead), which is the remaining doc fix from the earlier settlement.
- Owner: decide whether to implement the autolearn B1' layering on the shape evidence alone or wait for a cost fact, and whether the fork 4/5/6 answers should be written into the design doc; the reopen condition is recorded either way.
- Watch the curated headroom (2,449 characters) against the under-2,000 curate-again trigger.
- Sibling consumer repos (their call): test a pi-rendered MEMORY.md against HEAD before committing or merging it, merge back UniField's dropped curated block, decide on their unpushed local commits.

<!-- latest-session-title: Closed four decisions by measurement, re-curated the render, and answered the shutdown-coupling question from code facts -->
