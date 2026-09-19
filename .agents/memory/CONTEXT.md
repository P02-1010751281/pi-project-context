# Project Context

Last updated: 2026-09-19T06:04:20.446Z

## Summary

Restructured project documentation so README is a concise entry point and detailed architecture, configuration, and handoff material lives under docs/. Added readable plain-text and LaTeX formulas, validated links and formatting, and confirmed all 9 tests pass. Changes remain uncommitted.

## Key points

- Added docs/README.md, architecture.md, configuration.md, and handoff.md.
- README now contains only overview, installation, minimal configuration, verification, and documentation links.
- handoff documentation includes LaTeX with a plain-text fallback for unsupported Markdown renderers.
- git diff --check and documentation link/newline checks pass.
- node tests/run-all.mjs passes all 9 tests.

## Open tasks

- Review and commit the documentation and implementation changes.
- Complete installation, release, and real provider RPC verification when quota is available.

<!-- latest-session-title: Split detailed documentation into docs/ -->
