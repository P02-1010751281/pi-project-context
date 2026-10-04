---
doc_type: design
issue: command-surface-convergence
status: design-draft
revision: 5
date: 2026-10-04
decides: 命令面按层归位的完整契约（含 /handoff 收缩、伞形批量 on|off、命名、/context 拆分）
supersedes: revision 4 的伞形「不留 on|off」；owner 定向为「保留为四特性批量，但不设总开关」
---

# 命令面收束设计（revision 5：一条命令一层）

## 0. 定向

owner 定向：

1. `/project-context on|off` **保留，但只做"四个一起"的批量**；**不设总开关**，避免歧义。
2. `model` / `max-tokens` 是否按层拆（见 §1.2 的挡）。
3. `/handoff` 收缩：`threshold <auto|num>`、token 预算统一、`mode <send|draft>`。
4. 命名一块修；`/context` 拆分或另法修掉。

判据：一个参数住哪，由**它改的东西属于哪一层**决定；层内私有设置回本层命令；跨层者（`model`、`max-tokens`、`status`、**四特性批量**）住伞形。

## 1. 三个关键判断

### 1.1 伞形 `on|off`：保留为「四特性批量」，不是总开关

| 形式 | 归属 | 说明 |
| --- | --- | --- |
| `/memory on\|off`（新） | L2 | `autoConsolidate` |
| `/session-log on\|off`（新） | L5 | `archiveEnabled` |
| `/handoff on\|off`（已有） | L3 | `handoffEnabled` |
| `/autolearn on\|off`（已有） | L4 | `autoLearn` |
| **`/project-context on\|off`（裸，无目标）** | 跨层批量 | 一次设置上面四个键 |

为避免三种歧义，**形态写死为裸 `on|off`**：

- **不接受 feature 名**：per-feature 只住本层命令 ⇒ 同一事实只有一个名字，且只有一条路径。
- **不接受 `all` 记号**：`all` 与"裸调用"是同一事实两个词，删掉后者之一（裸调用即全部）。
- **不是扩展开关**：命令面**没有**"关掉整个扩展"；唯一的整扩展禁用是 CLI flag `--no-project-context`
  （run 级、不写持久配置；`shared/config.ts` 已注释为 "Run-level master switch"）。文档与注册描述都写明这一点。

仍保留的代价：批量语义只覆盖四个"自动行为"，不等价于停用扩展；`docs/configuration.md` 现文
「`memory`、`archive` 没有自己的 `on|off`，只能走伞形」需重写，`handoff/settings.ts` 两处引用批量形式的注释改指本层命令。

### 1.2 `model` / `max-tokens` 按层拆：**建议不拆**（有数据）

| 论据 | 内容 |
| --- | --- |
| 代码里的设计意图 | `memory/report.ts` 暂停提示原文 "Configure a **dedicated** model with /project-context model"——单数、专用 |
| 现场需求 | 本机 9 个 `project-context.json` 恰 1 个值异于默认，8 个 handoff 旋钮一个都没被碰过 |
| 仓库自身待办 | 复杂度审计 owner 待审项含「stop knob growth」 |
| 成本 | 按层拆 = 至少 +6 键（provider/model × 3 层） |

替代（若按层）：只做**可选覆盖 + 继承默认**（`/memory model …` 等），未设即继承跨层默认、行为不变；建议等出现层专属配额失败的现场事实再做。

### 1.3 `/handoff` 收缩：同意，收益最大

| 现在 | 收缩后 | 键（不动） |
| --- | --- | --- |
| `auto` | `threshold auto` | `handoffAdaptive` |
| 裸 `0.4` / `40%` | `threshold 0.4` | `handoffAdaptive=false` + `handoffThresholdRatio` |
| `target <n>` | `budget target <n>` | `handoffTargetTokens` |
| `keep <n\|off>` | `budget keep <n\|off>` | `handoffKeepTokens` |
| `send` / `draft` | `mode <send\|draft>` | `handoffMode` |

- 配置键一个不动 ⇒ 无迁移。
- 隐藏内动词保留、不进补全：`force-auto`（自动触发回路）、`language`（`lang` 同义）、`run`/`force`（`now` 同义）。
- CLI flag 不动：`handoff-ratio` 仍取 `auto|0.4|40%|off`。
- 公开动词 13 → 9：`status` `on|off` `threshold` `budget` `thinking` `mode` `guard` `lang` `now`。

