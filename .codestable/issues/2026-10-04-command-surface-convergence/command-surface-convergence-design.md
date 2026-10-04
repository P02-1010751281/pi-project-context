---
doc_type: design
issue: command-surface-convergence
status: design-draft
revision: 6
date: 2026-10-04
decides: 命令面按层归位的完整契约；owner 已回答五问并追加兼容链议题
supersedes: revision 5 的待决项；owner 定向「裸比例硬切、/session-log 只读+write、伞形名保留、budget、model/max-tokens 不拆」
---

# 命令面收束设计（revision 6：定稿候选）

## 0. owner 已答

| # | 议题 | 结论 |
| --- | --- | --- |
| 1 | `/handoff` 裸比例 | **硬切**，不再接受裸比例 |
| 2 | `/session-log` 裸调用 | **只读 + `write`** |
| 3 | 伞形名 | **保留 `/project-context`**（`/settings` 与 pi 撞名，`/pc` 不直观） |
| 4 | token 预算动词 | **`budget`**；二级词 `target`/`keep` 待定（owner 认为会迷惑） |
| 5 | `model`/`max-tokens` 按层拆 | **暂不拆**（精细化调用的理由不充分） |
| 6 | 兼容链是否收缩 | owner 提出，见 §7 |

## 1. 三个关键判断

### 1.1 伞形 `on|off`：四特性批量，非总开关

- 形态写死为**裸 `on|off`**（无目标）：一次写 `archiveEnabled` `autoConsolidate` `autoLearn` `handoffEnabled`。
- **不接受 feature 名**（per-feature 只住本层命令）、**不接受 `all` 记号**（裸调用即全部）。
- **不是扩展开关**：命令面没有"关掉整个扩展"；唯一整扩展禁用是 CLI flag `--no-project-context`（run 级，`shared/config.ts` 注释为 Run-level master switch）。

### 1.2 `model` / `max-tokens`：仍住伞形

owner 判定精细化调用的理由不充分 ⇒ 维持单条 dedicated 辅助路由（`memory/report.ts` 措辞即单数）。
将来若出现"某一层单独被配额卡住"的现场事实，再做**可选覆盖 + 继承默认**形态；记入审计作为触发条件。

### 1.3 `/handoff` 收缩：13 → 9 个公开动词

| 现在 | 收缩后 | 键（不动） |
| --- | --- | --- |
| `auto` | `threshold auto` | `handoffAdaptive` |
| 裸 `0.4` / `40%` | **不再接受**（硬切） | — |
| `target <n>` | `budget <二级词> <n>` | `handoffTargetTokens` |
| `keep <n\|off>` | `budget <二级词> <n\|off>` | `handoffKeepTokens` |
| `send` / `draft` | `mode <send\|draft>` | `handoffMode` |

- 配置键一个不动 ⇒ 无迁移。
- 隐藏内动词保留、不进补全：`force-auto`（自动触发回路）、`language`（`lang`，`handoff-test.mjs:307` 已钉）、`run`/`force`（`now`）。
- CLI flag 不动：`handoff-ratio` 仍取 `auto|0.4|40%|off`。
- 值形态：`threshold` 走 `parseRatio`（`>1` 除以 100）⇒ `40`、`0.4`、`40%` 等价；`budget` 走 `parseTokenCount` ⇒ `20000`、`12k`、`1.5k`。

### 1.4 二级词命名（owner 认为 `target`/`keep` 会迷惑）：建议 `summary` / `recent`

两个数**量的不是同一件事**，现有词各自说不出量的是什么：

| 键 | 实际含义 | 现词 | 建议词 | 理由 |
| --- | --- | --- | --- | --- |
| `handoffTargetTokens` | 摘要**产出**的目标量（非硬上限，不参与触发公式，被护栏压掉时点名） | `target` | `summary` | "target" 没说 target 什么；`summary` 直指被定量的对象 |
| `handoffKeepTokens` | 逐字保留的**近期窗口**（不是摘要） | `keep` | `recent` | "keep" 没说保留什么；`recent` 与 status 现有措辞 `~20k recent kept` 对齐 |

