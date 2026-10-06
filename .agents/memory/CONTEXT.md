# Project Context

Last updated: 2026-10-06T11:07:54.506Z

## Summary

Closed the last memory-cap open item and audited the handed-over open list. The owner chose curation over raising maxMemoryChars, so .agents/memory/MEMORY.md was deep-curated in commit 8ffe467: 31,935 -> 30,290 characters (135 -> 130 entries, ~1,710 headroom), by merging semantically overlapping lines and pulling the Index entries back to pointer duty, with a survival check over 39 symbol/constant/version/backtick tokens (3 deliberate removals: the v0.4.5 tag ids and the v0.2.3 version stamp, carried by CHANGELOG and the release evidence). attention.md was rewritten from an open question into the decision plus both loss mechanisms (model rewrite AND cap clip adopted back into state, silent in the implementation), committed twice as c1b1545/e037575 and pushed to both URLs. The residual audit found 5 closed items (the cap decision, the restart note, the progressive-disclosure JSONL watch, the autolearn inventory cap marker, the summary-chain record) and 5 still open, all owner-side or other-repo: real-TUI handoff boundary work, 3 remaining autolearn forks (4/5/6), the turn-prefix second handoff summary, the prefix-cache skill recommendations, the three audit findings, and the newly named silent-clip residual.

## Key points

- Curation commit 8ffe467: render 31,935 -> 30,290 chars, 135 -> 130 entries, headroom ~1,710; method = merge overlapping lines + strip mechanism prose from Index entries.
- Survival verification: 39 symbol/constant/version/backtick tokens re-checked, only 3 deliberate removals (v0.4.5 tag ids, v0.2.3 version stamp) - both carried by CHANGELOG / release-v0.4.5-evidence.md.
- attention.md now records the owner decision (curation, no cap raise) and names both loss mechanisms; two commits with the same message landed (e037575 = audit edit, c1b1545 = attention edit), both remotes at c1b1545.
- Second loss mechanism is field-evidenced: the 2026-10-06 10:48:14Z pass shows the journal recording a 138-entry unclipped reply then a 126-entry file, errors.log carrying `memory regression: 2` and `adopted an externally edited MEMORY.md`; the guard's count is verbatim-only and the cap line is throttled once per project per process, so the clip is silent.
- Still open (owner or other repo): real-TUI handoff boundary work + `/handoff threshold <ratio>` in fixed mode; autolearn forks 4/5/6 (parked while B1' is unbuilt - the earlier 'seven unanswered' phrasing is stale); the pi-style turn-prefix second handoff summary (design section 7); the prefix-cache skill recommendations; the three audit findings (shutdown coupling wants its own issue, legacy-config retirement window waits for a field fact beyond the 0-hit key, lock hygiene).
- Closed or already resolved: restart-for-v0.4.5 (installed clone describe=v0.4.5, clean; only limits the process that ran the install), the on-demand JSONL read watch (audit section 9.14), the autolearn inventory cap marker (7,970/8,000 with the marker emitted), the summary-chain deletion record (design rev 2 names b4c9405), dsh R-2 (owner's item in the dsh repo).
- New named residual needing an owner go-ahead: a cap clip can become permanent state through adoption with no diagnostic, because the cap log line is throttled; candidate fixes are a diagnostic immune to throttling or clipping only the injected projection while keeping the unclipped text.

## Open tasks

- Owner decision on the silent-clip residual: whether to always record a diagnostic when a cap clip occurs (immune to the once-per-project-per-process throttle) or to keep unclipped memory state and clip only the injected projection.
- Owner plus host: run one real TUI handoff to expose the A+B snap/anchor path and the cwd fallback boundaries, and exercise `/handoff threshold <ratio>` in fixed mode so the refusal is seen live.
- Owner: answer the three remaining autolearn forks in .codestable/issues/2026-10-05-autolearn-progressive-disclosure/ section 0 (4/5/6: references merge semantics, layering caps, whether the existing 17 skills get layered); they stay parked until autolearn B1' is implemented.
- Owner: give the go-ahead (or not) for the pi-style turn-prefix second handoff summary, designed-not-built in section 7 of handoff-last-turn-design.md.
- Owner: decide on the prefix-cache skill's recommendations (session-stable injected memory, no render at handoff time, showCacheMissNotices/cacheWarming) and whether to measure cacheRead against the system block on a real route.
- Owner review of the remaining audit findings: handoff/memory shutdown coupling (recorded as needing its own issue), the legacy-config retirement window (waiting for a field fact beyond the 0-hit [migration] key), and lock hygiene.
- Watch the curated memory's headroom (~1,710 chars) over the next few passes: if a pass adds more than that, the clip path can fire again and the clip is currently silent.
- Sibling consumer repos (their call): test a pi-rendered MEMORY.md against HEAD before committing or merging it, merge back UniField's dropped curated block, decide on their unpushed local commits.

<!-- latest-session-title: Closed the memory-cap decision by curation and triaged the open list -->
