---
name: pi-project-context-handoff-cost-quality-probe
description: "Measure a handoff payload knob's (budget, toolResult cap) cost and quality before claiming a saving: fixture, headless RPC arms, priced JSONL."
---

<!-- autolearn-generated: this skill may be superseded by a later autolearn pass -->

# When to use

Before claiming a handoff payload knob saves money or keeps quality — `handoffBudgetRecentTokens` or the toolResult cap — or when a review finding asks for a new cache/compaction mechanism on the strength of a cacheRead drop. Measure first, then land the verdict in the audit. For where the injected prefix comes from and how cache invalidation works, use `pi-project-context-prefix-cache-analysis` instead; this skill is the cost/quality side.

## Build a disposable fixture

- Create a run root under `/tmp/pc-<label>-<timestamp>/` with `.agents/memory/project-context.json` holding the arm's config, e.g. `{"handoffEnabled": true, "handoffBudgetRecentTokens": <value>, "handoffBudgetSummaryTokens": 64000, "memoryEnabled": false, "autolearnEnabled": false, "handoffLang": "en", "handoffMode": "send", "handoffGuard": "wait", "handoffThresholdAuto": true}`.
- Turn `memoryEnabled` and `autolearnEnabled` off so no render or learnt write moves between arms (the old `autoConsolidate`/`autoLearn` names are legacy aliases only).
- Seed several filler files of a few thousand lines each so the predecessor produces real tool results and reaches the threshold on content, not because the fixture is tiny.
- Plant a checkable fact in one file (a line such as `SECRET_CODE=<unique token>` deep in `target.txt`), read that file last in the predecessor, and ask the successor for the value. Correctness of the answer, not token counts, is the quality signal.

## Drive pi headless over RPC

- Spawn the extension from the repo, not the installed pin, with cwd = the run root:
  `pi --mode rpc -ne -np --tools read --thinking off [-ns] --provider <route> --model <model> --session-dir <root>/sessions -e <repo>/extensions/project-context/index.ts`
- `-ne` / `-np` keep other extensions and templates out of the measurement; `-ns` drops skills when the arm must not carry them.
- Send the predecessor turns, the handoff command, wait for the successor session id, then send the question. Keep route, model and thinking identical across arms or the comparison is void.

## Read the numbers

- Take only the **successor's own** assistant calls out of `sessions/<id>.jsonl`. The successor file opens with replayed predecessor messages that still carry old usage; summing the whole file reports the predecessor's window as if the successor paid it.
- Price every call from the model's registered input / cacheRead / output rates — read them from the pi install's model registry under `~/.pi/agent/install/releases/<version>/node_modules/@earendil-works/pi-coding-agent/dist/`, never from a rule of thumb.
- Report first-call and whole-successor totals in separate columns, plus predecessor+successor.
- Sanity check: the successor's first call should carry cacheRead close to the static system block alone; a much larger value means replay bought a hit and the arm is not comparable.

## Arms worth running

- Knob off vs on; for `handoffBudgetRecentTokens` use 0 / a small / a mid / a large value. A configured budget is an **upper bound** — the cut lands on a turn boundary, so actual carried content is smaller and varies with fixture shape.
- Quality: ask the same question several times per arm and count correct answers plus re-reads (tool calls that pull `target.txt` or the predecessor session log back in).
- Recovery path: delete `target.txt` between the handoff and the successor's turn. A correct answer then proves the trimmed-section marker's pointer into the predecessor session log works, and the tool-text volume shows what that recovery costs.
- Control: run the empty/cold variant (no replay) so a first-call value can be attributed to the cut point rather than to replay order.
- Compaction baseline: compare against a same-size compaction of the same conversation; compare miss counts, never absolute cacheRead.

## What the numbers mean (state as rules, not values)

- Carried tail costs roughly linearly in first-call input; a cap lowers that number in proportion to what it removes.
- A cap is not a total-cost lever: a successor that needs the trimmed content must re-read the file or the session log, and one re-read of a long log can outweigh the whole saving. Keep the cap off by default and say so in the receipt and `docs/handoff.md`.
- Lost cacheRead is not lost money on its own — compare `total` too, because the successor context can be much smaller.
- Outside implementations surveyed for this question do not restore the old conversation prefix; the survey lives in the audit, so cite it instead of re-surveying.
- Repeat before concluding: a single sample with an unexpected first-call value is cold noise until reproduced, and any fixture-level result is not a mechanism proof.

## Write it down

- Append the tables and the sample counts to the existing handoff field-run audit under `.codestable/audits/` rather than starting a second audit.
- Fix receipt and doc wording in a follow-up commit so the promise matches the measured verdict; run `node tests/run-all.mjs` for a knob/behaviour change.
- Record only the shape in MEMORY.md, `docs/` and skills ("first-call input scales with the carried tail", "a cap can raise total cost"); never the run's token counts, prices or cost totals.
