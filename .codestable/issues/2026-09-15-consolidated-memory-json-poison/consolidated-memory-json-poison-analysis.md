---
doc_type: issue-analysis
issue: 2026-09-15-consolidated-memory-json-poison
status: confirmed
root_cause_type: missing-guard
related: [consolidated-memory-json-poison-report.md]
tags: [memory, consolidation, data-format, token-budget, self-heal]
---

# consolidation JSON 污染 MEMORY.md 根因分析

## 1. 问题定位

| 关键位置 | 说明 |
|---|---|
| `extensions/project-context/project-state.ts:347` | `loadMemory()` 原样返回 `MEMORY.md` 内容，不识别、不修复被污染的 JSON 正文 |
| `extensions/project-context/consolidate.ts:250` | `before_agent_start` 把 `loadMemory().text` 注入每个会话的 system prompt（污染随之注入） |
| `extensions/project-context/consolidate.ts:333` | 整理 pass 把 `loadMemory()` 作为 `<existing-memory>` 反馈给模型（污染回流） |
| `extensions/project-context/autolearn.ts:415` | autolearn 也读 `loadMemory()`，污染会作为记忆素材 |
| `extensions/project-context/consolidate.ts:115-123` | `parseConsolidated()`：解析失败时按字段名恢复；仍失败且文本像 JSON 则返回 `undefined`（b9c8618 引入的正确保护） |
| `extensions/project-context/consolidate.ts:127-161` | `jsonStringField()`：要求字符串有闭合 `"`，被截断的字段恢复不了 |
| `extensions/project-context/consolidate.ts:347-355` | 解析失败抛 `consolidation reply was not a usable JSON object`；只写错误信息，不写原始回复，无法事后诊断 |
| `extensions/project-context/project-state.ts:26` / `config.ts:68` | `MAX_MEMORY_CHARS = 24000` 与默认 `maxTokens = 8192` 不匹配 |
| git 历史 `b9c8618^:consolidate.ts` | 修复前 `parseConsolidated()` 对任何解析失败都回退 `{ memory: text }`，把原始 JSON 当 Markdown 写入 |

## 2. 失败路径还原

**正常路径**：会话回合结束 → `agent_settled` → `consolidateProjectState()` → 读现有记忆拼 prompt → 模型返回 `{memory_markdown, context}` JSON → `parseJsonObject` 成功 → `cleanMemory()` 整形 → 写 `MEMORY.md`。

**失败路径 A（历史写入，造成污染）**：现有记忆已接近 24000 字符（中文为主）→ 模型需要在 8192 输出 token 内重写整份记忆 + context → 输出被截断在字符串中途 → `JSON.parse` 失败 → 修复前代码回退 `{ memory: text }` → `cleanMemory()` 把原始 JSON 前缀（`# Project Memory\n\n{"memory_markdown": ...`）写进 `MEMORY.md`。

**失败路径 B（现行代码，warning 来源）**：`loadMemory()` 返回已污染正文 → 注入 system prompt 并作为 `<existing-memory>` 再次进入整理 prompt → 模型继续在同样的体量下输出 → 再次被截断 → `parseJsonObject` 失败 → `jsonStringField` 因字段未闭合返回 `undefined` → `looksLikeJsonReply` 判定为 JSON 回复 → `parseConsolidated` 返回 `undefined` → 抛错、写 `errors.log`、弹 warning；`MEMORY.md` 保持污染不变，下一轮重复。

**分叉点**：
- `consolidate.ts:354` — 解析失败选择“拒绝写入”（正确），但由于读取端无自愈，污染长期滞留。
- `project-state.ts:350` — `loadMemory` 对污染正文没有识别/修复分支。

## 3. 根因

**根因类型**：missing-guard（主）+ config / data-format（次）

**根因描述**：
1. **主根因（读取端缺少自愈）**：修复提交 b9c8618 只堵住了“把不可解析回复写入 `MEMORY.md`”的入口，没有处理存量污染。污染正文会被注入每个会话、回流给每次整理，形成自锁：整理因污染而失败 → 失败又不改文件 → 污染继续。UniField（15249 字符）与 Quantum_Matrix（14717 字符）两个文件均处于该状态。
2. **次根因 1（输出预算不足）**：`MAX_MEMORY_CHARS = 24000` 允许的记忆规模（中文）远超 `maxTokens = 8192` 的输出预算；模型每次都被要求重写整份记忆，截断几乎是必然。两个坏文件的 `memory_markdown` 字符串都在文件末尾被截断，符合输出 token 上限特征。
3. **次根因 2（诊断缺口）**：失败时 `errors.log` 只记录错误消息，没有原始回复（哪怕前几 KB），无法判断是截断、schema 错误还是模型跑偏。
4. **背景条件（非代码根因）**：两个 2026-09-12 启动的 pi 进程（PID 370858/378387）至今仍运行修复前代码，持续写入原始 JSON；09-15 12:05（UniField）、14:35（Quantum_Matrix）两次写入均来自旧进程。修复后需用户重启这两个会话，否则仍会被旧进程回写。

