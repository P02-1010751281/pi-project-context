---
doc_type: issue-audit
issue: 2026-10-01-structured-consolidation-output
status: confirmed
path: quick
created_at: 2026-10-03
related: [structured-consolidation-output-design.md, implementation-note.md, release-v0.2.0-evidence.md]
tags: [strict, json-schema, verification, provider]
---

# strict 模式端到端取证：本机能验到哪一步

## 结论

「strict 模式端到端证据缺失」这条，**在本机不可取证**——但不是因为没验，而是因为**本机所有可达路由都不支持 strict**。因此把它拆成两半，可验的那一半已验并钉住，不可验的那一半改为写明**不可取证的原因**。

## 为什么本机不可取证

`resolveJsonSchemaStrictSampling(tool, supportsStrictMode, …)`（`pi-ai/dist/api/constrained-sampling.js:174-197`）是真正决定 strict / 降级的闸门。它先看 `supportsStrictMode`：

- `supportsStrictMode === true` → 跑 `makeStrictJsonSchema`，通过则 **true**（发 strict）；
- 否则 → 非 `require` 一律返回 **`undefined`（非 strict）**。

而 `supportsStrictMode` 的来源是各 api 适配器：

| api | 默认 | 证据 |
|---|---|---|
| `openai-completions` | **false** | 本项目实际运行的路由 |
| `bedrock-converse-stream` | false | `bedrock-converse-stream.js:129` `?? false` |
| `anthropic-messages` | **false** | — |
| `google-generative-ai` | 按模型 | `google-generative-ai.js:296` `supportsGoogleStrictToolSampling(model.id)` |
| `azure-openai-responses` | true | `azure-openai-responses.js:215` `?? true` |

本机两个自定义 provider（`~/.pi/agent/custom-providers/{commandcode,scnet}/provider.json`）**都是 `"api": "openai-completions"`**，且两者都只有 `not_ready` 之外的问题（余额/限流）。故本机唯一可用的模型路由上 `supportsStrictMode === false`，strict **不可能被触发**——不是没跑到，而是这条路上不存在。

## 可验的那一半：已验

新增断言（`tests/sections-test.mjs` 的 `=== strict resolver (pi-ai's real gate) ===` 段）用**真实的** `RECORD_MEMORY_TOOL` / `RECORD_SKILL_TOOL` 对象直接调 `resolveJsonSchemaStrictSampling`，补齐了此前只验 schema、从不问闸门的缺口：

| 断言 | 结果 |
|---|---|
| `record_memory` 在 strict-capable provider 上解析为 **true** | OK |
| `record_memory` 在 strict 不支持的路由上**静默降级**（`undefined`） | OK |
| `record_skill` 同上两条 | OK |
| **对照**：把 base 表禁止的 `$ref` 塞进同一工具 → **不**解析为 strict | OK |
| `strict: "require"` 在不支持的路由上**抛错**（两个工具都用 `prefer` 的原因） | OK |

对照是防空洞的关键：没有它，前两条对任何 schema 都会绿。另经变异复核：把 `$ref` 塞进**真实** `record_memory` schema 后，`record_memory is strict-ready` 与 `record_memory resolves to strict on a strict-capable provider` **同时变红** ⇒ 新断言非空洞。

**这证明了**：schema 本身是 strict-ready 的，一旦跑在 strict-capable provider（如 Google 某型号 / Azure responses）上，strict **会被真的发出**。此前这条推论没有证据支撑。

## 仍未证的那一半（明确标注）

- **provider 侧真的按 strict 约束解码**：需要一条 strict-capable 路由，本机没有。这属于「拿不到的能力」，不是「没做的验证」。
- 在支持 strict 的路由上跑一次真实 consolidation，确认 tool call 形状无变化。

## 对既有记录的影响

`implementation-note.md` 与 `release-v0.2.0-evidence.md` 里「strict 模式端到端证据仍缺」的表述**仍然成立**，本文件不改写它们，只补上：缺的是 provider 侧那一段，且本机不可取证；本地闸门那一段已由新断言覆盖，不再是缺口。
