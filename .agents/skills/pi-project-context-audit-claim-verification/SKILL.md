---
name: pi-project-context-audit-claim-verification
description: "Audit pi-project-context and record findings: apply the field-evidence rule, probe knob/config usage, verify claims against tests and call sites, deliver an addendum."
---

# When to use

When asked to audit pi-project-context for complexity (unused knobs, duplicated paths, legacy compatibility layers, dead code), to close the "unaudited" list of an existing `.codestable/audits/` document, or to decide keep / retire / residual for a mechanism someone proposes to add or delete. Also use it **before promoting any finding** into `.codestable/audits/*.md`, a design/fix note's `status:` field, or `.agents/memory/MEMORY.md`, and before repeating someone else's residual. Four false claims in this repo came from skipping that verification: an "untested" residual (D1), an unattributed-then-misattributed stale-`.lock` artifact (D7), a "not produced by the other project" corollary, and a byte-vs-character over-cap premise that fed a wrong config recommendation.

## The judging rule (state it in the doc, apply it to every item)

A mechanism may only be called justified (or newly built) if it traces to a **field fact**: an `errors.log` line, a journal line, a success artifact such as `migration-manifest.json`, or a reproducible probe. With no field fact, record it as a **residual** or a **non-goal** — never as a design requirement. This is the same rule used in `.codestable/issues/*/` design docs; keep it explicit so the next round cannot ask for a mechanism by argument alone.

Corollary: a zero-hit `logError` key proves the error did not occur, it does not prove the mechanism never ran — look for success artifacts as well before calling a path untested or unused.

## Step 1 — knob/config usage probe (the probe that is easy to get wrong)

The extension writes the **entire** config document, so every `.agents/memory/project-context.json` carries all keys (23 at the 2026-10-03 audit) regardless of whether anyone ever touched them. Key presence therefore proves nothing.

1. Locate every config file on the machine, including sibling consumer repos and throwaway probes:
   `find / -name project-context.json -path '*/.agents/memory/*' 2>/dev/null` (or search the known consumer roots).
