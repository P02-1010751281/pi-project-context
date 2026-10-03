# pi 会话 01a0fcfb-103c-7691-80f2-8f9a6a598650 的交接文档

- 生成时间：2026-10-02T16:00:41.985Z
- 项目：/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context
- 会话日志：.agents/memory/session-logs/01a0fcfb-103c-7691-80f2-8f9a6a598650/session.md
- 会话索引：.agents/memory/session-logs/INDEX.md

## 目标
- 主任务：为 `pi-project-context` 实现「结构化 consolidation 输出」设计（记忆结构由代码拥有，模型只填每节条目；用 pi-ai tool-calling 取分节内容；保留 fail-open 降级；配套记忆回归守卫），并扩到 autolearn（决策 7 共用 tools 管道）。
- 同批发版：命令改名（`/memory-learn` → `/memory update`；`/auto-handoff` → `/handoff`；`/context-update` **删除**，无别名无过渡期；`/context` 不变）+ 每个存留命令补 `getArgumentCompletions`。flag 不变。
- 流程：实现 → 代码侧 6 轮沙箱只读评审（审/校，全部 PASSED）→ commit → 双远端 push + tag → `pi-config` pin 升级。
- 附加（owner 本次明确批准）：「开工。修。竟态处理掉。同一发版」——修掉既有 flaky 测试竞态。

## 约束与偏好
- 简体中文回复；commit 英文 Conventional Commits；文档简体中文。
- **零 npm 依赖是硬约束**（项目无 `package.json`）。
- 协议改动走 `.agents/skills/pi-project-context-sandboxed-independent-review/SKILL.md`：字节级 `/tmp` 沙箱 + before/after `git status --porcelain -uall` 与 `find … stat` 快照证明零写入。
- 动手前先用工具核对文件状态，不重做已完成工作；不替用户选选项。
- 出范围：S4、可配置 context cap、CONTEXT.md 读取侧迁移、vault/加密/归档上传。
- 项目根：`/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context`

## 进展
### 已完成
- [x] 设计文档 `.codestable/issues/2026-10-01-structured-consolidation-output/structured-consolidation-output-design.md` 达 **`design-frozen`**（412 行，12 轮 prompt/transcript 全归档，每轮零写入有快照）。
- [x] 命名清单 `.codestable/issues/2026-10-01-command-naming-consolidation/command-naming-inventory.md` = `decided`；归档决定 `.codestable/issues/2026-10-01-session-log-durability/session-log-durability-decision.md` = `deferred`。
- [x] **修掉既有 flaky 测试竞态**：`tests/harness.mjs` 新增 `rmTemp(target)`（`rm(..., {recursive:true, force:true, maxRetries:10, retryDelay:25})`），48 处 `rm(tmp, {recursive:true,force:true})` 全部替换（12 个文件）。根因：扩展 fire-and-forget 后台写在 teardown 时仍在写 → `ENOTEMPTY: directory not empty, rmdir '/tmp/pi-handoff-XXX/.agents/memory/session-logs'`。压测：handoff-test 并行 60 次 0 失败；整套件 4 路并行 ×3 轮全过。
- [x] **实施全部代码改动**：
  - 新增 `extensions/project-context/memory/sections.ts`（`MemorySections`、`sectionsFromToolCall`、`sectionsFromMarkdown`、`renderMemoryDocument`、`sectionsSemanticallyEmpty`、`normalizeMemoryEntry`、`isMemoryEntryEmpty`、`isHeadingOnlyDocument`、`RECORD_MEMORY_TOOL`）。
  - 新增 `extensions/project-context/autolearn/schema.ts`（`RECORD_SKILL_TOOL`，always-object 形状）。
  - 新增 `extensions/project-context/shared/complete.ts`（`completeVerbs`、`completeValues`）。
  - `shared/llm.ts`：`completeWithMeta` 支持 `tools`、返回 `toolCalls`；新增 `AuxCallError`（kind `provider`/`incomplete`）、`callAux`、`pickToolCall`、`toolsFallbackApplies`。
  - `memory/pass.ts` 重写（双入口/截断优先/condense 触发与采纳/语义空门/回归守卫/`RemovedEntries`）；`memory/report.ts`（`kind` 判别、`sectionCapSentence`、`memoryKept`、`removed`、多集合分开）；`memory/prompt.ts`、`memory/parse.ts`（导出 `parseContext`）、`memory/document.ts`（导出 `isMemoryTruncationLine`）、`memory/context-schema.ts`（`CONTEXT_TOOL_SCHEMA`）；`autolearn/parse.ts` 重写（`parseDecision(reply: unknown)`）、`autolearn/pass.ts`、`autolearn/prompt.ts`。
  - `handoff/run.ts` 改名 + 补全；`index.ts`/`archive/archive.ts`/`autolearn/pass.ts` 补 `getArgumentCompletions`。
  - `tests/harness.mjs` 另增 `assertStrictReady(schema)`（16+11 并集扫描）、`loadShared(files)`（共享 jiti 模块缓存）。
  - 新增 `tests/sections-test.mjs`；`tests/consolidation-test.mjs`/`autolearn-test.mjs`/`registration-test.mjs` 新增端到端用例；测试内改名引用清扫。
  - 文档：`docs/architecture.md`（模块树补 3 个新模块）、`docs/configuration.md`（命令表 + cap 一节按「分节/逐字」重写）、`.agents/skills/*` 与 `.agents/memory/MEMORY.md:58` 改名清扫。
