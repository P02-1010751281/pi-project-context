# 先例调查：pi 插件与其它 coding agent 的上下文管理（2026-10-18）

范围：pi 官方扩展示例、pi 包注册表里的上下文/压缩插件、以及它们公开的 README/源码行为。
目的不是复刻某个实现，而是回答两个问题：**现成插件有没有保住旧对话前缀**，以及**有没有可借的
handoff/head 形状**。本文只记外部项目事实；本仓的前缀缓存实测在
`2026-10-18-handoff-prefix-cache-field-run.md`。

## 1. pi 官方示例（不是第三方插件，但最接近本仓）

| 实现 | 做法 | 对前缀/交接的含义 |
| --- | --- | --- |
| pi `examples/extensions/handoff.ts`（[source](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/handoff.ts)） | 调模型生成一份新 thread 的 prompt，列出相关文件，放进编辑器让用户改；`newSession` 后发送 | **不是自动交接**，也不做旧前缀复用；生成调用显式 `cacheRetention: "none"`。这是“带 LLM 的 handoff”，与本仓“机械 payload、不调用模型”相反 |
| pi `examples/extensions/custom-compaction.ts`（[source](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/custom-compaction.ts)） | 在 `session_before_compact` 里总结全部消息，返回 `firstKeptEntryId`，保留 recent tail | 与 pi 内置 compaction 同构；summary 插在 tail 前面，旧前缀在插入点分叉 |

## 2. pi 包注册表里的插件（按 npm 包名）

