---
name: pi-project-context-session-log-archive-repair
description: "Audit and repair duplicated/truncated pi-project-context session-log archives, and harden archive/session-log.ts append/rebuild logic."
---

<!-- autolearn-generated: this skill may be superseded by a later autolearn pass -->

## When to use

Use when a consumer project's `.agents/memory/session-logs/<session-id>/session.jsonl` shows adjacent duplicate JSON records that are absent from the harness session source, or when `/session-log` output looks duplicated/truncated.

## Audit

1. For each archived `session.jsonl`, compare line/byte count against the harness source session file; grep for adjacent identical JSON lines.
2. Inspect `session-logs/INDEX.md` for dangling lines (entries whose session dir is missing).
3. Treat empty probe sessions and `manual-refresh-*` dirs as expected history, not gaps.
4. Record counts before changing anything: `git status --porcelain -uall` and `stat` snapshots of the archive tree.

## Fix the writer

Edit `extensions/project-context/archive/session-log.ts`:

- Derive the append offset from the archive's own byte size (do not trust a pre-read `stat`).
- Serialize writes per project+session with a promise chain so `/session-log` and turn/settle paths cannot interleave.
- Clamp short reads with `bytesRead`; never NUL-pad.
- Rebuilds must not inject synthetic bytes.
- Before appending, compare the last 256 bytes of archive vs source with `Buffer.equals`; on mismatch or unreadable probe, force a full rebuild.

## Test

Add cases to `tests/sync-test.mjs`: duplicate-free append, concurrent-write serialization, short-read rebuild, and probe-mismatch rebuild. Run `node tests/run-all.mjs` (or `node tests/sync-test.mjs`). Prove each production line with a mutation matrix plus positive control (see existing gate-probe mutation workflow).

## Evidence pattern

This is the fix used for `.codestable/issues/2026-09-30-session-log-append-duplication/`; commits `1b01070`, `718a441`, `7f0e803`, `3ffdc26`, docs `eef592c`. Three sandboxed read-only review rounds (two CHANGES-REQUESTED, final PASSED) plus empty before/after `git status` and `stat` diffs proved zero writes.