- [x] `node tests/run-all.mjs` → **14/14 通过**；`git diff --check` 干净。
- [x] 实施记录 `.codestable/issues/2026-10-01-structured-consolidation-output/implementation-note.md`（含 D1–D6 偏离）。
- [x] 设计文档 N11 假举例已更正（仓库 `MEMORY.md` 实测只有 4 个标准节、全是 bullet → 走「降级·可解析」，不是散文体）。
- [x] **代码评审 round 1 = `CHANGES-REQUESTED`**（1 blocking + 4 important + 8 nit），已全部修复并归档 `…-code-review-round1-independent.txt`：B1 opaque 骨架覆盖记忆、I1 memoryKept 措辞、I2 名字匹配但参数不合法且无文本应判错、I3 opaque 侧守卫跳过诊断、I4 skills 清扫、N2 全新项目无噪声、N3 condense 不采纳空骨架、N4 `config.ts:19` sed 误伤 `auto-handoff.json`、N5 文档、N6 skill 的 `constrainedSampling` 形状、N7 删行号、N8 拆集合。
- [x] **代码评审 round 2 = `CHANGES-REQUESTED`**，已归档 `…-code-review-round2-independent.txt`；已修 **R2-I1**：`memory/report.ts` 的 `memoryKept: outcome.semanticEmpty` → `memoryKept: !memoryChanged`（**此改动已应用**）。

