---
doc_type: implementation-note
issue: 2026-10-01-structured-consolidation-output
status: implemented-pending-code-review
created_at: 2026-10-02
related: [structured-consolidation-output-design.md, ../2026-10-01-command-naming-consolidation/command-naming-inventory.md]
tags: [memory, consolidation, structured-output, breaking-change, implementation]
---

# 结构化 consolidation 输出 —— 实施记录

按 `structured-consolidation-output-design.md`（`design-frozen`，12 轮评审）与 `command-naming-inventory.md`（`decided`）施工。同一发版含破坏性命令改名。

## 施工范围

| 文件 | 改动 |
|---|---|
| `memory/sections.ts` | **新增**：`MemorySections`、`sectionsFromToolCall`、`sectionsFromMarkdown`、`renderMemoryDocument`、`sectionsSemanticallyEmpty`、条目卫生、`RECORD_MEMORY_TOOL` |
| `memory/context-schema.ts` | 新增 `CONTEXT_TOOL_SCHEMA`（`record_memory` 的 `context` 成员） |
| `memory/document.ts` | 导出 `isMemoryTruncationLine`（`sections.ts` 要用，避免重声明导致形状漂移） |
| `shared/llm.ts` | `completeWithMeta` 支持 `tools`、返回 `toolCalls`；新增 `AuxCallError`、`callAux`、`pickToolCall` |
| `autolearn/schema.ts` | **新增**：`RECORD_SKILL_TOOL`（always-object 形状） |
| `autolearn/parse.ts` | `parseDecision` 接受对象或文本，支持新形状 + 旧 `skill:null` |
| `autolearn/pass.ts` | 改走 `callAux`（带 tools）、截断重试、读 toolCall；`getArgumentCompletions` |
| `autolearn/prompt.ts` | 输出示例改为单一 always-object 形状 |
| `memory/prompt.ts` | 优先工具、降级时 `{memory_markdown, context}`；条目卫生与「不写标记」 |
| `memory/parse.ts` | 导出 `parseContext`（tool 路径复用同一套 context 校验） |
| `memory/pass.ts` | 结构化/降级双入口、截断优先级、condense 触发与采纳、语义空门、回归守卫 |
| `memory/report.ts` | `kind` 判别、按节计数、措辞、`removed` 上报；命令改名与补全 |
| `index.ts` / `archive/archive.ts` / `handoff/run.ts` | 补 `getArgumentCompletions`；`/auto-handoff` → `/handoff` |
| `tests/harness.mjs` | 新增 `rmTemp`、`assertStrictReady`、`loadShared` |
| `tests/sections-test.mjs` | **新增**：schema strict-ready、抽取契约、渲染上界、`pickToolCall`、`callAux` |
| `tests/consolidation-test.mjs` / `autolearn-test.mjs` / `registration-test.mjs` | 新增端到端用例；改名引用清扫 |

命令改名：`/memory-learn` → `/memory update`；`/auto-handoff` → `/handoff`；`/context-update` **删除**（无别名无提示）。flag 不变。

## 与冻结设计的偏离（5 处，均需复核）

### D1 `callAux` 的无 tools 回退加了「非 provider 故障」前置条件（**最重要的偏离**）

设计原文：「不尝试字符串分类（脆弱），也不重试每一次失败 —— 只在**本 pass 第一次**带 `tools` 的调用抛出时**无条件**回退一次」。

实施改为：仅当失败**不是** provider 级故障（`classifyModelFailure` 给出 auth/quota/transient）且不是「没有产出可用回复」时才回退。

理由（三条独立证据）：

1. **设计自己的措辞是「因 `tools` 参数报错时」**（决策 2 首句）；「无条件」只是不做字符串分类的**探测近似**，而这里要判定的不是「异常像不像 tools 拒绝」，而是「重试有没有可能成功」。
2. **项目已有维护中的分类器**：`classifyModelFailure` 就是为这个语义写的（`call-policy.ts`），所以「分类脆弱」这条理由在这里不成立——复用的是既有事实，不是新造字符串匹配。
3. **无条件回退会把故障期的调用量翻倍，而 `call-policy.ts` 整个模块就是为「一次故障不要变成连环重试」而建的**。实测：现有测试 `call-policy-test`（7 条）与 `consolidation-test`（2 条）明确断言「provider 出错不重试」「非最终 stop reason 不重试」；无条件回退会让这 9 条断言全部失效。按 D1 实施后，**一行测试预期都不用改**，且 `tools` 拒绝路径仍完整可用（含一条端到端用例）。

残余风险：若某路由把「不支持 tools」报成 429/连接错误，本实现不会回退（会正常冷却）。判定为可接受——那类路由本来也不可用。