**是否有多个根因**：是。主根因 1 是污染长期滞留的直接原因；次根因 1 是持续失败的触发条件；次根因 2 影响可诊断性。

## 4. 影响面

- **影响范围**：不限于报告中的两个项目。任何记忆接近 `MAX_MEMORY_CHARS`（尤其中文）的项目，一旦某次回复被截断且落在旧代码窗口内，都会进入同一自锁。
- **潜在受害模块**：会话注入（`before_agent_start`）→ 每个会话的 system prompt；整理（consolidate）；autolearn（`loadMemory` 素材）；HANDOFF 摘要（间接读取会话历史，不受直接影响）。
- **数据完整性风险**：有。污染写入覆盖了原 Markdown；记忆尾部内容不可恢复（两个文件的字段字符串都被截断）。可恢复部分为模型当次重写内容的完整行前缀。
- **已执行的存量修复（owner 授权）**：两个 `MEMORY.md` 已于 2026-09-15 用截断解码恢复为 Markdown，并保留原始字节备份 `MEMORY.md.poison-backup-20260915`；Quantum_Matrix 末行用 HEAD 的完整同前缀行补全；UniField 丢弃截断句尾 `短 ssh`。两个 `CONTEXT.md` 检查为正常内容，未改动。
- **严重程度复核**：维持 **P1**。修复读取端后自锁解除；但预算问题不解决时，大体量记忆仍可能反复触发截断失败（只是不再污染）。

## 5. 修复方案

### 方案 A：读取端自愈 + 失败诊断（推荐）
- **做什么**：
  1. `loadMemory()` 识别“正文是原始 JSON 回复”的存储格式（正文以 `{` 开头且存在顶层 `"memory_markdown":` 字符串字段），用容错解码恢复字段值（允许未闭合字符串，截到最后一个完整句），原子写回修复后的文件并保留一次 `.poison-backup-*`，随后返回修复后的 Markdown。
  2. 检测必须精确：仅匹配结构性顶层 JSON；正文中像 Quantum_Matrix 第 85 行那样在反引号里提到 `{"memory_markdown":...}` 的普通记忆文本不得误判。
  3. 整理失败路径把原始回复前若干 KB 追加到 `errors.log`（或在抛错信息里带摘要），便于日后诊断。
- **优点**：一并解除存量污染与注入回流；改动集中在共享读取点；自愈天然幂等（第二次读到的是干净 Markdown）。
- **缺点 / 风险**：`loadMemory` 是共享路径（注入 / 整理 / autolearn），读操作带写副作用；误判会破坏真实记忆。缓解：严格结构判定 + 首次修复前自动备份 + 测试覆盖“提及 JSON 的正常记忆不误判”。
- **影响面**：`project-state.ts`（`loadMemory` 与备份命名）、`consolidate.ts`（失败诊断）、`tests/consolidation-test.mjs`。

### 方案 B：仅解析端容错（不写回）
- **做什么**：放宽 `jsonStringField()`，对未闭合字符串返回已解码前缀，让被截断的回复也能更新记忆。
- **优点**：改动最小；warning 立即消失。
- **缺点 / 风险**：不修复存量文件——注入里仍是原始 JSON，模型继续在污染输入上工作；把截断记忆静默写入会丢失尾部且难以察觉；与 b9c8618 的“宁失败不写坏”取向相悖。
- **影响面**：`consolidate.ts` 单点 + 测试。

### 方案 C：预算治理（防止截断复发）
- **做什么**：让输出预算与输入规模匹配，二选一或组合：
  1. 提高默认 `maxTokens`（如 16384）并允许项目配置覆盖；
  2. 或按输出预算裁剪进入 prompt 的 `<existing-memory>`（超出部分不发送），并在提示词中要求模型对超限记忆先压缩再输出。
- **优点**：直接消除“必然截断”的触发条件；对大体量中文记忆最有效。
- **缺点 / 风险**：提高上限可能超过部分模型输出能力；输入裁剪若模型不配合会静默丢事实。需要明确的失败可见性（与 A 的诊断配套）。
- **影响面**：`config.ts`、`consolidate.ts`（prompt 构造）、可能的配置文档与测试。

### 推荐方案

**推荐 A + C（A 为主）**：A 解除存量自锁并把污染从注入/回流中清除；C 中的“输出预算与 `<existing-memory>` 规模匹配”作为最小防护，避免自愈后的记忆再次因预算截断而失败。B 的截断解码逻辑在 A 中复用（作为自愈解码器），不单独采纳。旧进程回写属环境条件，由 owner 重启会话处理，不写进代码修复。

**owner 决定（2026-09-15）：采纳 A + C，进入 fix 阶段。**
