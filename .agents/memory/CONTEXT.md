# Project Context

Last updated: 2026-09-19T06:42:00.000Z

## Summary

Released `v0.1.8` with memory-cap, adaptive-handoff, model-restore, documentation, and transient consolidation-JSON retry fixes. The tagged package is installed and passed a settings-loaded RPC probe.

## Key points

- `README.md` is a concise entry point; detailed material lives under `docs/`.
- `docs/handoff.md` contains plain-text formulas plus LaTeX equivalents and renderer fallback guidance.
- A malformed consolidation reply gets one bounded retry; persistent failure remains fail-closed with raw-reply diagnostics.
- Full test suite passes 9/9; `master` and `v0.1.8` are pushed to both remotes.
- `~/.pi` pins `pi-project-context@v0.1.8`; installed package HEAD is the tagged fix commit.

## Open tasks

- None for the `v0.1.8` fix and release.

<!-- latest-session-title: Release v0.1.8 and harden consolidation retries -->
