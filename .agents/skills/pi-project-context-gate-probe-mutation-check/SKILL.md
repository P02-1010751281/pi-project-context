---
name: pi-project-context-gate-probe-mutation-check
description: "Make each pi-project-context autolearn/gate test probe pin exactly one guard, then prove it with a mutation matrix plus a positive control, so a green test can no longer hide a dead gate."
---

# Gate-probe mutation check (pi-project-context)

## When to use

When a probe in `tests/` claims to cover a guard in `extensions/project-context/` but stays green when that guard is mutated to a no-op (this happened twice: the autolearn switch probe and the `archived.size === 0` gate), or when adding a new probe for one of the `autolearn.ts` gates.

## Steps

1. List every early-return condition in the module under test, e.g. `autolearn.ts`: `!config.autoLearn`, `archived.size === 0 && !force`, `!changed`, `!due`. A probe that is green with several of those open proves none of them.
2. Seed the fixture so **only the target gate** can fire. Autolearn template: a tmp project whose `.agents/memory/project-context.json` holds `{"autoLearn": true, "autolearnAt": 0}`, material newer than the interval, and — for the archived-gate probe — no session archive at all.
3. Drive a second pi instance with `pi.exec` rather than reusing the harness instance: `pi.exec` roots from its own cwd and does not share the harness' single-flight/throttle state, and its module cache is independent (`moduleCache: false`).
4. Count calls **cumulatively** (`learnCalls`, filtered by a prompt marker) instead of per-settle, so an earlier settle in the same run cannot absorb the probe.
5. Add a **positive control** in the same fixture: open the gate (e.g. drop in one archived session) and assert the model call now happens. Without it, "pass" may just mean the probe never ran.
6. Reset the shared counter right before the control (`emptyProjectCalls = 0`); a late call from the negative probe otherwise feeds the control and can mask a regression.
7. Run the mutation matrix by patching one gate to a constant at a time, running only the probe's test file, then reverting:
   - target gate -> the probe's assertion must be the **only** red;
   - unrelated gates (`autoLearn`, `changed`, `due`) -> green, i.e. no false red;
   - record the matrix verbatim in the issue fix-note.
8. Confirm stability and load: `node tests/autolearn-test.mjs` (expect 10/10) and `node tests/run-all.mjs` idle and under hog load (expect 9/9).

## Gotchas

- A probe that is green with its own gate forced false has zero detection power; that is the defect to fix, not a fixture annoyance.
- Test-only changes need no re-release: say so in the fix-note under `.codestable/issues/<...>/` and leave the commit to the owner's release flow (`test(scope): ...`).
- Fire-and-forget writes can race `rm(tmpdir)`, leaving `/tmp/pi-autolearn-*` dirs with only `INDEX.md` under load; reproducible only with mutated code, so record it as accepted.
- Non-trivial test changes still get one independent review round in the `/tmp` sandbox (see the sandboxed-independent-review skill) before reporting done.
