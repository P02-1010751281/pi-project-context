---
name: pi-project-context-sandboxed-independent-review
description: "Run per-round independent CodeStable reviews of uncommitted pi-project-context changes in a byte-identical /tmp sandbox via headless pi with read-only tools, and prove zero writes with before/after git-status and file-stat snapshots."
---

# Sandboxed independent review of pi-project-context changes

**When to use**: an independent (lane A) review of uncommitted changes in this repo is required — any CodeStable review round recorded under `.codestable/issues/<date>-<slug>/` — and the reviewer must not write to the working tree. The owner expects a real second `pi` process for this, not a self-review downgrade.

## Procedure
1. Byte-identical sandbox (never review or edit the live tree in place):
```bash
ROOT=/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context
N=8
rm -rf /tmp/pi-context-rev$N && cp -a "$ROOT" /tmp/pi-context-rev$N
```
   `cp -a` keeps the sandbox byte-identical; the uncommitted diff under review is already inside it.
2. Snapshot the baseline so "read-only" is provable afterwards:
```bash
cd /tmp/pi-context-rev$N
git status --porcelain -uall | sort > /tmp/rev$N-baseline-status.txt
find . -path ./.git -prune -o -type f -print0 | xargs -0 stat -c '%Y %s %n' | sort > /tmp/rev$N-baseline-files.txt
```
3. Write the prompt to `/tmp/rev$N-prompt.txt`. It must contain: the sandbox absolute path and an explicit read-only rule (no writes to the workspace, no `git add/commit/checkout/stash`, temp work only in `/tmp`); the files to read (`attention.md`, the issue dir's report/analysis/fix-note/review reports and earlier round transcripts, `git status --short`, `git diff`); severity buckets (blocking / important / nit / suggestion / learning / praise / residual-risk) with `file:line`, impact and fix boundary per finding; a Test And QA Focus section; a final `VERDICT` line (PASSED / CHANGES-REQUESTED / BLOCKED); the instruction to judge independently instead of inheriting earlier rounds' conclusions; and one adversarial pass that assumes a production bug is hiding in the change.
4. Run headless `pi` with restricted tools, capturing stdout/stderr/exit code:
```bash
out=/tmp/laneA-review-$(date +%s).txt
timeout 1500 pi -p --no-session --no-extensions --no-skills --no-prompt-templates --tools read,bash "$(cat /tmp/rev$N-prompt.txt)" > "$out" 2>/tmp/rev$N-stderr.txt
echo "exit=$? bytes=$(wc -c <"$out") out=$out"
```
   Run it in the background if the turn may be interrupted (long reviews have been aborted mid-flight).
5. Prove zero writes and file the evidence:
```bash
cd /tmp/pi-context-rev$N
git status --porcelain -uall | sort | diff - /tmp/rev$N-baseline-status.txt
find . -path ./.git -prune -o -type f -print0 | xargs -0 stat -c '%Y %s %n' | sort | diff - /tmp/rev$N-baseline-files.txt
```
   Both diffs must be empty (a reviewer-side md5 tree hash is a useful cross-check). Then copy `$out` to `.codestable/issues/<...>/<slug>-review-round$N-independent.txt` and update the review report's round table/verdict and, for accepted residue, the fix-note's residual-risk section.

## Gotchas
- pi resolves the project root from the process cwd: always `cd` into the sandbox and give the prompt the sandbox path, otherwise the reviewer reads the live tree.
- A separate `pi -p` process has its own config/root and does not share the current session's single-flight/throttle state; reusing the current session's own tools is not an independent review.
- Provider failures (e.g. deepseek 402 insufficient balance) produce an empty transcript with zero sandbox writes; rerun the round rather than treating empty output as a clean review.
- If a review run aborts, check the sandbox `git status` and baseline diff before repeating the launch; do not write transcripts into the live repo until step 5.
- Name sandboxes per review (e.g. `/tmp/pi-context-rev8`, `/tmp/pc-threshold-review`) so an older round's copy is not reused.