- 形态：`budget summary 64k` / `budget recent 20k` / `budget recent off`。
- 对称：两个二级词都命名"被定量的对象"（摘要 / 近期窗口）。
- 连带（若采纳）：`run.ts` 分派 + `HANDOFF_VALUE_COMPLETIONS`（`run.ts:532`）+ 用法串 + status 行 `· target 64k` → `· summary 64k` + 护栏点名句 `handoff target 200k is not applied in full`（`handoff-test.mjs:458` 钉住）+ `docs/configuration.md:108`。
- **测试改动为零**：全仓无任何测试调用 `target`/`keep` 动词。
- 备选：只改一个（`budget summary` + `budget keep`）；或 `verbatim` 代 `recent`（更准但更术语）。

## 2. 完整命令面（终态，⚠ 标记二级词待定）

| # | 命令 | 层 | 动词 / 参数 | 取值 | 效果 | 相对今天 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `/project-context` | 跨层 | 裸 / `status` | — | 只读六行总览 | 不变 |
| 2 | | | `on\|off`（裸） | — | 一次设置四个特性键 | **改**：原 `on\|off <feature\|all>` |
| 3 | | | `model <provider>/<id>` | `off` / `session` | `provider` `model`（L2/L3/L4 共用） | 不变 |
| 4 | | | `max-tokens <n>` | `default` | `maxTokens` `maxOutputTokens` | 不变 |
| 5 | `/memory` | L2 | 裸 | — | 只读：`MEMORY.md` 状态 ＋ `Context file:` 路径 | **新增**第二行（原 `/context` 的） |
| 6 | | | `update` | — | 立即 consolidation | 不变 |
| 7 | | | `on\|off` | — | `autoConsolidate` | **新增** |
| 8 | | | `max-memory <n>` | `default` | `maxMemoryChars` | **搬家**：原伞形 |
| 9 | `/handoff` | L3 | 裸 / `status` | — | 只读一行 | 不变 |
| 10 | | | `on\|off` | — | `handoffEnabled` | 不变 |
| 11 | | | `threshold auto\|num` | `0.4` / `40%` / `40` | `handoffAdaptive` + `handoffThresholdRatio` | **合并** `auto` + **硬切**裸比例 |
| 12 | | | `budget summary <n>` ⚠ | token 数 | `handoffTargetTokens` | 原 `target <n>` |
| 13 | | | `budget recent <n\|off>` ⚠ | token 数 / `off` | `handoffKeepTokens` | 原 `keep <n\|off>` |
| 14 | | | `thinking <off\|session\|level>` | 补全列 `off` `session` | `handoffSummaryThinking` | 不变 |
| 15 | | | `mode <send\|draft>` | 二选一 | `handoffMode` | 原两个裸词 `send`/`draft` |
| 16 | | | `guard <wait\|draft\|send\|skip>` | 四选一 | `handoffGuard` | 不变 |
| 17 | | | `lang <auto\|zh\|en>` | 三选一（`language` 同义） | `handoffLanguage` | 不变 |
| 18 | | | `now` | —（`run`/`force` 同义） | 立即交接 | 不变 |
| 19 | `/autolearn` | L4 | 裸 | — | 立即沉淀 | 不变 |
| 20 | | | `list` / `approve <name>` / `reject <name>` | 候选名 | 候选审阅与落地 | 不变 |
| 21 | | | `on\|off` | — | `autoLearn` | 不变 |
| 22 | `/session-log` | L5 | 裸 | — | **只读**：存档状态 ＋ `Session index:` ＋ `Session logs:` | **改**：原裸调用写文件 |
| 23 | | | `write` | — | 立即写当前存档（原裸调用动作） | **新增** |
| 24 | | | `import <path…>` | 文件 / 目录，可多个 | 回填 + 重建索引 | 不变 |
| 25 | | | `on\|off` | — | `archiveEnabled` | **新增** |
| 26 | `/context` | — | — | — | **退役**，三行按 §3 拆分 | **删** |

