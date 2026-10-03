---
doc_type: design
issue: 2026-10-01-structured-consolidation-output
status: design-frozen
created_at: 2026-10-01
related: [../2026-09-30-auxiliary-call-noise-and-memory-cap/auxiliary-call-noise-and-memory-cap-s1-s3-design.md, ../2026-09-30-auxiliary-call-noise-and-memory-cap/auxiliary-call-noise-and-memory-cap-s2-context-design.md]
tags: [memory, consolidation, structured-output, tools, schema, budgets, autolearn]
---

# 结构化 consolidation 输出设计

## 目标

- 让 consolidation 产物的**结构由代码拥有**，而不是由模型自由生成 Markdown：模型只提供每节的**条目**，标题、节序、空行、预算由扩展渲染。
- 用 pi-ai 的 **tool-calling**（`tools`）拿到分节内容，并在路由声明 strict 时用 `constrainedSampling` 收紧形状。**诚实的限界（I8）**：在用的路由默认 strict 关闭，所以这里主要是 function-calling 语义（形状可靠）而非文法强约束。它要消掉的三类正确性问题是：
  1. 分节标题漂移（模型漏写 / 改写 `## Invariants`）；
  2. 超 cap 时**整篇 60/40 位置式裁剪**丢掉中段（Invariants/Pitfalls）；
  3. 「这次删了哪条 invariant」**不可检测**（比的是两坨文本）。
- 对不支持结构化输出的路由**保留 fail-open 降级**：降级不是被替换的旧路径，而是明确保留的第二入口。
- 配套**记忆回归守卫**：写前 diff 旧/新 sections，报告被移除的 `Invariants`/`Pitfalls` 条目，把「模型静默丢弃」变成**可检测事件**（owner 2026-10-01 定：并入本次范围，不拆后续 issue）。
- **机制是共用的（owner 2026-10-01 追加）**：辅助调用产出 JSON 的只有 consolidation 与 **autolearn** 两处，两者共用 `shared/llm.ts` 的 `completeWithMeta`。因此 tools 管道、失败契约、截断纪律与 strict-ready schema 规范**一次做完全部消费者**，而不是只给 consolidation（见决策 7）。

## 硬约束

- **向后兼容**：已有自由结构的 `MEMORY.md` 仍能读、能渲染、能剪裁；不得为套结构重排或丢事实。
- **不改外部文件格式**：产物仍是 `# Project Memory` + 固定 4 节 Markdown；本节只改**写路径的内部表示**。
- **零新依赖**：项目无 `package.json`；只能用 Node 标准库与 `pi-ai` 已暴露的能力。
- **读路径不动**：`memory/parse.ts` 的 JSON fail-closed、归档层只读注入、`normalizeMemoryDocument` 的读侧语义保持不变。
- 改协议/边界 → 落地前走 `.agents/skills/pi-project-context-sandboxed-independent-review` 三审三校 6 轮只读评审 + 零写入快照。

## 现状（代码事实，均已核实）

- `memory/prompt.ts:24` 要求 `{ memory_markdown: <Markdown 字符串>, context: {...} }`：**memory 是整坨 Markdown，分节标题由模型写**。`context` 已经是对象。
- `shared/llm.ts:89-92` 只发 `{ messages }`，**没有 `tools`**；`completeWithMeta` 只取 `extractText`，且 `llm.ts:103-106` 把 `stopReason: "toolUse"` 且无文本视为错误。
- `memory/parse.ts:61-74` 用 `parseJsonObject`（剥 code fence + 大括号扫描）+ `jsonStringField` 恢复，专门应对「模型加散文 / 对象未闭合」。
- `memory/pass.ts:128-150`：超 cap 做**一次** condense，仍超则保留原回复；随后 `store.ts:76` 的 `normalizeMemoryReply` → `document.ts:118` 调用的 `clipToLineBoundaryBothEnds`（函数在 `document.ts:96`，`CLIP_HEAD_SHARE` 常量在 87；整篇头 60% / 尾 40%）。
- pi-ai 能力（读 `dist/` 确认）：
  - `Tool.constrainedSampling = { type: "json_schema"; strict: "prefer" | "require" }`（`types.d.ts:506-521`）；`Context.tools`（`types.d.ts:535`）。
  - `ToolCall = { type: "toolCall"; name: string; arguments: JsonObject }`（`types.d.ts:280-284`）——**`arguments` 已是解析好的对象**。
  - `resolveJsonSchemaStrictSampling`（`api/constrained-sampling.js:174-195`，`"require"` 的不支持抛错在 192 行）：provider 支持 strict 时尝试 strict，schema 含不支持关键字时 `strict==="require"` **抛错**、`"prefer"` 返回 `undefined` 降级；provider 不支持 strict 时 `"require"` **抛错**。
  - **OpenAI 兼容路由 `supportsStrictMode` 默认 `false`**（`api/openai-completions.js:1288-1289`：`// OpenAI compatibility alone does not imply strict JSON-schema tool support.`；由 `getCompat` 在 1331 行落地）。
  - **Anthropic 与 Bedrock 走同一条路且默认关闭**（`anthropic-messages.js:146` 默认、`:1261` 使用）、`bedrock-converse-stream.js:907`；**Google 是例外，默认开启**（`google-shared.js:333` `supportsStrictMode = true`，调用方传 `supportsGoogleStrictToolSampling(model.id)`，Gemini 3+ 为真）。
  - **两个不同的 compat 键，默认都是 false**：`openai-completions` / bedrock 读 `compat.supportsStrictMode`；`anthropic-messages` 读 `compat.supportsStrictTools`（`anthropic-messages.js:146`，`?? false`）。
  - `makeStrictJsonSchema`（`constrained-sampling.js:107` 起）：强制 `required = propertyNames`、`additionalProperties = false`，非必填属性包成 `anyOf:[<prop>, {type:"null"}]`。
  - **行号会随 pi-ai 包刷新而漂移（N10）**：本文件今天已偏移一次；落地时按**函数名**定位，不按行号。
  - 本机实况（2026-10-01 核对 `~/.pi/agent/models-store.json` + `~/.pi/agent/custom-providers/*/models.json`）：**只有 `deepseek` 两个模型声明了 `supportsStrictMode: true`**；commandcode 的 `models.json` **条数会随刷新漂移**（2026-10-01 当天两次核对就已不同：76→85 条；`api: "anthropic-messages"` 8→10 条，其余省略 `api`、继承 `provider.json` 的 `openai-completions`）—— 但**没有任何一条声明 strict compat 键**（`provider-composer.js:72`）；scnet 默认 `openai-completions`，openai-codex 走 `openai-codex-responses` —— 三者均未声明 strict 键 → **strict 默认全关**。本项目 `project-context.json` 的 `provider`/`model` 均为空 → **辅助调用用会话模型**，路由不固定。
  - `tools` 参数被路由拒绝时**没有可回退的文本回复**（请求在 `modelRegistry.complete` 就失败）；`strict:"prefer"` 只管 strict 化，管不了这个（见决策 2 / R1）。
- **第二个 JSON 消费者：autolearn（已核实）**：`autolearn/pass.ts:94/105/116` 用 `completeText` 调模型，`autolearn/parse.ts:10` 的 `parseDecision` 用 `parseJsonObject` 解析。prompt（`autolearn/prompt.ts:33-36`）要求三种形状之一：`{"skill": null}` / `{"skill": null, "inspect": [...], "reason": "..."}` / `{"skill": {"name","description","body","evidence":[],"candidate","reason"}}`。**顶层 `reason` 从未被读**（`parseDecision` 只读 `parsed.skill` 与 `parsed.inspect`）。
  - **strict 阻塞点（已探针验证）**：`skill` 是**可空对象**（`null | object`），而 strict 拒绝 object/array 的 union（`constrained-sampling.js:62-66`：对 `anyOf` 每个变体调 `isStructuredSchema`，后者在 `:24-30` 只要含 `object`/`array`/`properties` 就判为 structured）。两条写法都不可接受：
    - **(a) `skill` 必填 + `anyOf:[{object},{null}]`** → `makeStrictJsonSchema` **本地直接抛** `object and array unions are unsupported`（实测）。
    - **(b) `skill` 非必填 + `type:"object"`** → **本地不抛**，但 `:100` 把它包成 `anyOf:[{object},{null}]`，而 `:104` 又把**所有**属性名强制写进 `required` —— 等于把 object union 原样发给 provider，**静默违反 strict 子集**（实测输出确认）。
    所以 **autolearn 不是「加个 tool 就行」，必须改形状**（见决策 7；新形状已实测通过 `makeStrictJsonSchema`）。
  - `completeText` **丢弃 `stopReason`**（`llm.ts:118-124` 只返回 `.text`）→ autolearn 今天根本无法实施 B2 的截断纪律，必须先改用它为 `completeWithMeta`。
- **handoff 不走 JSON**：`handoff/run.ts` 只 `import { resolveAuxModel }`（:10）并用在 :32/:40/:75/:322 的模型选择与阈值计算上；摘要用 pi 内建 summarizer。所以「其他 schema」仅指 autolearn。

## 决策 1：写路径内部表示改为「分节」

新增 `MemorySections`：

```ts
type MemorySections = {
  project: string[];
  invariants: string[];
  pitfalls: string[];
  index: string[];
};
```

