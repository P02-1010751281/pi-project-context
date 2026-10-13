---
name: pi-project-context-residual-closeout-audit
description: "Answer whether pi-project-context's residual/open items are all closed: collect attention/design/review/handoff lists, verify each against artifacts, classify by owner."
---

<!-- autolearn-generated: this skill may be superseded by a later autolearn pass -->

# When to use

Use when the owner asks whether residuals/open items (残留/开放项) are all closed, before declaring a chain, issue or release done, or when a handoff prompt's open-item list must be trusted or refuted.

## Procedure

1. Gather every candidate list; none is authoritative on its own:
   - `.codestable/attention.md` - the current attention list.
   - The newest design/issue doc under `.codestable/issues/<date-topic>/`: its front-matter, its "未实现 / 留待后续" section, and any recorded amendment (for example a "§0 补记") that lists answers the owner has already given.
   - The last review report's close-out note: named residuals, unclosed findings, follow-ups.
   - `.agents/memory/HANDOFF.md` and the handoff prompt's open-item list - treat as stale until verified against the design doc; its count of unanswered questions is often wrong because items were answered in a later session.
2. Verify each item against an artifact, never against another list: `git log --oneline -- <path>`, the evidence file in the issue dir, or a `grep` of the item's log key in `.agents/memory/errors.log`. A zero-hit key proves the error did not occur, not that the mechanism never ran.
3. Classify every item into exactly one bucket and say which:
   - closed - cite the commit, evidence file or audit section;
   - open, owner decision - state the candidate directions and what field evidence a fix must cite first (a finding that asks for a new mechanism needs an errors.log line, journal line, success artifact or reproducible probe);
   - open, sibling repo (its call) - cite it only as ownership, never copy its state;
   - list stale - the item was answered elsewhere; correct the stale list in the same pass.
4. When an audit or field run exposes a new residual, register it with its field fact as evidence and name the candidate fixes; do not fold it silently into another item.
5. Reply with the yes/no answer in the first line ("no, N remain"), then a table: item | status | evidence. Keep confirmed-closed items to one line each.

## Gotchas

- A design doc's "not implemented" section is a scope statement, not a bug list: an item sitting there waits for an explicit owner nod before any code.
- Distinguish "no trace because nothing changed" from "no trace because the pass never ran": the extension writes a journal op only when the document changes, so a silent pass is indistinguishable from a skipped one except by forcing a pass and watching `.agents/memory/memory.jsonl`.
- Per-section shares are targets, not caps, so "over share" is not a defect on its own; a real residual needs the whole-document cap or a field artifact behind it.
- When a session corrects an earlier conclusion, commit the correction and cite the correcting commit id; leave the old wording only as a marked superseded note, not silently edited.
