# Release evidence: v0.4.12

Released 2026-10-19. This patch closes the v0.4.11 review follow-ups. It is a new tag, not a
re-point.

## Reviewed revision and verdict

- Frozen revision: `bf22a8a` (`fix(handoff): zero replayed usage instead of deleting it`).
- Review chain: R3 on `0580b2d` and R4 on `31cfb64` returned CHANGES-REQUESTED for the replayed
  assistant shape; R5 on `bf22a8a` returned **PASSED** (0 blocking, 0 important), full suite 15/15,
  zero-write proof empty.
- R3 caught the `isContextOverflow` crash caused by deleting `usage` while keeping
  `stopReason: "stop"`. R4 caught the next shape violation: deleting `usage` also crashes pi's
  footer accumulator and post-compaction context accounting. R5 verified the final shape against
  the real installed pi 1.3.0 consumers: a fresh zeroed usage record, with `stopReason` and
  `rawStopReason` dropped.
- Post-PASS nits (not fixed, to keep the PASS on `bf22a8a`): a two-message freshness pin for the
  zeroed record; the A-2 stale-usage fixture lacks a real `cost` field; `docs/handoff.md` lists only
  the English marker literal while claiming zh/en.

## What changed

- A-2: replayed assistant messages get a fresh zeroed usage record and no stop verdict, so pi's
  overflow classifier, footer totals and context accounting do not inherit the predecessor prompt.
- A-1: a synchronous `sendUserMessage` throw in `maybeTrigger` arms the failure backoff; docs scope
  the async runtime gap.
- B-1: cap receipts say "target", and a tiny cap names the omission marker instead of promising a
  hard token cap; the status line says `toolResult target`.
- B-2: the trim marker follows the resolved handoff language (zh/en).
- B-3: tests cover two oversized results, the measured-rate conversion (rate ~2.2, would fail with a
  hard-coded 4), the null-usage path and the budget-recent receipt.

## Tag, branch and remotes

- Tag object: `e09a25420d0991399079805b5cc6a2f240736e2d`
- Peeled commit: `bf22a8a2967b2cb62f594c976adb8117f912cb23`
- Branch `master` was pushed through the review/release evidence commits (starting `2fb42f5`).
- Both `git ls-remote` checks returned the same tag object and peeled commit:
  - forgejo `ssh://forgejo@git.lentech.site/C02-1010751281/pi-project-context.git`
  - github `ssh://git@ssh.github.com:443/P02-1010751281/pi-project-context.git`

## Pin and installed clone

- Pin commit in `~/.pi`: `2b6fec8` (`chore: pin pi-project-context v0.4.12`); `agent/settings.json`
  and `README.md` both name `v0.4.12`. Settings backup before the edit:
  `/tmp/settings.json.before-v0.4.12-*`.
- `pi update --extensions` fetched `v0.4.12` and checked out `bf22a8a`; the installed clone is
  `/home/user/.pi/agent/git/git.lentech.site/C02-1010751281/pi-project-context`.
- Installed verification: `HEAD = bf22a8a`, `v0.4.12^{commit} = bf22a8a`, `git describe` =
  `v0.4.12`, working tree clean. Markers `replayZeroUsage`, `toolResultCharBudget`,
  `toolResult target` are present.
- Installed clone test: `node tests/handoff-test.mjs` → `handoff: all checks passed.`

## Settings-installed probe

Throwaway project `/tmp/pc-release-probe-v0411-rpc`, default settings (no `-ne`/`-e`), default
`deepseek-flash` route, RPC session:

```
PROBE_OK
info: Features: archive=on  memory=on  autolearn=on  handoff=on
info: Handoff: tool result text is carried verbatim (no cap).
FILES [".gitignore","project-context.json","session-logs"]
```

`errors.log` had no lines from the probe. The provider/MCP refresh warnings in the transcript are
environmental, not extension errors.

## Restart note

The pi process that produced this session started before the v0.4.12 pin update, so it still runs
the old code. A restart is required to load v0.4.12; the installed clone is already at the tag.
