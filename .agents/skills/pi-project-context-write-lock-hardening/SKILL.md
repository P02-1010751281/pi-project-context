---
name: pi-project-context-write-lock-hardening
description: "Harden and triage the cross-process write lock/claim path in pi-project-context (extensions/project-context/project-state.ts): lstat-based pathological-path self-heal, inode-pinned steals, claim ownership rechecks, bounded backups, and non-vacuous directory/FIFO/symlink lock tests."
---

## When to use
Use when a pi-project-context memory write or consolidation hangs (the 5s lock timeout), when `.agents/memory/MEMORY.md.lock` or a claim path may be a non-regular file (directory, FIFO, symlink, dangling symlink), or when changing lock/claim/backup logic in `extensions/project-context/project-state.ts`.

## Key files
- Lock path: `.agents/memory/MEMORY.md.lock` (per project, under `.agents/memory/`).
- Code: `extensions/project-context/project-state.ts` (`tryLock`, `acquireClaim`, `stealStaleLock`, backup pruning).
- Tests: `tests/consolidation-test.mjs`; run the suite with `node tests/run-all.mjs`.

## Procedure
1. Classify the lock/claim path with `lstat`, never `stat`. `stat` follows symlinks, so a dangling symlink returns ENOENT and a real obstruction looks like "no lock"; the subsequent `open`/rename then fails and callers loop into the permanent 5s timeout. Treat directory/FIFO/symlink (including dangling) as pathological: `rename` the entry aside to self-heal, then retry.
2. Only delete locks you created. `open` the lock, record the inode, and on write-failure cleanup unlink only that inode so a successor's lock is never removed.
3. Pin before stealing. In `stealStaleLock`: `lstat` (capture ino/dev) -> read -> `lstat` again -> re-read bytes -> verify claim ownership; remove only when all five checks match. Reclaim likewise deletes only the observed inode+bytes.
4. Recheck ownership before every destructive op (`claimStillOurs`) using a per-acquisition claim token; a reclaimed claim invalidates the previous holder's token so it cannot delete the new lock.
5. Bound backups: hard cap 20 (`max(KEPT, 20)` self-guarding), deterministic tie-break by name when mtimes collide, and skip entries whose `stat` fails instead of treating size as 0 and deleting them.
6. Fix the tests so they are not vacuous: separate the pathological-path probe from the assertion, so a lock failure makes the test fail (a FIFO/rename probe with no assertion always passes). Add directory, FIFO, symlink, dangling-symlink, backup-cap, and tie-break regressions.
7. Verify: `node tests/run-all.mjs` (all tests green; 8/8 at commit `6818935`, 9/9 now), plus a pathological matrix and a multi-writer stress run expecting 0 overlap and 0 leaked locks.

## Gotchas / limits
- `node:fs` exposes no `flock`, so the final `check -> unlink` is not kernel-atomic. Trigger needs a process suspended >=30s inside the window plus a concurrent steal; impact is transient mutex loss only (writes are atomic renames with pre-overwrite backups). Document trigger and impact instead of claiming closure.
- Windows/NFS rename/rm/mtime errno behavior and real tokenizer/provider limits are unverifiable in the sandbox.
- Keep non-empty `.broken-*` directories (user data) rather than deleting them; keep the documented backup count <=20 as a design bound.
- A live pi process running the old installed extension can re-introduce the symptom; restart it before re-fixing (see the stale-writer section of `pi-project-context-memory-recovery`).
