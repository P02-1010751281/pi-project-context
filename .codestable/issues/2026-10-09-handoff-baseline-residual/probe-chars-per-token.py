#!/usr/bin/env python3
"""Measure pi's chars-per-token assumption against provider-reported usage.

Reads pi session JSONL files and, for each pair of consecutive usage records, compares the prompt-token
delta with the character delta of the messages added in between. The delta cancels the non-conversation
part (system prompt, tool schemas, injected memory/context) — windows that contain a `context_edit`
entry do NOT (the injected block changed without new message text), so they are reported separately.

Usage: probe-chars-per-token.py <session-dir-or-glob> [count]
"""
import glob, json, os, sys

def median(xs):
    xs = sorted(xs)
    return xs[len(xs) // 2] if xs else float("nan")

def scan(path):
    entries = []
    for line in open(path, encoding="utf-8", errors="replace"):
        try:
            entries.append(json.loads(line))
        except Exception:
            pass
    chars, recs, edits = 0, [], set()
    for i, d in enumerate(entries):
        kind = d.get("type")
        if kind == "context_edit":
            edits.add(i)
        if kind != "message":
            continue
        m = d.get("message") or d
        content = m.get("content")
        chars += len(json.dumps(content, ensure_ascii=False)) if content is not None else 0
        u = m.get("usage")
        if isinstance(u, dict) and u.get("input") is not None:
            prompt = (u.get("input") or 0) + (u.get("cacheRead") or 0) + (u.get("cacheWrite") or 0)
            recs.append((i, prompt, chars))
    rows = []
    for (i0, p0, c0), (i1, p1, c1) in zip(recs, recs[1:]):
        dp, dc = p1 - p0, c1 - c0
        if dp <= 50 or dc <= 0:
            continue
        rows.append((dc / dp, any(j in edits for j in range(i0, i1))))
    clean = [r for r, dirty in rows if not dirty]
    dirty = [r for r, dirty in rows if dirty]
    if not recs or not clean:
        return None
    i, prompt, chars = recs[-1]
    rate = median(clean)
    est = chars // 4                      # pi's estimateTokens assumption
    return {
        "file": os.path.basename(path),
        "windows": len(rows), "dirty": len(dirty), "clean": len(clean),
        "clean_rate": rate, "dirty_rate": median(dirty),
        "prompt": prompt, "chars": chars, "est": est,
        "b_reported": prompt - est, "b_true": prompt - int(chars / rate),
        "est_share": est / prompt if prompt else float("nan"),
    }

def main():
    target = sys.argv[1] if len(sys.argv) > 1 else "."
    count = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    files = sorted(glob.glob(os.path.join(target, "*.jsonl")), key=os.path.getmtime, reverse=True)[:count]
    print(f"{'session':<44}{'clean c/t':>10}{'dirty c/t':>10}{'prompt':>9}{'est/4':>9}{'B_rep':>8}{'B_true':>8}{'est%':>7}")
    for f in files:
        r = scan(f)
        if not r:
            continue
        print(f"{r['file'][:42]:<44}{r['clean_rate']:>10.2f}{r['dirty_rate']:>10.2f}"
              f"{r['prompt']:>9}{r['est']:>9}{r['b_reported']:>8}{r['b_true']:>8}{r['est_share']*100:>6.0f}%")
    print("\nclean c/t = median chars per token on windows without context_edit (pi assumes 4)")
    print("B_rep = prompt - chars/4 (what baselineTokens reports) · B_true = prompt - chars/clean_c/t")

if __name__ == "__main__":
    main()
