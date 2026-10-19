---
name: pi-project-context-prefix-cache-analysis
description: "Analyze pi's provider prefix cache here: where the injected prefix comes from, what invalidates it, the handoff/settle coupling, and how to verify hits."
---

<!-- autolearn-generated: this skill may be superseded by a later autolearn pass -->

# When to use

The owner asks about provider prefix caching, cache hit/miss rates, why requests miss, whether to add caching, or whether a change to injected memory / handoff timing helps reuse. Apply this before proposing any cache mechanism.

## Where the prefix comes from (the extension owns the big block)

- `extensions/project-context/memory/report.ts` registers `before_agent_start` and returns `systemPrompt + '## Project Memory' + ` **the rendered memory text**, so the memory block sits at the **end of the system prompt** and is re-sent every turn. Its size is a per-turn cost, not a one-off. Since v0.4.1 that text is the **progressive render**, not the file's bytes: the kept sections verbatim plus one pointer line per indexed section. A render can change either part, so the cache-relevant surface is the rendered text, not `MEMORY.md` on disk.
- `extensions/project-context/archive/archive.ts` likewise appends the rendered CONTEXT.md text under `## Project Context` on `before_agent_start`.
- Trace any new injection the same way: find the `before_agent_start` handler and confirm whether it mutates the system prompt (prefix) or appends a message (breaks the prefix mid-stream).

## What invalidates the cache

- A consolidation render rewrites MEMORY.md → the system prompt changes → the cached prefix is invalidated **from that point on**.
- Conversely, keeping the injected text stable within a session is what makes prefix reuse possible. The block's *position* (end of system prompt) is already correct; do not move it mid-message.
- Do not assume the block changes every turn — inspect the render/journal frequency before claiming a rate; count renders over a window rather than asserting per-turn.

## What can be reused

- Within a session: the base prompt + tools + skills + memory block, as long as the injected text is byte-identical.
- Across a handoff: the successor's message list diverges from the predecessor immediately at the cut point, so **only the system block** (base prompt + tools + skills + memory) is a cross-session cache candidate, and only if it is byte-identical.

## The handoff / settle / compaction coupling

- `extensions/project-context/handoff/run.ts` and `extensions/project-context/memory/report.ts` both register on `agent_settled`. A handoff that coincides with a consolidation render rewrites MEMORY.md at that moment, so the successor's system block no longer matches the predecessor and the one reusable block is lost; the successor's first request necessarily misses.
- Handoff fires *before* pi's compaction (a `session_before_compact` handler cancels so handoff runs first), so on a compaction-shaped turn the successor follows a handoff, not a summary; do not assume compaction is the cache-friendlier alternative — verify with a same-size control.
- The chain where a memory consolidation error thrown during `session_shutdown` failed `ctx.newSession` (one `errors.log` line, 2026-09-22) had one source: a model call on the teardown path. Since 2026-10-06 (decision 1) the exit only flushes, so that source is gone; the teardown still writes files inside a guard, and the settle/render overlap above stays the thing to watch.

## pi already caches (do not re-implement)

- Session JSONL records `cacheRead` and `cacheWrite` per message — this is the observation surface.
- Knobs: `cacheWarming` (default `streaming`; `idle` pre-warms while waiting), `showCacheMissNotices` (default `false`).
- pi sets `cacheRetention: "none"` on its one-off summarization calls; leave those alone.
- Get exact knob names/defaults from the managed install tree docs (`~/.pi/agent/install/releases/<version>/node_modules/@earendil-works/pi-coding-agent/dist/`), not from memory.

## Recommended actions (ranked)

> **Field verdict: adopt none of 1/3; 2 and 4 stand.** The handoff drop comes from the successor's divergent conversation prefix, which no ordering or snapshot can avoid; a same-size control also showed compaction pays the same single miss with a much larger successor context. Do not build a caching layer, a snapshot, or a handoff-path suppression on the strength of the handoff drop alone — cite the audit under `.codestable/audits/` that used a field fact instead.

1. Keep the injected memory **stable within a session** (snapshot the rendered text) instead of rewording it on every settle.
2. Keep the memory block at the **end of the system prompt**; never insert it as a mid-stream user message.
3. **Decouple handoff** from a same-moment memory render (suppress or snapshot the render on the handoff path).
4. **Observe** with `showCacheMissNotices` and `cacheWarming` before claiming a win.

## How to verify (shape, not a target number)

- Correlate the request/response boundaries that bracket a render with the `cacheRead`/`cacheWrite` fields in the session JSONL; the first turn after a render should show the cache-read collapse, later turns recover. Compare **counts between turns**, never a single run's absolute values.
- After a handoff, the successor's JSONL begins with replayed predecessor messages carrying the old usage: skip those and read only the successor's own assistant calls, otherwise the numbers mislead.
- Controls to run before drawing a conclusion: `keep=0` (no replay), a `/new` session (pure cross-session system-block reuse), and a same-size handoff-vs-compaction pair. If all controls agree on the first-call value, the cause is the conversation cut point, not replay order.
- A single run showing `cacheRead=0` on the first call is cold noise until repeated; re-run before calling it a mechanism.
- Caveat to state honestly: whether a relay route passes Anthropic `cache_control` through is unverified; pi's `anthropic-messages` emits it, but the transport is not guaranteed to preserve it. Do not present relay-mediated cache reuse as already in effect.

## Pitfalls

- Do not propose a new caching layer before checking whether pi already caches (it does).
- Do not propose a fixed handoff preamble to "save" the successor's first call: the predecessor never cached it, so it cannot be hit; it could only help a later link of a handoff chain.
- Do not try to preserve the old conversation prefix to "restore" the cache — that equals not dropping the old context, which defeats handoff.
- Lost cacheRead is not automatically worse cost: the successor's context can be far smaller, so compare `total` alongside it.
- Do not write measured sizes/tokens/hit counts into this repo's memory, docs, or skills — record only the shape and cite the audit that used a field fact.
- Treat the injected block as the prefix, not a payload: churning it is the main cache-hostile behavior here.