| 包 | 机制 | 缓存/交接相关判断 |
| --- | --- | --- |
| [`pi-async-compaction`](https://www.npmjs.com/package/pi-async-compaction)（[repo](https://github.com/almogdepaz/pi-async-compaction)） | 在 `turn_end` 提前用 pi 导出的 `compact()` 生成摘要，`agent_settled`/安全 idle 边界再交给 `session_before_compact` | **解决“压缩时等待”**，不是前缀复用；应用时仍是 summary + `firstKeptEntryId` 的 cut，旧前缀照样在 cut 处分叉 |
| [`pi-observational-memory`](https://www.npmjs.com/package/pi-observational-memory)（[repo](https://github.com/elpapi42/pi-observational-memory)） | 后台 observer/reflector 把会话沉淀成 observations/reflections；`session_before_compact` 用 projection 生成 compaction | npm 描述称“cache-friendly tiered compaction”；源码的主路径仍是 compaction projection，**保留边界由 `firstKeptEntryId` 决定**，没有看到显式的 head 保留。它比一次性 summary 更耐多代压缩 |
| [`billion-context-pi`](https://www.npmjs.com/package/billion-context-pi)（[repo](https://github.com/ranxianglei/billion-context-pi)） | 模型通过 `compress`/`decompress`/`search_context` 主动把连续消息折成摘要；取消 pi 内置 compaction | 最明确的缓存先例：设计说明写“**compress-as-anchor**，因为 prefix cache 优于 synthetic injection”；`acp_cache` 做 prompt-cache 对账（input/cached/hit rate、每次 miss 归因、per-fold 经济学）；`EntryProjectionCache` 是 prefix-stable 的增量投影缓存。但压缩点仍会让前缀在 fold 处分叉，**它管理的是 fold 的代价，不是复活旧前缀** |
| [`@shinynito/pi-amber`](https://www.npmjs.com/package/@shinynito/pi-amber)（[repo](https://github.com/ShinyNito/pi-amber)） | 用结构化 XML checkpoint 替换 compaction；校验必需 section/技术引用，失败自修复；保留 tail | 更偏“summary 质量/抗幻觉”，不是 cache；设计说明明确“head 已由上一份 summary 覆盖”，即**不保留 head** |
| [`@cortexkit/pi-magic-context`](https://www.npmjs.com/package/@cortexkit/pi-magic-context)（[repo](https://github.com/cortexkit/magic-context)） | 给消息打 `§N§` 标签，`ctx_reduce` 按 turn 删除；historian 在后台压缩；`<session-history>` 注入 system prompt | 明确做 **cache-safe removal** 和 cache state 展示；但把 `<session-history>` 放到 system prompt 每轮注入，意味着系统前缀本身会随历史变化。它是“可删除 turn + 历史注入”的另一种取舍 |
| [`pi-context-view`](https://www.npmjs.com/package/pi-context-view) | 可视化 context usage、base prompt、tool defs、extension injections | 只读诊断工具；适合确认“实际发出去的前缀是什么”，不是压缩器 |
| [`@cortexkit/opencode-magic-context`](https://www.npmjs.com/package/@cortexkit/opencode-magic-context) / [`opencode-acp`](https://github.com/ranxianglei/opencode-acp) | OpenCode 侧的同一思路：标签删除 / 模型驱动压缩，后者关闭内置 compaction | 说明“插件化上下文管理”不是 pi 独有；核心问题仍是 fold 点与前缀边界 |

### Claude Code 侧的一个对照

| 包 | 机制 | 缓存/交接相关判断 |
| --- | --- | --- |
| [`claude-code-handoff`](https://www.npmjs.com/package/claude-code-handoff)（[repo](https://github.com/eximIA-Ventures/claude-code-handoff)） | `/handoff` 保存会话状态到 `.claude/handoffs/`，`/clear` 后 `/resume` 恢复；auto-handoff 默认关闭、阈值默认 90%；另有 `/context-doctor` | **手动/自动状态保存 + 恢复**，不是 compaction；文档重点是“跨 `/clear` 不丢状态”，没有前缀复用或 cache 机制。它和本仓的差异是：保存的是结构化 handoff 状态，不是原文 tail |

## 3. 三条可借的形状

1. **官方 `handoff.ts` 的“goal + files + 可编辑草稿”**：本仓已经用机械 payload 取代了 LLM 生成；
   若要补语义，这个形状是参照，但不要重新引入一次模型调用。
2. **`billion-context-pi` 的缓存对账**：把“命中/未命中归因、fold 经济学”作为诊断面，而不是只报
   cacheRead 绝对值；本仓当前只记 `input/cacheRead`，够做机制判断，不够做账。
3. **`pi-magic-context` 的 turn 标签 + cache-safe removal**：若要“只删某些旧 turn”而不是整段
   handoff，这是插件层的成熟形状；代价是消息标记和 system prompt 注入会改变前缀。

## 4. 没有找到的东西

- 没有 pi 插件实现“**handoff 后保留旧对话 head 以复用前缀**”。官方 handoff 是 LLM 生成；
  第三方插件都围绕 compaction/fold，保留边界是 `firstKeptEntryId`。
- 没有插件把 `keep_first` 作为显式策略暴露；最接近的是 OpenHands 的 `LLMTrueSummarizingCondenser`
  （`keep_first` 默认 4）和 Codex compaction 的 user-message retention，但两者都不是 pi 插件。
- 因此本仓的 keepHead 属于**空白区**；它是否值得做，取决于“多保留的 context 总成本”是否小于
  “多命中的 cacheRead 折扣”。实测见 `2026-10-18-handoff-prefix-cache-field-run.md` 的 keepHead 一节。

## 5. 对本仓的结论

- 本仓当前的 handoff 更接近 **Amp Handoff 的机械版**：不生成摘要、tail 原文、日志指针；不是
  `pi-amber`/`billion-context` 那类压缩器。
- **插件层的“cache-friendly”通常指不要把 fold 做在中段、以及把 fold 的代价算清楚**，不是让旧
  conversation 前缀继续命中。
- 若要继续这条线，优先做 **cache 对账**（像 `acp_cache` 那样分清新内容/压缩重付/上游 TTL），
  再决定是否加 `keepHead`；不要先加一个没有账的 head 旋钮。
