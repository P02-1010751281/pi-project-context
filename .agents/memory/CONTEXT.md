# Project Context

Last updated: 2026-10-07T13:10:48.382Z

## Summary

Closed the shutdown-coupling review chain: five CHANGES-REQUESTED rounds chased one TOCTOU class (the bytes a decision used and the mtime it trusted came from different reads) until round 6 returned PASSED on c212fcf, then fixed only documentation and recorded the leftovers. Round 3 (re-run after an empty transcript) found my own round-2 fix still had the hole and no coverage; round 4 escalated it to a blocking finding on the adopt path with a FIFO race probe that made a newer hand edit vanish from both journal and disk; round 5 escalated it again to the borrowed-key path recordMemoryDocument uses (its key is read before the model call, so it can be stale by append time) and also caught the promise I had just written into architecture.md. The fix collapsed to one load-bearing guard - adoptExternalEdit verifies immediately before the append that the file still holds those bytes, refusing and logging on mismatch - plus two deterministic regressions (FIFO race incl. adopted=true; stable file with a stale borrowed key refused, current key accepted) that redden six checks when the guard goes. Docs, records and memory are committed and pushed to both push URLs; a doc-only round-6 record adds the PASS, the nit dispositions and residual R-L1.

## Key points

- Review chain closed: rounds 1-2 CHANGES, round 3 re-run CHANGES, round 4 CHANGES (blocking, adopt path), round 5 CHANGES (blocking, borrowed-key path), round 6 PASSED on c212fcf - all on deepseek/deepseek-flash with thinking high, each in a byte-identical /tmp sandbox with zero-write proof.
- Code fix b37cb55: adoptExternalEdit judges against its own read and re-verifies immediately before appendMemoryOp that the file still holds those bytes; mismatch refuses the append and logs. The overlapping read.changed early exit was proven non-load-bearing and deleted.
- Removing the guard reddens six checks across the self-read and borrowed-key paths; the FIFO race case ran three times green with its three assertions and the borrowed-key case has a positive control.
- Two side-findings fixed on the way: extracting flushActionFor exposed a real regression (a missing render had stopped being republished) and the render had twice reverted the corrected shutdown facts in MEMORY.md:23/:97 and CONTEXT.md - restored, then written into the local journal in the extension's own op shape so later renders stop reverting them.
- Doc-only follow-ups after the PASS: architecture.md's borrowed-key wording (N2), the third republish condition (empty render) in three places (N3), the CONTEXT.md round count (N4), and the fix note's trigger sentence.
- Residuals registered, none on the write path: R-L1 (loadMemory's pure-read sites pair bytes with a separate stat, contained by the write path's nowKey recheck), the FIFO test's failure-path hang, the mtime+size heuristic in readRenderWithMtime, and the settle-path issue (settle can publish a whole conversational reply as memory, another issue).
- Head approved the disposition earlier this session ('可以继续' = proceed) and the recommendation now is to stop here; the two remaining nits (N1 test robustness, S3 comment) would change the reviewed revision and were left as recorded follow-ups.
- The 2026-10-07 curation restored the durable rules the model render had dropped, merged duplicates and brought MEMORY.md to 31728 characters against the 32,000 cap (headroom 272), so the ~2,000 hand-curation trigger is still met and the next curation must propose retirements rather than only formatting; the curated text went into the local journal in the extension's own op shape.

## Open tasks

- Owner: decide whether to cut a tag for the merged shutdown-flush work (v0.4.6 semantics: no merge at exit, model-free exit) and bump the host pin, then restart, so live sessions stop running the previous tag's modules - I offered to follow pi-project-context-release-tag-and-pin-sync.
- Owner: cut the v0.4.6 tag and bump the host pin so live sessions stop loading the previous tag's modules; the code is merged, reviewed and pinned to no release yet.
- Follow-ups recorded in the review report, not blocking: converge loadMemory's read site per S1 (residual R-L1), make the FIFO test's failure path bounded (N1), and note the mtime+size heuristic at readRenderWithMtime (S3).
- Open at the owner's call: the settle-path finding - the settle pass can replace the whole curated render with a conversational reply (field-observed in a sandbox under the installed v0.4.5) - which the report recommends as its own issue.
- Next session: record the cache measurement in the prefix-cache skill (a same-session hand edit did not collapse cacheRead), the remaining doc fix from an earlier settlement.
- Owner: decide whether to implement the autolearn B1' layering on the shape evidence alone or wait for a cost fact, and whether the fork 4/5/6 answers go into the design doc; the reopen condition is recorded either way.
- Sibling consumer repos (their call): test a pi-rendered MEMORY.md against HEAD before committing or merging it, merge back UniField's dropped curated block, decide on their unpushed local commits.

<!-- latest-session-title: Shutdown-flush review converged: round 6 PASSED at c212fcf, code collapsed to one verified-before-append guard, removal reddens eight checks -->
