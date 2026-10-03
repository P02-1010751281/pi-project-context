# Project Context

Last updated: 2026-10-03T04:01:42.254Z

## Summary

The v0.2.0 release is finished and pushed. Implementation (structured consolidation output via `record_memory`, code-rendered `MemorySections`, Markdown-extractor fallback, semantic-emptiness gate; autolearn `record_skill`; command renames + `getArgumentCompletions`; the `rmTemp` teardown fix) had already landed; this session closed it out. Seven sandboxed independent code-review rounds ran: R1–R5 returned CHANGES-REQUESTED (every finding fixed, each round proven zero-write against baseline `git status --porcelain -uall` + `stat` snapshots), R6 and R7 returned VERDICT: PASSED, and R7 covered the tagged code. Post-R6 fixes F1–F4 were required (F1 had a silent-overwrite shape), which is why R6's PASSED was not reused. The earlier 'all routes unusable' block was a misdiagnosis: the probes passed `--no-extensions`, which disables the extension-registered `commandcode` provider, so the route could never resolve; using `--no-project-context` restored it in one command. Released v0.2.0 as an annotated tag (`cc85efdd`) peeling to `a870dc3d`, pushed `master` + tag to both remotes, bumped the `pi-config` pin (`1ae281a`), verified the installed clone (HEAD == tag peel, clean tree, markers present, its own suite 14/14), ran a valid settings-installed probe (`/tmp/pc-v020-probe2-bKO8`) that wrote a schema-conformant 4-section `MEMORY.md` + 3-section `CONTEXT.md` + `memory.jsonl` with no `errors.log`, and recorded release evidence in a post-tag commit (`6ef87e8`). The first probe hit a 402 and was recorded as non-evidence. Remaining work is operator housekeeping and two small deferred fixes.

## Key points

- Deep root cause: `--no-extensions` disables extension-registered custom providers, so the spawned reviewer probe could never resolve `commandcode/...`. `--no-project-context` is the correct isolation flag. No balance or quota problem existed; the 20-minute empty round was a self-inflicted probe error.
- Code review: 7 rounds for this issue. R1–R5 CHANGES-REQUESTED (all fixed), R6 and R7 VERDICT: PASSED. Every round proven zero-write. The empty R3 transcript was never filed as a round, and R6's PASSED was not stretched over the post-PASSED F1–F4 fixes — R7 was run instead.
- Review pattern worth keeping: the opaque skeleton gate needed three rounds of narrowing (separators → tag names → fence families) before switching to a general criterion — the whole Unicode `Cf` category, the whole tag family, family+length+info-aware fence handling — after which it converged, verified by mutation checks and differential fuzzing.
- R3's own fix introduced a regression: fence stripping consumed `\r`/U+2028 and real memory was refused. Direction of failure now must be stated for every filter change: fail-open (skip a write) or fail-safe (refuse one), never a silent overwrite.
- Release artifacts: tag `v0.2.0` object `cc85efdd` → peel `a870dc3d`; commits `a562d7e` feat, `afccf5c` docs, `e90dace` codestable, `a870dc3` memory render, post-tag evidence `6ef87e8`; both remotes carry `master` = `6ef87e8` and `v0.2.0` = `cc85efdd`; pi-config pin bump `1ae281a`.
- Installed clone verified after `pi update --extensions`: `HEAD` = `a870dc3df47f…` = tag peel, clean tree, `INVISIBLE_RE` / `isHeadingOnlyDocument` / `record_memory` / `UNTERMINATED_TAG_RE` all present under `extensions/project-context/memory/sections.ts`, and the clone's own `tests/run-all.mjs` passed 14/14.
- Valid settings probe `/tmp/pc-v020-probe2-bKO8` (`pi -p --model commandcode/deepseek/deepseek-v4.1-flash-fast`) produced a 4-section all-bullet `MEMORY.md`, a 3-section `CONTEXT.md`, `memory.jsonl`, `session-logs/`, and no `errors.log`. First probe `/tmp/pc-v020-probe-QKH5` used default `deepseek` and hit 402; recorded as non-evidence, since the extension's fail-closed behavior there is correct but not validation.
- User-facing breaking changes for the release notes: `/memory-learn` → `/memory update`, `/auto-handoff` → `/handoff`, `/context-update` deleted (no aliases, no transition period); `/context` unchanged.
- Accepted and recorded residuals (decision 6 / D7, `implementation-note.md`): fail-open — prose preamble wrapping a skeleton, `---` setext skeleton, an info-string fence line keeping a code block open; fail-safe — orphan `<T>`/`<hN>…</hN>`/`<tel:…>`, 4-space-indented fence closers, punctuation/emoji-only bodies conservatively refused; performance `TAG_SPAN_RE` O(n²) worst ~2s; strict-mode end-to-end evidence still missing.
- Restart required: `pi update --extensions` only refreshes the on-disk clone; already-running pi processes keep the code they loaded at startup, and a status line without `· summarize …` is the tell.

## Open tasks

- Restart pi so v0.2.0 is actually running; `pi update --extensions` alone does not affect running processes.
- Owner ops on live projects: raise Quantum_Matrix `maxMemoryChars`, reconcile its `MEMORY.md`/journal divergence and backups, review UniField settings.
- Deferred cheap fixes: section-aware memory clipping; persist an over-cap consolidation reply locally instead of silently clipping.
- Close the strict-mode end-to-end evidence gap when a strict-capable route is available; the installed strict path is still unverified.
- Nothing prunes `session-logs/`; revisit size/retention as it grows (durability direction itself remains deferred to the owner).

<!-- latest-session-title: v0.2.0 released — structured consolidation + command renames; 7 review rounds, R6/R7 PASSED -->
