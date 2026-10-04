---
name: pi-project-context-audit-claim-verification
description: "Verify an audit, residual or status claim against the real tests and call sites, and fix it at every propagation site. Use before recording claims."
---

# When to use
Before promoting any finding into `.codestable/audits/*.md`, a design/fix note's `status:` field, or `.agents/memory/MEMORY.md`, and before repeating someone else's residual. Four false claims in this repo came from skipping this step: an "untested" residual (D1), an unattributed-then-misattributed stale-`.lock` artifact (D7), a "not produced by the other project" corollary, and a byte-vs-character over-cap premise that fed a wrong config recommendation.

## 1. "Not exported to tests" is not "not tested"
Open the test file and look for how it reaches the code, before writing a coverage residual:

```bash
rg -n "newSession|captureNewSession|maybeTrigger|runHandoff" tests/
```

`tests/handoff-test.mjs` drives `runHandoff` through a `newSession` mock (skip / success / cancel / throwing ctx) and asserts `maybeTrigger`'s settle trigger plus a non-stacking negative, so the "maybeTrigger and runHandoff are untested" residual was false. Same trap for dead code: grep the named consumer, not only the symbol — `memory/journal.ts::newestMemoryArchiveSync` is dead because its JSDoc cites `loadMemorySync`, which no longer exists anywhere (`rg -n "newestMemoryArchiveSync|loadMemorySync" .`).

## 2. Attribute an artifact by its producer's call sites, not by its shape
Found stale field files that *look* like evidence for a code path? Grep the path's call sites in the extension before citing them:

```bash
rg -n "withMemoryLock\(" extensions/            # which targets are ever locked?
rg -n "logError|LOCK_STALE" extensions/project-context/memory/lock.ts
```

Only the session-index target was ever passed to `withMemoryLock` in this repo, so the zero-byte locks under `session-logs/<id>/` are **not** evidence for `lock.ts`'s stale-steal path. But exclusion is half the job — attribute positively before recording "ownership unknown":

```bash
rg -n "O_CREAT|\.lock" ../codex-project-context/scripts/contextctl.py   # who opens that path?
```

The Codex port's `file_lock()` opens `session_dir / ".lock"` with `O_RDWR|O_CREAT` and never unlinks it, so every `render_session` left one 0-byte file behind; the `s-{urlsafe_b64(session_id)}` directory naming confirms it. Note the trap that produced the second false claim here: flock does not *need* a path, but a helper that opens one with `O_CREAT` still leaves a file — a lock mechanism's syscall family does not tell you whether it writes a file. Check the open flags and whether the path is unlinked. Correct any addendum in place, both for the original misattribution and for the "other project does not produce these" corollary.

## 3. Check the unit before doing the arithmetic
`maxMemoryChars` counts characters, not bytes:

```bash
python3 -c "print(len(open('.agents/memory/MEMORY.md',encoding='utf-8').read()))"   # characters, compare to the cap
wc -c .agents/memory/MEMORY.md                                                     # bytes, CJK-heavy files run ~1.6x larger
```

Comparing bytes to a character cap produced a false "over cap" premise (the files were under the cap) and a wrong `maxMemoryChars` raise; byte growth is also not evidence that curated content survived a rewrite.

## 4. Status fields and self-claims: verify against code and commit, then flip

```bash
rg -n "^status:" .codestable -g '*.md'      # look for non-terminal values
rg -n "toLowerCase" extensions/project-context/shared/gitignore.ts   # the code site a residual cites
git log --oneline -- <path/to/fix.md>
```

For each drifted field, check the cited code site and the fix commit (`handoff-residuals` m4 lands in `7976ebb`) before flipping. Also repair stale self-claims: fix notes reading "尚未提交" while the commit shipped in v0.1.6 (`7976ebb`) / v0.1.7 (`d4cdad3`).

## 5. When a claim is falsified, correct every propagation site in one commit
A false residual had already been copied into an addendum, the main audit summary and `MEMORY.md:53`; all three were corrected in place, tests re-run (`node tests/run-all.mjs`, 15/15), committed, pushed to both push URLs, and each remote verified separately with `git ls-remote <url> HEAD`. Never leave the correction only where it was first written.