- 渲染由**代码**拥有：标题文案、节序、空行都来自 `memory/schema.ts` 的 `MEMORY_SECTIONS`，模型只填每节的条目数组。
- 收益：
  - 标题漂移消失（标题不再由模型生成）；
  - 每节预算在渲染器里执行 → **按节裁剪**取代整篇位置式裁剪，天然不丢中段；
  - 回归守卫退化成数组 diff（见决策 5；**已并入本次**，不是后续 issue）。
- `Project` 是散文性最强的节，仍用 `string[]` 承载（一词条一行），由渲染器拼成 bullet，避免再引入第二套 prose 类型。

## 决策 2：结构化输出用 tool + `strict: "prefer"`

- 调用侧新增 `tools: [record_memory]`，其 `constrainedSampling: { type: "json_schema", strict: "prefer" }`。
- **必须用 `"prefer"`**：`"require"` 在不支持 strict 的路由上抛错（`constrained-sampling.js:192`；:188 是关键字重抛，:180 是 `makeStrictJsonSchema` 调用，不要搞混），而 OpenAI 兼容路由默认关闭 strict → 会把当前可用的路由整个打死。
- **strict 需路由侧显式开启**（owner 2026-10-01 选可靠路线）：在模型定义加 `compat.supportsStrictMode: true`（openai 兼容 / bedrock）或 `compat.supportsStrictTools: true`（anthropic-messages）。但设计**不依赖它生效**：本机在用路由默认全未声明，且 `models-store.json` 会被刷新，因此 `"prefer"` + 降级路径仍是硬要求，仅当 strict 真生效时才收紧形状保证。
- 读取优先 `toolCall.arguments`；无 `toolCall` 时回落现有 `parseConsolidated`。
- `toolChoice` 保持 **`"auto"` 而非 `"required"`**（S1）：要给「模型不调工具、改用散文」留退路；`required` 在部分 route 上不被支持，且会直接挡掉降级路径。
- **`tools` 被拒时的兜底（I7 / F3）**：`complete` 因 `tools` 参数报错时，做**恰好一次**不带 `tools` 的重试落回降级路径。**触发策略定稿**：不尝试字符串分类（脆弱），也不重试每一次失败 —— 只在**本 pass 第一次**带 `tools` 的调用抛出时无条件回退一次，且 **`noteModelFailure` 只在两次都失败后记一次**（避免一次 quota/auth 故障被记两次、提前触发 backoff）；仍失败才 fail-closed（R1）。**回退是粘性的（N4）**：一旦触发，本 pass 之后所有调用都不再带 `tools`。**该兜底与计数只有一份实现**（`shared/llm.ts` 的 `callAux`，见「接口改动」）：两条 pass 不得各自实现一遍。

## 决策 3：降级路径、`sectionsFromMarkdown` 契约与双路径收敛

两条入口，**汇到同一个渲染器与同一套按节预算**：

| 入口 | 来源 | 内部表示 | 裁剪行为 |
|---|---|---|---|
| 结构化 | `toolCall.arguments` | `MemorySections` | 按节预算 + 逐项截断 |
| 降级·可解析 | `parseConsolidated().memory`（Markdown） | `sectionsFromMarkdown` → `MemorySections` | 同上（一致） |
| 降级·不可解析 | 自由结构 / 旧记忆回写 | 不透明整体 | 沿用 M3 整篇裁剪 |

**降级提示词形状（I3）**：降级路径必须继续要求 **`{memory_markdown, context}`**（`parseConsolidated` 只认它）；`pass.ts` 的 retry / condense 文案同步保持该形状，**不得**改成 sections 对象 —— 否则「忽略 `tools` 的 provider」在 retry 后必然再次失败。

**`sectionsFromMarkdown` 提取契约（I2 / F1 / F6；不写明等于静默丢内容）**：
- **先吃掉恰好一行可选的文档头 `# Project Memory`**（大小写不敏感，取首个非空行；与 `parseMemoryValue` 剥离的形状一致）。**这一步不可省**：`prompt.ts:24` 要求 `memory_markdown` 是「含 `# Project Memory` 的整篇文档」，`normalizeMemoryDocument` 也总是先输出该行 —— 不豁免它，本契约会拒掉**所有真实记忆**，「降级·可解析」与回归守卫的旧侧会永远失效（F1）。
- 节头识别**只有** `MEMORY_SECTIONS` 的四个 `## <heading>`（大小写不敏感、允许前后空白）。
- **可选的文档头与首个节头之间，任何非空白行 → `undefined`**（N2；round 2 修 F1 时误删了这条，与测试计划不一致）。
- 条目 = 该节下以 `- ` 开头的行，去前缀后做行内空白归一。
- **最后一个非空行如果是 `MEMORY_TRUNCATION_LINE` 形状的截断标记，先剥掉再应用下面的规则（N7 / F4-8 / R6-5）**：历史被 cap 过的记忆末节带这个标记，不剥就会把它当成节内非 bullet 而整篇拒掉，导致回归守卫对**所有曾超 cap 的记忆**永远跳过。该正则目前是 `document.ts:13` 的**模块私有**量，`sections.ts` 要用得先导出（或在本模块重声明并钉住形状），否则形状会漂移。
- **节内非空白且不以 `- ` 开头的行（散文续行、`*` / 缩进 bullet）→ 整个函数返回 `undefined`**（保守：宁可退回逐字路径，也不静默丢，F6）。
- 未知节（如 `## Notes`）、末节之后的内容：**任一非空即 `undefined`**。
- **四个节头全部存在**才返回 `MemorySections`；缺任一 → `undefined`。
- **tool-call 侧的条目剥掉一个前导 `- `**（模型可能自行加 bullet 前缀，F6）。
- 上述每条都要有对应用例（见测试计划）。

- 「降级·可解析」让**今天的规范回复**与新路径行为一致，只有一条损失语义需要理解。
- 「降级·不可解析」是自由结构记忆与旧记忆的唯一退路，行为与今天**完全相同**（向后兼容的落点）。
- 前两条入口（结构化 / 降级·可解析）都**不走**既有 `normalizeMemoryReply`/`clipToLineBoundaryBothEnds`；两者都落空时，**第三种入口本身就是那条老路径**，不是第四层兜底（F10）。

## 决策 4：cap 仍由代码执行，且丢弃必须可见（B1 / I4）