### 进行中
- [ ] **R2-B1（blocking）**：`isHeadingOnlyDocument` 剥离太窄 —— `` ```md ``/`` ```json ``/`~~~`/`---` frontmatter/ZWSP-only/`*`×60 等仍可让无内容骨架覆盖真实记忆。**上次 edit 失败未应用**（同一 edit 的第二块 oldText 不存在 → all-or-nothing 回滚）。拟改法：
  - 新增 `const ATX_HEADING_RE = /^#{1,6}(?:\s.*)?$/;`（`#1 rule` 不算标题）；
  - 剥离 `` /^[^\S\n]*(?:```|~~~)[^\n]*$/gm `` 与 `` /^[^\S\n]*(?:-{3,}|\*{3,}|_{3,})[^\S\n]*$/gm ``；
  - 内容行判定：标题行 → false；`- ` 开头 → `CONTENT_RE.test(normalizeMemoryEntry(line))`；其余 → `CONTENT_RE.test(line)`（`CONTENT_RE = /[\p{L}\p{N}]/u`）。
  - **注意**：新谓词会丢 `isMemoryTruncationLine` 判定，导致 `tests/sections-test.mjs` 的 `a marker-only document carries nothing worth writing` 用例失败 —— 需保留截断标记行的剥离。
- [ ] **R2-I2**：把 opaque 语义门记为 **D7**（设计未记录的偏离），并更新设计「决策 6」；同时 **R2-N2**：修正 implementation-note 里 D6 的错误说法（现写「294 → 288」，实为净零、长度仍是 294）。
- [ ] 补 `sections-test.mjs` 用例：`` ```md ``/`` ```json ``/`~~~`/`---`/ZWSP/`*`×60/`#1 rule must hold`（后者应判为**有内容**）。
- [ ] 跑 `node tests/run-all.mjs` 确认 14/14，然后启动**代码评审 round 3**（沙箱 `rev23`）。

### 阻塞
- （无）

## 关键决策
- **D1（最重要偏离）**：`callAux` 的无-tools 回退**只在非 provider 级故障**（`classifyModelFailure` 非 auth/quota/transient）且非 `AuxCallError` 时触发。理由：设计原意是「因 `tools` 参数报错时」，且项目已有维护中的分类器；无条件回退会让故障期调用量翻倍，并使既有的 9 条断言（`call-policy-test` 7 条 + `consolidation-test` 2 条）全部失效。按 D1 实施后**一行测试预期都不用改**。
- **D2**：`toolsAttempted` 在**调用前**置位（成功的工具调用也算「本路由接受 tools」），否则「先成功一次、之后失败」会误判为首次并多打一次模型。
- **D3**：condense 采纳拒绝**空**回复（`condensedText.trim() !== ""`），否则 `parseConsolidated("")` → `{memory:""}` 会丢掉第一次的有效结果。
- **D4**：`removed` 放进 `LastWriteInfo` 并由 `consolidateReply` 拼进命令回复（`/memory update` 走 silent 路径，pass 自己的 toast 被抑制）。
- **D5**：`sectionCapSentence(outcome)` 由 errors.log / toast / 命令回复**共用一句**。
- **D6**：删掉 `record_skill.reason` 描述里的行号（`autolearn/parse.ts:28, autolearn/skill.ts:51` → 只留文件名），按设计自身 N10「按函数名定位，不按行号」；`500 chars` → `500 characters`，**净零，长度仍 294**。
- **必须用 `strict: "prefer"` 而非 `"require"`**；`toolChoice` 保持 `"auto"`；`tools` 回退**粘性**（pass 内）。
- **cap 只能由代码执行**，不得依赖 schema 约束。
- **命令改名无过渡期**，与结构化输出同一次发版（破坏性）。

## 下一步
1. 重写 `extensions/project-context/memory/sections.ts` 的 `isHeadingOnlyDocument`（含 `ATX_HEADING_RE`、fence/thematic-break 剥离、截断标记剥离、内容行判定），一次 edit 完成，避免上次的 all-or-nothing 失败。
2. 在 `implementation-note.md` 记 **D7**（opaque 语义门为设计未记录偏离）并修正 **D6** 的错误长度说法；同步更新设计文档「决策 6」。
3. 在 `tests/sections-test.mjs` 补 fence/preamble/ZWSP/`*`×60/`#1 rule must hold` 用例；跑 `node tests/run-all.mjs` 至 14/14。
4. 启动**代码评审 round 3**（沙箱 `rev23`，对 `rev22` 取 diff），只确认 R2-B1/R2-I1/R2-I2/R2-N2 并做新一轮对抗。
5. 收敛后：commit（英文 Conventional Commits，破坏性改动需在 notes 列改名与删除）→ push `master` + tag 到双远端（fetch `ssh://forgejo@git.lentech.site/C02-1010751281/pi-project-context.git`；push 加 `ssh://git@ssh.github.com:443/P02-1010751281/pi-project-context.git`）→ 刷新记忆渲染单独提交 `docs(memory): refresh the memory render` → `pi-config` pin 升级。

## 关键上下文
- **测试**：`node tests/run-all.mjs`（14 个文件；新增 `tests/sections-test.mjs`）。
- **评审命令模板**：`cd /tmp/pi-context-revN && nohup env -u PI_SESSION_FILE -u PI_SESSION_ID -u PI_PROVIDER -u PI_MODEL -u PI_REASONING_LEVEL timeout 2000 pi -p --no-session --no-extensions --no-skills --no-prompt-templates --tools read,bash --model deepseek/deepseek-flash "$(cat /tmp/revN-prompt.txt)" > out 2>err &`
- **沙箱**：`rm -rf /tmp/pi-context-revN && cp -a "$ROOT" /tmp/pi-context-revN`；基线 `git status --porcelain -uall | sort > /tmp/revN-baseline-status.txt`、`find . -path ./.git -prune -o -type f -print0 | xargs -0 stat -c '%Y %s %n' | sort > /tmp/revN-baseline-files.txt`；评审后 `diff -` 证明零写入。已用 rev16–rev22；**下一个是 rev23**。设计删除前备份在 `/tmp/design-before-desc-edit.md`。
- **pi-ai 路径**：`/home/user/.local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/`
- **pi-ai 关键事实（已实测）**：基础禁用表 **16 键** `constrained-sampling.js:3-20`（`$ref $defs definitions allOf oneOf patternProperties dependentSchemas dependencies unevaluatedProperties propertyNames contains prefixItems not if then else`）；Anthropic 附加 11 键 `anthropic-messages.js:1223-1235`（含 `maxItems`）；`ANTHROPIC_STRICT_STRING_FORMATS` `:1236-1247`；`isAnthropicStrictUnsupportedKeyword` `:1248-1256`（另 `minItems` 仅允 0/1）；`makeStrictJsonSchema(schema, isUnsupportedKeyword?)`；`resolveJsonSchemaStrictSampling(tool, supportsStrictMode, isUnsupportedKeyword)`；`Tool.constrainedSampling = { type:"json_schema", strict:"prefer"|"require" } | { type:"grammar", variants } | false`；`tool.parameters` 原样透传（无 TypeBox 转换）。
- **pi 内置工具实际下发描述长度**：`edit` 326、`read` 303、`bash` 248、`grep` 221、`find` 186、`ls` 184、`write` 127（**不要量 `.js` 模板串**，那是 344/304/279/222 的假数字）。
- **本设计两个工具描述**：`record_memory` **413**、`record_skill` **294**（描述计数：`record_memory` 10 条、`record_skill` 8 条；脚本里数 `"description"` 字符串会把属性名也算进去）。
- **测试观察技巧**：`loadNamespace` 每次用 `moduleCache:false` → 不共享模块状态；要观察 `call-policy` 状态必须用 `loadShared([...])`（独立 jiti，默认缓存）。
- **关键代码事实**：`memory/pass.ts` 的 `resolveReply(completion, allowTools)`、`truncatedToolCall`、`changes`；`memory/report.ts` 的 `sectioned = outcome.kind !== "fallback-opaque"`、`memoryChanged = !outcome.semanticEmpty && (sectioned || memoryText.length >= 40)`；`tests/harness.mjs` 的 `assertStrictReady` 会断言 base.length===16、anthropic.length===11。
- **已知待办（非本次范围）**：MEMORY.md/CONTEXT.md 会随下次 consolidation 刷新；HANDOFF.md 是过期交接文档。
- **当前工作树**：`extensions/` 与 `tests/` 有大量改动（新增 3 个模块 + 1 个测试文件）；`.agents/memory/*` 运行时 churn。
- **未验证**：真实路由探针（需付费路由）；strict 真生效时无端到端证据，如实标注。

<read-files>
/home/user/.local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/constrained-sampling.js
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.agents/skills/pi-project-context-sandboxed-independent-review/SKILL.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.codestable/issues/2026-10-01-structured-consolidation-output/structured-consolidation-output-code-review-round1-independent.txt
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.codestable/issues/2026-10-01-structured-consolidation-output/structured-consolidation-output-code-review-round2-independent.txt
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.codestable/issues/2026-10-01-structured-consolidation-output/structured-consolidation-output-design-review-round11-independent.txt
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/memory/schema.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/memory/store.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/shared/call-policy.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/shared/limits.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/tests/handoff-test.mjs
</read-files>

<modified-files>
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.agents/memory/CONTEXT.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.agents/memory/MEMORY.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.agents/skills/pi-project-context-structured-tool-output-strict-mode/SKILL.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.codestable/issues/2026-10-01-structured-consolidation-output/implementation-note.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.codestable/issues/2026-10-01-structured-consolidation-output/structured-consolidation-output-design.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/docs/architecture.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/docs/configuration.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/archive/archive.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/autolearn/parse.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/autolearn/pass.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/autolearn/prompt.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/autolearn/schema.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/handoff/run.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/index.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/memory/context-schema.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/memory/document.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/memory/parse.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/memory/pass.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/memory/prompt.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/memory/report.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/memory/sections.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/shared/complete.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/shared/config.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/shared/llm.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/tests/autolearn-test.mjs
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/tests/consolidation-test.mjs
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/tests/harness.mjs
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/tests/registration-test.mjs
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/tests/sections-test.mjs
</modified-files>
