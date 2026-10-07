---
name: pi-project-context-headless-runs
description: "Run headless pi against this extension: probe model routes for review or helper runs, and validate handoff end-to-end over RPC."
---

<!-- autolearn-generated: this skill may be superseded by a later autolearn pass -->

# Headless pi runs (pi-project-context)

## When to use

- Before launching a sandboxed independent-review round (`pi -p` over a read-only `/tmp` copy) or any headless helper call that must reach a custom provider.
- Whenever a headless run reports `Model ... not found`, `Unknown provider "<id>"`, `402 Insufficient Balance`, an invalidated OAuth token, or hangs with zero output for many minutes.
- After changing handoff code (`extensions/project-context/handoff/`), compaction-prompt handling, `handoffBudgetRecentTokens`/`handoffLang` logic, or memory write paths, to prove the feature works end-to-end: unit tests in `tests/*.mjs` do not exercise pi's real prompt/turn alignment.

## Part 1 — Probe a model route first

### Trap: `--no-extensions` unregisters custom providers

Providers such as `commandcode` are **registered by an extension**, not by pi core. A probe that passes the blanket `--no-extensions` drops the registration before model-id resolution, so every id fails with `Model not found` / `Unknown provider "commandcode"` — even the model the live session itself is using. That false signal produced a ~20-minute zero-output review round and a wrong "the balance is exhausted" diagnosis before it was caught.

Disable only the extension under test, keeping provider registration:

```bash
pi -p --no-project-context \
  --provider commandcode \
  --model commandcode/deepseek/deepseek-v4.1-flash-fast \
  "Reply with exactly OK."
```

Rule of thumb: prefer the narrowest disable flag (`--no-project-context`); never `--no-extensions` when the goal is to exercise a provider.

### Probe one route cheaply before starting a round

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

### Do not record a failed probe as a review round

An empty or timed-out transcript is a provider failure, not a clean review. Per the project invariant, paid-route failures must never be recorded as successful validation: leave the round unfiled, re-probe, and only then restart the round.

### Enumerate the routes before calling a round blocked

A single `429` from `commandcode/deepseek/deepseek-v4.1-flash-fast` parked a whole review round for a day (2026-10-03) because the operator trusted a note saying this machine had **one** usable route. It had four:

```bash
pi --list-models | awk 'NR>1{print $1}' | sort | uniq -c          # which providers exist here
pi auth check --provider deepseek --json                           # core providers only — see trap
pi -p --no-project-context --model "deepseek/deepseek-v4-pro" "Reply with exactly OK."   # cheap real probe
```

