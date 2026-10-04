---
name: pi-project-context-structured-tool-output-strict-mode
description: "Wire strict JSON-schema structured output into pi-project-context auxiliary LLM calls, with the pi-ai strict-mode gotchas and a schema checklist."
---

# When to use
Adding or changing structured output for pi-project-context auxiliary calls (e.g. the `record_memory` consolidation tool), or turning on real strict-mode sampling for a route.

# pi-ai facts (re-verify line numbers against the installed version)
- `shared/llm.ts` (the `stopReason === "toolUse"` / empty-text branch) throws when there is no text. When `tools` are requested this is the SUCCESS path (the answer lives in `toolCall.arguments`), so this error contract must be relaxed or structured output always fails.
- `ToolCall.arguments` is already parsed; pi-ai's `parseStreamingJson` also repairs a truncated argument string into a shape-valid object. So check `stopReason === "length"` BEFORE trusting a tool call as complete.
- Request structured output via `tools: [<tool>]` with `Tool.constrainedSampling = { type: "json_schema", strict: "prefer" }` (`strict: "require"` throws on routes without strict support).
- Use `strict: "prefer"`. `strict: "require"` throws on routes that do not support it (`resolveJsonSchemaStrictSampling`).
- OpenAI-compatible providers (commandcode / scnet etc.): `supportsStrictMode` defaults to `false` (`openai-completions.js`, the provider-options table). Grammar constraints only appear with `compat.supportsStrictMode: true` in `models.yml` AND an upstream that honors it.
- Constrained sampling is built by `makeStrictJsonSchema` (`constrained-sampling.js` → `makeStrictJsonSchema`).

# Steps
1. Move the internal representation to code-owned structure (e.g. `MemorySections {project, invariants, pitfalls, index: string[]}`) so headings/order/blank lines come from code, not the model.
2. Define the tool with a strict-ready schema (checklist below).
3. Send the request with `tools`; treat `stopReason: "toolUse"` plus parsed arguments as success.
4. Relax the `llm.ts` empty-text-with-toolUse throw for tool-bearing requests.
5. Keep a Markdown fallback entry (parse the fixed `##` sections) converging on the same renderer.
6. Enforce the char cap in code (per-section budgets), never via `maxLength`/`maxItems`.

# strict-ready checklist
- root is `type: "object"`
- every property listed in `required` (avoid nullable / `anyOf`)
- `additionalProperties: false`
- no `$ref` / `$defs` / `allOf` / `oneOf` / ...
- no `anyOf` object/array variants
- arrays use `items: { type: "string" }`
- do NOT depend on `maxLength` / `maxItems` being enforced by the provider

# Gotcha
`strict: "require"` on an unsupported route kills the call; `strict: "prefer"` still gives function-calling semantics (arguments must be JSON inside the tool call, no prose or code fences) without the grammar guarantee, which already removes the free-form brace-scanning parser.
