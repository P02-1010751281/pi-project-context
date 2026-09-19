---
name: pi-project-context-release-tag-and-pin-sync
description: "Cut or re-point a pi-project-context release (annotated tag, dual-remote push, pi-config pin bump), verify the installed clone carries the tagged code, and run a real settings-installed probe."
---

# When to use
After a change set is complete (full `node tests/run-all.mjs` green, `git diff --check` clean, review closed) and you are releasing vX.Y.Z; when re-pointing an existing tag on explicit owner instruction; or when confirming that an installed version matches its tag.

## Release steps
1. Run the full suite from the project root: `node tests/run-all.mjs` and `git diff --check`.
2. Commit in separate slices: implementation, documentation, memory render (`docs(memory): refresh the memory render`), and `.codestable/` evidence (commit it when tracked docs link to it, as the README/docs index do). Leave intentionally untracked files alone.
3. Annotated tag: `git tag -a vX.Y.Z -m "<summary>"`, then record the peeled commit: `git rev-parse vX.Y.Z^{commit}`.
4. Push branch + tag to every remote (`git push origin master vX.Y.Z` pushes both configured URLs). Transient connection failures are common — retry until each remote confirms, then verify each with `git ls-remote --tags <remote> vX.Y.Z` (annotated tags show two hashes: tag object and peeled commit).
5. Bump the pin in the separate `~/.pi` repo (`agent/settings.json` + `README.md`: `pi-project-context@vX.Y.Z`), backing the settings file up to `/tmp` first (e.g. `cp agent/settings.json /tmp/settings.json.before-vX.Y.Z-<ts>`), commit + push there, then run `pi update --extensions`.
6. Verify the installed clone, not just the version label: its `HEAD` must equal the peeled tag commit, its working tree must be clean, grep the installed tree for a marker string introduced by the release (e.g. `KNEE_ASYMPTOTE_TOKENS`, `SPLIT_TURN_MARKER`), and run the installed clone's own `node tests/handoff-test.mjs`.
7. Run a real settings-installed probe in a throwaway project (default settings, no `-ne`/`-e`) and inspect the generated `.agents/memory/` artifacts; provider quota/credit failures (402/429) must not be reported as successful validation.
8. Record release evidence under `.codestable/` (commit/tag/pin/installed HEAD/probe transcript) and, if the memory render changed, commit it separately. Post-release evidence is appended as new commits — never rewrite a released tag.

## Re-pointing an existing tag
`git tag -f -a vX.Y.Z -m "..."` creates a new tag object, so every remote needs a force push (`git push --force <remote> vX.Y.Z`). Only on explicit owner instruction; docs-only deltas are safe, but if code moved treat it as a new release.

## Gotchas
- A version label in `pi list` proves nothing: check the installed `HEAD` and a code marker, since the pin and the checkout can drift after a re-tag.
- Already-running pi processes keep the old code (e.g. an old process re-truncating `MEMORY.md` with the previous cap); say explicitly in the report that a restart is required to load the release.
- `.codestable/` evidence may be intentionally untracked mid-issue; commit it only once the docs that reference it are being released.