### D2 `toolsAttempted` 在**调用前**置位

设计只说「本 pass 第一次带 tools 的调用抛出时回退」。实施中「第一次」必须包含**已成功**的调用，否则「先成功一次工具调用、之后某次工具调用失败」会误判为首次并多打一次模型。已由 `sections-test` 的 `a failure after a tools success is not retried` 钉住。

### D3 condense 采纳拒绝**空**回复

设计写「解析失败或仍 `sectionDropped > 0` → 保留第一次的结果」。实施中发现：一个**解析不出内容的压缩回复**（如又一次只回 toolCall、文本为空）经 `parseConsolidated("")` 会得到 `{memory: ""}`，旧判据 `!exceedsMemoryCap("")` 为真 → **采纳空记忆、丢掉第一次的有效结果**。已在采纳条件里加 `condensedText.trim() !== ""`。由 `consolidation-test` 的 cap 可见性用例覆盖（该用例正是靠这条才保留住第一次的按节裁剪结果）。

### D4 回归守卫的上报要进命令回复

设计说守卫输出「一条 `warning` + 一条 `errors.log` 诊断」。实施中发现 `/memory update` 走的是 `consolidate(ctx, true, silent = true)`，pass 自己的 toast 被 `silent` 抑制 → **显式命令路径下「删了 N 条 invariant」将完全不可见**。已把 `removed` 放进 `LastWriteInfo`，由 `consolidateReply` 拼进命令回复。`errors.log` 诊断不变。

### D5 按节 cap 的措辞在 log / toast / 命令回复**共用一句**

设计的「按触发成分拼句」在实施中收敛为一个 `sectionCapSentence(outcome)`，三处引用同一字符串，避免三份措辞漂移（前一版实施里 toast 说「exceeded a section budget」、回复说「a section exceeded its budget」，测试与用户都要面对两种说法）。

## 设计层事实更正

- **N11 的举例是假的**：设计称「仓库自己的 `MEMORY.md` 属于散文体/含未知节、会回落逐字路径」。实测该文件只有四个标准节且全是 bullet（见设计文档该条下的实施期更正）。策略不变，仅删去错误举例。**影响**：仓库自身记忆**会**走「降级·可解析」并获得回归守卫，而不是被跳过。

## 非本次范围（照设计）

S4、可配置 CONTEXT cap、CONTEXT.md 读取侧迁移、归档 vault/加密、autolearn 节流与准入规则、handoff 摘要路径。

## 验证

- `node tests/run-all.mjs` → **14/14 通过**（新增 `sections-test.mjs`）。
- 新增用例覆盖设计的测试计划：strict-ready 自检（含 `$ref` / 必填 object-union 反例，及「`() => false` 会漏 `maxItems`」的 F8 复现）、抽取契约（引言/未知节/缺节/节内散文/星号 bullet/缩进 bullet/节后内容/空串 → `undefined`）、截断标记豁免、渲染上界（`cap=4000` 单条 803 字符被截到本节上限；2000 次随机 cap 零越界）、语义空门（`[""]`/`[" "]`/`\u200b`/`##`）、部分校验、`pickToolCall` 三种情形、`callAux` 回退与「只记一次失败」、结构化 vs 降级逐字节一致、回归守卫（命中/跳过）、cap 可见性与「不给数字建议」、截断优先于 toolCall、tools 被拒回退、autolearn 形状与截断重试、命令注册表与补全。
- **并发竞态**（owner 同次批准）：`tests` 的 teardown `rm -r` 与扩展的 fire-and-forget 后台写竞争导致约 1/10 假失败（`ENOTEMPTY … session-logs`）。修法是 `tests/harness.mjs` 的 `rmTemp()` 带 `maxRetries`，48 处调用点全部替换。压测：`handoff-test` 并行 60 次 0 失败，整套件 4 路并行 ×3 轮全过。
- **未验证**：真实路由探针（需付费路由）。`models-store.json` 实况是 strict 全关，所以本次只覆盖了「非 strict 的 function-calling + 文本降级」两态；strict 真生效时的收紧行为**没有**端到端证据，如实标注。

## 代码评审 round 1 的修复

R1 = `CHANGES-REQUESTED`（1 blocking + 4 important + 8 nit）。逐条落地：

