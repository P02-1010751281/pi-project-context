#!/usr/bin/env python3
"""Attribute baselineTokens' residual: real non-conversation baseline vs estimator bias.

Mechanism (pi dist core/compaction/compaction.js): pi reports
    tokens = usageTokens + trailingTokens,  usageTokens = totalTokens = prompt + output,
    trailingTokens = sum(estimateTokens(messages after the last usage)),  estimateTokens = ceil(chars/4).
The extension computes  B_rep = pi.tokens - sum(estimateTokens(branch)); the trailing estimates cancel, so
    B_rep(k) = [prompt_k - chars_before_k/4] + [output_k - reply_chars_k/4]
             = B_true + estimate error on the prefix + estimate error on the reply.

Claim under test: within one *stable* segment (no context_edit / model_change / thinking_level_change /
session / compaction entry ever occurring between two records, so the non-conversation part and the prefix
never change) B_true is constant, hence B_rep must not drift; every drift is estimator error, and its size is
    drift = added_chars * (1/r - 1/4),  r = true chars per token (provider-calibrated per window).
The section intercept of a clean segment (line fit, R^2 >= 0.99, r in a sane range) is a direct B_true sample.

Usage: probe-baseline-attribution.py <session-dir|glob> [count]
"""
import glob, json, os, statistics, sys

SPLIT = {"context_edit", "model_change", "thinking_level_change", "session", "compaction"}
RANGE = (1.5, 8.0)          # sane chars-per-token band; outside it the prompt moved without message chars

def collect(path):
    """-> (records, ) records = (seg, chars_before, reply_chars, prompt, output, seg_is_clean, split_before)"""
    entries = []
    for line in open(path, encoding="utf-8", errors="replace"):
        try:
            entries.append(json.loads(line))
        except Exception:
            pass
    recs, chars, seg, split, prev = [], 0, 0, True, None
    for d in entries:
        kind = d.get("type")
        if kind in SPLIT:
            seg += 1; split = True
        if kind != "message":
            continue
        m = d.get("message") or d
        content = m.get("content")
        js = json.dumps(content, ensure_ascii=False) if content is not None else ""
        u = m.get("usage")
        if isinstance(u, dict) and u.get("input") is not None:
            prompt = (u.get("input") or 0) + (u.get("cacheRead") or 0) + (u.get("cacheWrite") or 0)
            if prev is not None and prompt < prev:
                seg += 1; split = True
            prev = prompt
            recs.append([seg, chars, len(js), prompt, u.get("output") or 0, split])
            split = False
        chars += len(js)
    return recs

def free(rec):      # what the extension effectively reports (integer view of the same formula)
    _, cb, rc, p, o, _ = rec
    return (p + o) - (cb + rc) // 4

def seg_clean(recs, seg):
    pts = [(r[1], r[3]) for r in recs if r[0] == seg]
    if len(pts) < 5:
        return None
    xs = [x for x, _ in pts]; ys = [y for _, y in pts]
    mx, my = statistics.mean(xs), statistics.mean(ys)
    den = sum((x - mx) ** 2 for x in xs)
    if den == 0:
        return None
    b = sum((x - mx) * (y - my) for x, y in pts) / den
    a = my - b * mx
    ss = sum((y - my) ** 2 for y in ys)
    r2 = 1 - sum((y - (a + b * x)) ** 2 for x, y in pts) / ss if ss else 0
    if b <= 0 or not RANGE[0] <= 1 / b <= RANGE[1] or r2 < 0.99:
        return None
    return len(pts), a, 1 / b, r2

def main():
    target = sys.argv[1] if len(sys.argv) > 1 else "."
    count = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    files = sorted(glob.glob(os.path.join(target, "*.jsonl")), key=os.path.getmtime, reverse=True)[:count]
    print(f"{'session':<30}{'win':>5}{'r_p10':>7}{'r_p50':>7}{'r_p90':>7}{'drift_sum':>11}{'clean_seg':>10}{'B_true samples':>28}")
    for f in files:
        recs = collect(f)
        ws, drift = [], 0
        for a, b in zip(recs, recs[1:]):
            if a[0] != b[0]:                       # segment boundary: composition changed, not comparable
                continue
            dchar = b[1] - a[1]                    # chars sent between the two prompts
            dprompt = b[3] - a[3]
            if dchar <= 500 or dprompt <= 100:
                continue
            r = dchar / dprompt
            if not RANGE[0] <= r <= RANGE[1]:
                continue
            ws.append(r); drift += free(b) - free(a)
        samples = []
        for s in sorted({r[0] for r in recs}):
            c = seg_clean(recs, s)
            if c:
                samples.append((c[0], round(c[1]), round(c[2], 2), round(c[3], 3)))
        p = lambda q: statistics.quantiles(ws, n=10)[q] if len(ws) >= 3 else float("nan")
        print(f"{os.path.basename(f)[:28]:<30}{len(ws):>5}{p(0):>7.2f}{p(4):>7.2f}{p(8):>7.2f}{drift:>11}"
              f"{len(samples):>10}   {', '.join(f'{n}pt B={b} r={r}' for n, b, r, _ in samples[:6])}")
    print("\nwin = 同段内可比窗口数（无 split 且 1.5<=r<=8）· drift_sum = 这些窗口里 B_reported 的累计变化（真实 B 恒定 ⇒ 应≈0）")
    print("clean_seg = R²>=0.99 且 r 合理的段（>=5 点），其截距 B 即真实 baseline 的直接取样")

if __name__ == "__main__":
    main()
