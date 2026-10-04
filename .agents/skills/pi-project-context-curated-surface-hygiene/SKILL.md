---
name: pi-project-context-curated-surface-hygiene
description: "End-of-pass hygiene sweep over the curated surface (MEMORY/CONTEXT/docs/CHANGELOG/skills): consumer-repo state, dead pointers, stale counts, doc re-wraps, skill merges."
---

# Curated-surface hygiene for pi-project-context

Use after any pass that touched `docs/`, `CHANGELOG.md`, `.agents/memory/MEMORY.md`,
`.agents/memory/CONTEXT.md` or `.agents/skills/`, and whenever an audit's field evidence started
leaking consumer-repo state into this repo (owner wording: "the audit reached outside the project").
Also use it when the skill inventory itself needs restructuring (section 6).

Run from the project root:
`cd "$(git rev-parse --show-toplevel)"`

## 1. Boundary rule

Reading a consumer repo (Quantum_Matrix, UniField, CipherCat, pi-custom-providers) is necessary and
read-only: this extension has no runtime of its own, so its field evidence (errors.log, memory.jsonl,
backups, skill-candidates/) exists only there. Copying that state into this repo is the violation.

Never persist in MEMORY.md, CONTEXT.md, docs/, CHANGELOG.md **or a tracked skill body**: sibling commit
distances, sibling memory file sizes or character counts, another project's research values, line
pointers such as `MEMORY.md:78`, or module line numbers. Naming the repo and who owns an open item is
allowed (that is the declared owner boundary). Field facts belong in the `.codestable/` audit that used
them; replace a measurement in a skill with a shape description ("the cap clips the tail", not a
character count).

## 2. Verify the boundary mechanically

```bash
grep -nE 'UniField|Quantum_Matrix|CipherCat|gitcode' .agents/memory/MEMORY.md CHANGELOG.md
grep -c 'UniField' docs/*.md
grep -nE '[0-9]{3}/[0-9]{3}|[0-9]{2,3},[0-9]{3} char' .agents/skills/*/SKILL.md
```

The second pattern is a shape, not a value: a bare `N/M` pair or a comma-grouped character tally is the
signature of a measurement copied out of a consumer repo. Do not park the actual numbers in the pattern,
because then the guard carries the dirt it exists to find.

Expected after cleanup: one hit in MEMORY.md (the consumer-repo boundary declaration) and none in
CHANGELOG.md, every `docs/*.md` and every skill body. Sources of re-contamination are the session
context and the consolidation render, not the hand edit you just made.

## 3. Docs re-wrap proven content-identical

Wrap `docs/*.md` at sentence boundaries, no line over 160 characters. Write the rewrite script so it
asserts the cap *before* writing anything: an early run with a too-tight cap aborted with every file
untouched, which is the behaviour you want (no half-edited files).

Then prove only layout changed, comparing against the committed bytes:

```bash
git show HEAD:docs/architecture.md > /tmp/old.md
python3 - <<'PY'
import re
old = open('/tmp/old.md', encoding='utf-8').read()
new = open('docs/architecture.md', encoding='utf-8').read()
norm = lambda s: re.sub(r'\s+', ' ', s).strip()
print('content-identical' if norm(old) == norm(new) else 'CONTENT CHANGED')
PY
```

## 4. CHANGELOG derived from tagged ranges

`CHANGELOG.md` holds version-visible behaviour changes only: walk the tags
(`git tag --sort=v:refname`, then `git log --oneline <prev>..<tag>`), keep `feat`/`fix` commits, drop
docs and audit commits, and add an `Unreleased` section. Link it from `docs/README.md`. Keep
`docs/architecture.md` semantics-only: field incidents go to `.codestable/` audits, version changes
to CHANGELOG.

## 5. Skill-description trim

Every `.agents/skills/*/SKILL.md` description is injected into each session's system prompt, so it
stays one short what-plus-when line (<=170 chars here) with the steps in the body. Check lengths and
frontmatter together before committing:

```bash
python3 - <<'PY'
import glob, yaml
total, bad = 0, []
for f in sorted(glob.glob('.agents/skills/*/SKILL.md')):
    fm = open(f, encoding='utf-8').read().split('---\n', 2)[1]
    d = yaml.safe_load(fm)
    total += len(d.get('description') or '')
    if not d.get('name') or not d.get('description') or len(d['description']) > 170:
        bad.append(f)
print(total, 'chars', bad or 'all within cap')
PY
```

Report the measured total; never cite a total from an earlier pass (the skill count moves, so a copied
number is stale by construction).

## 6. Merge overlapping skills (one capability per skill)

When skills overlap or a newly learned skill covers ground an existing one already owns:

```bash
ls -d .agents/skills/*/ | wc -l
grep -h '^description:' .agents/skills/*/SKILL.md | cut -c1-120
```

Read each body and pair skills that describe the same capability. Merge rule: one capability per skill;
the landing skill gains a numbered section holding the absorbed steps, and the absorbed directory is
deleted. A merge with no concrete command, path or gotcha to carry over is a hint the skill was never
procedural. Keep `name:` equal to the directory name (pi does not require it, but the spec's portability
rule does) and make every `pi-project-context-*` cross reference resolve. Pi's hard caps are 64 characters
for the name and 1024 for the description (this repo trims descriptions to 170); a name pushing past
about 50 characters is a hint the skill is too narrow to stand on its own.

## 7. Dead-pointer sweep

The extension was split, so module paths in skills go stale silently: `handoff.ts` -> `handoff/run.ts`,
`project-state.ts` -> `shared/project-state.ts`, `consolidate.ts` -> `memory/*`.

```bash
grep -ho 'extensions/project-context/[A-Za-z0-9_/.-]*\.ts' .agents/skills/*/SKILL.md \
  | sort -u | while read p; do [ -e "$p" ] || echo "DEAD $p"; done
```

Two gotchas: a backtick-only search misses dead paths inside fenced code blocks (check the fences too),
and third-party line pointers (`constrained-sampling.js:42-110`) rot at every pi upgrade — use the file
or function name instead. Fix every hit in the curated surface (skills, docs); leave `.codestable/`
alone, its dead pre-split paths are frozen history and rewriting them falsifies the evidence.

## 8. Preserve provenance before deleting a superseded artifact

When a note under `.agents/memory/skill-candidates/` has already been promoted into a skill, its
session ids are the only evidence it carried. Record those ids in the relevant audit addendum
(`docs(audits): addendum N section M ...`) and only then `git rm` the candidate. Candidates are
untracked pipeline state, so a *tracked* candidate is an anomaly worth reporting; the promoted skill
drops the evidence comment, so the candidate file is not redundant evidence.

## 9. Commit discipline

Stage explicit paths, never `git add -A`: one pass swept a render's churn into a `docs(skills)` commit
that way, which also broke the "memory render gets its own commit" rule. A memory render is its own
commit in the `docs(memory): refresh the memory render` style, never bundled with docs, audit or code.
A description/body-only pass leaves `extensions/` byte-identical to the current release tag, so it
needs no new tag, pin bump or restart.

## 10. Re-check at every render, not once

A render draws on the session's own context as well as the journal, so hand-cleaned external state
came back three times in the field. Re-run step 2 before committing any render. The only durable fix
is a boundary instruction in the consolidation prompt (`memory/prompt.ts`); that is a code change, so
`extensions/` stops being byte-identical to the current tag and needs a new tag, `~/.pi` pin bump and
session restart. Open that as an issue rather than slipping it into a docs commit.
