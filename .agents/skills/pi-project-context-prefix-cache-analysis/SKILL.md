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

## The handoff / settle coupling

- `extensions/project-context/handoff/run.ts` and `extensions/project-context/memory/report.ts` both register on `agent_settled`. A handoff that coincides with a consolidation render rewrites MEMORY.md at that moment, so the successor's system block no longer matches the predecessor and the one reusable block is lost; the successor's first request necessarily misses.
- There is also a known chain where a memory consolidation error thrown during `session_shutdown` fails `ctx.newSession`, so handoff success is coupled to memory not throwing at shutdown. Treat these as memory-side changes that need owner sign-off.

## pi already caches (do not re-implement)

- Session JSONL records `cacheRead` and `cacheWrite` per message — this is the observation surface.
- Knobs: `cacheWarming` (default `streaming`; `idle` pre-warms while waiting), `showCacheMissNotices` (default `false`).
- pi sets `cacheRetention: "none"` on its one-off summarization calls; leave those alone.
- Get exact knob names/defaults from the managed install tree docs (`~/.pi/agent/install/releases/<version>/node_modules/@earendil-works/pi-coding-agent/dist/`), not from memory.

## Recommended actions (ranked)

> **Measured verdict (2026-10-06 field run): adopt none of 1/3; 2 and 4 stand.** In one session a hand edit of the
> memory block did not collapse `cacheRead` (2048 -> 2432); the handoff's drop (2048 -> 640) comes from the successor's
> divergent message list, which no ordering or snapshot can avoid. Do not build a caching layer, a snapshot, or a
> handoff-path suppression on the strength of the handoff drop alone - cite the measurement in
> `.codestable/audits/2026-10-06-handoff-and-cache-field-run.md` instead.

1. Keep the injected memory **stable within a session** (snapshot the rendered text) instead of rewording it on every settle.
2. Keep the memory block at the **end of the system prompt**; never insert it as a mid-stream user message.
3. **Decouple handoff** from a same-moment memory render (suppress or snapshot the render on the handoff path).
4. **Observe** with `showCacheMissNotices` and `cacheWarming` before claiming a win.

## How to verify (shape, not a target number)

- Correlate the request/response boundaries that bracket a render with the `cacheRead`/`cacheWrite` fields in the session JSONL; the first turn after a render should show the cache-read collapse, later turns recover. Compare **counts between turns**, never a single run's absolute values.
- Caveat to state honestly: whether a relay route (e.g. scnet / commandcode) passes Anthropic `cache_control` through is unverified; pi's `anthropic-messages` emits it, but the transport is not guaranteed to preserve it. Do not present relay-mediated cache reuse as already in effect.

## Pitfalls

- Do not propose a new caching layer before checking whether pi already caches (it does).
- Do not write measured sizes/tokens/hit counts into this repo's memory, docs, or skills — record only the shape and cite the audit that used a field fact.
- Treat the injected block as the prefix, not a payload: churning it is the main cache-hostile behavior here.