| # | 结论 | 修复 |
|---|---|---|
| **B1**（blocking） | `fallback-opaque` 回复仍能用**纯标题骨架**覆盖真实记忆（骨架不解析成 sections → 落到 opaque → 长度 ≥40 → 写盘）。这正是决策 6 要消灭的 N1 类，而设计把 `>= 40` 留给了 opaque。 | 新增 `isHeadingOnlyDocument()`（每行都是标题/空行/截断标记，含 fence 剥离），opaque 侧改用它做语义门；`report.ts` 的 `memoryChanged` 改为 `!semanticEmpty && (sectioned \|\| len>=40)`。**散文记忆有正文行，不受影响** —— opaque 路径行为不变。 |
| **I1**（important） | `semanticEmpty` + `outcome.clipped` 时，`clipped` 措辞在 `memoryKept` 之前返回 → 仍说「memory 与 context 已更新（并被缩短）」，报了一次没发生的写。 | 命令回复把 `memoryKept` 提到 `clipped` 之前（并合并「提示词也被缩短」）；toast 增加 `!memoryChanged` 首分支。 |
| **I2**（important） | 名字匹配但 arguments 形状不合法**且无文本** → `parseConsolidated("")` → `{memory:""}` → 静默空转成功（consolidation 记为 unchanged；autolearn 记为「没返回 JSON」）。统一策略只覆盖了 name 不匹配。 | 两条 pass 在「名字匹配 + 形状失败 + 文本为空」时**抛错**；有文本仍走文本降级。 |
| **I3**（important） | 守卫跳过诊断只覆盖「旧侧不可解析」，**本轮走 opaque** 时完全静默。 | 拆成两支：本轮无 sections → `guard skipped: this pass did not produce sections`；旧侧不可解析 → 原句。 |
| **N2** | 全新项目也会写一条「guard skipped」噪声。 | 两支都加 `existing.text.trim()` 前置。 |
| **N3** | condense 采纳会接受**语义空的骨架**（文本非空、`sectionDropped===0`），丢掉第一次的按节裁剪结果并抑制 cap 事件。 | 采纳条件加 `!sectionedEmpty`（sections 用 `sectionsSemanticallyEmpty`，opaque 用 `isHeadingOnlyDocument`）。 |
| **N4** | 我的改名 sed 误伤了 `shared/config.ts:19` 注释里的 `~/.pi/agent/auto-handoff.json`（该文件名字面含 `/auto-handoff`）。 | 还原。 |
| **N5** | `docs/architecture.md` 未列三个新模块；`docs/configuration.md` 只描述整篇 60/40 cap。 | 模块树补 `memory/sections.ts`、`autolearn/schema.ts`、`shared/complete.ts`；配置文档按「分节路径 / 逐字路径」重写 cap 一节并写明语义空门与回归守卫。 |
| **N6** | 项目 skill 把 `constrainedSampling` 写成 `{type, schema}`。 | 改为 `{ type: "json_schema", strict: "prefer" }`。 |
| **N7** | `record_skill.reason` 的字段描述里写 `autolearn/parse.ts:28`，实施后行号已漂移。 | **删掉行号**只留文件名（按设计自身 N10「按函数名定位，不按行号」的原则）。**偏离记录（D6）**：删行号（−6）与 `chars`→`characters`（+6）相消，**该描述长度仍是 294**（实测），`record_memory` 仍是 413；设计文档里的长度断言无需改，只同步了它的 schema 字面量块。 |
| **N8** | 按节 cap 与整篇 cap 共用一个 `memoryCapWarned`，先触发者压掉另一条的 `errors.log`。 | 拆成 `memoryCapWarned` / `memorySectionCapWarned`。 |
| I4 | 改名清扫漏了 tracked 的 skill 运行手册与生成的记忆文件。 | 已清扫 `.agents/skills/*`（`/memory-learn`、`/auto-handoff`）与 `.agents/memory/MEMORY.md:58`。决策记录行里的新旧名对照是历史叙述，保留。 |

评审同时判 **D1–D5 全部成立**、**N11 更正为真**，并独立复现：3000 例随机 cap fuzz 零越界（最差余量 11）、抽取器对抗性输入全拒、`callAux` 每次调用恰好记 1 次失败（第 5 次才 disable）、两个 schema 过基表 16 + Anthropic 11 并集。

新增测试：`isHeadingOnlyDocument` 7 例；opaque 骨架不覆盖记忆、malformed toolCall 判错、opaque 侧守卫跳过诊断、全新项目无噪声 —— 4 条端到端。

## 代码评审 round 2 的修复

R2 = `CHANGES-REQUESTED`（1 blocking + 2 important + 2 nit）。评审复核 R1 处置：I1/I2/I3/I4/N1/N2/N4/N5/N6/N8 **ADDRESSED**，B1 与 N3 判 **PARTIALLY**（同一根因），N7 代码已修但记录写错。