## 2. 调整后完整命令面（终态）

| # | 命令 | 层 | 动词 / 参数 | 取值 | 效果（键 / 只读） |
| --- | --- | --- | --- | --- | --- |
| 1 | `/project-context` | 跨层 | 裸 / `status` | — | 只读六行总览 |
| 2 | | | `on\|off`（裸） | — | 一次设置 `archiveEnabled` `autoConsolidate` `autoLearn` `handoffEnabled` |
| 3 | | | `model <provider>/<id>` | 或 `off` / `session` | `provider` `model`（L2/L3/L4 共用） |
| 4 | | | `max-tokens <n>` | 或 `default` | `maxTokens` `maxOutputTokens`（同上） |
| 5 | `/memory` | L2 | 裸 | — | 只读：`MEMORY.md` 状态 ＋ `Context file:` 路径 |
| 6 | | | `update` | — | 立即 consolidation |
| 7 | | | `on\|off` | — | `autoConsolidate` |
| 8 | | | `max-memory <n>` | 或 `default` | `maxMemoryChars` |
| 9 | `/handoff` | L3 | 裸 / `status` | — | 只读一行 |
| 10 | | | `on\|off` | — | `handoffEnabled` |
| 11 | | | `threshold <auto\|num>` | `auto` / `0.4` / `40%` | `handoffAdaptive` + `handoffThresholdRatio` |
| 12 | | | `budget target <n>` | token 数 | `handoffTargetTokens` |
| 13 | | | `budget keep <n\|off>` | token 数 / `off` | `handoffKeepTokens` |
| 14 | | | `thinking <off\|session\|level>` | 补全列 `off` `session` | `handoffSummaryThinking` |
| 15 | | | `mode <send\|draft>` | 二选一 | `handoffMode` |
| 16 | | | `guard <wait\|draft\|send\|skip>` | 四选一 | `handoffGuard` |
| 17 | | | `lang <auto\|zh\|en>` | 三选一（`language` 同义） | `handoffLanguage` |
| 18 | | | `now` | —（`run`/`force` 同义） | 立即交接 |
| 19 | `/autolearn` | L4 | 裸 | — | 立即沉淀 |
| 20 | | | `list` / `approve <name>` / `reject <name>` | 候选名 | 候选审阅与落地 |
| 21 | | | `on\|off` | — | `autoLearn` |
| 22 | `/session-log` | L5 | 裸 | — | 只读：存档状态 ＋ `Session index:` ＋ `Session logs:` |
| 23 | | | `write` | — | 立即写当前存档（原裸调用动作）¹ |
| 24 | | | `import <path…>` | 文件 / 目录，可多个 | 回填 + 重建索引 |
| 25 | | | `on\|off` | — | `archiveEnabled` |
| 26 | `/context` | — | — | — | **退役**，三行按 §3 拆分 |

¹ 最小替代：裸调用保持「写」，写完再印那两行，不新增 `write`。
**已消失**：伞形的 `<feature\|all>` 目标与 `max-memory`；`/handoff` 的 `auto`、裸比例、`target`、`keep`、`send`、`draft`。

## 3. `/context` 拆分与命名

| `/context` 的行 | 产物层 | 新家 |
| --- | --- | --- |
| `Context file: <CONTEXT.md>` | L2 | `/memory` 裸调用 |
| `Session index: <INDEX.md>` | L5 | `/session-log` 裸调用 |
| `Session logs: <dir>` | L5 | `/session-log` 裸调用 |

四个路径 helper 全在 `shared/paths.ts`（L6），拆分只换调用点，不新增 helper。

命名三处：命令层歧义由「拆分 + 退役 `/context`」根除；产物称呼 v0.2.3 已统一为 `Context file:`；
伞形收缩后只剩纯跨层项，建议**保留名字**、注册描述改为 `cross-layer settings and status`（若改：`/settings`、`/pc`，均硬切）。

## 4. 连带修改

