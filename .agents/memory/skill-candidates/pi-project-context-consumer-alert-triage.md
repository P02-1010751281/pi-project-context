---
name: pi-project-context-consumer-alert-triage
description: "Triage recurring pi-project-context alerts in consumer projects: errors.log floods, empty auxiliary provider/model falling back to the session model, and memory renders sitting at maxMemoryChars, then apply cooldown/reroute/cap fixes."
candidate: true
---

<!-- evidence: 01a0f19c-40e0-75f6-9452-fa8df68590f0, 01a0b4de-d116-75fb-b815-6d0fc812cdcb — Reusable triage playbook: the alert-storm session gives the full errors.log -> empty-route -> cooldown procedure with concrete paths, and the memory-cap session independently exercises the same errors.log/maxMemoryChars-vs-render check; stored for confirmation because the second session supports only that part. -->

## When to use
A project consuming pi-project-context (e.g. the sibling repos next to this one) repeatedly toasts, floods `errors.log`, or shows false "hit the cap" warnings around consolidation/autolearn.

## Steps
1. Find the alert source per project:
   `for p in ../*/; do echo "== $p"; wc -l "$p/.agents/memory/errors.log"; tail -30 "$p/.agents/memory/errors.log"; done`
   Count repeats: `sort "$p/.agents/memory/errors.log" | uniq -c | sort -rn | head`.
2. Read the auxiliary route: `cat .agents/memory/project-context.json`. Empty `provider`/`model` means consolidation/autolearn use the session model (Codex), so a provider quota/auth outage hits both on every `agent_settled`.
3. Check cap pressure: `wc -c .agents/memory/MEMORY.md` vs `maxMemoryChars`. A render at/near the cap truncates replies, producing JSON shape failures and false cap warnings.
4. Classify: `auth`/`quota`/`transient` are provider-level -> per-project/per-scope cooldown, backoff, session disable after 5 consecutive failures; `shape` (JSON shape/truncation) must NOT cool the route down. Explicit commands like `/autolearn` still run.
5. List live consumers: `ps -eo pid,etime,cmd | grep -i pi`. Running processes use the installed v0.1.11+ clone; working-tree fixes need rebuild/reinstall + restart.
6. Fix in order: set an explicit auxiliary provider/model, raise `maxMemoryChars` for the noisy project (owner confirmation required), reduce duplicate `errors.log` lines, restart the PIDs.

## Gotchas
- A copied `_[memory truncated …]_` marker must not count as a cap event (`exceedsMemoryCap` strips it first).
- Failed paid routes (deepseek 402, scnet 429, commandcode credits) are never successful validation.
- Commit render changes separately as `docs(memory): refresh the memory render`.
