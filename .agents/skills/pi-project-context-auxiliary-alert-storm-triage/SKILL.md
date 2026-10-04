---
name: pi-project-context-auxiliary-alert-storm-triage
description: "Triage repeating pi-project-context toasts and a fast-growing errors.log, then verify the fix. Use during alert storms."
---

## When to use
A project consuming pi-project-context starts toasting repeatedly ("hit the cap", quota/auth/transient toasts) or its `.agents/memory/errors.log` grows to hundreds of lines / ~100 KB. Usual root cause: auxiliary consolidation/autolearn model calls failing on every `agent_settled` (retry storm), or a copied `_[memory truncated …]_` marker faking a cap event on a short reply. For pure memory-dir repair (poisoned JSON, dropped tails) use `pi-project-context-memory-recovery` instead.

## Steps
1. Inventory consumers and live sessions.
   - `ps -eo pid,ppid,etime,cmd | grep -iE "pi|omp" | grep -v grep` — note the PIDs of the affected projects.
   - Look in the Projects dir for the consumer repos (e.g. `UniField`, `Quantum_Matrix` next to `pi-project-context`).
2. Size and read the noise per project.
   - `wc -l .agents/memory/errors.log; ls -l .agents/memory/errors.log`
   - `tail -60 .agents/memory/errors.log` — spot repeated identical headlines and the failure text (usage limit, 402 insufficient balance, 403 auth, 429 quota, connection errors, JSON truncation).
3. Classify the failure before touching anything: provider-level (auth/quota/transient) vs `shape` (JSON shape/truncation). Only provider-level failures may trigger route cooldown; `shape` must not, or a healthy route gets wrongly disabled.
4. Check route and cap pressure.
   - `.agents/memory/project-context.json`: empty `provider`/`model` means the session model is used, so a Codex quota/auth failure hits consolidation and autolearn directly.
   - Compare `maxMemoryChars` with the render size: `wc -c .agents/memory/MEMORY.md` (a cap at or near the render size guarantees repeated cap hits).
5. Pin the code the live sessions actually run: running PIDs execute the installed clone under `~/.pi/agent/git/<host>/<...>/pi-project-context/`, not the working tree. Locally committed fixes are invisible until rebuild/reinstall + restart of those PIDs — never report an unreleased fix as curing a live alert.
6. Fix and verify in the source repo `/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context`.
   - Cooldown/backoff and failure classes: `extensions/project-context/shared/call-policy.ts` (wired in `memory/pass.ts`, `memory/report.ts`, `autolearn/pass.ts`).
   - Log noise dedupe: `extensions/project-context/shared/error-log.ts`.
   - Cap/truncation handling: `memory/document.ts`, `memory/prompt.ts`.
   - Run `node tests/run-all.mjs` and `git diff --check`; threshold/cap tests pin exact strings, so update them with any wording change.
7. Cap-loss sanity checks: clipping now keeps head 60% / tail 40% by whole lines (tail-only clipping dropped the last sections); confirm a copied truncation marker does not register as a cap event, and that the cap warning is once per project per process (a restart resets it).

## Gotchas
- Paid routes observed as 402 insufficient balance / 429 quota / insufficient credits must never be reported as successful validation.
- `shape` failures are excluded from route cooldown by design — don't treat "no cooldown after a JSON error" as a bug.
- Live-project ops (editing `project-context.json`, raising `maxMemoryChars`, reconciling `MEMORY.md`/journal divergence, restarting PIDs) change the user's running projects: confirm before doing them.
- Keep the deployment boundary in mind when reporting: source-repo green + installed clone stale + PID not restarted = alert still firing.