- **`maxLength` / `maxItems` 一律不进 schema（两条独立理由，均已实测）**：① pi-ai 自己的 **16 键**禁用表（`constrained-sampling.js:3-20`）虽不含它们，但 **Anthropic 适配器另加 11 个键**（键集在 `anthropic-messages.js:1223-1235`：`minimum` `maximum` `exclusiveMinimum` `exclusiveMaximum` `multipleOf` **`maxItems`** `uniqueItems` `minContains` `maxContains` `minProperties` `maxProperties`；`format` 白名单 `:1236-1247`；判定谓词 `:1248-1256`，`minItems` 仅允 0/1）：带上 `maxItems` 会让 Anthropic 路由在 `"prefer"` 下**静默降级**，白丢 strict。② 即便通过，provider 是否真执行也不可保证。→ **cap 只能由代码执行**。（原稿写「不在拒绝清单里」，**对 `maxItems` 是错的**；`maxLength` 两张表都不含，只受理由 ② 约束。结论不变。）
- **计数单位（I4 / R6-1）**：预算按**渲染后的整节正文**计（含 `- ` 前缀与换行，每条约 +3 字符），不是条目文本之和；条目先做归一（换行→空格、去 bullet 前缀、去首尾空白）。
- **按节裁剪算法（R6-1，必须写死，否则在小 cap 下退回整篇 60/40）**：对每个节 s（预算 `budget_s`）：
  1. **先定该节的条目上限** `itemCap_s = max(1, min(MAX_LIST_ITEM_CHARS, budget_s − 3))`，把条目截到 `itemCap_s`（截过的条数计入 `itemTruncated`）。截断必须用**现有 `document.ts:74-82` 的 `clipToLineBoundary` / `isHighSurrogate` 回退**（surrogate-safe），**不得**裸 `slice(0, itemCap_s)` —— 否则会在高位代理处切出非法 UTF-16（F3）。
  2. **再从前往后贪心放**，放不下的**整条丢弃**（丢弃条数计入 `droppedItems`，该节记入 `sectionDropped`）。
  3. 若 `budget_s < 8`（理论不可达：`MIN_MEMORY_CHARS=4000` 时最小节预算 588）→ 整节丢弃并记入 `sectionDropped`。
  如此**单条永远放得下**，`text.length <= cap` 构造性成立，不依赖「最小节预算 > 条目上限」—— 该假设在 `cap=4000` 下**不成立**（`memorySectionBudgets(4000)` = 784/1569/981/**588**，而单条可达 803）。**不得**照抄 `context-doc.ts:47-54` 的 `clipList`（它正建立在那个不成立的假设上）。
- **量纲（R6-1 / F4）**：`sectionDropped` = **丢过至少一条条目的节数**；`droppedItems` = 丢弃条目总数；`itemTruncated` = 被截到 `itemCap_s` 的条目数。三者都不是字符数。注意 `itemCap_s` 是**本节**上限（`cap=4000` 时 Index 是 585，不是 `MAX_LIST_ITEM_CHARS` 的 800），所以警告要说「超过**本节**单项上限」；且一条条目**先被截后又被丢**会**同时**计入 `itemTruncated` 与 `droppedItems` —— 警告同时报两个数不是矛盾（F4）。
- **新渲染器不写标记（F10）**：丢弃信息只经返回值 `sectionDropped` / `droppedItems` / `itemTruncated` 传递，不在正文里落 `MEMORY_TRUNCATION_LINE`（那会被 `store.ts:76` 的 `stripMemoryMarker` 抹掉，正是 B1）；老标记只属于「降级·不可解析」的整篇裁剪路径。断言 `text.length <= cap`。
- **诊断要说对话（F4 / N5 / R6-3）**：`report.ts` 需要一个 `kind` 判别式（而不是单个 `lastWrite.capped` 布尔）来把旧 60/40 文案限在「降级·不可解析」；cap 事件 = `sectionDropped > 0 || itemTruncated > 0`，警告按**触发成分**拼句（丢节 → 「N 个节超出其预算，M 条条目被丢弃」；只截条 → 「K 条条目超过**本节**单项上限被截断」）。
- **不给数字建议（F5-10 / R6-3 / F5-5）**：按节份额下「最小可行 cap」不是整数（探针：share 0.15、content 590 → 4009.33），而 `/project-context max-memory` 只 `Math.round`（`index.ts:145`），照抄仍会裁 → **结构化与降级·可解析两条入口一律不报建议值**，警告只说原因与计数。**`neededChars` 随之从渲染器返回值与 `ConsolidateOutcome` 中删除**：没有消费者就不留死载体。**降级·不可解析沿用**现有 `raise it with /project-context max-memory <n>`（`report.ts:125/154`）**不动** —— 那条路走的是整篇裁剪，数字仍然是准的。
- **condensation 的存亡（F5 / N3 / N4）**：**保留一次有界 condense**。触发条件分两路：
  - 结构化 / 降级·可解析：由 **`sectionDropped > 0`** 触发（渲染器已保证 `text ≤ cap`，旧的 `exceedsMemoryCap` 条件**恒 false**，等于静默退役了这个质量回路）。
  - **降级·不可解析：保留旧的 `exceedsMemoryCap(result.memory, cap)` 作为唯一闸门（N3）** —— 它不走渲染器，不产生按节计数；不写明就会让「最可能超 cap 的那条路」直接掉到 60/40 裁剪。
  - retry / condense **一律不带 `tools`**、用 `{memory_markdown, context}` 形状（N4）：condense 的前提是文本 JSON，带着「优先调 `record_memory`」的提示会得到 toolCall 而 `parseConsolidated` 拿不到东西。
  - **采纳判定（F5-4 / R6-2）**：retry/condense **始终是文本 JSON、不带 `tools`**，所以**不可能**有 toolCall —— 旧稿里「结构化 = toolCall 可用」那个分支**不可达，删除**。结构化与降级·可解析**统一**用 `parseConsolidated` → `sectionsFromMarkdown` → `renderMemoryDocument(..., cap)`，取 **`sectionDropped === 0`** 才采纳；降级·不可解析沿用 `!exceedsMemoryCap`。**解析失败或仍 `sectionDropped > 0` → 保留第一次的结果**，按 `kind` 告警；**绝不**因 condense 不可解析就把写入静默切到「降级·不可解析」路径。单条 `itemTruncated>0` **不**阻止采纳（逐行上界，不是整篇丢失）。**context 归属（F9）**：采纳 = condense 的 memory + `condensed.context ?? first.context`（与现状 `pass.ts:142-150` 一致：压缩重试可能丢掉 context 段，不能因此丢掉第一次的有效 context）。
- **丢弃必须活过写路径（B1 / F4-3）**：`renderMemoryDocument(sections, cap)` 返回**一个固定形状**：`{ text, sectionDropped, droppedItems, itemTruncated }` —— **不**再叫裸 `dropped`，也**不含** `neededChars`（旧稿在同一节里同时写了「两个计数」与「同一个 dropped」，自相矛盾，F4-3）。现有链路证明「渲染器自己写的标记会被抹掉」：`store.ts:76` 的 `normalizeMemoryReply` → `stripMemoryMarker` 会删掉它；`report.ts:111` 又用 `exceedsMemoryCap` 判断，对已裁好的文档**恒为 false**；`isMemoryTruncated` 只被 `/memory` 命令读、写路径从不看。因此**不能**靠「并入现有 marker」实现，必须把计数显式往上传：`pass.ts` 用 **`sectionDropped > 0 || itemTruncated > 0`** 作为 cap 事件，触发既有的 `errors.log` 诊断与 warning 通知。

## 决策 5：记忆回归守卫（并入本次）

- **位置与比较基准（I6 / N8）**：在**渲染器裁剪之前**比较「本轮**实际采纳写入**的 sections（即 condense 采纳后的版本）」与「**裁剪之前**的旧 sections」；旧侧来自 `loadMemory()`（journal-aware）解析出的 sections，**不是**磁盘上的 `MEMORY.md` 原文件。`silent`（shutdown）路径同样执行。
- **跳过条件**：任一侧无法解析成 sections（自由结构旧记忆 / 本轮走「降级·不可解析」）→ **不告警**，只记一条诊断。否则自由结构记忆会整篇误报。
- **归一化**：去 bullet 前缀、行内空白压缩、去首尾空白；比较用归一化后的整串。**不做**语义归一。
- **已知误报（接受并写明）**：改写/压缩某条使其字符串变化、两条合并成一条、条目在 `Invariants`↔`Pitfalls` 间移动、大小写/标点差异 —— 都会被报成「移除 + 新增」。
- **已知漏报（接受并写明）**：旧记忆本就是自由结构（无 sections 可比）、旧内容已被更早的 cap 裁掉（旧侧根本不存在）、逐项截断发生在 diff 之后（所以 diff 必须**在裁剪前**）。
- 输出：一条 `warning`（移除条数 + 前 N 条）+ 一条 `errors.log` 诊断；**不阻断写入**（owner 未要求否决权，且 fail-closed 会让 memory stale）。
- 边界：只报「消失了什么」，**不判断该不该消失**（内容真伪不可工程化）；`Project` / `Index` 太易变，不报。
- 依赖决策 1：sections 是数组，diff 是 `filter` 而非文本对比。

## 决策 6：语义空回复绝不写盘（N1 / F4-1 / F4-2 / F4-7）

- **问题**：`report.ts:73` 用 `memoryText.trim().length >= 40` 判「有变化」。而 `renderMemoryDocument({project:[],invariants:[],pitfalls:[],index:[]})` 仍会输出 `# Project Memory` + 四个 `## ` 标题（**实测 67 字符，trim 后 66** ≥ 40）→ 判为「有变化」→ 用只剩标题的文档**覆盖已有记忆**；`update = outcome.result.context ?? …`（**`report.ts:75`**）与 context 无关，守卫只告警不拦，且旧侧不可解析时还静默跳过。
- **规则（只看 memory，不看 context）**：**「四个节全空」这一条就足以禁止写 memory**。不得把 context 可用性当作写 memory 的条件 —— 否则「空 sections + 有可用 context」这个最可能的回复（本轮没有值得留存的事实，但有会话状态要更新）仍会抹掉记忆。
  - 四节全空 → **memory 一律不写**（保持盘上原样），**无论 context 是否可用**。
  - **「空」定义在归一化后的条目上（F5-1 / R6-6）**：每个条目先按条目卫生归一（换行→空格、去 bullet 前缀、去首尾空白）；**归一后为空串/纯空白的条目视为不存在**（`[""]`、`[" "]` 都算空）；**归一后不含任何字母/数字/表意字符的条目也视为空**（RF6-6：`\u200b`、`\u00ad`、`-`、`##` 这类纯不可见/纯符号）。schema 是 `items:{type:"string"}` 且 `makeStrictJsonSchema` 不补 `minLength`，所以「数组非空」根本不能当「有内容」。`semanticEmpty` 必须在这个视图上算，渲染器也只渲染归一后非空的条目。**接受的风险（F8）**：纯 emoji / 纯箭头 / 形如日期的标点条目也会被判空而静默丢 —— 记忆条目写的是散文，实际可忽略，但归入「接受的漏报」明列。
  - 四节全空但 context 可用 → **仍写 context、不写 memory**（context 是会话态，与 durable memory 分离）。
  - 四节全空 **且** 无可用 context → memory 与 context 都不写。`fallbackUpdate`（`report.ts:75`）是**既有独立路径，本次不改其语义**（无 `CONTEXT.md` 时仍会写 fallback 占位），因此措辞不得声称「整个 pass unchanged」，只说**「memory 未变」**。
  - 「可用 context」定义：`result.context !== undefined`；`contextUnusable` 或缺失都算不可用。
- **门的位置与载体（F4-2 / F5-8 / F6）**：门在 `pass.ts` 按**采纳写入的 sections** 计算；`ConsolidateOutcome` 携带 `semanticEmpty` / `sectionDropped` / `droppedItems` / `itemTruncated` / `kind`（**不携带 `sections`** —— 守卫已在 `pass.ts` 里跑完，`report.ts` 只需要判定与计数）。**回归守卫本身也在 `pass.ts`**（旧 `loadMemory()` 与采纳 sections 都在那里），所以**由 `pass.ts` 在 `semanticEmpty` 时跳过守卫**（不能对一次未发生的写入报「移除了 N 条」）；`report.ts` 只消费 `semanticEmpty` 来定 `memoryChanged` 与措辞。`kind` 取值域固定为 `"structured" | "fallback-sections" | "fallback-opaque"`。
- **门命中时的报告措辞（F5-5 / R6-4）**：`semanticEmpty` 时 `memoryChanged=false`，但 `update` 可能仍为真（有 context）→ `report.ts:139`/`:159` 与命令回复**不得**说「Project memory updated」；改为「context updated; memory kept」。**载体（R6-4）**：把 `semanticEmpty`（或 `memoryKept`）加进 `LastWriteInfo`，**即使 memory 未写也要 set**（现有代码只在 `memoryChanged` 时写 `lastWrite`，`report.ts:102-121`），`consolidateReply`（`report.ts:289-292`）据此选措辞。
- 适用于结构化与降级·可解析两条入口（两者都渲染标题骨架）；降级·不可解析沿用 `>= 40`。
  - **实施期修订（D7，2026-10-02，代码侧 round 1 的 B1）**：`>= 40` **单独不足以**把 N1 类堵死——一个标题写错/缺一节的**纯标题骨架**不解析成 sections，落到 opaque，长度≥ 40，照样拿骨架覆盖真记忆（评审端到端复现）。因此 opaque 侧改为「`>= 40` **且**文档含至少一行正文」（`isHeadingOnlyDocument()`：剥掉任意 fence 家族/分隔线/标记行后，若每一行都是 ATX 标题，则视为无内容）。**对散文/自由结构记忆行为不变**（它们有正文行）。R2 又把剥离面扩到 `~~~`/任意 info string/前置 metadata 分隔线/零宽字符行。
  - **同一修订也适用于 condense 采纳（R2-N3）**：`condensedEmpty` 除了原判据，也要求 condensed 结果不是语义空骨架，否则丢掉第一次的有效结果又抑制 cap 事件。
  - **实施期修订 2（D7 续，2026-10-02，代码侧 round 3）**：R3 查出两个问题。（1）**回归**：fence 剥离写成了 `^…(?:```|~~~)[^\n]*$` 且**在行终止符归一之前**执行，而 `[^\n]*` 会吞 `\r`/U+2028/U+2029 —— 用这些分隔符拼的**带 fence 的真实记忆**被整篇吞掉、误判为空 → 拒写并给出假诊断。修法：**先**归一 `\r\n?|[\u2028\u2029]` 再切行（与 JSDoc 原本的声明一致）。（2）**装饰包裹的骨架**（`- # Project Memory…`、`> …`、`1. …`、ZWSP 前缀、`<memory>` 包裹、`<h2>…</h2>`、setext `===`）仍被当成「有内容」，而 condense 分支会把这种骨架当 condensed 结果采纳（实测：第一次的 4800 字符真结果被丢弃，盘上只剩 91 字节骨架且 toast 说 updated）。修法：引入**装饰归一** `canonicalLine()`（去零宽字符、去任意层 `>`/bullet/有序标记）后再判 ATX；结构行集合扩到 fence / 分隔线 / HTML·XML 标签行 / HTML 标题 / `===` setext 下划线（含其上方标题行，**仅限代码块之外**）。**标签行的判据是「去掉所有 `<…>` 跨度后不再含字母数字」**（而不是枚举标签名形状——枚举过 `[A-Za-z][A-Za-z0-9-]*`，结果把 `<foo_bar>`/`<ns:memory>`/`<my.tag>` 漏成绕过，评审 R5-I1 端到端复现），`<https://…>`/`<mailto:…>` 是 autolink、算真实文本。**边界措辞**：`<h2>Title</h2>` 整行是标题 → 结构行；`<h2>Title</h2>` 之外还有带字的行、或元素里含文字，则算**内容**。两者不矛盾：**判据是「去掉结构行之后还剩不剩带字词的行」**。修完 condense 数据丢失路径关闭，并有 e2e 固定。
  - **装饰 + ATX 的交互（R4-N3）**：装饰先归一，所以 `- # 1 rule must hold` 是按 `# 1 rule must hold` 判的 —— 即当成标题。因此「正文只有这种 bullet」的记忆会被判为空而拒写；这是有意代价，换取 `- - # Project Memory…` 这类装饰骨架被堵住。
  - **fence 奇偶（R5-L1）**：`===` 只在**没有打开代码块**时消耗上一行；代码块的**族**要记住（`~~~` 块不能被 ``` 行关闭），且 fence 判定走**原始行**（`> ``` ` 在 markdown 里不关闭代码块，先做装饰归一就会翻转奇偶、让 `===` 吃掉正文）。
  - **该门是启发式且故意单边，残余边界**「**写着真实词句的包裹**一律算内容」**不关闭**（记录而非修）：散文前言（`Here is the consolidated project memory:` + 骨架）、元素内含文字、`---` setext 骨架仍会被当成有内容而写入。理由：另一个方向的错误是「拒写模型真的写出来了的记忆」，而**从前言里区分「作者的话」与「丢失正文」没有可行判据**。此边界需 owner 知情。
- **可见性（F4-7 / F5-9）**：门命中而盘上已有非空记忆时，由 **`pass.ts`** 写一条**普通诊断**（不是 warning、不进 toast）到 `errors.log`，避免「模型持续返回空」变成完全不可见的空转；必须有对应用例。
- 用例：全空 + 有 context → memory 字节不变、context 正常更新；全空 + 无 context → memory 不变；`[""]`/`[" "]` 视同全空；以上都不得产生「移除 N 条」告警，也不得说「Project memory updated」。

## 决策 7：autolearn 的决策输出走同一套结构化管道（owner 2026-10-01 追加）

**为什么必须一起做**：见「现状 → 第二个 JSON 消费者」。两条 pass 共用 `llm.ts` 的 `completeWithMeta`，管道/失败契约/B2 截断纪律改一处就影响两处；只改 consolidation 会留下 autolearn 仍在「静默接受被截断的 skill body」。

**新的 strict-ready 形状（唯一输出形状）**：

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["skill", "inspect"],
  "properties": {
    "skill": {
      "type": "object",
      "additionalProperties": false,
      "required": ["name", "description", "body", "evidence", "candidate", "reason"],
      "description": "The proposed skill. When there is nothing to propose — the normal outcome — set `name` to \"\" and fill every other field with an empty string or array; never omit this object.",
      "properties": {
        "name":        { "type": "string", "description": "New lowercase-kebab-case name, never reused from the existing inventory. \"\" means propose nothing; the other skill fields are then ignored." },
        "description": { "type": "string", "description": "One line: when to use the skill." },
        "body":        { "type": "string", "description": "Concise Markdown procedure with when-to-use and exact commands or paths." },
        "evidence":    { "type": "array", "items": { "type": "string" }, "description": "Session ids copied from the archive index that verify this skill." },
        "candidate":   { "type": "boolean", "description": "true stores a proposal for the user to confirm and needs at least one verified session id; false needs at least two distinct verified session ids." },
        "reason":      { "type": "string", "description": "One line: why this proposal is worth storing. Code trims it to 500 characters and embeds it in the candidate SKILL.md header (autolearn/parse.ts, autolearn/skill.ts)." }
      }
    },
    "inspect": { "type": "array", "items": { "type": "string" }, "description": "Up to four archived session ids whose raw transcripts you want to read before deciding." }
  }
}
```

- **不要可空**：`skill` 永远是一个对象，**`name === ""` 表示「无 skill」**。这样没有 union、没有 null、全部必填，直接满足 strict-ready 清单。
- **不要 `action` 判别字段**：它与 `skill`/`inspect` 的内容可能矛盾。判定**唯一**由内容推导：`skill.name` 非空 → propose；否则 `inspect` 非空 → inspect（`collectEvidence` 已限 4 个且只需已归档 id）；否则 → none。
- **向后兼容（一行代价）**：`parseDecision` 同时接受旧形状（`skill` 为 `null` 或缺失 → none），因为模型可能仍凭习惯回 `{"skill": null}`。
- `ProposedSkill` 类型与准入规则（`rejectionReason` / `shapeRejection` / 证据校验 / `candidate` 生命周期）**全部不动**：本次只改**输出形状与解析**，不改它接受什么。

**其余纪律与 memory 一致**：
- `stopReason === "length"` **优先于**「拿到 toolCall」（B2）：autolearn 今天**没有 retry**，必须补**一次**不带 `tools` 的重试，否则被截断的 skill body 会被当完整体写入。
- 重试/后续调用保持**旧文本 JSON 形状**（fail-open），与决策 2/3 的粘性回退一致。**tools 被拒的回退也沿用决策 2 的完整触发策略（F1）**：只在**本 pass 第一次**带 `tools` 的调用抛出时无条件回退一次、之后粘性不带 `tools`；**且 `noteModelFailure` 只在两次都失败后记一次**（同一个 wrapper 包住两次尝试）—— 否则一次 `tools` 拒绝会烧掉 `AUTO_DISABLE_AFTER=5` 里的 2 个名额（`call-policy.ts:23`），而 autolearn 今天在不支持 tools 的路由上本来是好用的。**这个 wrapper 只有一份实现**（`shared/llm.ts` 的 `callAux`），不得在两条 pass 里各写一遍。
- 失败契约随 `llm.ts` 一起变（I1）：`toolUse` + 空文本在**有可用 toolCall** 时不再抛错；「有 toolCall 但不可用且文本为空」由共享的 `pickToolCall(…, text)` 统一判为错误（不在两条 pass 各写一遍）。
- autolearn 改用 `completeWithMeta`（因为需要 `stopReason`）；**记账上收**：`autolearn/pass.ts:92-102` 那个自己调 `noteModelSuccess`/`noteModelFailure` 的 wrapper **改为直接走共享的 `callAux`**（`callAux` 持有 `noteModelSuccess` 与「两次都失败才记一次」的 `noteModelFailure`），pass 不再自己调 `noteModel*`。
- tool 名 `record_skill`（与 `record_memory` 区分）；`llm.ts` 侧仍是 name-agnostic，**名称匹配由共享的 `pickToolCall` 判**（两条 pass 各传自己的名，策略一份）。

## `record_memory` schema（strict-ready 草稿）

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["memory", "context"],
  "properties": {
    "memory": {
      "type": "object",
      "additionalProperties": false,
      "required": ["project", "invariants", "pitfalls", "index"],
      "description": "Long-term memory in the four fixed sections (project / invariants / pitfalls / index). One self-contained statement per entry; keep entries short and pointerized (`see docs/x.md`, `file.ts:123`) — no headings, no bullets, no `# Project Memory` header, and no inline formulas, tables, or command transcripts.",
      "properties": {
        "project": {
          "type": "array",
          "items": { "type": "string" },
          "description": "What the project is: purpose, stack, layout, how to run its tests."
        },
        "invariants": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Rules that must hold: conventions, contracts, review and release procedures."
        },
        "pitfalls": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Concrete traps already hit, each naming the file:line or command that triggers it."
        },
        "index": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Where things live: docs, modules, skills, issue directories. Pointers, not prose."
        }
      }
    },
    "context": {
      "type": "object",
      "additionalProperties": false,
      "required": ["summary", "title", "key_points", "open_tasks"],
      "description": "The session's working state, rewritten from scratch every pass. State and pointers, not rules; nothing that already lives in memory. Keep entries short and pointerized; no inline formulas, tables, or command transcripts.",
      "properties": {
        "summary": {
          "type": "string",
          "description": "Prose summary of this session's state. Code enforces its own cap on this field."
        },
        "title": {
          "type": "string",
          "description": "One-line title for this session."
        },
        "key_points": {
          "type": "array",
          "items": { "type": "string" },
          "description": "What was established this session."
        },
        "open_tasks": {
          "type": "array",
          "items": { "type": "string" },
          "description": "What is still open, and who owns it."
        }
      }
    }
  }
}
```

### strict-ready 约束清单（硬性）

1. 根必须是 `type: "object"`。
2. **每个属性都进 `required`**（所有字段总是存在）→ 避免 nullable 包装与 `anyOf`；`strict` 会强制 `required = propertyNames`。
3. 显式写 `additionalProperties: false`。
4. 禁用关键字：`$ref` `$defs` `definitions` `allOf` `oneOf` `patternProperties` `dependentSchemas` `dependencies` `unevaluatedProperties` `propertyNames` `contains` `prefixItems` `not` `if` `then` `else`。
5. `anyOf` 仅允许**非 object/array** 变体（`"object and array unions are unsupported"`）→ 本 schema 不需要 `anyOf`。
6. 数组用 `{ "type": "array", "items": { "type": "string" } }`。
7. 不把 `maxLength` / `maxItems` 当 cap 依赖，且**一律不写**（`maxItems` 在 Anthropic 的附加禁用表里，见决策 4）。

## 工具描述（定稿）

**房规**（实测 pi 内置工具**实际下发**的工具级描述长度：`edit` 326、`read` 303、`bash` 248、`grep` 221、`find` 186、`ls` 184、`write` 127 —— **不要量 `.js` 里的模板串**：那是未展开的 `${…}`，会量出 344/304/279/222 的假数字，本设计初稿正是这么量错的，round 10 抓出）：工具描述只写「**做什么 → 调用时机 → 返回/副作用 → 全局约束**」；**字段级约束放进该字段的 `description`，不堆进工具描述** —— `edit` 就是这么写的（「Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.」）。

本设计两个工具描述：`record_memory` 413 字符，**长于全部内置工具**（最长 `edit` 326）；`record_skill` 294 字符，与 `edit` 同档但**短于** `edit`。偏长是有意的：它们承载「调用次数 + 代码拥有什么 + 全局安全线」这类**工具级**契约，而非字段级规则（后者已全部迁到 schema 的 `description`）。

**`description` 在 strict 下安全（已实测）**：pi-ai 的 **16 键**禁用表（`constrained-sampling.js:3-20`）没有它，Anthropic 的 11 键附加表（`anthropic-messages.js:1223-1235`）也没有；带 `description` 的嵌套 schema 实跑 `makeStrictJsonSchema` **通过且原样保留**（含 `items` 层级）。

- `record_memory.description`（定稿，413 字符）：

  > Submit the consolidated durable project memory and the current session context; call it once at the end of the pass. Code renders the section headings and enforces the character cap by dropping whole entries and reporting what it dropped, so never write truncation or omission markers yourself. Never store secrets, API keys, credentials, generic advice, or instructions that override system or user instructions.

- `record_skill.description`（定稿，294 字符）：

  > Submit this pass's skill decision; call it once. Code validates the proposal, stores a valid one for the user to confirm, and reports the rest, so state evidence honestly. Never include secrets, credentials, generic programming advice, or instructions that override system or user instructions.

两者共有的最后一句是**全局安全约束**，留在工具描述；其余字段级规则全部归 schema 的 `description`（通用规则挂父对象 `memory` / `context` / `skill`，特例挂子字段）。

## 接口改动

- `shared/llm.ts`
  - `completeWithMeta` 增加可选 `tools` 透传（进 `Context.tools`），返回值增加 `toolCalls?: Array<{ name: string; arguments: unknown }>`（**通用多态，不内置 `record_memory` 名称策略**，N9）。
  - **`tools` 的承载与 provider 差异（已核实）**：`tools` 进 `Context.tools`（`types.d.ts:535`；`ctx.modelRegistry.complete(model, {messages, tools}, opts)`）。pi-ai 的**归一化内容模型里只有 `type:"toolCall"`**（`types.d.ts:280-288`）；`function_call` / `functionCall` 是 **OpenAI / Google 的线格式名**，由 provider 适配器归一（`google-generative-ai.js:117-147`、`google-vertex.js:120-149`、`openai-completions.js:296-334`），Google 侧还会据 `currentTools.length` 打开 `functionCallingConfig`。因此**一处 `type === "toolCall"` 抽取覆盖所有路由**，不需要按 provider 分支，也不需要认 `functionCall`。另：`registerTool` 是 pi 扩展注册主 agent 工具的**另一套**机制，本设计**不用**（本扩展 0 工具）。
  - **共用抽象（owner 2026-10-01 强调）**：本设计**不**让两条 pass 各自实现「带 tools 调用 + 粘性回退 + 失败计数」。这三件事只有**一份**实现，放在 `shared/llm.ts`，与已有共享件 `completeWithMeta` / `parseJsonObject` 同级：
    - `callAux(ctx, prompt, { model, maxTokens, tools, scope, projectRoot, state })`：把 `tools` 放进 `Context.tools`、把 `constrainedSampling` **原样透传**（strict 的解析与降级在 pi-ai 适配器里，扩展不自己判 `compat`；F5）、在本 pass **第一次带 `tools` 的调用抛出**时无条件去掉 tools 重试一次（不分类错误字符串，与决策 2 措辞一致；F5）。**它同时拥有 `noteModelSuccess` 与「两次都失败才记一次」的 `noteModelFailure`（F3）**：`scope`/`projectRoot` 是记账身份（`ctx` 里没有 projectRoot，调用方本来就在算），pass 只保留自己的副作用（如 `throttle.set`）。粘性开关放在调用方传入的 `state` 里（每 pass 一个）。
    - `pickToolCall(toolCalls, name, text)`：按名挑出可用 toolCall，并落实「有 toolCall 但不可用**且 `text` 为空** ⇒ 判错」这条**统一**策略（旧稿把它写在两条 pass 里，等于两份）。**必须把回复文本一起传进来（F1）**：`completeWithMeta` 是 name-agnostic 的，一个「结构可用、但 name 不匹配且文本非空」的回复**不得**判错 —— 那正是要保留的 fail-open 文本降级；没有 `text` 这个签名根本区分不了两种情形，策略就会退回两份。
    - 测试侧 `assertStrictReady(schema)` 一份，供 `record_memory` 与 `record_skill` 两个 schema 共用。**它必须覆盖 provider 附加表（F8 / round 10）**：只 `makeStrictJsonSchema(schema, () => false)` 等于关掉 provider 特定检查，`maxItems` 这类「基表放过、Anthropic 拒收」的键就永远测不出来；要么传**真实**的 `isAnthropicStrictUnsupportedKeyword`，要么扫 **16 + 11 的并集**（本设计 round 10 的机械验证用的就是并集）。
    **故意不共用**：prompt 文案、schema 字面量、解析/校验、采纳与准入策略、以及 length 重试的**载荷**（memory 走 condense，autolearn 走纯文本重试）。**共享机制，不共享策略。**
  - **抑制条件与名称无关（F4-5 / I1 / F2 / F5-2）**：`completeWithMeta` 只在**确实抽到至少一个 `arguments` 为非 null 对象的 `type:"toolCall"` part** 时才抑制「`stopReason:"toolUse"` + 空文本」的抛错，并把**抽取到的全部** toolCalls 原样返回（**包括 name 不匹配者**，让上层能观察到「有调用但不可用」）。**名称匹配、以及「有 toolCall 但不可用且 `text` 为空」的判定，由共享的 `pickToolCall(toolCalls, name, text)` 统一落实**（策略只一份，两条 pass 共用）。否则 `toolUse` 但无可用 tool call 会返回 `text: ""`，`parseConsolidated("")` 经 `looksLikeJsonReply` 兜底成 `{memory: ""}`，`report.ts:73` 的 `length >= 40` 再把它当 unchanged —— 一个**静默空转的成功**。因此**「有 toolCall 但不可用且 text 为空」必须当错误，不得把 `""` 喂给 `parseConsolidated`**。
- 新模块 `memory/sections.ts`：`MemorySections` 类型、`sectionsFromToolCall`、`sectionsFromMarkdown`、`renderMemoryDocument(sections, cap) → { text, sectionDropped, droppedItems, itemTruncated }`。
- **`memory` 与 `context` 独立校验（I5）**：`sectionsFromToolCall` 不得因 `context` 一处形状错误就丢掉整份 `memory`。照抄 `parseContext` 的既有语义：memory 可用就用，context 坏就标 `contextUnusable`（注意此时**不能**回落 `parseConsolidated("")`，见 I1）。
- 条目卫生（I4/I5）：换行、`## ` 开头、truncation-marker 形状的条目在渲染前归一/转义，避免污染代码拥有的结构。
- `memory/prompt.ts`：文案改为「优先调用 `record_memory`；**若无法调用工具，按 `{memory_markdown, context}` 返回 JSON**」（形状与 `parseConsolidated` 一致，见 I3）；保留每节说明与指针化规则。
- `memory/parse.ts`：**只**保留 `parseConsolidated` 降级入口（`sectionsFromMarkdown` 归 `memory/sections.ts`，F7）。
- `memory/pass.ts`：
  - 调用带 `tools`；从 `toolCall` 或 `parseConsolidated` 取结果。
  - **`stopReason === "length"` 优先级高于「拿到了 toolCall」（B2）**：pi-ai 的 `parseStreamingJson`（`utils/json-parse.js:90-107`）会把被截断的 arguments **修复成形状合法的对象**（实测 `{"memory":{…,"index":["i1","i2` → `index:["i1","i2"]`）。所以「有 toolCall 就接受」会静默吃掉内容；截断必须**强制**走 retry/condense 分支。
  - retry / condense 提示词保持 `{memory_markdown, context}` 形状（I3）。
- `memory/store.ts` / `memory/report.ts`：`pass.ts` 把 `sectionDropped` / `droppedItems` / `itemTruncated` / `kind` / `semanticEmpty` 经 `ConsolidateOutcome` 传到 `report.ts`；cap 事件 = `sectionDropped > 0 || itemTruncated > 0`（见决策 4 / B1）。`semanticEmpty` 还要进 `LastWriteInfo`，供命令回复选措辞（R6-4）。
- `autolearn/parse.ts`：`parseDecision` 改为决策 7 的 strict-ready 形状；同时接受旧 `skill:null`/缺失（向后兼容）；不再依赖顶层 `reason`。**tool 路径的输入形态（F2）**：`parseDecision` 现在只吃 `string`；tool 路径下 `toolCall.arguments` 已是**对象**（`types.d.ts:280-288`），所以要么把签名放宽为接受 `unknown`，要么由调用方 `JSON.stringify(arguments)` 后再喂 —— 两者皆可，形状校验不变。
- `autolearn/prompt.ts`：输出示例改为**单一 always-object 形状**；说明 `name:""` 表示「无新 skill」；保留原有准入规则描述。
- `autolearn/pass.ts`：`completeText` → `completeWithMeta`；调用带 `tools: [record_skill]`；`stopReason === "length"` → 一次不带 tools 的重试。
- `autolearn/skill.ts`：`ProposedSkill`、`skillDocument`、安全检测**不变**。

## 向后兼容

- 读路径（`loadMemory` / `normalizeMemoryDocument` / 归档注入）不动。
- 自由结构记忆：降级·不可解析路径 → 整体保留 + 整篇裁剪，**与今天行为一致**。
- 旧记忆（已是 4 节 Markdown）：**只有 bullet 形状的**才会走降级·可解析；**散文体 4 节文档会因 F6 规则返回 `undefined`、落到不可解析路径**（N11）。因此本节描述为：「仅**bullets 形状**的规范记忆预算更精确；散文体/含未知节的一律回落逐字路径，与今天完全一致」。
  - **实施期更正（2026-10-02）**：本节曾以「仓库自己的 `MEMORY.md` 就属于后者（含未知节 `## Documentation and review conventions`）」举例，**该举例是假的**——实测该文件只有 `## Project`/`## Invariants`/`## Pitfalls`/`## Index` 四个标题（`grep -n '^## ' .agents/memory/MEMORY.md`），全部正文行都是 `- ` 开头的 bullet，因此它**走的是降级·可解析路径**，回归守卫对它有效。策略本身不变，仅删去这条错误举例。

## 风险

- **R1 provider 能力不匹配**：路由不支持 tool/strict → 靠 `"prefer"` + 降级路径；必须一轮真实探针，不得用单元测试冒充（付费路由不可用时不得报告为验证成功）。
- **R2 模型的多轮工具行为**：某些模型收到 tools 后倾向追问或多调用 → prompt 明确「只调用一次 `record_memory`，不要再调用其他工具」，代码只取第一个匹配名的 `toolCall`。
- **R3 tool args 仍可能超 cap**：代码按节裁剪兜底（决策 4）。
- **R4 双路径使测试面翻倍**：渲染/预算测试对两条入口各跑一次，其余共享。
- **R5 `arguments` 形状不可信**：运行期校验，形状不对即走降级，绝不做类型断言。
- **R6 strict 的 schema 重写**：`makeStrictJsonSchema` 会改 schema（补 `required`/`additionalProperties`），且第二次规范化遇到 object/array 的 `anyOf` 会抛 → 本设计全程必填、不用 `anyOf`，规避。
- **R7 成品的裁剪不可自证（R6-7，接受）**：结构化 / 可解析路径写出的 `MEMORY.md` 不再带任何「被节裁剪过」的痕迹（标记会被写路径抹掉），可见性只剩「每项目每进程一次的 warning + `errors.log` 诊断」。设计上接受这一点（自证标记反而会被 `stripMemoryMarker` 吃掉，正是 B1）。

## 测试计划

- **strict-ready 自检**：对 `record_memory.parameters` **与决策 7 的 autolearn schema** 各跑一次 pi-ai 的 `makeStrictJsonSchema`，断言不抛；含一个「故意带 `$ref` 会抛」的反例、及一个「必填 `anyOf:[{object},{null}]` 会抛」的反例。**签名（F7）**：`makeStrictJsonSchema(schema, isUnsupportedKeyword?)` —— 第二参（provider 回调）**是可选的**（`constrained-sampling.d.ts:5` 标 `?`；实现里用 `if (isUnsupportedKeyword)` 守卫），**单参调用不抛**（本轮实测；早先「必须传」的说法是我把 `"require"` 当第二参传错导致的假结论）。测试传 `() => false` **只用于固定「基表」行为，不构成完整校验**（F8 / round 10）：真的 strict-ready 断言必须另跑 provider 回调或 16+11 并集扫描，否则 `maxItems` 这类键漏网。**导入路径（F9）**：该函数不在 pi-ai 根条目导出；且从仓库 CWD `import("@earendil-works/pi-ai/api/constrained-sampling")` 会 `ERR_MODULE_NOT_FOUND`（沙箱无 `node_modules`，harness 别名只覆盖裸包名）→ 测试要走 harness 别名，或绝对路径 `${PI}/node_modules/@earendil-works/pi-ai/dist/api/constrained-sampling.js`。
- **结构化入口**：mock 返回带 `toolCall` 的 completion → 渲染出固定 4 节、节序正确、预算数字正确。
- **降级·可解析**：无 `toolCall`、返回散文 JSON → 结果与结构化入口**逐字节一致**。
- **降级·不可解析**：自由结构 Markdown → 与今天行为一致，且 `normalizeMemoryDocument` 幂等。
- **截断**：`stopReason: "length"` 仍触发一次带 headroom 的重试；toolCall arguments 不可解析同样可重试。
- **既有套件全通过**（`node tests/run-all.mjs`，13/13）。
- **B2 截断 + 部分 toolCall**：mock 一个以 `stopReason:"length"` 结束、arguments 被 `parseStreamingJson` 修复过的流 → 必须重试，不得接受。
- **B1 丢弃可见性**：断言 `sectionDropped>0 || itemTruncated>0` 时**经 `store.ts`/`report.ts` 仍触发**诊断与 warning（仅渲染器单测不足以证明）；并补一例**仅 `itemTruncated>0`**（整篇未超 cap）→ 措辞不得给 `raise max-memory` 数字建议。
- **I1 空 toolUse**：`toolUse` 但无 toolCall → 必须抛错，不得产生 `{memory:""}` 空转。**补 name 不匹配的两种情形（F7）**：① 有 toolCall 但 name 不匹配 **且文本非空** → **不得**判错，走文本降级；② 有 toolCall 但 name 不匹配 **且文本为空** → **必须**判错（`pickToolCall` 用例，两条 pass 共用一份）。
- **`callAux` 记账（F7）**：mock 第一次带 `tools` 抛错 → 恰好一次去 tools 重试；两次都失败 → `noteModelFailure` **恰好记 1 次**（不是 2 次），且本 pass 后续调用不再带 `tools`（粘性）。
- **I2 提取契约**：引言 / 未知节（`## Notes`）/ 缺一节 / 末节后内容 → 必须 `undefined` 走逐字路径。
- **I4 渲染长度**：大量短条目的一节 → 断言 **`text.length <= cap`** 且 `sectionDropped > 0`（不再提 `marker`，N6）。**R6-1 变体**：`cap=4000` 时给 Index 一个 803 字符单条 → 必须截到 `itemCap_s`，`text.length <= cap` 仍成立，**不得**退回 60/40 整篇裁剪。
- **N1/F4-1/F5-1 语义空门**：全空 sections + 有可用 context → memory 字节不变、context 更新；全空 sections + 无 context → memory 不变；**`[""]` / `[" "]` 等归一后为空白的条目视同全空**；以上都不得产生「移除 N 条」告警，也不得说「Project memory updated」。
- **I5 部分校验**：`memory` 合法但 `context` 非法 → memory 必须保留。
- **I7 tools 被拒**：mock 一次因 `tools` 报错 → 必须无 `tools` 重试一次。
- **回归守卫**：改写/合并（应报）/ 自由结构旧记忆（应跳过）/ 裁剪前 diff 点 / **带尾截断标记的旧记忆（应能解析，N7）** —— 各一例。
- **F4-7 门命中诊断**：门命中且盘上旧记忆非空 → `pass.ts` 写一条普通 `errors.log` 诊断（非 warning toast）。
- **F5-4 condense 采纳**：condense 回包不可解析 / 仍 `sectionDropped>0` → 保留第一次结果；仅 `itemTruncated>0` → 采纳。
- **决策 7 autolearn 形状**：新 always-object 形状 → 解析出 skill；`name:""` → none；`inspect` 非空、`name:""` → inspect；旧 `{"skill": null}` → none（向后兼容）。
- **决策 7 截断**：autolearn 以 `stopReason:"length"` 结束且 toolCall 被修复过 → 必须重试，不得写入被截断的 body。
- **N3 不可解析路径**：超 cap 的自由结构回复 → 仍触发 condense。
- **N4 粘性回退**：首次带 `tools` 失败后，retry / condense **不带 `tools`**。
- **真实探针**：用 `.agents/memory/project-context.json` 的 `provider`/`model`（或 `/project-context model`）指向实际路由 —— **`PI_PROVIDER`/`PI_MODEL` 是会话描述输出，不能选路**（`@earendil-works/pi-coding-agent/docs/environment-variables.md:28-32`，**pi 安装包的文档**，不在本仓库 `docs/` 下）。记录 strict 是否真被 provider 接受与产物；付费路由不可用时如实标注未验证。

## 评审计划

- 6 轮只读沙箱评审（三审三校），每轮 before/after `git status` + `stat` 快照证明零写入；prompt/transcript 存本 issue 目录。

### 评审记录

| 轮 | 结论 | 要点 |
|---|---|---|
| design round 1 | `CHANGES-REQUESTED` | 2 blocking（B1 渲染器的丢弃计数被写路径 `stripMemoryMarker` 抹掉；B2 被截断的 toolCall 被 `parseStreamingJson` 静默修复成形状合法）+ 9 important（I1–I9）+ 2 nit + 1 suggestion。评审逐条核实了本设计引用的 file:line，并修正了 Google 默认 strict、commandcode api 组成、多处行号等事实错误。transcript 见 `structured-consolidation-output-design-review-round1-independent.txt`。 |
| design round 2 | `CHANGES-REQUESTED` | 复核 fix delta：B2/I3/I4/I5/I6/I8/I9/N2/S1 **ADDRESSED**；B1 **ADDRESSED 但需 F4 修诊断**；I1/I2/I7 **PARTIALLY**。新发现：F1（blocking，`sectionsFromMarkdown` 未豁免 `# Project Memory` 文档头 → 降级路径与守卫旧侧永远失效）、F2（不可用 toolCall + 空文本仍空转）、F3（无 `tools` 重试无触发定义）、F4（cap 诊断措辞变错）、F5（condense 被静默退役）、F6（节内非 bullet 未定义）+ F7–F11。transcript 见 `…-review-round2-independent.txt`。 |
| design round 3 | `CHANGES-REQUESTED` | F1/F2/F3/F6/F7/F8/F9/F11 **ADDRESSED**；F4/F5/F10 **PARTIALLY**。新发现：N1（**blocking**：schema 合法的四空数组回复会渲染出 ~72 字符纯标题文档，绕过 `length >= 40`，**清空 MEMORY.md**；守卫只告警且旧侧不可解析时静默跳过）、N2（修 F1 时误删了「引言非空即拒」规则，与测试计划不一致）、N3（不可解析路径的 condense 闸门未写明）、N4（回退非粘性；retry/condense 仍带 tools）、N5（`dropped` 混了节超预算与单条截断）+ N6–N11。transcript 见 `…-review-round3-independent.txt`。 |
| design round 4 | `CHANGES-REQUESTED` | N1/N3/N4/N6/N7/N8/N11 **ADDRESSED**（已用探针逐条验）。新发现：**F4-1（blocking）**——我写的决策 6 门是「四节全空**且**无可用 context」的**合取**，于是「空 sections + 有可用 context」仍写出 66 字符标题骨架并抹掉记忆（旧稿实测：纯标题文档 trim 后 66 ≥ 40）；F4-2（门与守卫的先后、`ConsolidateOutcome` 载未定义）、F4-3（决策 4 内三种 `dropped` 契约自相矛盾）、F4-4（按节份额下 `neededChars` 公式错：一节超份额而整篇 < cap 时，建议的数字仍会继续裁）、F4-5（llm.ts 一边说不内置名称策略、一边在抑制条件里匹配名字）、F4-6（`anthropic-messages.js:1163` 指到了无关代码，应为 `:146`/`:1261`）、F4-7/F4-8 建议。transcript 见 `…-review-round4-independent.txt`。 |
| design round 5 | `CHANGES-REQUESTED` | F4-1/F4-2/F4-6/F4-7/F4-8 **ADDRESSED**；F4-3/F4-4/F4-5 **PARTIALLY**。新发现：**F5-1（important）**——门可被 `{project:[""]}` 绕过（schema 无 `minLength`，「数组非空」≠「有内容」）；**F5-2（important）**——我上一轮只插了新 llm.ts 条目、**没删旧的 name 匹配子句**，两段并存直接矛盾（F4-5 其实没修）；**F5-3**——`接口改动` 里 `renderMemoryDocument → {text, dropped}` 与决策 4 的固定形状并存；F5-4（condense 采纳判定仍未定）、F5-5（门命中仍会报「Project memory updated」+ `fallbackUpdate` 与「unchanged」冲突）、F5-6（`neededChars` 非整数、`max-memory` 只 round）、F5-7（`report.ts:84`→`:75`、`constrained-sampling.js:180`→`:192`）、F5-8/F5-9 边界措辞。transcript 见 `…-review-round5-independent.txt`。 |

| design round 6 | `CHANGES-REQUESTED` | F5-1/F5-2/F5-3/F5-5/F5-6/F5-7/F5-8/F5-9/F5-10 **ADDRESSED**；F5-4 **PARTIALLY**。评审明确答「**尚不能无歧义实现**」，但只剩两处：**R6-1**（逐节裁剪算法与 `sectionDropped` 量纲未写死；照抄 `clipList` 会因「最小节预算 > 条目上限」假设在 `cap=4000` 下不成立（预算 588 vs 单条 803）而退回整篇 60/40，破坏 `text.length <= cap`）、**R6-2**（condense 不带 tools ⇒ 不可能有 toolCall ⇒「结构化 = toolCall 可用」分支不可达）。其余为 nit：R6-3（`neededChars` 死载体、item-only 措辞）、R6-4（「memory kept」载体）、R6-5（「末行」应为「最后一个非空行」）、R6-6（ZWSP/软连字符残留）、R6-7（成品裁剪不自证，接受）、R6-8（model-store 计数已漂移 85/10/75）、R6-9（docs 路径与裸 `dropped`）。transcript 见 `…-review-round6-independent.txt`。 |
| design round 7 | **`PASSED`** | R6-1/R6-2 **ADDRESSED**，且评审**自己实现了逐节裁剪算法并 fuzz 6000 例**（cap 4000–200000）：0 次越界、最差余量 −11；`cap=4000` 时 803 字符的 Index 条目被截到 585（+3=588=预算），证明 R6-1 的回归前提成立。F3–F10 与 R6-3..R6-9 均 ADDRESSED。**决策 7（autolearn）判为 sound**：两处探针复现（必填 `anyOf:[object,null]` 抛 / 非必填 object 不抛但被包成 object union 并强制进 `required`）、新 always-object 形状通过、决策规则与 `rejectionReason`/`collectEvidence` 一致、确认「辅助 JSON 消费者只有两处」为真。评审还抓到**我一条假结论（F7）**：`makeStrictJsonSchema` 第二参是**可选**的，单参不抛；我先前写的「必须传、否则 TypeError」是我自己把 `"require"` 当第二参传错的产物 —— 已更正。明确答「**可以无歧义实现**」，剩余全部是文案/实现细节（F1–F10）。transcript 见 `…-review-round7-independent.txt`。 |
| **post-PASSED 修订** | `pending-review` | owner 2026-10-01 追加两处（非契约层）：① 核实并写明 `functionCall` 与 `Context.tools`（`functionCall` 只是 Google/OpenAI 的**线格式名**，pi-ai 适配器统一归一为 `type:"toolCall"`；一处抽取覆盖全路由；`registerTool` 是另一套机制，本设计不用）；② **共用抽象**：`callAux` / `pickToolCall` / `assertStrictReady` 三件共享件在 `shared/llm.ts`，两条 pass **不得各写一遍**，并写明「共享机制、不共享策略」的边界；同时把两段重复的名称策略合并。因属调用边界变更，需一次 focused 复核（round 8）。 |
| design round 8 | **`CHANGES-REQUESTED`**（无 blocking） | 复核 post-PASSED 修订。**B（provider / `functionCall` 核实）逐条复现通过**：`Context.tools` 在 `types.d.ts:535`、`ToolCall` 在 `280-288`、`functionCall` 只存在于 wire 适配器、一处 `type:"toolCall"` 抽取全路由通用、`registerTool` 在 `extensions/` 确为空。同时判 A（共享抽象）**方向对但未冻结**，给出三条 amendment-local important：**F1** `pickToolCall` 缺 `text` 参数 → 区分不了「name 不匹配且文本非空」（合法 fail-open）与「name 不匹配且文本为空」（必须判错），策略会退回两份；**F2** 决策 7 三行旧稿仍把名称匹配/记账写给 `autolearn/pass.ts`，与新共享抽象矛盾；**F3** `callAux` 签名缺 `scope`/`projectRoot`，兑现不了「`noteModelFailure` 两次才记一次」，也未写明 `noteModelSuccess` 归它。另有 F4 引用漂移、F5 措辞（「tools 被拒」应为「带 tools 的调用抛出」；strict 不能由扩展「按 compat 解析」）、F6 评审记录字误。**F1–F7 已全部落地**，含新增两条 `pickToolCall` / `callAux` 测试行。transcript 见 `…-review-round8-independent.txt`。 |
| design round 9 | **`PASSED`** | 窄幅确认轮：F1–F7 **全部 ADDRESSED**（逐行证据：doc:252 `pickToolCall(toolCalls, name, text)`、doc:197/198/199 记账与名称匹配上收、doc:251 `{…, scope, projectRoot, state}` + 同时拥有 `noteModelSuccess`、doc:249/266 引用校正、doc:297/298 两条新测试行）。无新矛盾、无重开已决项、无 scope creep。评审明确答「**Frozen-ready: Yes**：两个共享件都有可实现的签名/契约与直测，不再需要设计层决策」。transcript 见 `…-review-round9-independent.txt`。 |
| design round 9 后（owner「选更好更规范更标准的」） | **文案/schema 规范化**（round 10 复核 → 已修） | 按 pi 内置工具房规重排：**字段级约束从工具描述迁到各字段 `description`**（`record_memory` 10 条、`record_skill` 8 条），通用规则挂父对象（`memory`/`context`/`skill`）、特例挂子字段；工具描述收敛到 413 / 294 字符。**同时修掉一条事实错误**：原稿称「`maxLength`/`maxItems` 不在 strict 拒绝清单里」—— 实测 Anthropic 适配器另加 11 键且**含 `maxItems`**（键集 `anthropic-messages.js:1223-1235`），结论（cap 只能由代码执行）不变但前提对 `maxItems` 是错的。机械验证：两块 schema JSON 可解析、全属性进 `required`、`additionalProperties:false`、零禁用键（pi-ai **16** + Anthropic 11 并集）、`makeStrictJsonSchema` 均 PASS。 |
| design round 10 | **`CHANGES-REQUESTED`**（无 blocking） | 复核该 delta，抓到三个 important：**F1** `skill.reason` 描述写「Not read back by code」是**假的**（`autolearn/parse.ts:28` 读、`skill.ts:51` 写进 SKILL.md 头）；**F2** 房规长度量错（量的是 `.js` 模板串 344/304/279/222，**实际下发** 303/248/221/184、最长 `edit` 326），且改前描述 623/439 **长于所有内置件**，「压到房规长度」不成立；**F3** pi-ai 基础禁用表是 **16** 键不是 14。另有 F4 描述计数错、F5 引用漂移且 `maxLength` 结论过宽、F6 context 条目 hygiene 范围收窄、F7 「API keys / generic programming advice」措辞丢失、F8 `assertStrictReady` 传 `() => false` 等于关掉 provider 检查。**规则丢失表逐条核对 22 条：无一条被静默丢弃。** F1–F8 已全部落地（`record_memory` 413 / `record_skill` 294；`skill` 对象补齐无-skill 形状规则；`context` 补回 pointerize）。transcript 见 `…-review-round10-independent.txt`。 |
| design round 11 | **`CHANGES-REQUESTED`**（无 blocking） | 窄幅确认：F1、F3–F8 **全 ADDRESSED**；仅 **F2 判 PARTIALLY** —— 长度已改为**实际下发**值且 413/294 复现无误，但我替换后的比较句「两个工具描述仍长于全部内置工具（最长 `edit` 326）」对 `record_skill`(294) **是假的**（短于 `edit`）。另有引用可收紧：键集字面量实为 `anthropic-messages.js:1223-1235`，我写 1223-1233 截掉两行。评审独立跑：两 schema `makeStrictJsonSchema` 单参 **PASS**、带**真实** Anthropic 谓词 **PASS**、`resolveJsonSchemaStrictSampling(supportsStrictMode=true, "prefer")` 均为 `true`、零 16+11 并集键、描述在每层（含 `items`）原样保留；并复现了 F8 漏洞（含 `maxItems` 的 schema 被 `() => false` 放过、被真谓词拒）。**已修**：比较句改分列陈述、引用收紧到 1223-1235。transcript 见 `…-review-round11-independent.txt`。 |
| design round 12 | **`PASSED`** | 最小确认轮：**R1** 比较句已改为分列（`record_memory` 413 长于全部内置工具；`record_skill` 294 与 `edit` 同档但短于 `edit`），评审独立复测内置件实际下发长度与两描述长度（413/294）**完全复现**；**R2** 键集引用已收紧到 `anthropic-messages.js:1223-1235`，全文无残留 `1223-1233`。无新矛盾，评审记录行与状态行自洽。明确答「frozen-ready: **Yes**」。transcript 见 `…-review-round12-independent.txt`。 |

**设计**冻结（`design-frozen`）**：第 7 轮 PASSED；post-PASSED 修订经第 8 轮复核（3 important + 4 nit）、第 9 轮确认（全 ADDRESSED）；第 9 轮后按 owner 要求做文案/schema 规范化（房规重排 + 16 键纠正），经第 10 轮（3 important）、第 11 轮（1 处比较句）、第 12 轮确认 **PASSED** 收敛。共 12 轮，每轮零写入均有快照证明。下一步为按本设计施工。

**实施期修订（2026-10-02）**：代码侧 round 1 评审发现 `record_skill.reason` 的描述内嵌了 `autolearn/parse.ts:28` 行号，而实施后该行号已漂移。按本设计自己的 N10 原则（「按函数名定位，不按行号」）**删去行号**、只留文件名（`500 chars` → `500 characters`），两者字符数相消，描述长度仍为 294。此处 schema 块已同步。其余实施偏差（D1–D5）与新增的 D6 见 `implementation-note.md`。

## 非目标（明确出范围）

- S4（超 cap 按节优先序丢）。
- 可配置的 CONTEXT cap。
- CONTEXT.md 读取侧迁移。
- 归档 vault / 压缩 / 加密 / 上传（已单独论证，不在本次）。
- schema 符合度可见性（`status` 报告收敛度）。
- 不改 autolearn 的节流（`autolearnAt`/turns/interval）、候选生命周期与准入规则；本次只改它的**输出形状与解析**。
- 不改 handoff 的摘要路径（它不走辅助 JSON 调用）。

## 决策记录（owner 2026-10-01 拍板）

- **Q4 → 走可靠路线**：在路由侧显式开启 strict（见决策 2）。两个 compat 键名不同，且本机现有路由默认全关 → 实现必须容忍 strict 未生效，不能把它当既定条件。
- **Q3 → 回归守卫并入本次**：不拆后续 issue（见目标与决策 5）。
- **Q1 → 无冲突**：本扩展**未注册任何 tool**（`grep registerTool extensions/` 为空）；`Context.tools` 是**单次辅助调用的局部 schema**，不进 pi 的工具注册表，因此不存在与内置工具（`read`/`bash`/…）重名的问题。名称 `record_memory` 保留。
- **Q2 → `context` 也走同一个 tool**：`record_memory` 的 `context` 成员即 `ContextUpdate`；降级路径仍保留 `parseContext`（tool 不可用时用）。
- 命名梳理（`/context-update` 是 `/memory-learn` 的重复别名等）另开 issue，见 `../2026-10-01-command-naming-consolidation/command-naming-inventory.md`；**不在本次评审面**。
- **Q5（2026-10-01 追加）→ autolearn 的决策输出一并结构化**：辅助 JSON 调用共两处（consolidation + autolearn），共用 `llm.ts` 管道，机制一次做完全部消费者；autolearn 的可空对象形状必须改成 always-object（见决策 7）。

## 仍开放

- round 2 的 design-level 决策已在本轮定稿：F1（文档头豁免）、F2（可用 toolCall 判定）、F3（无 `tools` 重试触发与 `noteModelFailure` 互动）、F4（按节裁剪的诊断措辞与 `neededChars`）、F5（condense 改为 `dropped > 0` 触发）、F6（节内非 bullet）、F7（`sectionsFromMarkdown` 归档）。round 3 只应复核 fix delta。
- `parseJsonObject` 的大括号扫描**保留不动**：它是 `"prefer"` 降级路径的必要组成，不与结构化路径重叠。