| # | 结论 | 修复 |
|---|---|---|
| **R2-B1**（blocking） | `isHeadingOnlyDocument` 只剥一种 fence 形式（` ```markdown `），` ```md `/` ```json `/`~~~`/前置 metadata 分隔线/零宽字符行/主题分隔线都能绕过 → 无内容骨架仍覆盖真记忆（端到端复现）。 | 重写谓词：剥掉**任意** fence 家族（反引号与 `~~~`，含任意 info string）、主题分隔线/前置 metadata 分隔线、截断标记行；然后「某行是内容」= 不是 ATX 标题（`^#{1,6}(\s…)?$`，所以 `#1 rule` 不是标题）且含字母/数字。新增 15 例「无内容」+ 5 例「有内容」单测，以及 ` ```md `/`~~~`/分隔线三种端到端覆盖。 |
| **R2-I1**（important） | `memoryKept: outcome.semanticEmpty` 只覆盖「语义空」，「文本 < 40 一律不写」时命令回复仍说「Project memory and context updated.」（toast 是对的，回复不是）。 | `memoryKept: !memoryChanged` —— 覆盖**所有**未写原因。新增端到端用例（短 opaque 回复 + 可用 context）。 |
| **R2-I2**（important，设计一致性） | opaque 语义门是与冻结决策 6 的真实偏离，却只写在修复表里，决策 6 仍写着「降级·不可解析沿用 `>= 40`」。 | 记为 **D7** 并就地更新设计决策 6（含 N3 的 condense 采纳加严）。 |
| **R2-N1**（nit） | `#` 前缀启发式会把 `#1 rule must hold` 当标题（fail-safe 但静默）。 | 改用真 ATX 标题正则（`#` 后必须有空白），`#1 rule must hold` 现在是内容。 |
| **R2-N2**（nit） | D6 记录自相矛盾（写「294 → 288」，但实测仍 294）。 | 更正 D6：两项改动相消，长度不变。 |

评审端到端复现但**我判定为正确行为、不改**的一点：`## Project Memory uses Postgres` 整行是 ATX 标题，标题自身的文字不是正文，因此「纯标题行文档」仍判无内容。反向风险（把真记忆误判为空而拒写）只在「整篇只有标题行」时发生，而那种文档本来就没有可存内容；只要有一行正文（散文或 bullet）就不受影响。

## 代码评审 round 3：**受阻，未完成**

按 `.agents/skills/pi-project-context-sandboxed-independent-review` 启动 round 3（沙箱 `/tmp/pi-context-rev23`，基线快照已取）。**20 分钟零输出**，stderr 为：

```
402: {"message":"Insufficient Balance", ...}
```

按该 skill 的 gotcha，空 transcript 不算评审、必须重跑；重跑前逐一探测可用路由，**全部不可用**：

| 路由 | 结果 |
|---|---|
| `deepseek/deepseek-flash` | `402 Insufficient Balance`（余额耗尽；R1/R2 用的就是它） |
| `openai-codex/*` | `Encountered invalidated oauth token for user` |
| `commandcode/claude-sonnet-5` | `403 MODEL_NOT_IN_PLAN`（免费套餐不含） |
| 其余 `commandcode/*`（逐一试了 gpt-5.6-sol / gpt-5.4 / gpt-5.3-codex / claude-sonnet-5-5 / claude-fable-5-1 / claude-opus-5 / claude-haiku / gemini-3.5-flash-lite / deepseek-v4-flash-fast …） | `Model ... not found`（新进程解析不到；**本会话自己正在用的 `commandcode/deepseek/deepseek-v4.1-flash-fast` 在新进程里也解析不到**） |
| `--provider commandcode --model <id>` | `Unknown provider "commandcode"` |

沙箱 before/after 快照 `diff` 为空 —— round 3 **零写入**，因此**没有**伪造出一份「通过」的评审记录。

**结论**：R1、R2 两轮已完成并全部处置（见上两节）；当时 R3 及后续**未完成**，等可用路由。按项目不变式，付费路由失败**不得**记作验证成功，故此处如实标注为未验证。

> **后续（同日晚）**：上面那次失败**不是**「额度用完」那么简单 —— 根因是探针带了 `--no-extensions`，而 `commandcode` 这个自定义 provider **正是由扩展注册的**，flag 把整条路由一起关掉了，于是「模型找不到」。去掉 `--no-extensions`（改用 `--no-project-context` 关掉本扩展自身）后 `commandcode/deepseek/deepseek-v4.1-flash-fast` 直接可用，R3 随即跑通。**教训：把「模型不存在」当成「额度耗尽」，会让整轮工作白等 20 分钟。**

## round 3 受阻期间的自检（**不是**独立评审，不可替代轮次）

