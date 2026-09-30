# Project Context

Last updated: 2026-09-30T14:32:43.938Z

## Summary

Restored state from git/artifacts, then audited `.agents/memory/session-logs/`. Found a real append-duplication bug in the session archive (12 archived `session.jsonl` files had adjacent duplicate entries while the harness source did not) and fixed `archive/session-log.ts`: append offset now comes from the archive's own byte size, per project+session writes are serialized, short reads are clamped, rebuilds add no synthetic bytes, and a 256-byte `Buffer.equals` probe guards same-inode rewrites. `tests/sync-test.mjs` gained four cases; suite is 12/12 and the mutation matrix kills each production line. Three independent read-only sandbox review rounds ran (rounds 1–2 CHANGES-REQUESTED → round 3 PASSED, only doc nits left). The earlier interrupted chain was also finished: the aux-call/memory-cap 6-round review artifacts were filed and everything was pushed; master is `eef592c` on both remotes with a clean tree.

## Key points

- Previous context was stale: step 3 (B4/M3/M4/M7) was already committed and the aux/memory 6-round review was done; only archiving the artifacts and pushing were missing.
- GitHub mirror had diverged (`8b300dc`); merged it and pushed `42f0956..eef592c` to both remotes.
- Session-log audit: 12 archived `session.jsonl` files had duplicate entries; `INDEX.md` had 2 dangling lines (cleaned). Empty probe sessions and `manual-refresh-…` dirs are normal history, not gaps.
- Fix commits: `1b01070`, `718a441`, `7f0e803`, `3ffdc26`, plus docs `eef592c`; new issue dir `.codestable/issues/2026-09-30-session-log-append-duplication/` holds 3 rounds of prompts/transcripts and the fix note.
- Round-3 zero-write proof passed (sandbox `git status` and `stat` snapshots unchanged).
- Live pi PIDs changed from 3225/3278 to 262684/263321/324402; they still run the installed v0.1.11+ clone.
- `CONTEXT.md` remains from `10:04Z` because the last shutdown consolidation reply lost its context section; the next pass should refresh it.

## Open tasks

- Release both unreleased fixes (aux-call/memory-cap and session-log) and reinstall, then restart running pi processes so they take effect.
- Owner-confirmed ops on live projects: raise Quantum_Matrix `maxMemoryChars`, reconcile its `MEMORY.md`/journal divergence and backups, review UniField settings.
- Next planned feature: S1+S3 (fixed schema + pointerization), which needs the sandboxed independent review before landing.
- Confirm whether to start S1+S3 now or handle ops/release first.

<!-- latest-session-title: Session-log append-duplication fix and push -->
