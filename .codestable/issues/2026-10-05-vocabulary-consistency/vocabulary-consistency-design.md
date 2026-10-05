---
doc_type: design
issue: vocabulary-consistency
status: draft
revision: 1
date: 2026-10-05
decides: 配置键改名（V2/V3）、通知前缀统一（V5）、跨层渲染器名（V6）三件事一起做；V4 已决（四层动词各自描述本层动作），规则成文于 .codestable/reference/vocabulary-conventions.md
supersedes: 无（承接 2026-10-05 词汇审计；V1 已在 v0.3.1 之后的 b869be3 修完）
---

# 词汇一致性设计（revision 1，draft）

## 0. 背景与现场事实

- 规则与终态表的权威来源：`.codestable/reference/vocabulary-conventions.md`（本项目自有，非 `cs-onboard` 释放）。
- 审计证据：`.codestable/issues/2026-10-05-autolearn-progressive-disclosure/autolearn-progressive-disclosure-design.md` §13（V1–V7，逐条 `file:line`）。
- 现场事实（引用计数，2026-10-05 实测 `grep -rho '\b<key>\b'`）：

| 键 | extensions | tests | docs+README+CHANGELOG | 终态 |
| --- | --- | --- | --- | --- |
| `handoffTargetTokens` | 18 | 9 | 4 | `handoffSummaryTokens` |
| `handoffKeepTokens` | 19 | 8 | 4 | `handoffRecentTokens` |
| `autoLearn` | 9 | 15 | 3 | `autolearnEnabled` |
| `autoConsolidate` | 10 | 17 | 3 | **待定**（§6.1） |
| `archiveEnabled` / `handoffEnabled` | 12 / 14 | 4 / 17 | 3 / 2 | 不变（已是 `<能力>Enabled`） |
| `autolearnAt` / `autolearnTurns` / `autolearnIntervalMs` | 10 / 7 / 7 | 7 / 3 / 2 | 1 / 2 / 2 | 不变（`autolearn*` 拼写统一后即一致） |

- V1 已修（`b869be3`）：命令词 v0.3.0 已改，通知/补全说明共 6 处仍留旧词 —— 这是「只改一半」的活例，也是本主题存在的原因。

## 1. 目标 / 非目标

**目标**：持久化键名、通知前缀、跨层渲染器名与命令面同词，并把终态写进规范文档 §5；迁移一次性、可回滚（旧文件仍能被读）。

**非目标**：不改任何键的**语义**（只改名）；不动 `/handoff` 动词集与状态行结构；不新增命令/动词/开关；不动 `.agents/skills/` 里的技能正文（技能里若引用旧键名，随本主题一起改文案，不改行为）。

## 2. V2/V3 配置键改名

- 映射见上表；`autoConsolidate` 的终态待定（§6.1）。
- **迁移只住一处**：`shared/config.ts` 的 `legacyConfigPatch()`/`migrateLegacyConfig()` 是全仓唯一知道旧配置形态的地方（v0.3.0 已建立这条纪律），
  新映射直接加进去，读路径不再看旧键。
- 迁移必须覆盖两种输入：① 项目文件里已有旧键；② 用户手写的旧键 + 新键同时存在（冲突时以**新键**为准，并提示 moved from）。
- 写回：迁移后整份写回新键（与 v0.3.0 的一次性迁移同形）。

## 3. V5 通知前缀

- 现状 9 个前缀（`Autolearn:`、`Auto handoff:`、`Automatic consolidation:`、`Project memory updated:`、`Memory cap:`、
  `Session log written:`、`Session archiving:`、`Auxiliary calls:`、`Features:`）→ 终态「一层一个」：
  `Memory:`、`Session log:`、`Handoff:`、`Autolearn:`；跨层命令（`/project-context status`）用 `Features:`、`Auxiliary calls:`（它是跨层的，不是某一层）。
- 同一层的多条通知合并到同一前缀，事实写在冒号后（`Memory: cap reached (32000 of 32000 chars)`）。
- 成本主要在测试：断言多为 `includes("<片段>")`，需逐条核对片段是否仍在。

## 4. V6 跨层渲染器名

- 现状：handoff = `statusText(ctx)`；memory = `memoryStatusMessage` / `memoryStatusLevel` / `contextStatusLine`。
- 终态：`handoffStatusLine` / `memoryStatusLine` / `memoryStatusLevel` / `contextStatusLine`（一层一个 `*StatusLine`，等级判定叫 `*StatusLevel`）。
  纯内部改名，测试引用行为而非名字，成本低；`docs/architecture.md` 的模块说明同步。

## 5. 验收

1. 规范 §6 的口径：旧词全仓 `grep` 清零 + `node tests/run-all.mjs` 15/15 绿 + `docs/`/`CHANGELOG`/MEMORY/规范同轮更新。
2. 迁移断言：写一份只含旧键的 `project-context.json` → 新键生效、旧键被改写、提示 `moved from`（与 v0.3.0 迁移断言同形）。
3. 单侧变异：去掉迁移里的某一对映射 → 对应断言红；只改读路径不改写回 → 写回断言红。
4. 通知前缀：每层一条通知的断言就够，不必逐条断言全部前缀。

## 6. 待 owner 决定

1. **`autoConsolidate` 的终态**：能力名是 `memory`（命令 `/memory`、键 `maxMemoryChars`），但「自动整理」是它的动作。
   候选：`memoryEnabled`（与其余三个 `<能力>Enabled` 齐）／`autoConsolidate`（保留，理由是它描述动作而非能力）／`consolidateEnabled`。
2. **`handoffRecentTokens`** 还是 `handoffRecentWindowTokens`（后者更长但更明确；命令词是 `budget recent`）。
3. **通知前缀词形**：`Memory:` / `Session log:` / `Handoff:` / `Autolearn:` 是否照用（`Session log` 与命令名 `/session-log` 一致）。
4. **顺带修一个死指针**：`.codestable/attention.md` 的「一个 issue 只做一个主题」条目指向
   `.agents/skills/pi-project-context-design-review-round-budget/SKILL.md`，该技能已不存在（现有 17 条技能里没有它）。
   修法需 owner 指定归宿（`curated-surface-hygiene`？`independent-review`？）——不猜。

## 7. 发布

- 破坏性（配置键改名）= minor（**v0.4.0**）；与 autolearn 渐进披露的 A1（v0.3.2）分开，避免把破坏性改名夹进 feat。
- 需要**重启 pi**（改动在 `extensions/`）。
- 提交切片：① 迁移 + 键名（行为）；② docs/CHANGELOG/规范终态表（文档）；③ 通知前缀；④ 渲染器名。