路线全线不可用，但代码风险不会因此消失，所以对 `isHeadingOnlyDocument` 做了一遍**作者自检**（探针 `/tmp/selfcheck-sections.mjs`，两个方向各 20+ 用例）。**自检由实现者本人运行，不具独立性，不得计入 6 轮审校。**

自检抓到 **4 个此前两轮评审都未覆盖的真实缺口**，均已修复并固化进 `tests/sections-test.mjs`：

| 缺口 | 后果 | 修法 |
|---|---|---|
| **裸 `\r` 行分隔的骨架**被判「有内容」 | `.split("\n")` 不切 `\r`，整篇变成一行 → `CONTENT_RE` 命中字母 → **骨架放行、真记忆被覆盖** | 切分改为 `/\r\n|[\r\n\u2028\u2029]/`（同时覆盖 CRLF、裸 CR、U+2028、U+2029 —— 后两者是 JS 行终止符，部分模型会输出） |
| **7 个以上 `#` 的伪标题**被判「有内容」 | 原 `^#{1,6}` 不匹配 `####### X`，落入内容判定 | 放宽为 `^#{1,}`（`#` 后有空白才算标题，`#1 rule` 仍不是） |
| **HTML 注记独占的文档**被判「有内容」 | `<!-- no changes -->` 这类「无改动」回复会被当成真记忆写进去 | 先剥 `<!--[\s\S]*?-->`（未闭合的注释不匹配 → 仍算内容，fail-open） |
| **只含空 bullet 的骨架**被判「有内容」 | R2 的 `- ` 分支用 `normalizeMemoryEntry`，`- ` 归一后仍是 `-` → 命中内容判定 | 改为先做「装饰归一」（`canonicalLine`）再判，空 bullet 归一为空行 → 被过滤 |

自检方向 B（**误判为空的危险方向**，会导致合法写入被静默拒绝）全绿：散文、`- ` / `* ` / `+ ` / 有序列表、纯数字行、日期行、CJK 行、`#1 rule`、带正文的代码块、标题+一行正文 —— 全部判为**有内容**。

**结论**：这 4 个缺口正好落在 R2-B1 的同一类（「无内容文档仍能覆盖记忆」），说明**同一根因的第三次收窄仍不彻底**。因此独立评审（尤其 R3 的对抗面）**不可省**——但当前路线环境下无法进行。

## 代码评审 round 3（跑通）

transcript：`structured-consolidation-output-code-review-round3-independent.txt`（沙箱 `rev23`，零写入有快照证明：`git status --porcelain -uall` 与 `find … stat` 双 `diff` 均空）。

**结论 `CHANGES-REQUESTED`**：R2-I1 / R2-I2 / R2-N1 / R2-N2 判 **ADDRESSED**；**R2-B1 判 PARTIALLY** —— 结构类绕过与自检那 4 个缺口都确认关闭，但还有一类未堵。