2. Read `DEFAULT_CONFIG` in `extensions/project-context/shared/config.ts`.
3. Diff each file against the defaults key by key; count how many files differ and on which knob. Report it as `changed/total` numbers (at the 2026-10-03 audit: nine config files, exactly one knob ever changed anywhere — one consumer's `maxMemoryChars` — and zero of the eight handoff knobs).
4. Treat `autolearnAt` (and similar) as machine-written state, not user intent; exclude it from "was this knob tuned".
5. Same technique for the legacy compatibility layer: grep the consumer configs for nested `features` / `autolearn` / `handoff` keys, `autolearn.json`, agent-level `auto-handoff.json`. Migration is one-way (read old, write new), so an evidence count of 0/N licenses a **retirement window** rather than permanent support.

## Step 2 — read the code paths, record both findings and negative results

Negative results are findings and must be written down: they stop the next audit from re-deriving them.

- `handoff/prompt.ts` heading map: compare against pi's real handoff template, `<bundle>/dist/compaction.js` `SUMMARIZATION_PROMPT` (bundle = `~/.pi/agent/install/releases/$(cat ~/.pi/agent/install/current-version)/node_modules/@earendil-works/pi-coding-agent`) (nine heading lines). Verified complete at that audit — `Critical Context` is on the handoff path, and `Context Needed to Continue` / `Original Request` / `Progress So Far` belong to other pi templates and correctly stay unmapped.
- `handoff/settings.ts` `saveConfig`: check for the claimed lost-update bug — it builds a patch and goes through `updateConfig`, which re-reads the file under `withMemoryLock` before merging, so there is no lost update.
- Real failure chains: read the `errors.log` stack traces rather than inferring. The one real handoff failure is a memory consolidation error thrown during `session_shutdown` that bubbles into `ctx.newSession` in `extensions/project-context/handoff/run.ts`; that both justifies the failure backoff and names a cross-feature coupling.
- Always re-measure cited line numbers against the final commit with `grep -n`; citations copied from a parent commit land off by a couple of lines and get flagged in review. Prefer file-level pointers.
- Untested surface (e.g. `maybeTrigger`, `runHandoff`) is recorded as an accepted infrastructure residual, not a reason to add machinery.

## Step 3 — verify each claim before recording it

### 3a. "Not exported to tests" is not "not tested"
Open the test file and look for how it reaches the code, before writing a coverage residual:

```bash
rg -n "newSession|captureNewSession|maybeTrigger|runHandoff" tests/
```

`tests/handoff-test.mjs` drives `runHandoff` through a `newSession` mock (skip / success / cancel / throwing ctx) and asserts `maybeTrigger`'s settle trigger plus a non-stacking negative, so the "maybeTrigger and runHandoff are untested" residual was false. Same trap for dead code: grep the named consumer, not only the symbol — `memory/journal.ts::newestMemoryArchiveSync` is dead because its JSDoc cites `loadMemorySync`, which no longer exists anywhere (`rg -n "newestMemoryArchiveSync|loadMemorySync" .`).

### 3b. Attribute an artifact by its producer's call sites, not by its shape
Found stale field files that *look* like evidence for a code path? Grep the path's call sites in the extension before citing them:

```bash
rg -n "withMemoryLock\(" extensions/            # which targets are ever locked?
rg -n "logError|LOCK_STALE" extensions/project-context/shared/lock.ts
```

Only the session-index target was ever passed to `withMemoryLock` in this repo, so the zero-byte locks under `session-logs/<id>/` are **not** evidence for `lock.ts`'s stale-steal path. But exclusion is half the job — attribute positively before recording "ownership unknown":

```bash
rg -n "O_CREAT|\.lock" ../codex-project-context/scripts/contextctl.py   # who opens that path?
```

The Codex port's `file_lock()` opens `session_dir / ".lock"` with `O_RDWR|O_CREAT` and never unlinks it, so every `render_session` left one 0-byte file behind; the `s-{urlsafe_b64(session_id)}` directory naming confirms it. Note the trap that produced the second false claim here: flock does not *need* a path, but a helper that opens one with `O_CREAT` still leaves a file — a lock mechanism's syscall family does not tell you whether it writes a file. Check the open flags and whether the path is unlinked. Correct any addendum in place, both for the original misattribution and for the "other project does not produce these" corollary.

### 3c. Check the unit before doing the arithmetic
`maxMemoryChars` counts characters, not bytes:

```bash
python3 -c "print(len(open('.agents/memory/MEMORY.md',encoding='utf-8').read()))"   # characters, compare to the cap
wc -c .agents/memory/MEMORY.md                                                     # bytes, CJK-heavy files run ~1.6x larger
```

Comparing bytes to a character cap produced a false "over cap" premise (the files were under the cap) and a wrong `maxMemoryChars` raise; byte growth is also not evidence that curated content survived a rewrite.

### 3d. Status fields and self-claims: verify against code and commit, then flip

```bash
rg -n "^status:" .codestable -g '*.md'      # look for non-terminal values
rg -n "toLowerCase" extensions/project-context/shared/gitignore.ts   # the code site a residual cites
git log --oneline -- <path/to/fix.md>
```

For each drifted field, check the cited code site and the fix commit before flipping. Also repair stale self-claims: fix notes reading "尚未提交" while the commit had shipped in an earlier release.

### 3e. When a claim is falsified, correct every propagation site in one commit
A false residual had already been copied into an addendum, the main audit summary and `MEMORY.md`; all three were corrected in place, tests re-run (`node tests/run-all.mjs`, 15/15), committed, pushed to both push URLs, and each remote verified separately with `git ls-remote <url> HEAD`. Never leave the correction only where it was first written.

## Step 4 — recommendation shape

For a publicly published extension, the honest conclusion for unused surface is usually **stop widening it, do not delete it** (the audit's handoff knobs: eight knobs never tuned yet carrying a twelve-branch command handler, two completion tables and a status renderer). State the evidence boundary in the document, i.e. exactly which machines/files the count covers.

## Step 5 — deliver, verify, commit

- New audit goes to `.codestable/audits/YYYY-MM-DD-<topic>-audit-addendum-<scope>.md`; update the **main audit's "unaudited" section** to point at it so the list cannot silently stay stale.
- Run the gates: `node tests/run-all.mjs` must stay 15/15 (an audit changes docs only, so any test movement means you touched code).
- Commit as `docs(audits): ...` and push once: `git push origin master` reaches **both** push URLs (forgejo + github mirror); verify the mirror separately, `git ls-remote origin` only queries the fetch URL.
- Hand the owner the leftover non-audit items with current numbers instead of re-deriving them (e.g. sibling repos N commits ahead of `origin/master`, untracked `.agents/memory/*` files and skill dirs).
