# Project Context

Last updated: 2026-10-05T00:38:00.455Z

## Summary

This session wrote and shipped the design document that answers the earlier autolearn learned-body budget question. The owner chose to design options (a) on-demand body fetch and (b) skill layering together, in one design doc rather than implementing straight away, so the session first hardened the v0.3.1 supersede assertions and then produced .codestable/issues/2026-10-05-autolearn-progressive-disclosure/autolearn-progressive-disclosure-design.md (280 lines, status draft, revision 1), committed as 1367027 and pushed to both push URLs (verified: both report master=1367027962bf). The document fixes the field facts with a rerunnable probe (17 marked skills, 96,975 body characters, 20,000-character total budget, four injected bodies, prompt 32,057 -> 13,149 without bodies), specifies part A (inspectSkill naming plus a code-level shown-names guard on gate, write path and candidate path), part B (self-contained SKILL.md entry plus references/*.md, B1 merges the entry only), the change surface over nine files, ten assertions each with a one-sided mutation, acceptance criteria, non-goals and a two-slice release plan. Nothing of the design is implemented: the only committed change is the design doc, and implementation waits on the owner answering seven forks.

## Key points

- Design doc path: .codestable/issues/2026-10-05-autolearn-progressive-disclosure/autolearn-progressive-disclosure-design.md, status draft, revision 1, committed 1367027 and pushed to both push URLs.
- Design A reuses the existing inspect backtrack: first round carries inventory only, the model names a learned skill with inspectSkill, the second round injects only that body; measured first round 32,057 -> 13,149 characters and coverage 4/17 -> 17/17.
- The shown-names set becomes a code-level fact: rejectionReason, the write path and the candidate path all require the name to have been rendered in this run; approve is recommended to stay unrestricted but must say it blind-writes.
- Design B fixes the layered shape pi already supports: self-contained SKILL.md entry with an index table plus references/*.md read on demand, references written before the entry, recommended caps entry 2,500 / reference 20,000 / five references / two inspectSkill names.
- B1 merges the entry only and never deletes or rewrites references; reference-level merging is deliberately deferred, and existing 17 skills are not force-split but migrate when next named.
- Seven owner forks are open in the doc's section 0: inspectSkill count, G1 guard vs log-only, candidate/approve scope, B1 vs B2, the cap values, existing-skill migration, and release split (recommended A1 -> v0.3.2, B1 -> v0.4.0, both needing a pi restart).
- Mutation results recorded this session: gate relaxation to scope-only reddened nothing until a candidate-path assertion was added (the write-path check masks it); the approve-side mutation reddens its two assertions; dropping learnedBodiesText reddens one; dropping the shared provenance marker reddens eight.
- Test hardening this session: tests/autolearn-test.mjs gained two candidate-path gate assertions (no candidate file for a hand-written name, and its notification names the collision) and a padded merge fixture to clear MIN_SKILL_BODY_CHARS 160; tests/autolearn-test.mjs reported ALL OK and run-all.mjs stayed 15/15 green.
- The doc's appendix probe was executed as written and reproduced 32,057 / 13,149 / 18,859; the doc has no line over 160 characters.
- The design-doc commit staged only .codestable/, so any uncommitted autolearn-test.mjs edit from this session still sits in the working tree.

## Open tasks

- Owner answers the seven forks in the design doc's section 0 (or says follow the recommendations); then implement slice A1 (schema, prompt, shown-names set, three guards, assertions) and later slice B1.
- Verify whether the new candidate-path assertions in tests/autolearn-test.mjs are committed; commit them separately if the working tree still holds them.
- Restart pi (both v0.3.0 and v0.3.1 need it; pi update --extensions does not hot-swap loaded modules) - owner.
- Decide approve or reject for the pending candidate .agents/memory/skill-candidates/pi-project-context-legacy-config-one-time-migration.md (untracked pipeline state) - owner.
- Optional owner-named marker backfill for the two known pre-v0.3.1 promoted skills (auxiliary-alert-storm-triage, consolidation-prompt-rule); only when the owner names a skill.
- Render-based acceptance of the consolidation and autolearn cross-project boundary: require zero sibling-repo measurements in later renders - owner plus this extension.
- Owner review of remaining audit findings: handoff/memory shutdown coupling, memory/journal.ts dead export newestMemoryArchiveSync, per-session migration cost, lock hygiene, corrected addendum-2 D7.
- Sibling consumer repos (their call): test a pi-rendered MEMORY.md against HEAD before committing or merging it, merge back UniField's dropped curated block, decide on their unpushed local commits.
- Watch for field habit regressions from the hard cuts (/handoff's bare ratio and bare send|draft, the retired /context) - this extension.
- Watch the first real autolearn supersede and, after A1 lands, the first real named-body merge, for the marker plus a correct notification - this extension.

<!-- latest-session-title: Progressive disclosure design: on-demand learned bodies plus layered skills -->