| # | 结论 | 修复 |
|---|---|---|
| **R3-I1**（important，**我引入的回归**） | fence 剥离写成 `^…(?:```|~~~)[^\n]*$` 且**在行终止符归一之前**跑，而 `[^\n]*` 会吞 `\r`/U+2028/U+2029 → 用这些分隔符拼的**带 fence 的真实记忆**被整篇吞掉、判为空 → **拒写**并报「carried no entries」（假诊断）。评审用重构出的 R2 旧谓词证明这是新引入的回归。**fail-safe（不会损坏数据），但会静默停止写入。** | **先**归一 `/\r\n?|[\u2028\u2029]/` 再切行（与 JSDoc 原本的声明一致）。新增 5 个分隔符 × 带 fence 的用例 + 未闭合 fence 用例。 |
| **R3-I2**（important，残余边界 + **数据丢失路径**） | 规则是「不是 ATX 标题 **且** 含字母数字」，所以任何**带字词的包裹**都能击败它：散文前言、XML 标签包裹、HTML 标题、有序标记、bullet/ZWSP 前缀、setext —— 都能覆盖真记忆。更糟的是 **condense 分支会采纳这种骨架**：第一次约 4800 字符的真实结果被丢弃，盘上只剩 **91 字节骨架**且 toast 说 updated（评审实测复现）。 | 引入**装饰归一** `canonicalLine()`（去零宽字符 + 去任意层 `>`/bullet/有序标记）后再判 ATX；结构行扩到 fence / 分隔线 / 独立标签 / HTML 标题 / `===` setext 下划线（含其上标题行）。**带词句的包裹（散文前言、元素含文字、`---` setext）按设计意图保留为 fail-open 边界并已记入决策 6/D7**（另一个方向的错误是拒写真记忆，且无法从前言区分作者的话与丢失正文）。新增装饰骨架单测 8 条 + condense 数据丢失路径 e2e。 |
| **R3-N1**（nit） | 未写原因被统一说成「carried no entries」，但「太短」那条明明带了文本（`Short note.`），措辞为假。 | `LastWriteInfo` 增加 `keepReason: "empty" \| "short"`，回复按原因分支（「the reply was empty or too short to be a change」），并补 e2e 固定命令回复文本（此前只有 toast 被固定）。**注：第一版这个 e2e 是空断言** —— 命令 handler 只 `notify` 不返回值，`reply` 恒为 `undefined`，所以断言 `!String(reply).includes(...)` 永远为真；R4 指出后改为断言 toast，并做了变异检查（把措辞改坏 → 该断言确实 FAIL）。 |
| **R3-N2**（nit） | 自检记账说「4 个缺口」但表里只列 3 个（第 4 行是空的 `（无）`）。 | 补上第 4 行（空 bullet 骨架）。**这条本身是「不许轻信自检记账」的示范**，如实采纳。 |

评审同时确认：R2-I1 的**每一条**跳过原因都走对了分支（6 行逐路点名）；R2-I2 的设计文档与代码一致；`record_memory.description` 413 / `record_skill.description` 294 实测不变；套件 14/14；opaque 门那一段当时有 27 条断言（R4 实测现为 **56** 条；整个 `sections-test.mjs` 为 118 条）。

## 代码评审 round 4（跑通）

transcript：`structured-consolidation-output-code-review-round4-independent.txt`（沙箱 `rev24`，双快照 `diff` 空 = 零写入）。

**结论 `CHANGES-REQUESTED`**：R3-I1 / R3-I2 / R3-N2 判 **ADDRESSED**，R3-N1 代码 ADDRESSED 但**新加的 e2e 是空断言**（评审给出变异证明）。评审还确认 test 15 **非空**：把 rev23 的谓词还原后它恰好 2 条断言 FAIL（91 字节骨架被存入），修复后 4024 字节的第一次结果保留。

| # | 结论 | 修复 |
|---|---|---|
| **R4-I1**（important） | `ZERO_WIDTH_RE` 只枚举了部分 Unicode `Cf`：漏 U+200E LRM、U+200F RLM、U+202A–202E、U+2061–2064、U+2066–2069、U+180E、U+061C。用这些前缀的骨架仍是「有内容」→ **R3-I2 的静默数据丢失路径沿另一个不可见前缀重新打开**（评审 e2e：普通路径覆盖真记忆；condense 路径丢掉 4800 字符真结果、盘上只剩 **86 字节**骨架）。 | 改为 `/\p{Cf}/gu`（整类不可见字符）。剥 `Cf` 只可能让一行更趋「结构行」、不会更趋「内容行」，所以方向安全。新增 LRM/RLM/bidi/isolate 4 条单测。 |
| **R4-L1**（low，新误拒） | `===` setext 规则会吃掉上一行，但**不看 fence 上下文**：`# Project Memory\n## Project\n```\nvalue\n===\n```` 里代码块的唯一正文行被吃掉 → 整篇判空、拒写。 | setext 消耗上一行**仅限 fence 之外**（跟踪 fence 奇偶）。新增「fence 内以 `===` 收尾的代码块算内容」用例。 |
| **R4-L2**（low，新误拒） | `TAG_LINE_RE` 也匹配 `<T>`、autolink `<https://…>`，`HTML_HEADING_LINE_RE` 匹配 `<h2>…</h2>`；若该行是唯一非结构行，整篇被拒。 | 标签正则收紧为**标签名形状**（`<https://…>` 是 autolink 即真实文本，不再算结构行）。autolink 用例已补。`<T>` / `<hN>…</hN>` 单行仍判空 —— **按 D7 记录为边界**（单行标签/标题本就没有正文）。 |
| **R4-N1**（nit，**测试空断言**） | 新加的 R3-N1 e2e 断言打在 `reply` 上，而命令 handler 只 `notify` 不返回值 → `reply` 恒 `undefined`，断言恒真（评审变异证明：把措辞改坏，整套件仍全绿）。 | 改为断言 **toast**（回复文本落地处），并在 test 9 补「semantic-empty 那条**确实**说 carried no entries」的反向断言。**已做变异检查**：把措辞改成永远说 carried no entries → 新断言 FAIL。 |
| **R4-N2**（nit） | note 说 opaque 门「现为 60+」条，实测 49；设计「HTML 标题算结构行」与「元素内含文字算内容」并列读起来自相矛盾。 | 计数改为实测（当时 49，现 56）；设计补明边界措辞：判据是「去掉结构行后还剩不剩带字词的行」，两者不矛盾。 |
| **R4-N3**（nit） | 测试注释还在说「fence matcher 是 `$`-anchored」（描述 rev23）；ZWSP 前缀标题行未固定；装饰+ATX 交互未写进 D7。 | 注释改写；补 ZWSP 前缀标题行等用例；D7 补「装饰先归一 → `- # 1 rule must hold` 按标题判 → 正文只有这种 bullet 的记忆会被拒，这是有意代价」。 |

