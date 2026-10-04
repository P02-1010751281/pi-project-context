---
doc_type: design
issue: command-surface-convergence
status: design-draft
revision: 4
date: 2026-10-04
decides: 命令面按层归位的完整契约（含 /handoff 动词收缩、伞形去 on|off、命名、/context 拆分）
supersedes: revision 3 的 /handoff 动词集与伞形开关归属；owner 定向「/handoff 收缩、伞形不留 on|off」
---

# 命令面收束设计（revision 4：一条命令一层）

## 0. 定向与判据

owner 定向：

1. `/project-context` 不留 `on|off <feature|all>`。
2. `model` / `max-tokens` 是否也该由各命令自己指定。
3. `/handoff` 收缩：阈值统一为 `threshold <auto|num>`，token 预算统一，`mode <send|draft>`。
4. 命名问题一块修；`/context` 拆分或另法修掉。

判据（沿用）：一个参数住哪，由**它改的东西属于哪一层**决定；层内私有设置一律回本层命令，**连"批量入口"也不再保留**。

## 1. 三条结论

### 1.1 伞形去 `on|off`：同意

四个特性各有本地开关后就无重复口径：

| 特性 | 键 | 层内入口 |
| --- | --- | --- |
| `memory` | `autoConsolidate` | `/memory on\|off`（新增） |
| `archive` | `archiveEnabled` | `/session-log on\|off`（新增） |
| `handoff` | `handoffEnabled` | `/handoff on\|off`（已有） |
| `autolearn` | `autoLearn` | `/autolearn on\|off`（已有） |

代价两条，都在文档/注释层，无代码耦合：

- 失去「一次全关」：`on|off all` 消失，要关四次要敲四条命令。
- 两处注释引用了伞形批量形式，需改指本层命令：`handoff/settings.ts` 的 `/project-context off handoff` 与 `/project-context off memory`。
- `docs/configuration.md` 现文「`memory`、`archive` 没有自己的 `on|off`，只能走伞形」必须重写。

### 1.2 `model` / `max-tokens` 按层拆：**建议不拆**（有数据）

| 论据 | 内容 |
| --- | --- |
| 代码里的设计意图 | `memory/report.ts` 的暂停提示原文是 "Configure a **dedicated** model with /project-context model"——单数、专用，说明现状就是**一条**辅助路由 |
| 现场需求 | 本机 9 个 `project-context.json` 里恰有 1 个值与默认不同，8 个 handoff 旋钮一个都没被碰过 ⇒ 无按层分路的需求证据 |
| 仓库自身待办 | 复杂度审计的 owner 待审项里明确有「stop knob growth」 |
| 成本 | 按层拆＝至少 +6 个键（provider/model × 3 层），或「可覆盖 + 继承默认」形态 ＋6 个可选键 |

**替代（若你要按层）**：只做**可选覆盖**形态——`/memory model …`、`/handoff model …`、`/autolearn model …`，未设置时继承跨层默认，行为不变。
这是加法、不破坏，但键数量仍增长，且无现场证据；建议等出现「某层单独被配额卡住」的现场事实再做（`report.ts` 已有按失败类别的暂停提示，届时可指到该层的覆盖）。

### 1.3 `/handoff` 收缩：同意，且是本设计里收益最大的一步

现状 13 项里有 **3 处"裸词带状态"**（`auto`、裸 `0.4`/`40%`、`send`/`draft`），与其余「动词 + 取值」的形状不一致，也是补全菜单最难读的部分。收缩为统一形状：

| 现在 | 收缩后 | 说明 |
| --- | --- | --- |
| `auto` | `threshold auto` | 自适应（`handoffAdaptive=true`） |
| 裸 `0.4` / `40%` | `threshold 0.4` | 固定比例（`handoffAdaptive=false` + `handoffThresholdRatio`） |
| `target <n>` | `budget target <n>` | 摘要目标量 |
| `keep <n\|off>` | `budget keep <n\|off>` | 逐字保留的近期 token |
| `send` / `draft` | `mode <send\|draft>` | 交接后注入方式 |

