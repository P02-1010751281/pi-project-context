# Release v0.1.12 evidence

## Scope

Bundles the unreleased post-v0.1.11 work:

- auxiliary-call policy + damping and `maxMemoryChars` hardening (`d02e869`…`fd0cc9e`);
- session-log append-duplication hardening (`1b01070`…`eef592c`);
- S1/S3 memory fixed schema + pointerization (`a3f8370`…`0b81099`);
- autolearn prompt real body/description bounds (`024b3db`);
- S2 CONTEXT.md fixed schema + per-section budgets + truncation marker (`6e3b371`), plus the S2 design and six review rounds (`415a3ae`).

## Release

| Item | Value |
|---|---|
| Release commit (HEAD) | `cd82b3308b697d675a4bbb6575ebec97515f0669` |
| Annotated tag | `v0.1.12` (tag object `c60fa15807e22b0c22a52d66476c3f112f62fb57`) |
| Peeled commit | `cd82b33` |
| Forgejo `refs/tags/v0.1.12` | `c60fa15…` |
| GitHub `refs/tags/v0.1.12` | `c60fa15…` |
| `pi-config` pin bump | `9472a43` (`pi-project-context@v0.1.12`, settings backed up to `/tmp/settings.json.before-v0.1.12-1790824108`) |
| Installed clone HEAD | `cd82b3308b697d675a4bbb6575ebec97515f0669` (matches the peeled tag), clean tree |

## Verification

- `node tests/run-all.mjs` → **All 13 tests passed** (incl. `context-schema-test.mjs`).
- `git diff --check` clean at the release commit.
- Installed-clone marker grep: `contextTruncationDropped` / `CONTEXT_SECTIONS` present in `extensions/project-context/memory/{context-schema.ts,report.ts}`.
- Installed clone: `node tests/context-schema-test.mjs` → ALL OK; `node tests/handoff-test.mjs` → handoff: all checks passed.
- S2 independent review: six read-only rounds (three 审 / three 校), all `VERDICT: PASSED`, each with an empty `git status`/`stat` baseline diff against a byte-identical `/tmp` sandbox. Transcripts: `auxiliary-call-noise-and-memory-cap-s2-review-round{1..6}-{prompt,independent}.txt`.

## Real settings-installed probe

Throwaway project `/tmp/pc-v0112-probe-1X2T`, default settings (no `-ne`/`-e`):

```
pi -p "This project's test command is 'node tests/run-all.mjs'. Note that durably, then stop."
```

Artifacts written under `.agents/memory/`: `MEMORY.md` (canonical `# Project Memory` → `## Project`), `CONTEXT.md`
(fixed `## Summary` / `## Key points` / `## Open tasks`), `memory.jsonl`, a `MEMORY.md.memory-backup-*`,
`project-context.json`, `session-logs/<id>/{session.jsonl,session.md}` and `session-logs/INDEX.md`.
`errors.log` was not created. Route: `commandcode-c02-1010751281/deepseek/deepseek-v4.1-flash`.

## Restart required

`pi update --extensions` replaced the on-disk clone, but already-running processes keep the code they
loaded. As of this release two `pi` processes still run pre-v0.1.12 code and must be relaunched by the
owner to pick it up:

- PID `262684` (cwd `Projects/pi-project-context`, started 2026-09-30 17:19) — the session that produced
  this release;
- PID `324402` (cwd `Projects/UniField`, started 2026-09-30 19:15).

They were deliberately not signalled: killing them would end the owner's sessions without relaunching.