- **Trap: `pi auth check` lies about extension-registered providers.** For `commandcode` and `scnet` (both registered by extensions) it answers `{"status":"not_ready","reason":"provider_not_found"}` even when the route answers fine. It is only meaningful for providers pi core knows: measured `deepseek` → `ready` (api_key), `openai-codex` → `invalid_state`.
- Measured 2026-10-03 on this host: `commandcode/deepseek/deepseek-v4.1-flash-fast` → `429` weekly (reset `2026-10-08T08:37:39Z`); every probed `scnet/*` model → `403 … does not support Token Plan` (the relay's plan, not the route — but note `scnet/DeepSeek-V4.1-Flash-Event` was serving the live session, so the relay itself was up); `deepseek/deepseek-flash` and `deepseek/deepseek-v4-pro` → `OK`; `openai-codex/*` → credentials invalid.
- **Record the serving route in the round's prompt and transcript.** When a round runs on a different model than the protocol's original one, the round table must be able to say which model judged what: rounds R1–R8 of the external-edit issue ran on `commandcode/deepseek/deepseek-v4.1-flash-fast`; R9 and code-review round 1 ran on `deepseek/deepseek-v4-pro` because the former was `429` until 2026-10-08.

## Part 2 — Validate handoff end-to-end over RPC

### Preconditions

- Extension entry point: `extensions/project-context/index.ts` in the repo root.
- Use a throwaway project directory (e.g. `mktemp -d`) so `.agents/memory/` artifacts do not pollute the repo.
- Old `pi` processes must be exited first; a stale process holding `MEMORY.md.lock` will stall writes.

### Procedure

1. Create a sandbox project and drive pi in RPC mode with extensions/skills/prompt-templates disabled except the extension under test:

   ```bash
   sandbox=$(mktemp -d)
   cd "$sandbox"
   pi --mode rpc -ne -ns -np --thinking off \
     -e <repo>/extensions/project-context/index.ts -- <prompt-file-or-stdin>
   ```

   `-ne` = `--no-extensions`, `-ns` = `--no-skills`, `-np` = `--no-prompt-templates`, so only the `-e` extension loads;
   `--thinking off` keeps output deterministic.
   **Flag trap (found 2026-10-05, after a whole invalid round): `-nt` is `--no-tools`, not prompt templates.**
   A run that passes `-nt` has no `read`/`bash` at all, so any test of "does the agent consult a file" measures nothing;
   use `--tools read,grep,find,ls` when the run needs tools, and keep `-nt` only when it must not act.

2. Drive the session far enough to cross the handoff threshold (or temporarily lower `handoffBudgetRecentTokens` in `.agents/memory/project-context.json` in the sandbox) so `runHandoff` actually fires.

3. Inspect the artifacts in `$sandbox/.agents/memory/`:
   - `HANDOFF.md` — check headers/language match the configured `handoffLang` (`auto`|`zh`|`en`), and that old handoff prompts appear as the one-line `[handoff prompt omitted]` marker rather than being deleted.
   - `MEMORY.md` + `memory.jsonl` — confirm a `replace` record was appended, not an overwrite outside the journal.
   - `memory-log-*.jsonl` / `MEMORY.md.memory-backup-*` — confirm backups were taken when a write occurred.
   - `errors.log` — confirm no unparseable-model-reply or lock errors.

4. For language resolution, send a short Chinese user turn and repeat: the handoff doc headings should render in Chinese when `handoffLang: auto` resolves to `zh`.

> **v0.4.x 更新（2026-10-05）**：键名已从 `handoffKeepTokens` / `handoffLanguage` 更到
> `handoffBudgetRecentTokens` / `handoffLang`（正文已替换）；交接自 v0.4.1 起不生成摘要，HANDOFF.md 只有机械头部（Created/Project/Log/Index）与文件清单，没有摘要散文。

### Gotchas

- Replay blocks must not open with `assistant(toolCall)` — Anthropic/Gemini routes reject it with 400. Verify the omitted-marker substitution preserved `findCutPoint` slicing and toolCall/toolResult pairing.
- `session_shutdown` runs a **model-free flush** (since 2026-10-06, decision 1): it folds a hand-edited `MEMORY.md` into the journal, republishes the journal's fold only when the render is missing or not newer than the journal (a newer hand edit is journaled and its bytes left alone), and writes nothing when the file already carries the fold. Do not expect a consolidation pass or a `CONTEXT.md` write at exit. A republish does write a `MEMORY.md.memory-backup-*` first, and while the flush itself skips a project with no journal (no memory state, no memory lock), the archive layer still takes its own lock and makes `.agents/memory/`.
- Known pre-existing gap: when the whole session fits in `handoffBudgetRecentTokens`, `runHandoff` returns before any notify and the user sees a silent no-op. Do not mistake that for a failure of your change.
- `--mode json` does **not** emit the system prompt, so an injected-memory experiment cannot be verified from the transcript;
  infer it from the answer's shape (a fact from a kept section present, a fact from a dropped section absent).
- The consolidation pass runs at `agent_settled` and writes `CONTEXT.md` + `session-logs/` into the sandbox, so one sandbox per
  variant is mandatory: in the 2026-10-05 progressive-disclosure probe a run's own hallucination came back as CONTEXT.md bait.
- The keep budget is an upper bound; do not back-fill old prompts to "use" the budget — refilling breaks turn alignment.
