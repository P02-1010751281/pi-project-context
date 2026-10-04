---
name: pi-project-context-curated-surface-hygiene
description: "End-of-pass hygiene sweep over the curated surface (MEMORY/CONTEXT/docs/CHANGELOG/skills): consumer-repo state, dead pointers, stale counts, doc re-wraps."
---

# Curated-surface hygiene for pi-project-context

Use after any pass that touched `docs/`, `CHANGELOG.md`, `.agents/memory/MEMORY.md`,
`.agents/memory/CONTEXT.md` or `.agents/skills/`, and whenever an audit's field evidence started
leaking consumer-repo state into this repo (owner wording: "the audit reached outside the project").

Run from the project root:
`cd "$(git rev-parse --show-toplevel)"`

## 1. Boundary rule

Reading a consumer repo (Quantum_Matrix, UniField, CipherCat, pi-custom-providers) is necessary and
read-only: this extension has no runtime of its own, so its field evidence (errors.log, memory.jsonl,
backups, skill-candidates/) exists only there. Copying that state into this repo is the violation.

Never persist in MEMORY.md, CONTEXT.md, docs/ or CHANGELOG.md: sibling commit distances, sibling
memory file sizes or character counts, another project's research values, line pointers such as
`MEMORY.md:78`, or module line numbers. Naming the repo and who owns an open item is allowed (that is
the declared owner boundary). Field facts belong in the `.codestable/` audit that used them.

## 2. Verify the boundary mechanically

```bash
grep -nE 'UniField|Quantum_Matrix|CipherCat|gitcode' .agents/memory/MEMORY.md CHANGELOG.md
grep -c 'UniField' docs/*.md
```

Expected after cleanup: exactly one hit in MEMORY.md (the consumer-repo boundary declaration) and
zero in CHANGELOG.md and every `docs/*.md`. Sources of re-contamination are the session context and
the consolidation render, not the hand edit you just made.

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

A 2026-10-04 pass trimmed 18 descriptions from 4008 to 2443 characters; a later pass merged overlapping
skills, landing at 14 descriptions / 1981 characters.

## 6. Dead-pointer sweep

The extension was split, so module paths in skills go stale silently: `handoff.ts` -> `handoff/run.ts`,
`project-state.ts` -> `shared/project-state.ts`, `consolidate.ts` -> `memory/*`.

```bash
grep -rn 'handoff\.ts\|project-state\.ts\|consolidate\.ts' .agents/skills docs .codestable | cut -d: -f1 | sort | uniq -c
```

Fix every hit in the curated surface (skills, docs, including module paths inside code blocks); leave
`.codestable/` alone - its dead pre-split paths are frozen history and rewriting them falsifies the evidence.

## 7. Commit discipline

Stage explicit paths, never `git add -A`: one pass swept a render's churn into a `docs(skills)` commit
that way, which also broke the "memory render gets its own commit" rule. A memory render is its own
commit in the `docs(memory): refresh the memory render` style, never bundled with docs, audit or code.

## 8. Re-check at every render, not once

A render draws on the session's own context as well as the journal, so hand-cleaned external state
came back three times in the field. Re-run step 2 before committing any render. The only durable fix
is a boundary instruction in the consolidation prompt (`memory/prompt.ts`); that is a code change, so
`extensions/` stops being byte-identical to the current tag and needs a new tag, `~/.pi` pin bump and
session restart. Open that as an issue rather than slipping it into a docs commit.
