# Project Context

Last updated: 2026-09-30T10:04:12.250Z

## Summary

User asked to restore context: the two recently active projects (UniField, Quantum_Matrix) keep raising alerts. Root cause found: with empty `provider`/`model`, auxiliary consolidation and autolearn fall back to the session model (Codex), and provider failures (usage limit, 402/403/429, connection errors) retried on every settle, flooding `errors.log` (UniField 211 lines, Quantum_Matrix 769 lines / ~104 KB) and toasting repeatedly. A four-step improvement plan was agreed. Steps 1 and 2 are implemented and green but uncommitted; step 3 ops actions touch the user's live projects and await confirmation.

## Key points

- Diagnosis: alerts come from auxiliary model calls failing (Codex usage limit, 402 insufficient balance, 403 auth, 429 quota, connection errors/stream termination) during consolidation and autolearn, plus a retry storm on every agent_settled and false 'hit the cap' warnings from copied truncation markers.
- `errors.log` is unbounded/append-only and noisy: repeated identical entries, no rotation-based dedupe, and both live projects have `maxMemoryChars` set at or near the render size (UniField 36000, Quantum_Matrix 32000) while renders reached ~31 KB.
- Step 1 (done): new `shared/call-policy.ts` with failure classes, per-project/per-scope cooldown, exponential backoff, and session disable after 5 consecutive provider failures; `shape` failures deliberately do not cool down routes; wired into `memory/pass.ts`, `memory/report.ts`, `autolearn/pass.ts` with class-specific toasts.
- Step 2 (done): consolidation prompt now carries the real `maxMemoryChars` cap and current size and forbids writing truncation markers (M1); an over-cap reply gets one bounded condensation call instead of a silent tail drop (M2); `exceedsMemoryCap` stops a copied `_[memory truncated …]_` marker from faking a cap event (M6).
- `docs/architecture.md` shared-module tree updated with `call-policy.ts`.
- Verification: `node tests/run-all.mjs` is 11/11 (new `tests/call-policy-test.mjs`, `tests/memory-budget-test.mjs`); `git diff --check` clean.
- Changed files: extensions/project-context/{memory/pass.ts,memory/report.ts,memory/prompt.ts,memory/document.ts,autolearn/pass.ts,shared/project-state.ts,docs/architecture.md} plus new shared/call-policy.ts and two test files — all uncommitted.
- `.agents/memory/CONTEXT.md` and `.agents/memory/project-context.json` in this repo are modified by the live extension; per convention they are committed separately from code.
- Running pi sessions PID 3225 (UniField) and PID 3278 (Quantum_Matrix) use the installed v0.1.11+ clone and cannot see these fixes until rebuilt/reinstalled and restarted.

## Open tasks

- Step 3 code-only remainder: B4 (merge duplicate `errors.log` lines / reduce noise) plus M3, M4, M7 memory-budget items.
- Step 3 ops items require explicit confirmation before touching live projects: raise Quantum_Matrix `maxMemoryChars` (and reconcile its MEMORY.md/journal divergence and backups), review UniField settings, restart PIDs 3225 and 3278.
- Step 4 (separate feature): S2 memory-entry lifecycle and S5 incremental ops protocol.
- Run the sandboxed independent review skill over the M2/M5 protocol boundary changes.
- Decide whether to create a CodeStable issue/feature record and commit the current work (code commit vs `docs(memory)` render commit separately).

<!-- latest-session-title: Fixing recurring alerts in UniField and Quantum_Matrix -->
