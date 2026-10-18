# Handoff loses an active skill/mode (2026-10-18)

## Report

The user observed that a handoff successor does not continue every requirement from the previous
session: a mode such as `grilling` is simply gone after the handoff. The successor knows the last
request (the carried tail) but not that the previous session was following a skill that shaped how
to answer it.

## Mechanism

A pi skill is loaded by reading its `SKILL.md` (pi advertises only name, description and path at
startup). The handoff cut can drop that tool result; the continuation then carries only the path in
its `<read-files>` block, with no instruction that the skill was an active mode. The closing asked
the successor to restate the last request and the state, not the skill/mode, so the successor starts
fresh. The same loss happens one handoff later when the original read call is already outside the
branch: the only surviving copy is the previous continuation prompt's `<read-files>` text.

Field check on this project's own successor session: its v0.4.10 continuation prompt lists two
review skills under `<read-files>` and has no active-skill section; `collectActiveSkills` on the
session returns both from the prompt text, so the new continuation would name them.

## Fix

- `handoff/file-ops.ts`: `collectActiveSkills(entries)` collects `SKILL.md` paths from
  - assistant `read` tool calls (the normal way pi loads a skill),
  - a compaction entry's non-hook `details.readFiles`,
  - a recognized handoff prompt's `<read-files>` block (the only copy left after a read call was
    dropped); a user message that is not a handoff prompt is ignored.
  Deduped by file; a real `read` outranks a prompt/compaction file list and reads keep their
  recency; prompt/compaction lists are indexes with no activity order, so their lines are rendered in
  reverse block order and only fill the slots reads leave; capped at 8, name = parent directory. The
  priority matters at the cap: pi sorts its file indexes, so an alphabetically early active skill
  would otherwise be evicted by a prompt/compaction list (independent review I-1).
- `handoff/prompt.ts`: when the list is non-empty, the continuation gets a localized
  "skills and modes" section naming each skill and its `SKILL.md` path, plus a line telling the
  successor to re-read any skill that set an active mode. The closing now asks for the last request,
  the current state **and any skill or mode still in effect**, and says to re-read the `SKILL.md`
  first if its instructions were dropped.
- `handoff/run.ts`: collects the list from the **whole branch** (not only the dropped prefix) and
  passes it to `buildHandoffPrompt`.
- Docs and CHANGELOG updated; old closings stay in `HANDOFF_PROMPT_CLOSINGS`, so a v0.4.10 prompt
  is still recognized and replaced on replay. The list also carries the intermediate 0ca14ba
  restatement-only closing (en/zh), so a non-paused handoff written by that local build before
  v0.4.11 ships is recognized too.

## Verification

- `collectActiveSkills`: a `read` of `SKILL.md` is found; a normal file read is not; a duplicate is
  deduped and reads are most-recent-first; a compaction `readFiles` entry is found and a `fromHook`
  compaction is ignored; a prior continuation prompt's `<read-files>` is found; an ordinary user
  message quoting `<read-files>` is not; a draft-added list marker is stripped; a real read outranks
  a later prompt list; the 8-cap keeps the read plus the seven latest prompt entries; nine reads
  keep the eight latest and drop the oldest.
- `buildHandoffPrompt`: zh and en sections carry the name and path and the re-read instruction; no
  list means no section; both closings are recognized by `isHandoffPromptText`.
- `isHandoffPromptText` recognizes a legacy Chinese prompt, and the intermediate English/Chinese
  restatement-only closings; each fixture asserts the replacement actually changed the current
  prompt, so a future wording drift cannot make the check silently re-test the current prompt.
- Integration: the `runHandoff` pin branch includes a `read` of
  `/home/user/.agents/skills/grilling/SKILL.md`; the sent prompt names it under the zh section.
- Mutations (each applied to a copy, restored; `node tests/handoff-test.mjs`):
  - remove the section -> 4 FAIL (zh/en section, re-read line, integration);
  - stop passing `activeSkills` from `runHandoff` -> 1 FAIL (integration);
  - treat every read as a skill -> 1 FAIL (dedupe/detection);
  - remove the re-read phrase -> 1 FAIL;
  - remove the `fromHook` skip -> 1 FAIL;
  - remove the 8-cap -> 2 FAIL;
  - remove the source priority -> 1 FAIL (a read vs a later prompt list);
  - remove the list-marker strip -> 1 FAIL.
- Full suite: `node tests/run-all.mjs` -> `All 15 tests passed.`

## Residuals

- A skill read once for reference (not as a mode) is listed too; the section says "if one set an
  active mode", so the successor decides. Direction is prompt-level, not enforced.
- Detection relies on a `read` of `SKILL.md`, a compaction `readFiles`, or a prior handoff prompt.
  A skill injected by a command that leaves no read and no prior prompt is not detected.
- The cap is 8. Read-sourced entries are the newest reads; a prompt-only list keeps the last 8
  block lines (an index, not a recency order), so an alphabetically early mode with no surviving
  read evidence can still be evicted at hop 2.
- The successor may still ignore the instruction; the fix makes the mode visible and re-readable,
  it cannot force a model to follow it.
- A compaction inside the successor session drops the stored continuation prompt; only a real
  re-read by that successor keeps the skill in its `readFiles`, so a mode ignored at hop 1 is still
  lost at hop 2.
- A codemode script's `nestedCalls` reads are not scanned: that is a script-side file access, not
  the assistant loading a skill into its own context (the assistant-content scan matches
  `collectFileOps`; pi's own `extractFileOpsFromMessage` reads them for its file index).
- A `branch_summary` entry's `details.readFiles` describe the branch that was **left**, not the
  current branch, so they are not active-skill evidence; scanning them would list skills from an
  abandoned branch. `collectFileOps` excludes them for the same reason. Only `compaction` is
  scanned.
- A draft-mode handoff stores the user's edited text as the opening message; if the user appends
  an answer it fails `isHandoffPromptText` and contributes no skills at hop 2, so only a successor
  re-read survives that shape.