- **配置键一个不动**（`handoffAdaptive` / `handoffThresholdRatio` / `handoffTargetTokens` / `handoffKeepTokens` / `handoffMode`），避免迁移。
- **隐藏内动词保留**：`force-auto`（自动触发回路 `maybeTrigger` 使用）；`language`（`lang` 的同义）；`run`/`force`（`now` 的同义）——它们不进补全表。
- **裸比例入口决定**：硬切（不再接受裸 `0.4`）并给用法提示，与仓内「无别名」政策一致；若你要保留肌肉记忆，也可把它留成不进补全的隐藏同义（与 `language` 同规格）。
- **CLI flag 不动**：`handoff-ratio` 仍取 `auto|0.4|40%|off`，`no-auto-handoff` 不变（flag 不是命令面）。
- 收缩后 `/handoff` 公开动词 **9 个**：`status` `on|off` `threshold` `budget` `thinking` `mode` `guard` `lang` `now`，全部「动词 + 取值」。

## 2. 调整后完整命令面（终态）

| # | 命令 | 层 | 动词 / 参数 | 取值 | 效果（键 / 只读） |
| --- | --- | --- | --- | --- | --- |
| 1 | `/project-context` | 跨层 | 裸 / `status` | — | 只读六行总览 |
| 2 | | | `model <provider>/<id>` | 或 `off` / `session` | `provider` `model`（L2/L3/L4 共用） |
| 3 | | | `max-tokens <n>` | 或 `default` | `maxTokens` `maxOutputTokens`（同上） |
| 4 | `/memory` | L2 | 裸 | — | 只读：`MEMORY.md` 状态 ＋ `Context file:` 路径 |
| 5 | | | `update` | — | 立即 consolidation |
| 6 | | | `on\|off` | — | `autoConsolidate` |
| 7 | | | `max-memory <n>` | 或 `default` | `maxMemoryChars` |
| 8 | `/handoff` | L3 | 裸 / `status` | — | 只读一行 |
| 9 | | | `on\|off` | — | `handoffEnabled` |
| 10 | | | `threshold <auto\|num>` | `auto` / `0.4` / `40%` | `handoffAdaptive` + `handoffThresholdRatio` |
| 11 | | | `budget target <n>` | token 数 | `handoffTargetTokens` |
| 12 | | | `budget keep <n\|off>` | token 数 / `off` | `handoffKeepTokens` |
| 13 | | | `thinking <off\|session\|level>` | 补全列 `off` `session` | `handoffSummaryThinking` |
| 14 | | | `mode <send\|draft>` | 二选一 | `handoffMode` |
| 15 | | | `guard <wait\|draft\|send\|skip>` | 四选一 | `handoffGuard` |
| 16 | | | `lang <auto\|zh\|en>` | 三选一（`language` 同义） | `handoffLanguage` |
| 17 | | | `now` | —（`run`/`force` 同义） | 立即交接 |
| 18 | `/autolearn` | L4 | 裸 | — | 立即沉淀 |
| 19 | | | `list` / `approve <name>` / `reject <name>` | 候选名 | 候选审阅与落地 |
| 20 | | | `on\|off` | — | `autoLearn` |
| 21 | `/session-log` | L5 | 裸 | — | 只读：存档状态 ＋ `Session index:` ＋ `Session logs:` |
| 22 | | | `write` | — | 立即写当前存档（原裸调用动作）¹ |
| 23 | | | `import <path…>` | 文件 / 目录，可多个 | 回填 + 重建索引 |
| 24 | | | `on\|off` | — | `archiveEnabled` |
| 25 | `/context` | — | — | — | **退役**，三行按 §3 拆分 |

¹ 最小替代：裸调用保持「写」，写完再印那两行，不新增 `write`。
**已消失**：伞形的 `on|off <feature|all>` 与 `max-memory`；`/handoff` 的 `auto`、裸比例、`target`、`keep`、`send`、`draft`。

## 3. `/context` 拆分与命名

| `/context` 的行 | 产物层 | 新家 |
| --- | --- | --- |
| `Context file: <CONTEXT.md>` | L2 | `/memory` 裸调用 |
| `Session index: <INDEX.md>` | L5 | `/session-log` 裸调用 |
| `Session logs: <dir>` | L5 | `/session-log` 裸调用 |

四个路径 helper 全在 `shared/paths.ts`（L6），拆分只换调用点，不新增 helper。

命名三处：