| 位置 | 现文 | 改后 |
| --- | --- | --- |
| `docs/configuration.md` 命令表 | `/handoff` 13 项；伞形含 `<feature\|all>` 与 `max-memory`；`/context` 一行 | 按 §2 重写；`max-memory` 移到 `/memory` 行；删 `/context` 行 |
| `docs/configuration.md` 说明段 | 裸 `/handoff 0.6` 等旧写法；「`memory`、`archive` 只能走伞形」；`/context` 三行独有 | 全段重写；并写明伞形 `on\|off` **不是**扩展开关、整扩展禁用只有 `--no-project-context` |
| `docs/configuration.md` 改名说明 | 三条历史改名 | 追加 `/context` 拆分去向；`/handoff auto\|0.4\|target\|keep\|send\|draft` → `threshold`/`budget`/`mode`；伞形 `on\|off <feature\|all>` → 裸 `on\|off` |
| `tests/switches-test.mjs` | 10 处调用伞形（`off autolearn`、`off archive`、`on archive`、`off memory`、`on memory`、`off handoff`、`on handoff`、`off all`、`on all` ×2）与文件头注释 | per-feature 调用改派到本层命令（`/memory`、`/session-log`、`/handoff`、`/autolearn`）；`off all`/`on all` → 裸 `off`/`on`；头注释同步 |
| `index.ts` 用法串 / 补全 / 注释 | `Usage: /project-context … on\|off <feature\|all> …`；`on`/`off` 两级的特性值补全；第 30 行注释 | 去目标；补全只留 `on`/`off` 动词；注释写明批量语义 |
| `handoff/settings.ts` 注释 | 引 `/project-context off handoff`、`off memory` | 改指 `/handoff off`、`/memory off` |
| `memory/status.ts` 截断提示 | `raise it with /project-context max-memory <n>` | `/memory max-memory <n>` |
| `index.ts` cap 告警与用法串 | `/project-context max-memory …` | `/memory max-memory …` |
| `memory/report.ts` 暂停提示 | `Fix the route with /project-context model` | 不变（`model` 仍跨层） |
| `CHANGELOG.md` | v0.2.3 | 新增 v0.3.0（破坏性） |

## 5. 验收

- **逐行覆盖**：`/context` 三行各出现在目标层命令通知里、同一 helper 生成；**单侧变异**（删该行 → 断言变红）。
- 补全逐项断言：`/project-context` 含 `status` `on` `off` `model` `max-tokens` 且**不含** `max-memory`、不含特性值；`/memory` 含 `update` `on` `off` `max-memory`；`/session-log` 含 `write` `import` `on` `off`；`/handoff` 含 `threshold` `budget` `mode` 且不含 `auto` `target` `keep` `send` `draft`。
- 行为等价：裸 `on\|off` 一次写四个键；`threshold auto\|0.4`、`budget target 64k`、`budget keep off`、`mode draft` 各自落原键；`pi.commands` 无 `context`；`force-auto` 仍可被自动回路调用（`handoff-test.mjs` 不回归）。
- `status` 仍六行（`Memory cap warning:` 文本改指 `/memory`）；全套 `node tests/run-all.mjs` 绿（只加断言，不新增测试文件）。

## 6. 工作量与发版

`index.ts`（`on\|off` 改裸批量 + 去 `max-memory` + 用法/补全/注释）~25 行；`memory/report.ts` ~30 行；
`archive/archive.ts`（删 `/context`、裸调用改只读 + `write` + `on\|off`）~30 行；`handoff/run.ts`（动词收缩 + 补全 + 用法串）~45 行；
`memory/status.ts` 1 行；测试 ~60 行（switches-test 10 处调用改造 + 覆盖/变异断言）；docs + CHANGELOG ~40 行。
经验修正（本仓偏低约 1.7x）⇒ 预算 **~400 行**。属 `extensions/` ⇒ **tag + pin + 重启**；破坏性 ⇒ **v0.3.0**。

## 7. 非目标与待决

**非目标**：不按层拆 `model`/`max-tokens`（§1.2）；命令面不加扩展开关（只有 run 级 flag）；不改 pi CLI flag；不做归档 retention；不引入命令别名。

**待决**：

1. `/handoff` 裸比例**硬切**还是留作不进补全的隐藏同义？
2. `/session-log` 裸调用取**只读 + `write`** 还是最小版（写完再印两行）？
3. 伞形名保留，还是改 `/settings` / `/pc`？
4. `budget` 动词名可否（备选 `tokens`）？
5. §1.2 的挡（不按层拆 `model`/`max-tokens`）可否？
