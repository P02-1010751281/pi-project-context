# 配置与命令

## 配置文件

配置位于 `<project>/.agents/memory/project-context.json`。v0.4.0 起键名**镜像命令路径**（`.codestable/reference/vocabulary-conventions.md` 是权威表）；
七个改名两仓同名：dsh 改的是同样七个拼写，两仓配置面不在拼写上分叉。差别是 dsh profile 里残留的旧拼写没有别名可退、须在宿主重启前改掉；本项目旧名在首次读配置时一次性迁移。

```json
{
  "archiveEnabled": true,
  "memoryEnabled": true,
  "autolearnEnabled": true,
  "handoffEnabled": true,
  "autolearnAt": 0,
  "autolearnTurns": 20,
  "autolearnIntervalMs": 1800000,
  "consolidateTurns": 6,
  "consolidateIntervalMs": 300000,
  "forceDedupeMs": 15000,
  "maxTokens": 8192,
  "maxOutputTokens": 32768,
  "maxMemoryChars": 32000,
  "provider": "",
  "model": "",
  "handoffThresholdAuto": true,
  "handoffThresholdRatio": 0.4,
  "handoffBudgetSummaryTokens": 64000,
  "handoffBudgetRecentTokens": 20000,
  "handoffMode": "send",
  "handoffGuard": "wait",
  "handoffLang": "auto"
}
```

## 常用字段

| 字段 | 作用 |
|---|---|
| `archiveEnabled` | 是否自动存档会话 |
| `memoryEnabled` | 是否自动更新 memory/context |
| `autolearnEnabled` | 是否自动沉淀项目 skill |
| `maxMemoryChars` | `MEMORY.md` 正文 cap；4000–200000，默认 32000；可用 `/memory max-memory <n>` 修改 |
| `provider` / `model` | consolidation/autolearn 的辅助模型路由；空值使用会话模型 |
| `maxTokens` | consolidation/autolearn 输出上限；默认 8192，最低 256 |
| `maxOutputTokens` | 辅助输出自适应上限；默认 32768 |
| `consolidateTurns` / `consolidateIntervalMs` | 整理的轮数/时间节流 |
| `autolearnTurns` / `autolearnIntervalMs` | 沉淀的轮数/时间门槛 |
| `forceDedupeMs` | 强制整理的去重窗口 |
| `handoffThresholdAuto` / `handoffThresholdRatio` | 阈值是自适应还是固定比例 |
| `handoffBudgetSummaryTokens` / `handoffBudgetRecentTokens` | 交接预算（对应 `/handoff budget summary|recent`）；详见 [handoff 预算与恢复](handoff.md) |
| `handoffMode` | `send` 自动发送 successor continuation，或 `draft` 留在编辑器 |
| `handoffGuard` | 遇到待回答问题时 `wait`/`draft`/`send`/`skip` |
| `handoffLang` | `auto`、`zh` 或 `en`（对应 `/handoff lang`） |

### memory cap

`maxMemoryChars` 限制的是 `MEMORY.md` 正文，两条路径的裁剪方式不同：

**分节路径**（结构化 tool 回复，或回复是规范的四节 bullet 文档）：四段的份额是**目标值**，不是硬上限——唯一硬约束是
`maxMemoryChars`。渲染器先把每段用不完的目标汇成一个池，超额段按超出比例借用（池够时精确等于各自超额，即**一条不丢**），
只有整个文档到达 cap 时才整条丢弃条目。每段先按**借到的额度**推出单项上限（`max(1, min(MAX_LIST_ITEM_CHARS, 额度 − 3))`），
单项按行边界截断（surrogate-safe），标题与节序由代码拥有。单条永远放得进空段，所以 `正文长度 <= cap` 是**构造性成立**的。
**渲染器不写任何截断标记**（写路径会把标记再抹掉）：丢弃信息只经返回值 `sectionDropped` / `droppedItems` / `droppedSamples` /
`itemTruncated` 上抛。
每项目每进程写一次 `errors.log`，该行列出被丢条目的**样本**（最多 3 条、每条 ≤ 72 字符）。
通知与回复里的「样本在 errors.log 里」只在本次真的写了那行时才说，被限流的后续 pass 改成「样本来自本项目第一次提示」。
**不给数字建议**（总文档离上限还有多少不是可用余额，`max-memory` 只取整，给了还会再裁）。

