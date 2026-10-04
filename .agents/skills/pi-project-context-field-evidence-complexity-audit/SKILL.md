---
name: pi-project-context-field-evidence-complexity-audit
description: "Audit pi-project-context for over-built or unused mechanisms/knobs using the field-evidence rule, and land the result as an audit addendum instead of new code."
---

# When to use

When asked to audit pi-project-context for complexity (unused knobs, duplicated paths, legacy compatibility layers, dead code) or to close the "unaudited" list of an existing `.codestable/audits/` document. Also use it to decide keep / retire / residual for a mechanism someone proposes to add or delete.

# The judging rule (state it in the doc, apply it to every item)

A mechanism may only be called justified (or newly built) if it traces to a **field fact**: an `errors.log` line, a journal line, or a reproducible probe. With no field fact, record it as a **residual** or a **non-goal** — never as a design requirement. This is the same rule used in `.codestable/issues/*/` design docs; keep it explicit so the next round cannot ask for a mechanism by argument alone.

# Step 1 — knob/config usage probe (the probe that is easy to get wrong)

The extension writes the **entire** config document, so every `.agents/memory/project-context.json` carries all keys (23 at the 2026-10-03 audit) regardless of whether anyone ever touched them. Key presence therefore proves nothing.

1. Locate every config file on the machine, including sibling consumer repos (QM / UF) and throwaway probes:
   `find / -name project-context.json -path '*/.agents/memory/*' 2>/dev/null` (or search the known consumer roots).
2. Read `DEFAULT_CONFIG` in `extensions/project-context/shared/config.ts`.
3. Diff each file against the defaults key by key; count how many files differ and on which knob. Report it as `changed/total` numbers (at the 2026-10-03 audit: nine config files, exactly one knob ever changed anywhere — one consumer's `maxMemoryChars` — and zero of the eight handoff knobs).
4. Treat `autolearnAt` (and similar) as machine-written state, not user intent; exclude it from "was this knob tuned".
5. Same technique for the legacy compatibility layer: grep the consumer configs for nested `features` / `autolearn` / `handoff` keys, `autolearn.json`, agent-level `auto-handoff.json`. Migration is one-way (read old, write new), so an evidence count of 0/N licenses a **retirement window** rather than permanent support.

# Step 2 — read the code paths, record both findings and negative results

Negative results are findings and must be written down: they stop the next audit from re-deriving them.

- `handoff/prompt.ts` heading map: compare against pi's real handoff template, `<bundle>/dist/compaction.js` `SUMMARIZATION_PROMPT` (bundle = `~/.pi/agent/install/releases/$(cat ~/.pi/agent/install/current-version)/node_modules/@earendil-works/pi-coding-agent`) (nine heading lines). Verified complete at that audit — `Critical Context` is on the handoff path, and `Context Needed to Continue` / `Original Request` / `Progress So Far` belong to other pi templates and correctly stay unmapped.
- `handoff/settings.ts` `saveConfig`: check for the claimed lost-update bug — it builds a patch and goes through `updateConfig`, which re-reads the file under `withMemoryLock` before merging, so there is no lost update.
- Real failure chains: read the `errors.log` stack traces rather than inferring. The one real handoff failure is a memory consolidation error thrown during `session_shutdown` that bubbles into `ctx.newSession` in `extensions/project-context/handoff/run.ts:262`; that both justifies the failure backoff and names a cross-feature coupling.
- Always re-measure cited line numbers against the final commit with `grep -n`; citations copied from a parent commit land off by a couple of lines and get flagged in review.
- Untested surface (e.g. `maybeTrigger`, `runHandoff`) is recorded as an accepted infrastructure residual, not a reason to add machinery.

# Step 3 — recommendation shape

For a publicly published extension, the honest conclusion for unused surface is usually **stop widening it, do not delete it** (the audit's handoff knobs: eight knobs never tuned yet carrying a twelve-branch command handler, two completion tables and a status renderer). State the evidence boundary in the document, i.e. exactly which machines/files the count covers.

# Step 4 — deliver, verify, commit

- New audit goes to `.codestable/audits/YYYY-MM-DD-<topic>-audit-addendum-<scope>.md`; update the **main audit's "unaudited" section** to point at it so the list cannot silently stay stale.
- Run the gates: `node tests/run-all.mjs` must stay 15/15 (an audit changes docs only, so any test movement means you touched code).
- Commit as `docs(audits): ...` and push once: `git push origin master` reaches **both** push URLs (forgejo + github mirror); verify the mirror separately, `git ls-remote origin` only queries the fetch URL.
- Hand the owner the leftover non-audit items with current numbers instead of re-deriving them (e.g. sibling repos N commits ahead of `origin/master`, untracked `.agents/memory/*` files and skill dirs).
