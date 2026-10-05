# 词汇与命名规范（pi-project-context）

**本项目自有文件**（不是 `cs-onboard` 释放的共享口径；`cs-onboard` 升级不会覆盖它）。

适用范围：本仓代码、提示词与工具 schema、`docs/`、`CHANGELOG.md`、tag 与提交信息、`.codestable/` 产出、`.agents/skills/` 技能正文。
第三方技能与全局技能（`~/.agents/skills/`）不适用——那是别人的产物，本仓只读不写。

来历：v0.3.0 用「一个事实一个名字」收束了命令面；2026-10-05 的词汇审计（证据见
`.codestable/issues/2026-10-05-autolearn-progressive-disclosure/autolearn-progressive-disclosure-design.md` §13）
发现当时只收束到命令面，通知文案、持久化键、通知前缀、跨层渲染器名都没跟上。本文件把规则与终态写下来，避免再次只改一半。

---

## 1. 总则

1. **一个事实一个名字**：同一个事实在两个地方出现，必须用同一个名字（命令、帮助、通知、状态行、文档、键名都算）。
2. **名字说的是那个事实**，不是动作、不是历史、不是实现方式。反例：两个 token 量曾被叫 `target` / `keep`，两个词都说不出量的是什么；
   现在是 `budget summary` / `budget recent`，各自命名被定量的对象。
3. **改名必须同轮改齐**：代码 + 提示词 + `docs/` + `CHANGELOG` + MEMORY + 本文件。只改一半 = 未完成
   （2026-10-05 修的 `Auto summarize target` 就是 v0.3.0 只改了命令、没改通知留下的）。
4. **偏离本文件要写下来**：确有必要偏离时，在本文件 §5 记一条「已决/例外」，并写理由；不要静默偏离。

## 2. 分层词汇表

### 2.1 命令面

- 命令名 = 层名：`/memory`、`/session-log`、`/handoff`、`/autolearn`；跨层的只有 `/project-context`。
- 动词 = 这一层做的动作；**参数住在改变它的那一层**（v0.3.0 起）。
- **四层的「立即执行」动词各不相同，这是已决而非残留**（见 §5 D1）：
  `/memory update`、`/session-log write`、`/handoff now`、`/autolearn`（裸调用）。动词描述本层动作，不追求跨层同字。
- 二级词命名「被定量的对象」（`budget summary` / `budget recent`），不用「动作 + 宾语」（`summarize target`）。

### 2.2 配置键（`.agents/memory/project-context.json`）

- 形式：camelCase，不带下划线；同一特性的键**同一拼写**（`autolearn*` 全用小写 `learn`）。
- 开关：`<能力>Enabled`（终态见 §5 K）。
- 量：`<对象>Tokens` / `<对象>Chars` / `<对象>IntervalMs`；对象词必须与命令面二级词一致（`budget summary` ⇒ `handoffSummaryTokens`）。
- 时间水位：`<能力>At`。
- 改键名 = 破坏性变更：必须一次性迁移 + 文档 + 测试同轮更新（迁移机制见 `shared/config.ts` 的 `legacyConfigPatch`）。

### 2.3 用户可见文案

- **通知前缀**：一层一个前缀，形态 `<前缀>: <事实>`，且前缀之后**不再重复层名**（`Memory: updated <file>`，不是 `Memory: memory updated`）。
  两条豁免：① `Usage: …` 行不加层前缀（它本身以命令名开头）；② `/project-context status` 的多行报告用**行标签**
  （`Features:`／`Auxiliary calls:`／`Config:`／`Memory:`／`Context file:`／`Memory cap warning:`），与单行 toast 是两个面。
- **拒绝理由**：小写、无句号、`<对象> <条件>`；必须是可以被测试断言的**字面量**，不要在别处再拼一份。现行全集：
  `invalid kebab-case name`、`missing description`、`description too long`、`body too short`、`body too long`、
  `body looks like an instruction injection`、`body not shown this pass`、`skill "<name>" already exists`、
  `candidate "<name>" already exists`、`needs at least one verified session id`、`needs evidence from at least two different sessions`。
- **状态行**：` · <事实> <值>` 片段；事实词与命令面同词（`summary budget 64k`，不是 `summarize 64k`）。
- **用法提示**：`Usage: /<命令> <动词> <二级词> <参数>`，照抄命令面，不另起同义写法。

### 2.4 模型可见词汇（提示词与工具 schema）