## 代码评审 round 5（跑通）

transcript：`structured-consolidation-output-code-review-round5-independent.txt`（沙箱 `rev25`，零写入双快照 `diff` 空）。

**结论 `CHANGES-REQUESTED`**：R4-I1 / R4-N1 / R4-N3 判 **ADDRESSED**；R4-L2、R4-N2 判 **PARTIALLY**，并抓到**我在 R4 收紧标签正则时新开的洞**。评审还独立复现了 R4-N1 的变异检查（改坏措辞 → 恰好 1 条 FAIL）。

| # | 结论 | 修复 |
|---|---|---|
| **R5-I1**（important，**R4-L2 的修复新引入**） | 收紧后的 `TAG_LINE_RE` 只接受 `[A-Za-z][A-Za-z0-9-]*`，把 XML 名字里的 `_`/`:`/`.` 漏掉 → `<foo_bar>`/`<ns:memory>`/`<my.tag>` 包裹的骨架不再算结构行 → **静默覆盖 + condense 数据丢失路径重新打开**（评审 e2e：普通路径 81 字节骨架覆盖真记忆并 toast updated；condense 路径丢掉 4000+ 字符真结果、只剩 65–71 字节）。 | **不再枚举标签名形状**，改为通用判据：`isTagOnlyLine()` = 「去掉所有 `<…>` 跨度后不含字母数字」，再按名字排除 autolink（`<https://…>`/`<mailto:…>`）。这样 `<foo_bar>`/`<ns:memory>`/`<my.tag>`/`<_x>`/`<1memory>`/`<记忆>` **整族**一次堵住，而不是逐个补。新增 6 条包裹用例 + autolink/mailto 反例。 |
| **R5-L1**（low） | fence 奇偶**不看族、也不看装饰**：`~~~` 块里的 ``` 行会翻转奇偶 → `===` 吃掉代码块唯一正文行 → 误拒（fail-safe，但诊断是假的）。 | 记住**开块族别**（只有同族才能关闭），且 fence 判定走**原始行**（markdown 里 `> ``` ` 不关闭代码块）。新增「`~~~` 块内含 ``` 行与 `===` 行」「块内装饰 fence 行」两条用例。 |
| **R5-N1**（nit，**文档漂移**） | 我在 note 里声称设计已写入两条边界措辞，实际没写进去。 | **根因是我自己的脚本 bug**：同一个 heredoc 里第二次 `write()` 用的是**未应用第一次替换**的旧字符串，把第一次的编辑覆盖掉了。已改为「两次替换作用在同一字符串上、只写一次」，并逐条 grep 核对（4 个关键词全部命中）。**这条与 R4-N1 的空断言是同一类问题：声称做了但没做。** |

**值得记的模式**：`isHeadingOnlyDocument` 这个启发式在 R3/R4/R5 三轮里，**每次收窄都在同族边界上开了新口子**（R3-I1 分隔符、R4-L2→R5-I1 标签名、R4-L1→R5-L1 fence 族）。R5 的修法转为「用通用判据替代枚举」，方向上是收敛的（`\p{Cf}` 整类、「去标签后无字词」整族、族别感知），但**这条启发式的边界仍未穷尽**——评审同时列出 `<_x>`/`<1memory>`/`<记忆>`（本轮已堵）之外的既有边界：散文前言、`---` setext 骨架、孤行 `<T>`/`<hN>…</hN>`、纯标点/emoji 正文。这些已写进决策 6/D7，属**已知并接受**的 fail-open 边界。

## 代码评审 round 6 —— **VERDICT: PASSED**

transcript：`structured-consolidation-output-code-review-round6-independent.txt`（沙箱 `rev26`，零写入：评审自报 `SANDBOX WORKTREE UNCHANGED`，我方双快照 `diff` 亦空）。

**处置**：R5-I1 / R5-L1 / R5-N1 全部 **ADDRESSED**。评审并做了三条变异检查证明修复非空：把 `isTagOnlyLine` 退回 R4 的枚举式标签正则 → 6 条包裹用例 FAIL；把关闭判定改成不看族 → 1 条 FAIL；把 fence 判定改回用归一后的行 → 1 条 FAIL。

**收敛判定（评审原话要点）**：「从枚举转向通用规则**确实收敛了**——`\p{Cf}` 是完整类；标签**名**不再枚举；剩下的边不是新开的，而是 R5 修复前就存在的同族边界」。

**评审列出的 4 条残余**（都判 LOW/NIT、pre-existing、且给了单行修法）。其中 **F1 有静默覆盖形状**，而这个门的全部意义就是防静默覆盖，所以**全部按评审给的边界修掉了**（不是记录）：

| # | 内容 | 修法 |
|---|---|---|
| **F1** | `TAG_SPAN_RE = /<[^>]*>/g` 不感知引号：属性里含 `>` 的包裹（`<x title="a>b">`）剥不干净 → 骨架算「有内容」→ 普通路径覆盖真记忆、condense 采纳骨架（评审跨版本探针确认 rev24/rev25 同样，**非本轮引入**）。 | 引号感知跨度 `/<(?:[^>"']|"[^"]*"|'[^']*')*>/g`。另补一条**窄**规则覆盖未闭合标签（`<memory` 无 `>`）：`UNTERMINATED_TAG_RE = /^<\/?[A-Za-z][\w.:-]*$/` —— 刻意窄，`<3 this project` 仍算内容。 |
| **F2** | fence 奇偶只看族、不看**开启长度与 info string**：```` ```js ```` 行会被当成关闭符 → `===` 吃掉代码块唯一正文行（fail-safe 误拒 + 假诊断）。 | 记下 `{run, char, info}`；关闭需**同字符 + 不短于开启 + info 为空**。 |
| **F3** | `===` 判定用的是**归一后**的行，所以 `- ===` 也会吃掉上一行真内容（markdown 里那是 bullet）。 | 改判**原始行**。 |
| **F4** | `AUTOLINK_RE` 只认 `scheme://` 与小写 `mailto:` → `<user@example.com>`、`<MAILTO:…>` 被判空、报假诊断。 | 增加裸 email 形状。**刻意不**放宽到任意 `scheme:`（否则 `<ns:memory>` 又变成 autolink，R5-I1 复开）。`<tel:…>`/`<urn:…>` 单行仍判空，**按 D7 记录为边界**。 |

修完补 9 条用例（opaque 门 65 → **74** 条，整文件 127 → **136** 条），套件仍 14/14。因为**代码在 PASSED 之后又变了**，R6 的 PASSED 不再覆盖实际要发的代码，故继续跑 R7。

## 代码评审 round 7 —— **VERDICT: PASSED**（验证 R6 之后的改动）

transcript：`structured-consolidation-output-code-review-round7-independent.txt`（沙箱 `rev27`，零写入双快照 `diff` 空）。

**处置**：F1/F2/F3/F4 四条修复逐条引用并判 **CORRECT**。评审做了独立双向探针（42 + 131 例）、4 组变异（revert F1 → 2 FAIL；F2(info) → 1 FAIL；F3 → 1 FAIL；F4 → 2 FAIL），以及 **12 万例**种子化随机文档的差分模糊测试：
- F1 是**单向趋严**（`curT/preF1 F` 17 461 例，「当前新拒」**0** 例）；
- F2/F3/F4 **零**「当前新拒」；
- 没有任何变异能复现静默覆盖复开。

**唯一新发现**：`NIT-1`，纯测试层 —— 我加的「4 反引号被 3 反引号关闭」用例**不具区分度**（`===` 出现在关闭符之前，所以任何关闭规则下结论都一样）。评审给出区分性用例并用自己的变异证明。

**已修**：用例改为评审给的版本（把 3 反引号行放到正文**第一行**），并**自行复跑变异**验证：去掉 `run.length >= openFence.run.length` 条款后该用例确实 `FAIL`。**这是纯测试改动，不改扩展行为**；评审另列的 F2 加固条款由同一变异覆盖。

评审同时确认 note 里的计数准确（opaque 门 **74** / 整文件 **136**），套件 14/14。

**评审列出的残余（均 pre-existing、且不触及静默覆盖路径）**：info-string fence 行会保持代码块打开（fail-open，与 CommonMark 一致）；`<x=a@b.c>` 这类无空白 email 形状被当 autolink；4 空格缩进的关闭符被 trim 后误判为关闭（fail-safe 误拒）；`<tel:…>`/`<urn:…>` 单行、孤行 `<T>`/`<hN>`、散文/`---` setext 包裹属已记录边界；`TAG_SPAN_RE` 在病态 `<` 串上是 O(n²)（token 有界，最坏约 2 秒）。

**代码评审到此收敛：R6、R7 连续两轮 `PASSED`，且 R7 覆盖的就是当前要提交的代码。**
