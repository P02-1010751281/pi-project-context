# Project Context

Last updated: 2026-10-08T00:20:00.000Z

## Summary

As of round 6 the shutdown-coupling TOCTOU chain PASSed on c212fcf; rounds 7-12 then returned CHANGES-REQUESTED and every item was fixed (round 7 the FIFO fixture's scheduling barrier, round 8 the curation, rounds 9-12 the records), and the final revision still awaits its PASS.

## Key points

- Review chain: rounds 1-6 chased one TOCTOU class to a PASS on c212fcf; round 7 blocked on the FIFO fixture's scheduling barrier being replaced with a non-blocking open, round 8 on the curation, rounds 9-13 on record details; all on deepseek/deepseek-flash with thinking high, each in a byte-identical /tmp sandbox with zero-write proof.
- Code fix b37cb55: adoptExternalEdit judges against its own read and re-verifies immediately before appendMemoryOp that the file still holds those bytes; mismatch refuses the append and logs. The overlapping read.changed early exit was proven non-load-bearing and deleted.
- Removing the guard reddens seven checks across the two paths (the FIFO race case now carries four assertions, including its own check that the race happened); the race case ran green three times in a row and the borrowed-key case has a positive control.
- Two side-findings fixed on the way: extracting flushActionFor exposed a real regression (a missing render had stopped being republished) and the render had twice reverted the corrected shutdown facts in MEMORY.md:23/:97 and CONTEXT.md - restored, then written into the local journal in the extension's own op shape so later renders stop reverting them.
- Doc-only follow-ups after the PASS: architecture.md's borrowed-key wording (N2), the third republish condition (empty render) in three places (N3), the CONTEXT.md round count (N4), and the fix note's trigger sentence.
- Residuals registered, none on the write path: R-L1 (loadMemory's pure-read sites pair bytes with a separate stat, contained by the write path's nowKey recheck), the FIFO test's failure-path hang, the mtime+size heuristic in readRenderWithMtime, and the settle-path issue (settle can publish a whole conversational reply as memory, another issue).
- Head approved the disposition earlier this session ('可以继续' = proceed) and the recommendation now is to stop here; the two remaining nits (N1 test robustness, S3 comment) would change the reviewed revision and were left as recorded follow-ups.
- The 2026-10-07 curation restored the durable rules the model render had dropped and merged duplicates: MEMORY.md measures 31797 characters by the cap's own gauge (memoryDocumentChars; 31798 raw characters), i.e. 203 under the 32,000 cap, so the render sits at the cap and the next curation must propose retirements rather than formatting; the curated text is the journal's last replace op, byte-identical to the committed file.

## Open tasks

- Owner: cut the v0.4.6 tag, bump the host pin and restart, so live sessions stop loading the previous tag's modules; the code is merged and reviewed but unpinned, and the merged-but-untagged state keeps mixed-version noise in errors.log.
- Follow-ups recorded in the review report, not blocking: converge loadMemory's read site per S1 (residual R-L1), make the FIFO test's failure path bounded (N1), and note the mtime+size heuristic at readRenderWithMtime (S3).
- Open at the owner's call: the settle-path finding - the settle pass can replace the whole curated render with a conversational reply (field-observed in a sandbox under the installed v0.4.5) - which the report recommends as its own issue.
- Next session: record the cache measurement in the prefix-cache skill (a same-session hand edit did not collapse cacheRead), the remaining doc fix from an earlier settlement.
- Owner: decide whether to implement the autolearn B1' layering on the shape evidence alone or wait for a cost fact, and whether the fork 4/5/6 answers go into the design doc; the reopen condition is recorded either way.
- Sibling consumer repos (their call): test a pi-rendered MEMORY.md against HEAD before committing or merging it, merge back UniField's dropped curated block, decide on their unpushed local commits.

<!-- latest-session-title: As of round 6 the shutdown-coupling TOCTOU chain PASSed on c212fcf; rounds 7-12 then returned CHANGES-REQUESTED and every item was fixed (round 7 the FIFO fixture's scheduling barrier, round 8 the curation, rounds 9-12 the records), and the final revision still awaits its PASS -->
