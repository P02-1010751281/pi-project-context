---
name: pi-project-context-headless-route-probe
description: "Probe pi model routes for pi-project-context headless/independent-review runs without disabling extension-registered providers like commandcode, and read provider failures correctly."
---

# Headless model-route probing for pi-project-context

## When to use
- Before launching a sandboxed independent-review round (`pi -p` over a read-only `/tmp` copy) or any headless helper call that must reach a custom provider.
- Whenever a headless run reports `Model ... not found`, `Unknown provider "<id>"`, `402 Insufficient Balance`, an invalidated OAuth token, or hangs with zero output for many minutes.

## Trap: `--no-extensions` unregisters custom providers
Providers such as `commandcode` are **registered by an extension**, not by pi core. A probe that passes the blanket `--no-extensions` drops the registration before model-id resolution, so every id fails with `Model not found` / `Unknown provider "commandcode"` — even the model the live session itself is using. That false signal produced a ~20-minute zero-output review round and a wrong "the balance is exhausted" diagnosis before it was caught.

Disable only the extension under test, keeping provider registration:
```bash
pi -p --no-project-context \
  --provider commandcode \
  --model commandcode/deepseek/deepseek-v4.1-flash-fast \
  "Reply with exactly OK."
```
Rule of thumb: prefer the narrowest disable flag (`--no-project-context`); never `--no-extensions` when the goal is to exercise a provider.

## Probe one route cheaply before starting a round
Do not discover an unusable route only after a round times out. Run the one-line probe first and read the error:

| Error | Meaning / next action |
|---|---|
| `402 Insufficient Balance` | provider account out of credit; top up or switch route |
| `invalidated oauth token` / 401 | re-authenticate that provider |
| `403 MODEL_NOT_IN_PLAN` | plan gate on the account; pick another model id |
| `429 … weekly usage limit … resets at <time>` | plan exhausted until the stated reset; **switch route** (below) instead of parking the round |
| `403 … does not support Token Plan` | per-**model** plan gate on a relay/aggregator: other models on the same relay may still work, so probe a few before writing the route off |
| `Model ... not found` | if `--no-extensions` was passed, suspect the flag first; otherwise the id is not resolvable in a fresh process even when `--list-models` shows it |
| `Unknown provider "<name>"` | the provider's registering extension is not loaded |

## Do not record a failed probe as a review round
An empty or timed-out transcript is a provider failure, not a clean review. Per the project invariant, paid-route failures must never be recorded as successful validation: leave the round unfiled, re-probe, and only then restart the round.

## Enumerate the routes before calling a round blocked

A single `429` from `commandcode/deepseek/deepseek-v4.1-flash-fast` parked a whole review round for a day (2026-10-03) because the operator trusted a note saying this machine had **one** usable route. It had four:

```bash
pi --list-models | awk 'NR>1{print $1}' | sort | uniq -c          # which providers exist here
pi auth check --provider deepseek --json                           # core providers only — see trap
pi -p --no-project-context --model "deepseek/deepseek-v4-pro" "Reply with exactly OK."   # cheap real probe
```

- **Trap: `pi auth check` lies about extension-registered providers.** For `commandcode` and `scnet` (both registered by extensions) it answers `{"status":"not_ready","reason":"provider_not_found"}` even when the route answers fine. It is only meaningful for providers pi core knows: measured `deepseek` → `ready` (api_key), `openai-codex` → `invalid_state`.
- Measured 2026-10-03 on this host: `commandcode/deepseek/deepseek-v4.1-flash-fast` → `429` weekly (reset `2026-10-08T08:37:39Z`); every probed `scnet/*` model → `403 … does not support Token Plan` (the relay's plan, not the route — but note `scnet/DeepSeek-V4.1-Flash-Event` was serving the live session, so the relay itself was up); `deepseek/deepseek-flash` and `deepseek/deepseek-v4-pro` → `OK`; `openai-codex/*` → credentials invalid.
- **Record the serving route in the round's prompt and transcript.** When a round runs on a different model than the protocol's original one, the round table must be able to say which model judged what: rounds R1–R8 of the external-edit issue ran on `commandcode/deepseek/deepseek-v4.1-flash-fast`; R9 and code-review round 1 ran on `deepseek/deepseek-v4-pro` because the former was `429` until 2026-10-08.
