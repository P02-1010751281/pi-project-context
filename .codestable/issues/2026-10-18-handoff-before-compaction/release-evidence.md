# Release evidence: v0.4.11

Released 2026-10-19 (Asia/Shanghai). This release carries the pre-compaction handoff guard, the
opt-in tool-result cap, the active-skill/file-index work, the successor restatement and the
threshold re-anchor allowance. It is a new tag, not a re-point.

## Reviewed revision and verdict

- Frozen revision: `1a71b73` (`fix(handoff): warn that the toolResult cap can force a re-read`).
- Review: R2 in `review-report.md`, transcript `review-round2-release-independent.txt`.
- **VERDICT: PASSED** (0 blocking, 0 important); full suite 15/15 in the sandbox; zero-write proof
  (sandbox status and file-stat diffs empty). The `willRetry` correction is verified against
  installed pi 1.3.0 and mutation-pinned; removing it gives 1 FAIL.
- The post-PASS review nits and the pre-existing residual are deliberately **not** fixed after the
  PASS: A-1 failure-backoff catch, B-1 tiny-cap receipt wording, B-2 English-only marker, B-3 test
  coverage; A-2 (replayed usage can trip `_prepareRun` compaction when `recent` > pi's 20k keep).
  A code change would invalidate this PASS, so they are follow-ups, not tag rewrites.

## Tag, branch and remotes

- Tag object: `4c89b501937e98723ae76b37e7ae430e8101eed9`
- Peeled commit: `1a71b73d3efb9fb11e9af40466ef6f758b7ce823`
- The annotated tag was created on `1a71b73`; the review/release evidence commits follow it.
- Branch `master` was pushed to both URLs through `a575509` (review evidence).
- Both `git ls-remote` checks returned the same tag object and peeled commit:
  - forgejo `ssh://forgejo@git.lentech.site/C02-1010751281/pi-project-context.git`
  - github `ssh://git@ssh.github.com:443/P02-1010751281/pi-project-context.git`

## Pin and installed clone

- Pin commit in `~/.pi`: `783fb47` (`chore: pin pi-project-context v0.4.11`); `agent/settings.json`
  and `README.md` both name `v0.4.11`. The settings backup before the edit is
  `/tmp/settings.json.before-v0.4.11-*`.
- `pi update --extensions` fetched `v0.4.11` and checked out `1a71b73`; the installed clone is
  `/home/user/.pi/agent/git/git.lentech.site/C02-1010751281/pi-project-context`.
- Installed verification: `HEAD = 1a71b73`, `v0.4.11^{commit} = 1a71b73`, `git describe` =
  `v0.4.11`, working tree clean. `handoffBudgetToolResultTokens` is present in
  `extensions/project-context/shared/config.ts` and `handoff/run.ts`.
- Installed clone test: `node tests/handoff-test.mjs` → `handoff: all checks passed.`

## Settings-installed probe

Throwaway project `/tmp/pc-release-probe-v0411-rpc`, default settings (no `-ne`/`-e`), default
`deepseek-flash` route, RPC session:

```
PROBE_OK
info: Features: archive=on  memory=on  autolearn=on  handoff=on
Config: /tmp/pc-release-probe-v0411-rpc/.agents/memory/project-context.json
info: Handoff: tool result text is carried verbatim (no cap).
FILES [".gitignore","project-context.json","session-logs"]
```

The generated config contains `"handoffBudgetToolResultTokens": 0` (the default), and the command
path `/handoff budget toolresult off` answers correctly. `errors.log` had no lines from the probe.
The provider/MCP refresh warnings in the transcript are environmental (custom-provider discovery and
the `idea` MCP server), not extension errors.

## Restart note

The pi process that produced this session started before the pin update, so it still runs the old
code. A restart is required to load v0.4.11; the installed clone is already at the tag.