**逐字路径**（自由结构旧记忆、回复没有四节 bullet 结构）：保留头尾、丢弃中段，文末追加

```text
正文头段（整行边界）
正文尾段（整行边界）      ← 被丢弃的是中段
_[memory truncated at N characters: M dropped]_
```

marker 行不计入正文 cap。超限时在每项目每进程写一次 `errors.log`，并在通知、显式 consolidation 回复和 `/project-context status` 中提示（含所需字符数与 `/memory max-memory` 建议 —— 这条路径下数字是准的）
。journal 写入、fold、外部编辑比较、load、legacy 读取和 OMP migration 使用同一个显式 cap。

cap 每次写入都生效：只要 render 仍超限，下一次写入会再裁一次。已进 journal 的内容才有机会留下 ⇒ **手工并回 `MEMORY.md` 不算持久化**（要持久就抬高 `maxMemoryChars` 或让内容进 consolidation 输出）。

`MEMORY.md` 的顶层结构收敛到固定的 4 节：`Project` 20% / `Invariants` 40% / `Pitfalls` 25% / `Index` 15%（份额与每节说明定义在 `memory/schema.ts`）
。consolidation prompt 先扣掉固定开销（`# Project Memory` 标题 + 4 个 `##` 节标题及其空行）再按 `maxMemoryChars` 算出每节的**目标**字符数，让模型知道该把内容控制在哪里；

并要求长解释指针化到版本化 `docs/`（只指向**已存在且确实承载该细节**的路径，不虚构）。**四节归一后全空 = 不写 memory**（模型只回一堆标题时绝不拿骨架覆盖真记忆；此时仍会更新 context，并在回复里说明 memory 未变）
。**记忆回归守卫**在裁剪前比较新旧 sections，报告 Invariants/Pitfalls 里消失的条目（只报、不拦，`Project`/`Index` 太易变不报）；任一侧无法解析成 sections 则跳过并只记一条诊断。
（v0.4.5 起份额是目标值：渲染器把用不完的份额汇池、超额段按超额比例借用，只有文档到 cap 才丢条目——原先设想的「按节优先序丢」因此作废。）符合度统计仍待后续。

`CONTEXT.md` 同样收敛到固定的 3 节：`Summary` 40%（另受 `MAX_SUMMARY_CHARS=6000` 约束，散文摘要保持短小）/ `Key points` 35% / `Open tasks` 25%，
定义在 `memory/context-schema.ts`。consolidation prompt 与渲染器共用同一张表：先扣掉固定开销（`# Project Context`、`Last updated` 行、3 个节标题及空行、
最坏情况的尾部 `<!-- latest-session-title -->`，以及截断标记的预留）再按份额给出每节字符预算；渲染器按同一预算裁剪（列表按 `MAX_LIST_ITEM_CHARS=800` 截单项、按 `MAX_LIST_ENTRIES=50` 截条目，
再丢尾项；`dropped` 以归一化但未 trim 的完整渲染为基准，因此单项截断与条目上限的损失也计入标记），任一小节被裁就在文末追加严格标记 `_[context truncated: N characters dropped]_`，
并在每项目每进程写一次 `errors.log`。这是与 `MEMORY.md` 同级的收敛目标：已有自由结构的 CONTEXT.md 照常读、注入。

cap 能否装进模型输出上限也做静态校验：稠密（CJK）正文按 1 token/字符最坏估算，
`maxMemoryChars + 1024` 超过输出上限的上界 `max(maxTokens, maxOutputTokens)` 时 `status` 与 `max-memory` 命令都会告警（默认 32000 对 32768 已贴边）
——否则回复很可能在闭合前被截断。模型自身的 `maxTokens` 更小、reasoning 预留或大 context 可能比这个上界更紧，那些情况由 pass 自己的 `clipped` 诊断兜底。

## 命令

一条命令管一层；伞形只留两个以上层共用的东西。

