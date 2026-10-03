# Project Memory

## Project
- pi-project-context is a pi coding-agent extension that maintains durable project memory (MEMORY.md, CONTEXT.md) plus session context; written in TypeScript under extensions/project-context/.
- Module layout: memory/store.ts (journal, atomic write, external-edit adoption), memory/report.ts (record_memory tool, refusal gating, side effects), memory/pass.ts (ConsolidateOutcome.basisKey), memory/sections.ts, memory/migrate.ts, handoff/run.ts, handoff/prompt.ts, handoff/summary.ts, handoff/settings.ts, shared/config.ts, shared/llm.ts.
- The extension has 58 .ts modules totaling 7,772 lines; the audit's second addendum read 44 of them for rationale/constants/exports and 14 line-by-line.
- Tests live in tests/ with run-all.mjs as the entry point, run via `node tests/run-all.mjs` (15 tests, all green as of commit 25df85f); tests/external-edit-test.mjs holds 69 assertions.
- Process artifacts live under .codestable/ (issues/, audits/, attention.md); each issue dir holds its design doc, design archive, fix note, review report and review prompts/transcripts.
- Runtime memory state lives in .agents/memory/ (MEMORY.md, CONTEXT.md, memory.jsonl, HANDOFF.md, project-context.json); project-local skills live in .agents/skills/ (17 tracked skills).
- Release model: a git tag consumed through a pinned entry in ~/.pi/agent/settings.json, installed into ~/.pi/agent/git/git.lentech.site/C02-1010751281/pi-project-context.
- There is a single git remote `origin` carrying two push URLs (forgejo ssh://forgejo@git.lentech.site/C02-1010751281/pi-project-context.git and github mirror ssh://git@ssh.github.com:443/P02-1010751281/pi-project-context.git), so one `git push origin master` reaches both.
- Current release state: v0.2.1 (tag object d69ae48, peeled commit ab0984c) is the latest tag and ships 1f0672c (D2 overflow copy before clipping), 00bf797 (basisKey refusal) and dd2adcc (refusal-gate fix batch); the ~/.pi pin is @v0.2.1 (pi-config commit 3bd224e), the installed clone is at ab0984c, and release evidence is commit 82ca162.
- v0.2.0 was the prior tag; only three extension-code commits exist between v0.2.0 and v0.2.1.
- Master head after this session is 25df85f (audit addendum 2 plus the field-evidence audit skill), present on both push URLs.
- The pi host bundle reads at /home/user/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/.
- Consumer repos exist elsewhere on the same machine (referred to as QM and UF, UniField) that use this extension; a CipherCat repo also carries memory state.

## Invariants
- External-edit adoption is fixed by carrying the prompt-time loadMemory().text as basisKey and refusing to publish a reply whose basisKey no longer matches current effective content.
- Both sides of the basisKey comparison go through memoryComparisonKey with empty guards; a file holding only the header is a real edit, only zero-byte/whitespace counts as cleared.
- On refusal nothing publish-side runs: no overflow copy, no cap/section-cap/poison errors.log lines, no shortened log line, no removal warning, no publish-success toast; all of it sits behind one gate.
- Callers that do not pass basisKey (migration, legacy tests) must stay byte-identical.
- The fix never re-runs the model call: a stale reply is discarded and the next scheduled pass consolidates from the surviving content.
- Stale detection uses memoryComparisonKey-form comparison, so mtime-regressed or same-mtime external edits stay invisible by design (accepted residual).
- When the pre-publish recheck fires, the newer bytes are appended to the journal before returning.
- Independent review runs one round per frozen revision, in a /tmp sandbox copy of the repo, with before/after zero-write proof against the live tree.
- A review finding that asks for a new mechanism must first cite a field fact from this repo; with no field fact it goes to the non-goals instead of into the design.
- Design docs get status: design-frozen once implemented, and the banner records the implementing commit next to the revision number.
- Only origin is pushed to (both push URLs); release tags are never moved, and release docs land in a separate commit from the tag.
- Release evidence for a behavior-changing version must state that `pi update --extensions` requires a restart.
- Uncommitted .agents/memory/* render churn is left dirty by convention and is not committed; a deliberate in-place correction to MEMORY.md stays uncommitted too.
- Test gates: `node tests/run-all.mjs` must stay green at 15/15, tests/external-edit-test.mjs currently holds 69 assertions, and the issue's repro-write-ordering.mjs must exit 0.
- Refusal-fix regression lines need negative controls, and mutation checks (remove a gate, revert a comparison) must turn exactly the intended assertions red.
- Audit judging rule: a mechanism must trace to a field fact (errors.log, journal, or a reproducible probe); with no field fact it is recorded as a residual or not built.
- Audit residuals must be re-checked against tests/harness.mjs and the actual test files before being written into MEMORY.md, because a wrong residual propagates into memory.
- Prefer `strict: "prefer"` over `"require"` for constrainedSampling: prefer degrades silently on routes without compat, require throws there.
- Provider compatibility flags must not go into pi's models.json (it does not carry compat); declare them in a provider extension after probing the upstream.
- saveConfig in handoff/settings.ts:62 builds an eight-key patch and merges through updateConfig, which re-reads the file under a lock and Object.assigns in place, so the handoff mirror has no lost-update problem.
- External-edit adoption protects a user edit from being clobbered by pi; it does not stop an external writer (e.g. Codex in UniField) from dropping curated content, so a merge-on-external-edit guard is a legitimate candidate (field fact: the UniField 2026-10-03 rewrite) but is not built and the owner decides.
- Committing a consumer repo's working tree on owner instruction must record in the commit message whatever a non-pi rewrite of .agents/memory/* dropped.

## Pitfalls
- Grep the live filesystem before trusting any handed-off task list; a previous run may have died mid-implementation on a rate limit.
- /tmp sandboxes are about 100-130 MB each; accumulated rev8..rev36 review copies filled the 16 GB tmpfs and broke `cp -a`; clean old sandboxes after archiving their transcripts.
- Sibling journals showing two appends 69-450 ms apart are one recordMemoryDocument call appending twice (adoption at store.ts:68, this pass's render) and are byte-identical; they are not evidence of concurrent writers.
- memoryComparisonKey("") returns "# Project Memory\n", so a file holding only the header is treated as a real edit and refuses the reply; only zero-byte/whitespace lets the reply win.
- The old consolidation-test check about a mid-call writer being backed up depended on the stale reply being published; it must now assert the edit's bytes survive and that no written claim appears.
- The stale window is the span from the adopt read to the publish; the observed field case is an edit landing before the adopt read, leaving only a narrow post-read window as a residual.
- Each review round that adds machinery adds surface for the next round to find problems, so unconverged growth is a signal to stop rather than to add more.
- The superseded 415-line v5 design is archived with a do-not-implement banner; it must not be resurrected.
- The installed clone lags the repo by design through the pin, so verify the pin and the clone's tag before claiming a fix is live; `describe --tags` in the clone needs a fetch --tags first.
- Line numbers written into design and fix-note docs must be re-measured against the final commit with grep -n; mapping a review round's citations back to the parent commit lands sites off by a couple of lines.
- `git ls-remote origin` queries only the fetch URL; verify the github mirror through the second push URL separately.
- The design's code-size estimate came in about 1.7x low because report.ts needed a larger gating restructure; budget implementation accordingly.
- A provider 429 blocks only that route: commandcode/deepseek/deepseek-v4.1-flash-fast hit a weekly limit while deepseek/deepseek-v4-pro served design round 9 and both code-review rounds.
- pi's handoff summary goes through compaction.js SUMMARIZATION_PROMPT (nine heading lines); prompt.ts's zh map covers all of them and the three other headings belong to pi templates off the handoff path.
- On this machine's routes (commandcode/scnet, no compat declared, detectCompat defaults supportsStrictMode false) the extension sends the non-strict function tool, so structured output rests on the schema description, voluntary compliance and the post-hoc extractors.
- The one real handoff failure chain in errors.log is a memory consolidation error thrown during session_shutdown that fails ctx.newSession (run.ts:262), so handoff success is coupled to memory not throwing at shutdown.
- Do not read "not exported to tests" as "not tested": tests/handoff-test.mjs drives runHandoff through a newSession mock (skip/success/cancel/throw) and maybeTrigger's settle trigger plus a non-stacking negative assertion; the earlier untested-residual claim was false and had already been copied into MEMORY.md before it was corrected in place.
- Dead-code hunts must grep the named consumer, not only the symbol: memory/journal.ts::newestMemoryArchiveSync survived because its JSDoc cited loadMemorySync, a function that no longer exists anywhere in the repo.
- Knob usage cannot be read from key presence: the extension writes all 23 keys into every project-context.json, so only a value differing from DEFAULT_CONFIG means the user changed something; across nine files on this machine exactly one differs (UniField maxMemoryChars 32000 to 36000) and none of the eight handoff knobs was ever touched.
- Journal rotation has never fired in the field (largest memory.jsonl is 373 KB against a 512 KB threshold); cite it as preventive, not field-evidenced, unlike backups (43 files) and errors.log rotation (2 files).
- The UniField MEMORY.md rewrite on 2026-10-03 is a real lossy external rewrite: parent commit 1df6dc6 held a curated 63 lines / 7,036 bytes and the committed replacement (UF 4d54838) is 130 lines / 43,262 bytes with 61 lines deleted, so byte growth is not evidence of retained content.
- The pc_ch 41.5 dB conclusion has 0 hits in UniField's memory.jsonl, so it exists only at `git show 1df6dc6:.agents/memory/MEMORY.md` (identical to /tmp/uf-head-memory.md); other dropped numbers (36.3, 20.7, 0.005, 13.9, 15.37) still survive in the journal.

## Index
- extensions/project-context/memory/store.ts - journal, atomic write, adoption block, publishKey exclusion predicate.
- extensions/project-context/memory/report.ts - record_memory tool, refusal gating, stale sentence, side-effect skipping; migrateProjectState call at report.ts:319.
- extensions/project-context/memory/pass.ts - ConsolidateOutcome.basisKey.
- extensions/project-context/memory/sections.ts - section parsing and CLI, constrainedSampling strict prefer.
- extensions/project-context/memory/journal.ts - append-only journal plus dead export newestMemoryArchiveSync.
- extensions/project-context/handoff/run.ts - handoff transaction, newSession, replay filter, language selection, maybeTrigger to /handoff force-auto round trip.
- extensions/project-context/handoff/prompt.ts - summary heading localization map.
- extensions/project-context/handoff/summary.ts - summary call and token-cap retry via generateSummaryWithUsage.
- extensions/project-context/handoff/settings.ts - saveConfig eight-key patch through updateConfig.
- extensions/project-context/handoff/session-settings.ts - staged model/thinking handoff with never-fired logError keys.
- extensions/project-context/shared/config.ts - flat config, legacy fallback chains, saveConfig via updateConfig.
- extensions/project-context/shared/lock.ts - stale-horizon steal path; its justification is code-level only: the 22 zero-byte .lock files under CipherCat .agents/memory/session-logs/ are NOT evidence for it (no current or historical lock target produces that path; addendum 3 section 2 corrects addendum 2 D7).
- tests/run-all.mjs, tests/external-edit-test.mjs, tests/consolidation-test.mjs, tests/handoff-test.mjs, tests/harness.mjs (makeCtx / makePi / makeSessionManager fakes).
- .codestable/issues/2026-10-03-external-edit-adoption-overwritten/ - design doc (design-frozen, revision 9), v5 archive, fix note, review report, design rounds R6-R9 and code-review-round1/2 prompt+transcript files, repro-write-ordering.mjs.
- .codestable/issues/2026-09-30-auxiliary-call-noise-and-memory-cap/ - D2 fix note, release-v0.2.1-evidence.md.
- .codestable/audits/2026-10-03-design-complexity-audit.md - main audit; 2026-10-03-design-complexity-audit-addendum-handoff-config.md - handoff/config pass; 2026-10-04-design-complexity-audit-addendum-2-module-inventory.md - 58-module inventory plus findings D1-D8.
- .agents/skills/pi-project-context-sandboxed-independent-review/SKILL.md, .agents/skills/pi-project-context-design-review-round-budget/SKILL.md, .agents/skills/pi-project-context-field-evidence-complexity-audit/SKILL.md.
- .agents/memory/MEMORY.md:53 - corrected line about maybeTrigger/runHandoff test coverage.
- ~/.pi/agent/settings.json:30 - pinned extension URL; ~/.pi/README.md:23 - same pin in docs.
- Commands: `node tests/run-all.mjs`, `git push origin master <tag>`, `pi update --extensions`.