- 工具名与字段：`record_skill`、`skill`、`inspect`（要原始会话片段）、`inspectSkill`（要某条学到的技能正文）、
  `evidence`、`candidate`、`reason`；camelCase，与代码里同一事实同名。
- 提示词小节名：`<kebab-case>`，全小写名词短语 —— `<existing-skills>`、`<learned-skill-bodies>`、
  `<available-sessions>`、`<session-evidence>`、`<project-memory>`、`<current-context>`。
- **三个动词定死**（prompt / CHANGELOG / docs / MEMORY 一律照用）：
  - **show 展示** —— 本轮把已有正文喂给模型；
  - **merge 合并** —— 带原文重写，保留仍然成立的步骤；
  - **supersede 取代** —— 覆盖一条既有 learned 技能。
  禁止用 update / rewrite / replace 混指这三件事。
- 数量与长度上限**写在代码里**，不指望 schema 关键字（见 §4）。

### 2.5 代码词汇

- 函数：verb + noun（`collectSkills`、`buildPrompt`、`parseDecision`、`resolveAuxModel`）；判定用 `isX` / `hasX` / `xOf`。
- 常量：`MAX_` / `MIN_`（上/下限、单位后缀 `_CHARS` / `_TOKENS` / `_MS`）、`AUTOLEARN_`（一次 pass 的预算）。
- **预算常量的名字必须说出它量的是什么**：`AUTOLEARN_SHOWN_BODY_CHARS`（本轮展示总量），
  而不是语义已经变了的旧名 `AUTOLEARN_LEARNED_BODY_CHARS`。
- 集合变量命名对象：`shownNames`（被展示的名字），不是 `shown`。
- 理由/状态字符串就是枚举：改动只在 `candidate.ts` 的定义处，测试断言引用同一批字面量。

### 2.6 文件与目录

- 技能目录：`.agents/skills/<name>/SKILL.md`；引用文件**只一层**：`references/<kebab>.md`（规范原文 "one level deep"）。
- 候选：`.agents/memory/skill-candidates/<name>.md`（单文件；references 以 `## References` 分节承载）。
- 名字：lowercase-kebab-case、≤64 字符、不可用保留词（pi 规范）；`description` ≤1024 字符、本仓自律 ≤170。

## 3. 术语表（中文 ↔ 代码/英文）

| 中文 | 英文 / 代码 | 说明 |
| --- | --- | --- |
| 存档 | archive | 落 `session.jsonl` / `session.md` / `INDEX.md` |
| 整理 | consolidation | 重写 `MEMORY.md` / `CONTEXT.md` |
| 沉淀 | autolearn | 从记忆/上下文/会话索引蒸出技能 |
| 交接 | handoff | 阈值达成时开 successor session |
| 学到的技能 | learned skill | 带来源标记的 **project** 技能 |
| 来源标记 | provenance marker | `<!-- autolearn-generated: … -->`（写在 body） |
| 清单 | inventory | 提示词里的「名字 + scope + 描述」 |
| 展示 | show / `shownNames` | 本轮把正文注入提示词 |
| 合并 | merge | 带既有正文重写 |
| 取代 | supersede | 覆盖既有 learned 技能 |
| 入口 / 引用 | entry / `references/*.md` | 分层技能的两半；入口自包含 |
| 候选 | candidate | 等人确认的提案文件 |

## 4. 与 pi / pi-ai 的接口约束（不得违反）

- **strict schema**（`Tool.constrainedSampling = { type: "json_schema", strict: "prefer" }`）：
  根必须是 object；每个属性都写进 `required`；`additionalProperties: false`；
  禁 `$ref` / `$defs` / `definitions` / `allOf` / `oneOf` / `patternProperties` / `not` / `if` 等（pi-ai 直接抛错）。
- `strict: "require"` 在不支持的路由上会抛错，本仓一律用 `"prefer"`。
- **`maxItems` / `maxLength` 不保证被 provider 执行** ⇒ 数量与长度上限一律在代码里做（例：`inspectSkill` 最多 2 条用 `slice`）。
- 无 tools 的路由会回退到「文本 JSON」：同一个 `parseDecision` 必须同时吃两条路径，字段缺失要容错。
- `stopReason === "length"` 的 tool call 不可信（pi-ai 会把截断的 arguments 修成 shape-valid 对象）⇒ 丢弃并重试一次。

## 5. 已决与终态

### D. 已决（不再当残留）