| 命令 | 层 | 用法 |
|---|---|---|
| `/project-context` | 跨层 | `status`；`on|off`（**无目标**：一次开关四个特性）；`model <provider>/<id>|off`；`max-tokens <n>|default` |
| `/memory` | memory | 无参：memory 状态行 ＋ `Context file:` 行；`update`：立即跑 consolidation，重写 `MEMORY.md` 和 `CONTEXT.md`；`on|off`；`max-memory <n>|default` |
| `/handoff` | handoff | `status`、`on|off`、`threshold <auto|比例>`、`budget summary|recent`、`mode`、`guard`、`lang`、`now`（取值见下） |
| `/autolearn` | autolearn | 立即沉淀；`list`、`approve <name>`、`reject <name>`、`on`、`off`。`approve` 会重新套用与提案路径相同的形状规则（描述/体积上下限、注入检测），不满足则拒绝并点名原因 |
| `/session-log` | archive | 无参：存档状态行 ＋ `Session index:` 与 `Session logs:` 两行（**只读**）；`write`：立即写当前存档；`import <session.jsonl|目录>…`：导入历史 session；`on|off` |

每个命令都注册了 `getArgumentCompletions`，所以 Tab 会补全参数（`/memory max-memory ` → `default`，`/handoff guard ` → `wait|draft|send|skip`，`/handoff budget recent ` → `off`）。
`/project-context on|off` 是唯一没有二级补全的命令，因为它不接受目标。
同名覆盖只对 autolearn **自己生成的**技能开放，且必须**在本轮提示词里展示过它的正文**——模型要先在 `inspectSkill` 里点名（最多 2 条），
下一轮才拿到正文；没展示过的名字会被拒绝（`body not shown this pass`）。那类技能的 `SKILL.md` 正文带一行 `<!-- autolearn-generated -->` 标记，
手写技能与旧布局导入的技能仍按「已存在」拒绝（范围与判定见 `docs/architecture.md` 的「技能沉淀与来源」）。

**命令改名（破坏性，无过渡期）**：`/memory-learn` → `/memory update`，`/auto-handoff` → `/handoff`，`/context-update` 直接删除（无别名、无提示）。flag 不变。
**v0.3.0 收束（同样无过渡期）**：`/context` 退役，三行按层归位（context 文件行 → `/memory`，session index 与 session logs → `/session-log`）；
`max-memory` 与四个特性级 `on|off` 从伞形移到本层命令；`/handoff` 的裸比例、`auto`、`target`、`keep`、`send`、`draft` 六个写法被
`threshold`、`budget summary|recent`、`mode` 三个动词取代。**总开关不存在**：命令面只能关四个特性，整扩展禁用用 `--no-project-context` flag。

取值：`mode send|draft`、`guard wait|draft|send|skip`、`lang auto|zh|en`。固定比例模式（`handoffThresholdAuto=false`）
的阈值仍由比例与窗口决定，但低于物理下限时**自动触发会被拒绝**（手动 `/handoff now` 不查阈值）；见
[handoff 预算与恢复](handoff.md) 的物理下限一段。
`handoffThinking` 与 `/handoff thinking` 已在 v0.4.2 退役：它在本仓没有行为读者（只有那个动词写它），回执里
「stored for the dsh profile」的承诺在本仓找不到证据支撑——v0.4.0 的证据只说两仓共享那七个改名拼写，本机的 dsh 产物里这两个键拼写 0 命中（跨仓不可复验，见审计 §9.12 R-2）。这是硬切而非别名：v0.4.1 里它仍是已知键、
值会随写持久化，退役后它按未知键处理（忽略，下次写回时消失）。`mode`/`guard`/`lang` 照旧生效。

说明：`/handoff threshold auto` 是自适应模式（阈值取**两项**——模型的质量拐点：保守 MRCR 拟合曲线，≤~400K 诚实窗口取自身边界、500K 以上收敛到 157K 平台——与窗口末点取小；caps 只降不升）
，`threshold <比例>` 是固定比例模式（`handoffThresholdRatio` 只用于固定模式；`threshold 40`、`threshold 0.4`、`threshold 40%` 等价，都读作 40%），
两种模式共用一个动词、切换即覆盖一个字段。
`budget summary <n>` 是手动设定的**触发请求量**（不参与触发公式，被护栏压掉时 `status` 会点名；v0.4.1 起没有任何摘要调用读它），
`budget recent <n|off>` 是逐字带回新会话的近期窗口（`off` 等价 `0`，即不带原文，只留文件清单与会话日志指针）。`/handoff` 写入时只提交自己拥有的 handoff 键，
因此不会覆盖 `/memory off` 之类的开关、另一个实例的改动或手改的字段。