已消失：伞形的 `<feature|all>` 目标与 `max-memory`；`/handoff` 的 `auto`、裸比例、`target`、`keep`、`send`、`draft`。

## 3. `/context` 拆分与命名

| `/context` 的行 | 产物层 | 新家 |
| --- | --- | --- |
| `Context file: <CONTEXT.md>` | L2 | `/memory` 裸调用 |
| `Session index: <INDEX.md>` | L5 | `/session-log` 裸调用 |
| `Session logs: <dir>` | L5 | `/session-log` 裸调用 |

路径 helper 全在 `shared/paths.ts`（L6），只换调用点。伞形名保留（owner 定），注册描述改为跨层设置与状态口径。
**关键约束**：`/memory` 新增行必须与内存状态行**同一通知、且在其后**，否则 `memory-ops-test.mjs` 的 `both()`（取通知第 0 元素）会破。

## 4. 连带修改清单

| 位置 | 改动 |
| --- | --- |
| `index.ts` | 伞形 `on\|off` 改裸批量、去 `max-memory`、用法串、补全表、`index.ts:30` 注释 |
| `memory/report.ts` | `on\|off` + `max-memory` + `Context file:` 行 + 补全 |
| `archive/archive.ts` | 删 `/context` 注册；裸调用改只读；新增 `write` 与 `on\|off` |
| `handoff/run.ts` | 动词收缩（`threshold`/`budget`/`mode`）、补全表、用法串、status 行措辞 |
| `memory/status.ts:24` | 截断提示改指 `/memory max-memory` |
| `index.ts:123,131` | cap 告警与用法串改指 `/memory` |
| `handoff/settings.ts` | 两处注释改指 `/handoff off`、`/memory off` |
| `docs/configuration.md` | 命令表、说明段（含 107–110 行裸比例与 target 措辞）、入口关系段、改名说明 |
| `CHANGELOG.md` | 新增 v0.3.0（破坏性命令面） |
| `tests/switches-test.mjs` | **10 处**伞形调用改造：per-feature → 本层命令；`off all`/`on all` → 裸；`:122` 裸比例 → `threshold 0.5` |
| `tests/memory-ops-test.mjs` | M4 的 **5 处** `/project-context max-memory …` → `/memory max-memory …`；用法串断言；`both()` 改比第一行 |
| `tests/handoff-test.mjs` | `:554` `auto 0.7` → `threshold auto 0.7`；二级词若改 ⇒ `:458` 护栏点名句 |
| `tests/registration-test.mjs` | 补 `/context` 已删、`/session-log` 新增动词的补全断言 |

## 5. 验收

- **逐行覆盖**：`/context` 三行各出现在目标层命令通知里、同一 helper 生成；**单侧变异**（删该行 → 断言变红）。
- 补全逐项断言：伞形含 `status on off model max-tokens`，不含 `max-memory` 与特性名；`/memory` 含 `update on off max-memory`；`/session-log` 含 `write import on off`；`/handoff` 含 `threshold budget mode`，不含 `auto target keep send draft`。
- 行为等价：裸 `on\|off` 一次写四键；`threshold auto` / `threshold 0.4`；`budget …` 落原键；`mode draft` 落 `handoffMode`；`force-auto` 仍被自动回路调用。
- `/session-log` 裸调用**只读**（断言：不产生新存档文件）；`write` 产生（该命令首次获得测试覆盖）。
- `pi.commands` 无 `context`；`status` 仍六行；`node tests/run-all.mjs` 绿（只加断言，不新增文件）。

## 6. 工作量与发版

代码 ~130 行；测试 ~70 行；docs + CHANGELOG ~40 行。经验修正（本仓偏低约 1.7x）⇒ 预算 **~400 行**。
属 `extensions/` ⇒ **tag + pin + 重启**；破坏性 ⇒ **v0.3.0**。

