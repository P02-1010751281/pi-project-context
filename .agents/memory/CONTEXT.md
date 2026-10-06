# Project Context

Last updated: 2026-10-06T13:03:07.375Z

## Summary

Closed the memory-cap item, then adjudicated the clip-shape question with a probe, ran a live RPC field round, answered the autolearn forks and the turn-prefix question, dispositioned three audit residuals, and published the records. Curation first: .agents/memory/MEMORY.md was compressed 31,935 -> 30,290 characters (135 -> 130 entries, ~1,710 headroom, 3 deliberate token drops carried by CHANGELOG/evidence) with a 39-token survival check, committed as 8ffe467 and then pulled back to pointer duty for eight index entries. Then the two questions: a loadNamespace probe showed the read-side fold middle-cuts the document (a section header can vanish, sending the pass down the opaque path where the per-section accounting does not exist) while the write-side render drops whole entries, so the extension's own clipped render differs from the fold and, being newer, is adopted as an external edit - which is why a diagnostic alone is not enough and unifying the clippers is the recommended fix. A pi --mode rpc run against the extension's own command handlers gave the fixed-mode floor refusal a live line for the first time, showed the three skips, and produced a real handoff whose successor's first payload is the predecessor's last question verbatim, with cacheRead 2048 -> 640 across the handoff but no collapse from a same-session hand edit of the memory block. Three residuals were dispositioned: the legacy-config layer is kept because two of ten live configs still carry all six old keys, the shutdown coupling became its own issue dir, and both leftover lock families were attributed to the Codex port. The 109-entry render was kept as the memory state and the records landed as 7ca97c1 and cd48014, both pushed to both URLs; HEAD=cd48014, tree clean, sandboxes removed.

## Key points

- Curation commit 8ffe467: render 31,935 -> 30,290 chars, 135 -> 130 entries, headroom ~1,710; 39 symbol/constant/version tokens re-checked, 3 deliberate losses (v0.4.5 tag ids, v0.2.3 stamp) carried by CHANGELOG / release evidence.
- Clip probe (clip-shape-probe-2026-10-06.md): a 55,050-char journal folds to 31,796 chars and loses the `## Pitfalls` header, so sectionsFromMarkdown returns undefined and the pass takes the opaque path with no droppedItems/droppedSamples; the render is a different clipper, so the file differs from the fold and, being newer, is adopted back - the self-adoption loop.
- Recommendation for the owner: unify the clippers (section-aware fold that keeps four sections over the cap), then extend the diagnostic to the opaque path and to per-clip accounting; the keep-unclipped-state option is the only root fix but is design-level.
- Live RPC run (audits/2026-10-06-handoff-and-cache-field-run.md): fixed-mode floor refusal now has real text; `/handoff threshold 0.02` is caught by the usage line; busy and nothing-older skips both named; a real handoff dropped ~2.1k while keep was 60 and carried ~234, HANDOFF.md held only the mechanical header, and the successor's first payload was the predecessor's last question verbatim (no turn-prefix marker because the cut landed at a turn start).
- Cache measurements: within-session reuse is real (640 -> 1792/1920/2048 -> 2432); a handoff costs 2048 -> 640 but the cause is the successor's divergent message list; a same-session hand edit of the memory block of the same size caused no collapse, so the prefix-cache skill's recommendations 1 and 3 do not pay on this route and recommendation 2 is already true.
- Autolearn forks answered as recommendations: merge rewrites the entry only and references change only by being named (fork 4); entry <=6000, one level of references only, per-reference <=20000, <=5 references, inspectSkill <=2 (fork 5); no bulk split of the 17 existing skills, trigger-based instead (fork 6); all still parked until B1' is built.
- Turn-prefix second summary: the A-anchor already delivers the goal, the summary chain was removed by owner decision (zero model calls on the handoff path), so section 7's premise is void and the item needs that decision overturned first; the A path is pinned by tests/handoff-test.mjs:889.
- Residual dispositions: legacy-config layer kept with no retirement window (2 of 10 live configs carry all six old keys - `形式化证明`, `HWCup-Math-A`); shutdown coupling now in .codestable/issues/2026-10-06-handoff-shutdown-coupling/brief.md; both lock families attributed to the Codex port's contextctl.py.
- Memory state: the 109-entry render (cc6701f) wins and is the journal's adopted state; 29,957 chars with ~2,043 headroom, but the fold can drop that render's index entries, which is now recorded behaviour.

## Open tasks

- Owner: decide whether to build the unified clipper (recommended) and whether to ship the extended diagnostic in the same round; nothing was changed in code this pass.
- Owner plus host: run one real TUI handoff to see the A+B snap/anchor visibly, and exercise `/handoff threshold <ratio>` in fixed mode from the keyboard rather than RPC.
- Owner: answer the remaining autolearn forks in .codestable/issues/2026-10-05-autolearn-progressive-disclosure/ section 0 (the recommendations are recorded, but they stay parked until autolearn B1' is implemented).
- Owner: decide whether to overturn the zero-model-call handoff rule to build the pi-style turn-prefix summary, or retire section 7 of handoff-last-turn-design.md as history.
- Owner: choose among the three disposition options in .codestable/issues/2026-10-06-handoff-shutdown-coupling/brief.md.
- Owner: confirm that the prefix-cache skill's recommendations are settled by the field measurements (adopt nothing new) and whether to measure cacheRead on a relay route to test cache_control passthrough.
- Watch the curated headroom (~2,043 chars) and the new fold behaviour: a pass that adds more than the headroom can still lose entries, and the fold may now drop index entries from the injected projection.
- Sibling consumer repos (their call): test a pi-rendered MEMORY.md against HEAD before committing or merging it, merge back UniField's dropped curated block, decide on their unpushed local commits.

<!-- latest-session-title: Curated the memory, probed the two clippers, ran a live RPC field round and closed three residuals -->