**入口关系**（v0.3.0 起重排）：一个参数住在**改变它的那一层**。每个特性有自己的 `on|off`（`/memory`、`/session-log`、`/handoff`、`/autolearn`），
伞形只保留两个以上层共用的项：`status`、`model`、`max-tokens`，以及**四特性批量** `on|off`——批量形**不接受目标**，`/project-context off all`
会被拒绝并提示改用裸 `off`（一个事实一个名字）。伞形的批量不是扩展开关：命令面关不掉扩展，唯一的整扩展禁用是 run 级 `--no-project-context` flag。
`/project-context status` 是一屏总览（特性、辅助调用、配置路径、memory 状态行、context 文件行）；memory 状态行由共享的 `memoryStatusLine()` 渲染，
context 文件行由共享的 `contextStatusLine()` 渲染，所以 `/memory` 与伞形两处逐行一致（**不做整块相等**：伞形的副本带更新时间戳）。
`/session-log` 无参只读，打存档状态行与两条路径；`/memory` 无参打 memory 状态行与 context 文件行——`/context` 原来的三行就是这样拆完的。
**一个事实一个名字**（v0.2.3 起）：伞形首行只报特性，标签 `Features:`；context 文件那行都叫 `Context file:`。
旧版有三套叫法：伞形首行与 `/context` 都叫 `Project context:` 却指两样东西，context 文件在 status 里又叫 `Context:`。
## flags

```text
--no-project-context
--handoff-ratio 0.4|auto|off
--no-auto-handoff
```

flags 只影响当前运行；`--no-project-context` 不改项目配置。功能开关控制自动行为，显式命令仍可执行。

## 路由与输出预算

整理与沉淀默认使用会话模型（handoff 不再调用模型）。配置 `provider` 与 `model` 后使用指定路由；路由解析失败或未授权时退回会话模型，并按进程去重告警。`maxTokens` 可按 artifact token 率自适应抬高，
但不超过模型上限和 `maxOutputTokens`。reasoning 模型（`reasoning: true`）会额外预留隐藏思考 token，正文预算相应收紧；若回复被输出上限截断，会自动按更高预算重试一次，仍失败则显式报告截断并保留旧 memory。

handoff 自 v0.4.1 起不调用任何模型，也不再依赖辅助路由，因此 `maxTokens`/`maxOutputTokens` 与它无关；阈值与预算见 [handoff 预算与恢复](handoff.md)。

## 兼容迁移

旧配置形态**迁移一次，不再常驻读路径**：`features.*`、`autolearn.*`、`handoff.*` 嵌套布局，`memory/autolearn.json` 的 `enabled`/`at`，
以及全局 `~/.pi/agent/auto-handoff.json`，都在某项目第一次读配置时被折进扁平键、整份写回，并提示「migrated from …」。
之后的读路径只看扁平键；只有 `legacyConfigPatch()` 认识旧形态，所以新键不会再顺手得到一个回退项（扁平化之后新增的 8 个键从来没有过）。
扁平键已有的值永远优先，迁移不会覆盖当前设置。

v0.4.0 的**改名**走同一台机器：`autoConsolidate`→`memoryEnabled`、`autoLearn`→`autolearnEnabled`、
`handoffTargetTokens`→`handoffBudgetSummaryTokens`、`handoffKeepTokens`→`handoffBudgetRecentTokens`、
`handoffSummaryThinking`→`handoffThinking`（该目标键已于 v0.4.2 退役，见下）、`handoffAdaptive`→`handoffThresholdAuto`、
`handoffLanguage`→`handoffLang`。
旧名与新名并存时**新名优先**，写回后旧名消失；唯一认识这些旧名的地方仍是 `legacyConfigPatch()`。
`handoffThinking` 及其旧名 `handoffSummaryThinking` 在 v0.4.2 **退役**（不是改名）：没有现值可迁，文件里留下的旧键会被忽略，
并在下次写回时随整份重写消失。

旧 memory/session 数据的路径与冲突策略见 [架构与数据模型](architecture.md)。