## 7. 兼容链：现状、实测与建议（owner 新议题）

**结构**（`shared/config.ts`）：三条来源叠在扁平键之上——① 同文件嵌套 `features.*` / `autolearn.*` / `handoff.*`；
② 旧分文件 `.agents/memory/autolearn.json`；③ 全局 `~/.pi/agent/auto-handoff.json`。

**实测（2026-10-04）**：

| 度量 | 值 |
| --- | --- |
| 全机 `project-context.json` | **9 个**，全部 23 键扁平，**0 个**用嵌套形态 |
| 全机 `autolearn.json` | **0 个** |
| `~/.pi/agent/auto-handoff.json` | **不存在** |
| 无任何回退链的键 | **8/23**（`consolidateTurns`、`consolidateIntervalMs`、`forceDedupeMs`、`maxTokens`、`maxOutputTokens`、`maxMemoryChars`、`provider`、`model`） |
| 带嵌套 `features.*` 的键 | 4（`archiveEnabled`、`autoConsolidate`、`autoLearn`、`handoffEnabled`） |
| 带嵌套 `autolearn.*` 的键 | 3（`autolearnAt/Turns/IntervalMs`） |
| 带嵌套 `handoff.*` 的键 | 8（`handoffAdaptive` 起至 `handoffLanguage`） |
| 读全局 `auto-handoff.json` 的键 | 9（上列 8 个 ＋ `handoffEnabled`） |
| 读旧分文件的键 | 2（`autoLearn`、`autolearnAt`） |
| 扁平化提交 | `b5d825d` **2026-09-25** ⇒ 扁平形态仅 **9 天** |

**反直觉发现**：链**没有在增长**。8/23 个键（含全部后加的 `consolidate*`、`forceDedupeMs`、`max*`）**压根没有**回退项——
即"新键不继承旧形态"已是既成事实，只是没写成规则。链长但静态。

**建议（三档）**：

1. **现在（v0.3.0，零风险）**：把既成事实写成规则并钉住——*新增键不得带旧形态回退项*，补一条断言（新键忽略嵌套值）。不删任何回退，避免混入静默配置行为变更。
2. **v0.4.0 候选**：退役两条**旧文件**读取（`autolearn.json`、`auto-handoff.json`）。机器可证依据：全机 0 命中；且是"旧分文件"时代的产物。
   代价：从未写过配置的旧项目会静默回落到默认值——**静默丢配置比丢命令更重**（命令会报错，配置不会）。
3. **嵌套形态退役**：需要一次"检测到嵌套 → 写扁平 + 通知"的显式迁移才安全；但按本仓判据，*新机制必须先有现场事实*，而今天是 0/9 ⇒ **只能记为 residual，不做**。
   判定窗口建议：扁平形态 ≥ 60 天 **且** 新一轮全机扫描仍 0 命中。

**附带边界**：兼容链的读路径只影响"自 2026-09-25 起从未写过配置的项目"——任何一次配置写入都会把文件刷成扁平（写整个文档），所以影响面天然收敛。

## 8. 非目标与待决

**非目标**：不按层拆 `model`/`max-tokens`（§1.2）；命令面不加扩展开关；不改 pi CLI flag；不做归档 retention；不引入命令别名；不在 v0.3.0 删任何配置兼容链。

**待决**：

1. §1.4 二级词：`budget summary` + `budget recent`（建议）／只改一个／`verbatim`？
2. §7 兼容链：接受"现在只立规则、v0.4.0 再退旧文件、嵌套形态记 residual"？
3. 未跟踪技能 `.agents/skills/pi-project-context-consolidation-prompt-rule/`（40 行，desc 162）两处违规已复核：正文含兄弟仓测量值（`UF 207/205`、`42,006/18,976`）；守卫表达式写死字面数字而非形态模式。处置：改后收编／删除／暂留？
