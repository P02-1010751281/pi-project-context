# Project Context

Last updated: 2026-10-04T10:49:28.228Z

## Summary

This session answered the owner's challenge that the complexity audit had reached outside the project. Reading consumer repos is necessary (the extension has no runtime of its own; its only field evidence lives in the repos that install it), but persisting their state in this repo was a boundary violation, so 11 lines of MEMORY.md and 11 lines of CONTEXT.md were rewritten or dropped (sibling commit distances, sibling memory file sizes, UF's research values, a MEMORY.md:78 line pointer), the external-incident citation came out of docs/architecture.md, and the rule went into memory. The same pass closed the four documentation review items: docs re-wrapped at sentence boundaries with no line over 160 characters and proven content-identical, a new CHANGELOG.md derived from tagged ranges and linked from docs/README.md, the semantics/incident/version split made explicit, and all 18 project skill descriptions cut from 4008 to 2443 characters. Shipped as 0efd022, 02a1a11 and 268a53f; repo clean at 268a53f on both push URLs, tests 15/15, extensions/ still byte-identical to v0.2.1 so no new tag is needed. Separately, both consumer repos' working-tree MEMORY.md turned out to be pi re-renders that dropped curated facts, so neither memory layer was committed this pass.

## Key points

- The audit-scope answer: reading consumer repos is read-only and necessary (field evidence exists only there), but copying their state into this repo's memory is the actual breach; the two are now separated in writing.
- Removed as external state: sibling commit distances, their memory file sizes, and another project's quantified research values, plus a line pointer into MEMORY.md itself; MEMORY.md now names an external project on one line only, the boundary declaration.
- docs/architecture.md kept the durable semantics (a render does not read MEMORY.md's bytes, so a manual merge-back is not durable) while the field incident moved back to the audit.
- docs re-wrap: five files wrapped at sentence boundaries, zero lines over 160 characters, verified content-identical by whitespace-normalized comparison so only layout changed.
- CHANGELOG.md created (v0.1.0 through v0.2.1 plus Unreleased), derived from tagged ranges and limited to feat/fix commits, with docs and audit commits excluded; docs/README.md now links it.
- Doc split made explicit: architecture holds semantics, .codestable audits hold field incidents, CHANGELOG holds version-visible behavior changes.
- Skill descriptions: 18 project skills total 2443 characters instead of 4008 (about 390 tokens saved per session), every one at most 170 characters, frontmatter validated 18/18 as legal YAML.
- Commits this pass: 0efd022 docs(skills), 02a1a11 docs (re-wrap plus CHANGELOG plus architecture), 268a53f docs(memory) boundary cleanup; HEAD 268a53f is identical on forgejo and the github mirror, working tree 0 dirty, tests 15/15.
- extensions/ is unchanged relative to v0.2.1 across these commits, so no release tag is warranted; only the ~/.pi pin's installed clone still lags (pre-fix code in live sessions until a restart).
- Consumer memory verdict: both renders dropped curated facts (one lost the block merged back the previous day, the other its own lossy-summary declaration); the counts are in the audit. Neither memory layer was committed, because committing a render would bake the loss in.
- Neither sibling memory layer was committed, because committing either render would bake the dropped curation into that repo's history; their .agents/skills additions and the memory question stay with those repos.
- Tooling note: a python3 rewrite script that asserts a length cap before writing aborted with every file untouched, so nothing was half-edited when the first cap was too tight.

## Open tasks

- Sibling repos (their call, handed back): UF's quantified block dropped by the new render needs merging back again, and both repos still hold an uncommitted pi-rendered MEMORY.md plus unpushed local commits.
- Owner decision: whether the render-plus-cap loss, now twice field-evidenced, justifies work on re-render retention or cap policy; the merge-on-external-edit guard stays deliberately unbuilt.
- Restart the two pi processes older than the v0.2.1 install so the refusal fix actually loads; `pi update --extensions` only replaces on-disk code.
- Owner review of the accumulated audit findings (stop knob growth, legacy compat retirement window, handoff/memory shutdown coupling, D2 dead export, D4 per-session migration cost, lock hygiene, the corrected D7 attribution).
- UF's memory file sits over that repo's own maxMemoryChars, so its cap path can clip the tail again; that repo's config or trim decides.
- CipherCat's remaining stale .lock sweep: handed to that repo.
- Parked: option M (retarget the over-cap condensation retry at record_memory) and option N (rejected), plus whether D1 becomes wontfix.
- Note: the ~/.pi repo still carries another session's dirty files (agent/custom-providers/scnet/models.json plus a .bak) that the v0.2.1 pin commit deliberately did not touch.

<!-- latest-session-title: Audit-scope boundary cleanup, docs re-wrap, CHANGELOG, skill-description trim -->