| 冲突面 | 修法 |
| --- | --- |
| 命令层 `/context` vs `/project-context` | 拆分后退役 `/context` ⇒ 命令层只剩一个含 `context` 的命令 |
| 产物称呼（`Context:` / `Project context:`） | v0.2.3 已统一为 `Context file:` |
| 伞形名 | 收缩后伞形只剩 `status` + `model` + `max-tokens`（纯跨层）⇒ 建议**保留名字**并把注册描述改为 `cross-layer settings and status`。若坚持改：`/settings`（准确，需防与 pi 未来命令撞名）或 `/pc`（短），均为硬切 |

## 4. 连带修改

| 位置 | 现文 | 改后 |
| --- | --- | --- |
| `docs/configuration.md` 命令表 | `/handoff` 13 项；`/project-context` 含 `on\|off`、`max-memory`；`/context` 一行 | 按 §2 重写；`max-memory` 移到 `/memory` 行；删 `/context` 行 |
| `docs/configuration.md` 说明段 | 「裸 `/handoff 0.6`」等旧写法；「`memory`、`archive` 只能走伞形」；`/context` 三行独有 | 全段重写为收缩后写法与拆分去向 |
| `docs/configuration.md` 改名说明 | 三条历史改名 | 追加 `/context` → `/memory` + `/session-log`；`/handoff auto\|0.4\|target\|keep\|send\|draft` → `threshold`/`budget`/`mode` |
| `handoff/settings.ts` 注释 | 引 `/project-context off handoff`、`off memory` | 改指 `/handoff off`、`/memory off` |
| `memory/status.ts` 截断提示 | `raise it with /project-context max-memory <n>` | `/memory max-memory <n>` |
| `index.ts` cap 告警与用法串 | `/project-context max-memory …` | `/memory max-memory …` |
| `memory/report.ts` 暂停提示 | `Fix the route with /project-context model` | 不变（`model` 仍跨层） |
| `CHANGELOG.md` | v0.2.3 | 新增 v0.3.0（破坏性） |

## 5. 验收

- **逐行覆盖**：`/context` 三行各出现在目标层命令通知里、同一 helper 生成；**单侧变异**（删该行 → 断言变红）。
- `pi.commands` 无 `context`；`/project-context` 补全不含 `on|off` / `max-memory`；`/memory` 补全含 `on|off` / `max-memory`；`/session-log` 补全含 `write` / `on|off` / `import`；`/handoff` 补全含 `threshold` / `budget` / `mode` 且不含 `auto` / `target` / `keep` / `send` / `draft`。
- `/handoff` 行为等价：`threshold auto|0.4`、`budget target 64k`、`budget keep off`、`mode draft` 各自落到原键；`force-auto` 仍可被自动回路调用（`handoff-test.mjs` 既有断言不回归）。
- `status` 仍六行（`Memory cap warning:` 文本改指 `/memory`）；`switches-test.mjs` 的嵌套 handoff 配置映射断言不回归。
- 全套 `node tests/run-all.mjs` 绿（只加断言，不新增测试文件）。

## 6. 工作量与发版

`index.ts`（去伞形 `on|off` + `max-memory` 与补全）~20 行；`memory/report.ts`（`on|off` + `max-memory` + `Context file:` 行 + 补全）~30 行；
`archive/archive.ts`（删 `/context`、`/session-log` 裸调用改只读 + `write` + `on|off`）~30 行；`handoff/run.ts`（动词收缩 + 补全表 + 用法串）~45 行；
`memory/status.ts` 1 行；测试 ~50 行；docs + CHANGELOG ~35 行。经验修正（本仓偏低约 1.7x）⇒ 预算 **~350 行**。
属 `extensions/` ⇒ **tag + pin + 重启**；破坏性命令面变更 ⇒ **v0.3.0**。

## 7. 非目标与待决

**非目标**：不按层拆 `model`/`max-tokens`（§1.2）；不改 pi CLI flag；不做归档 retention；不引入命令别名。

**待决**：

1. §1.2 的挡（不拆 `model`/`max-tokens`）你是否接受？若坚持按层，选「可覆盖 + 继承默认」形态。
2. `/handoff` 裸比例是**硬切**还是留作隐藏同义？
3. `/session-log` 裸调用取**只读 + `write`** 还是最小版（写完再印两行）？
4. 伞形名保留，还是改 `/settings` / `/pc`？
5. `budget` 这个动词名可否（备选 `tokens`）？
