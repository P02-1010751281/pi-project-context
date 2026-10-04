---
name: pi-project-context-independent-review
description: "Run independent review rounds for this repo: frozen revision in a byte-identical /tmp sandbox, read-only with zero-write proof, budgeted and closed with a stop rule."
---

# Independent review rounds (pi-project-context)

**When to use**: an independent (lane A) review of uncommitted changes or of a frozen design revision in this repo is required — any CodeStable review round recorded under `.codestable/issues/<date>-<slug>/` — and the reviewer must not write to the working tree; or you are running per-round reviews of a design doc and need to keep the rounds finite, classify what a round found, and know when the next round stops paying. The owner expects a real second `pi` process for this, not a self-review downgrade. Applies to the current external-edit issue family (`.codestable/issues/2026-10-03-external-edit-adoption-overwritten/`) and to any future design-heavy issue.

## Part 1 — Sandbox mechanics

1. Byte-identical sandbox (never review or edit the live tree in place):
```bash
ROOT="$(git rev-parse --show-toplevel)"
N=8
rm -rf /tmp/pi-context-rev$N && cp -a "$ROOT" /tmp/pi-context-rev$N
```
   `cp -a` keeps the sandbox byte-identical; the uncommitted diff under review is already inside it.
2. Snapshot the baseline so "read-only" is provable afterwards:
```bash
cd /tmp/pi-context-rev$N
git status --porcelain -uall | sort > /tmp/rev$N-baseline-status.txt
find . -path ./.git -prune -o -path ./.agents/memory -prune -o -type f -print0 | xargs -0 stat -c '%Y %s %n' | sort > /tmp/rev$N-baseline-files.txt
```
3. Write the prompt to `/tmp/rev$N-prompt.txt`. It must contain: the sandbox absolute path and an explicit read-only rule (no writes to the workspace, no `git add/commit/checkout/stash`, temp work only in `/tmp`); the files to read (`attention.md`, the issue dir's report/analysis/fix-note/review reports and earlier round transcripts, `git status --short`, `git diff`); severity buckets (blocking / important / nit / suggestion / learning / praise / residual-risk) with `file:line`, impact and fix boundary per finding; a Test And QA Focus section; a final `VERDICT` line (PASSED / CHANGES-REQUESTED / BLOCKED); the instruction to judge independently instead of inheriting earlier rounds' conclusions; and one adversarial pass that assumes a production bug is hiding in the change.
4. Run headless `pi` with restricted tools, capturing stdout/stderr/exit code:
```bash
out=/tmp/laneA-review-$(date +%s).txt
timeout 1500 pi -p --no-session --no-project-context --no-skills --no-prompt-templates \
  --tools read,bash --model "commandcode/deepseek/deepseek-v4.1-flash-fast" \
  "$(cat /tmp/rev$N-prompt.txt)" > "$out" 2>/tmp/rev$N-stderr.txt
echo "exit=$? bytes=$(wc -c <"$out") out=$out"
```
   Two flag traps, both measured 2026-10-03. **Never** pass `--no-extensions`: it deregisters the providers that extensions register, so a working route reports `Model not found` / `Unknown provider` and the round looks like a provider outage that it is not. Use `--no-project-context` to isolate this extension instead. The short `-m` does not exist on this host — spell out `--model`. A `commandcode` id containing a slash does resolve under `--model` in a fresh `pi -p` (measured); a `--list-models` listing alone is not proof of addressability.
   **Route is a variable, not a constant.** The model above is the original protocol route and it was `429` (weekly limit) on 2026-10-03; `deepseek/deepseek-v4-pro` served the rounds that day instead. Probe the alternatives (`pi-project-context-headless-runs`) before parking a round, and put the serving model in the round's prompt so the transcript records which model judged it.
   Run it in the background if the turn may be interrupted (long reviews have been aborted mid-flight).
5. Prove zero writes and file the evidence:
```bash
cd /tmp/pi-context-rev$N
git status --porcelain -uall | sort | diff - /tmp/rev$N-baseline-status.txt
find . -path ./.git -prune -o -path ./.agents/memory -prune -o -type f -print0 | xargs -0 stat -c '%Y %s %n' | sort | diff - /tmp/rev$N-baseline-files.txt
```
   Both diffs must be empty (a reviewer-side md5 tree hash is a useful cross-check). The `.agents/memory` prune is deliberate: `--no-project-context` does **not** stop the extension creating its own state dir in the reviewer's cwd (measured 2026-10-03 — `.agents/memory/{MEMORY.md,CONTEXT.md,memory.jsonl,.gitignore}` appear in the sandbox), so that directory is the extension's own startup write, not reviewer-side editing. A diff touching anything else still fails the round. Cross-check the live tree independently: `md5sum` the file under review before and after the run and require it unchanged. Then copy `$out` to `.codestable/issues/<...>/<slug>-review-round$N-independent.txt` and update the review report's round table/verdict and, for accepted residue, the fix-note's residual-risk section.

### Sandbox gotchas

- pi resolves the project root from the process cwd: always `cd` into the sandbox and give the prompt the sandbox path, otherwise the reviewer reads the live tree.
- A separate `pi -p` process has its own config/root and does not share the current session's single-flight/throttle state; reusing the current session's own tools is not an independent review.
- Provider failures (e.g. deepseek 402 insufficient balance) produce an empty transcript with zero sandbox writes; rerun the round rather than treating empty output as a clean review. A timed-out request prints `Request timed out.` on stderr and also leaves a 0-byte transcript — same class, rerun it; a round only counts once it returns a `VERDICT` line (measured 2026-10-03: the first attempt at a round died this way and the rerun passed).
- A review round that returns CHANGES-REQUESTED, then a fix, then a PASSED round does **not** close the loop: the fix itself must be covered by a further round. Measured 2026-10-03 — a PASSED round was followed by six nit fixes, and the next round caught a regression those fixes had introduced (a sentence inserted inside a code span, splitting an axis string).
- If a review run aborts, check the sandbox `git status` and baseline diff before repeating the launch; do not write transcripts into the live repo until step 5.
- Name sandboxes per review (e.g. `/tmp/pi-context-rev8`, `/tmp/pc-threshold-review`) so an older round's copy is not reused.
- **Budget `/tmp`.** A sandbox is ~130 MB of a 16 GB tmpfs, so eight or so stale copies plus the other sessions' scratch dirs fill it: measured 2026-10-03, `rev8…rev36` accumulated until `cp -a` died with `设备上没有空间` and left a half-copied tree. Delete finished rounds' sandboxes (`rm -rf /tmp/pi-context-rev<old>`) before creating a new one, and if a copy dies mid-way discard it and recreate under a **new** number rather than running a round in a tree whose baseline you never took.
- **A launch-time `429`/`402`/`403` is not a blocked round, it is an unfiled one.** Re-probe and switch route; only a transcript containing a `VERDICT` line counts as a round.

## Part 2 — Budget, bookkeep, and close the rounds

One round = one fresh reviewer pass over one frozen revision (mechanics above). Use this part to keep rounds finite.

1. **Freeze + sandbox before the round.** Copy the frozen revision into the `/tmp` sandbox, run a fresh read-only reviewer there, take the before/after zero-write proof, then archive the transcript next to the design doc. One design-round nuance: the reviewer's sandbox writes `.agents/memory/*` at startup even with the extension disabled, so that directory is pruned from the proof instead of being treated as reviewer editing.
2. **One round per frozen revision**, and a `PASSED` round does not cover edits made after it — a fix needs its own round.
3. **Apply only findings you can trace to a field fact**, bump the design revision, re-run.
4. **A launch-time `429`/`402`/`403` is an unfiled round, not a blocked one.** Probe another route and write the serving model into that round's prompt: measured 2026-10-03, one provider's `429` parked a round for a day while three other routes answered.

### Per-round bookkeeping

One row per round: revision, verdict, blocking count, important count, and the *nature* of the findings. Verdict alone is not the signal — counts and nature are. Real table:

| round | rev | verdict | blocking | important | nature |
|---|---|---|---|---|---|
| R1 | v1 | CHANGES-REQUESTED | 2 | 8 | root: entry point absent, publish window unhandled |
| R2 | v2.1 | CHANGES-REQUESTED | 0 | 5 | structural: report semantics, contract, flow table |
| R3 | v3 | CHANGES-REQUESTED | 1 | 1 | regression: reordering dropped one append |
| R4 | v4 | CHANGES-REQUESTED | 0 | 2 | spec: side-effect gate, table cell |
| R5 | v4.1 | CHANGES-REQUESTED | 0 | 3 | spec: predicate exactness, missing errors.log line, test precondition |
| R6 | rev 6 (B revision, re-run cancelled) | CHANGES-REQUESTED | 1 | 3 | root: `renderKey` undefined plus a missing empty guard would have refused publication forever in a fresh project |
| R7 | rev 7 | CHANGES-REQUESTED | 0 | 3 | spec: the refusal reply lied, a source flip read false-stale, the repro predicate was inverted |
| R8 | rev 8 | CHANGES-REQUESTED | 0 | 1 | bookkeeping: an existing test depended on the stale reply being published |

All eight design rounds returned CHANGES-REQUESTED; that is not failure and not a reason to keep going forever. The last three asked for **no new mechanism**, which is the real convergence signal — and note *what* R8 still had left: a test-ledger entry, i.e. something a prose round can still see, whereas wiring, call ordering and predicate placement cannot be judged from prose at all.

### Stop rule

Stop design rounds and switch to **implementation + one code-review round** when the last two rounds have **zero blocking findings and every remaining important finding is spec-precision, fixture or wording class**. Rationale observed in practice: what is left at that point (wiring, call ordering, predicate placement) is exactly what a reviewer reading prose cannot see, so another prose round cannot retire it. Here the implementation came in at ~124 net added lines in the extension plus a 199-line test file against a ~270-line design — inside the 3x rule — and the residuals were already named R-1..R-15 in the design itself.

**The one round worth adding after implementation:** a review of a *frozen, already implemented* revision can use the code and the test suite as ground truth instead of reasoning over prose alone, so it can settle wording and residual questions a pre-implementation round cannot ("does the design's sentence describe what the code does?"). The external-edit issue spent exactly one such round (R9) after `00bf797`, on the owner's instruction — it is a validation round, not a design-iteration round, and it should not reopen the mechanism.

### Anti-growth rules (apply the moment a finding lands)

- If a finding asks for a **new mechanism** rather than a correction of an existing one, first ask which field fact (issue section 1) it serves. No field fact -> write it in the design's non-goals, not into the mechanism.
- Stop adding when a round merely echoes the previous round's additions.
- One theme per issue.
- If the design surface is >3x the code delta, require a **minimal fix surface** section: what is deliberately dropped plus the named residual list. Example: the B revision of the external-edit design drops the re-run loop (the complexity mother), the `memory-stale-*.md` archive, a `resolveMemory()` extraction, the test seam and every lock change, keeping only the `basisKey` refusal in the write path, one pre-append recheck, and the publish-side side-effect skip in `report.ts`.
- When a revision supersedes a longer one, keep the old text as `<name>-full-v<n>-archive.md` with an "archived, do not implement" banner at the top. Never delete it; the round history is the audit trail.

### Closing the loop with the owner

Report: the round table, what each round actually caught (the strongest argument that the rounds were worth their cost), the convergence argument, the total rounds (= model runs, ~10-20 min each here), and the explicit open choice (one more design round vs implement now with a code-review round after). Design/audit work stays in `.codestable` documents committed separately from any implementation commit.