- **D1 四层「立即执行」动词不统一是故意的**：`update` / `write` / `now` / 裸调用，各自描述本层的动作。

### K. 配置键终态（**已落地 v0.4.0**，一次性迁移在 `legacyConfigPatch`）

| 现值 | 终态 | 理由 |
| --- | --- | --- |
| `handoffTargetTokens` | `handoffBudgetSummaryTokens` | 键名镜射命令路径 `/handoff budget summary`（owner：`budget` 要保留在键里） |
| `handoffKeepTokens` | `handoffBudgetRecentTokens` | 同上，镜射 `/handoff budget recent` |
| `autoLearn` | `autolearnEnabled` | 同特性拼写统一（`autolearn*`）+ `<能力>Enabled` |
| `autoConsolidate` | `memoryEnabled` | 能力名是 `memory`，歧义最小（owner 定）；不用动作词避免与 `auto*` 旧名混 |
| `archiveEnabled` / `handoffEnabled` | 不变 | 已是 `<能力>Enabled` |
| `handoffSummaryThinking` | `handoffThinking` | 镜射 `/handoff thinking` |
| `handoffLanguage` | `handoffLang` | 镜射 `/handoff lang` |
| `handoffAdaptive` | `handoffThresholdAuto` | 镜射 `/handoff threshold auto`（与 `handoffThresholdRatio` 成对） |

### P. 通知前缀终态（**已落地 v0.4.0**）

一层一个前缀（v0.4.0 已统一）：`Memory:`、`Session log:`、`Handoff:`、`Autolearn:`；跨层仍是 `Features:` 与 `Auxiliary calls:`。
原 `Automatic consolidation:`／`Project memory updated:`／`Memory cap:` 归 `Memory:`，`Auto handoff*` 归 `Handoff:`，
`Session archiving:`／`Session log written:`／`Session log update failed:` 归 `Session log:`。

### X. 例外与约定

- 内部变量名（如 `keep`、`target`）只要不出现在用户可见文案与配置键里，可保留；改了更好，但不是规范要求。
- **项目级技能一律视为 autolearn 产物**（owner 2026-10-05 两次裁定）：本仓 `.agents/skills/` 与**任何消费仓**的 `.agents/skills/` 下的技能，
  正文都带 `<!-- autolearn-generated: … -->` 标记，从而可被该仓的 pass 合并。作用域外的只有 `~/.agents/skills/`（全局技能，只读，永不写、也不标记）。
  标记必须与 `autolearn/skill.ts` 的 `PROVENANCE_COMMENT` **逐字节相同**，否则 pass 认不出来。

## 6. 执行与核验

- 本规范被三处钉住：① 测试断言（文案、理由字符串、schema 字段与 `required`）；② `docs/configuration.md`、`docs/architecture.md` 的用词；
  ③ `.codestable/attention.md` 的「其他」条目（启动必读，指向本文件）。
- 改用户可见文案的验收口径：`grep` 旧词全仓清零 + 相关测试绿 + 本文件与 `docs/` 同轮更新。
- 发布前扫一遍：`grep -rn '<旧词>' extensions/ docs/ CHANGELOG.md`；本仓每个 `feat` 版本至少跑一次全量词扫（见 §7）。
- 本文件的规则若与某个设计文档冲突，以**本文件 + 该设计文档的 §0 owner 已答**为准；两者都缺才按总则推断。

## 7. 审计历史

| 日期 | 结论 | 证据 |
| --- | --- | --- |
| 2026-10-05 | v0.3.0 只收束了命令面与配置布局；通知文案、持久化键拼写、通知前缀、跨层渲染器名未跟上 | 设计文档 §13（V1–V7 + 逐条 `file:line`） |
| 2026-10-05 | V1 已修（`b869be3`）：`Auto summarize target` → `Summary budget`，连带 `keep/kept/keeping`、两处补全说明里的 `summary target`，共 6 处 | `extensions/project-context/handoff/run.ts`；`tests/handoff-test.mjs` 绿 |
| 2026-10-05 | V2/V3/V5/V6 立为独立主题；V4 记为已决（§5 D1） | `.codestable/issues/2026-10-05-vocabulary-consistency/` |
| 2026-10-05 | V2/V3/V5/V6 **全部落地**（v0.4.0）：7 个键改名＋一次性迁移、通知前缀统一、渲染器名统一 | 同上 issue 的设计文档与 `release-v0.4.0-evidence.md` |
