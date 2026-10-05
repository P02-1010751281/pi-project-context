# Changelog

只记**行为变化**（`feat` / `fix`）。文档、审计与记忆渲染的提交不入此表 —— 它们在 git 历史与 `.codestable/` 里。
版本号语义近似 semver：`fix` 进 patch，`feat` 或破坏性变更进 minor。

## v0.4.2 — 未发布

### 变更

- **`handoffThinking` 与 `/handoff thinking` 退役**：该键在本仓没有行为读者——它只被那个动词写进
  `project-context.json`，而 `parseConfig` 只保留已知键、`updateConfig` 整份重写，所以它写下的值本来也活不过
  任何一次 pi 写，回执里「stored for the dsh profile」的承诺从一开始就不成立。键、动词、二级补全、旧名迁移项与
  文档一并移除；没有别名，文件里留下的旧键按未知键处理（忽略，下次写回时消失）。保留同拼写的
  `handoffBudgetSummaryTokens` / `/handoff budget summary` 仍有活读者（触发公式）。同一片把常量
  `MIN_SUMMARIZE_TOKENS` 更名为 `MIN_DROP_TOKENS`（语义=最小可丢弃前缀，无行为变化），摘要链删除后
  代码里最后一个 `summarize` 词随之消失。

### 修复

- **注入的前言与分节改为同一次 fence 感知遍历**（`splitSections` → `scanDocument`）：此前前言用一次不看 fence
  的扫描找第一个标题、分节用另一次看 fence 的扫描，一段以 fenced 代码块开头的文档会让块内的 `## X` 既截断
  前言、又变成一个假小节。
- **fence 关闭按 CommonMark 判定**：关闭行必须是同字符、不短于开启行、且除空白外无内容；此前只比较首字符，
  一个三反引号行会提前关掉四反引号块。
- `session_shutdown` 的失败回退把存在性检查精确到 `.agents/memory`（与该处注释一致）：该分支只在
  `getProjectRoot` 拒绝时才可达，而它自身的回退就是会话 cwd，所以这是精度修正而非行为修正
  （单侧变异全绿，与 shutdown 守卫同类）。

## v0.4.1 — 2026-10-05

### 变更

- **memory / CONTEXT 注入改为渐进披露**：每轮固定前缀不再整篇注入这两个文件——决策与踩坑相关的小节
  （`MEMORY.md` 的 `## Invariants`、`## Pitfalls`，`CONTEXT.md` 的 `## Key points`、`## Open tasks`）保持逐字常驻，
  其余小节（`## Project`、`## Index`、`## Summary`）压成一行「文件 + 节名 + 何时读它」的指针，并附一条强指令
  「不确定的具体事实必须先 read 该文件再回答，不得凭印象作答」。指针语言跟随正文语言（同一个 CJK 判定 owner）；
  未知或新增节名默认常驻，没有任何可索引小节时整篇注入。当前渲染下两个文件合计减少约一万字符/轮，
  且服从度可测（真实会话 JSONL 里会出现对应的 `read` 工具执行）。
  设计：`.codestable/issues/2026-10-05-memory-progressive-disclosure/`。
- **交接不再生成摘要**：删除整条摘要链（模型调用、token-cap 重试、九节标题本地化、`summaryFocus`、
  `SUMMARY_OUTPUT_RESERVE_TOKENS` 与摘要模型窗口 cap）。successor 现在只拿到机械载荷：最近回合原文、文件清单，
  以及旧会话日志指针加一条「缺的细节必须先去日志里查」的强指令；较早的部分留在日志里按需取回。
  依据是两条现场事实：把一份真实对话转写折进 prompt 会让 successor 完全跑偏；而「指针 + 真尾 + 强指令」在同样模型
  与一份真实日志上三问全对（实测见 `.codestable/audits/2026-10-05-context-cost-and-progressive-disclosure.md` §9）。
  用户可见文案随之改成事实描述（开始提示 `dropping ~X`、成功提示说明被丢弃部分留在会话日志、状态行 `drop N` /
  `drop budget N`、拒绝句用 handoff 而非 summary）；旋钮名与动词拼写未改（`handoffBudgetSummaryTokens`、
  `/handoff budget summary`），因为它们与 dsh 面共享、改名或删除需要单独决定，因此 `handoffThinking` 在 pi 侧
  目前只剩写路径。

### 修复

- **`session_shutdown` 里的整理失败不再逃进 pi**：该事件中的 consolidation 失败此前会冒泡到 pi 的
  `ExtensionRunner`（`errors.log` 2026-09-22 那条链的栈穿过 `emitSessionShutdownEvent`），而交接正在同一个事件里
  `await ctx.newSession`。现在失败被捕获并记到 `errors.log` 的 `shutdown:consolidate` 键下。该守卫在测试面上不可达
  （pass 已吞掉能注入的所有失败形态），因此按「有现场依据的防御」记录，不写成已验证。
- **交接失败提示不再承诺 pi 的自动压缩**：`Handoff: failed — …` 去掉了 `pi auto-compaction still applies`，
  这一层从不控制 pi 的压缩。

- **交接保住「最后一轮」**：pi 的 `findCutPoint` 本来就返回 `turnStartIndex`/`isSplitTurn`，本扩展此前只取
  `firstKeptEntryIndex`，于是被切开的那个回合（连同它的起始 user 消息）会整段丢出重放，
  重放块以 assistant 工具调用/工具结果开头（`[turn prefix summarized during handoff]` 占位；v0.4.1 起该占位改名为
  `[turn prefix dropped during handoff]`）。
  现在：前缀不超一窗且老侧仍有内容可丢时**吸附到回合起点**（整轮原文保留）；否则把该回合的起始 user 消息
  **锚定进重放**，中间体积留在旧会话日志里（裁切 + 既有文件索引）。单回合会话不会因吸附而变成「无可丢内容」而中止。
  现场与设计：`.codestable/issues/2026-10-05-handoff-last-turn-not-replayed/`。

## v0.4.0 — 2026-10-05

### 变更（破坏性：配置键改名）

- 配置键改为**镜像命令路径**（`/handoff budget summary` ⇒ `handoffBudgetSummaryTokens`）：`autoConsolidate`→`memoryEnabled`、
  `autoLearn`→`autolearnEnabled`、`handoffTargetTokens`→`handoffBudgetSummaryTokens`、`handoffKeepTokens`→`handoffBudgetRecentTokens`、
  `handoffSummaryThinking`→`handoffThinking`、`handoffAdaptive`→`handoffThresholdAuto`、`handoffLanguage`→`handoffLang`。
  首次读配置时一次性迁移（与 v0.3.0 的嵌套布局同一条路）：**旧键存在即折进新键、整份写回、旧名消失；新旧并存时新键优先**；
  仍是只有 `legacyConfigPatch()` 认识旧名。根因是 v0.3.0 只收束了命令面，键名/文案没跟上（`Auto summarize target` 到 `b869be3` 才补）。
- 命名与词汇规则成文：`.codestable/reference/vocabulary-conventions.md`（配置键、通知前缀、拒绝理由句式、模型可见词汇、
  代码命名、pi/pi-ai 的 strict-schema 约束、术语表、审计历史）；`.codestable/attention.md` 指向它。
- 通知前缀按层统一：`Automatic consolidation:`／`Project memory updated:`／`Memory cap:` → `Memory:`，`Auto handoff*` → `Handoff:`，
  `Session archiving:`／`Session log written:`／`Session log update failed:` → `Session log:`；前缀后不再重复层名。
  `/memory` 与 `/project-context status` 的 memory 状态行现在是同一句 `Memory: …`。
- 跨层渲染器名统一：handoff 的 `statusText` → `handoffStatusLine`，memory 的 `memoryStatusMessage` → `memoryStatusLine`。
- 七个改名两仓同名：dsh 改的是同样七个拼写，两仓配置面不在拼写上分叉；dsh profile 里残留的旧拼写没有别名可退，须在宿主重启前改掉（映射见 `docs/configuration.md` 的兼容迁移段）。

## v0.3.2 — 2026-10-05

### 变更

- autolearn 改为**按需取正文**：第一轮提示词不再带任何技能正文，模型要用 `inspectSkill`（最多 2 条）点名要哪几条，
  第二轮才注入（整篇，放不下就整篇不放）。此前是「能塞多少塞多少」：17 条带标记的技能里只有 4 条进得了提示词，
  其余 13 条**可覆盖却看不到原文**，且谁进谁出取决于清单顺序。基础提示词从 32057 降到 13149 字符，17 条全部可达。
- 覆盖的前提变成「**本轮展示过它的正文**」：gate 与写入路径各读同一个展示集合，未展示的名字被拒绝
  （`body not shown this pass`），候选路径同受约束；点名了却不该给（手写/global/超预算）会在第二轮明确回执。
  数量上限写在代码里（`maxItems` 不保证被执行）。
- `/autolearn` 命令描述改为 `Learn or update a project skill now`；`/autolearn approve` 覆盖既有技能时明说是**盲写**
  （人工确认路径不经过提示词）。

## v0.3.1 — 2026-10-05

### 变更

- autolearn 可以**取代自己生成的技能**（此前只能新增）。它写出的 `SKILL.md` 带一行来源标记
  （`<!-- autolearn-generated: … -->`）在**正文**而不是 frontmatter：pi 启动只注入 name/description/path，未知 frontmatter 键行为未定义。
- 标记就是范围判据：只有带标记的 **project** 技能允许同名覆盖；手写、旧布局导入（`shared/migrate.ts`）、global 技能一律照旧拒绝。
  标记跟着文件生灭，所以「只动 autolearn 生成的」是结构保证 —— 技能删掉后名字被手写占用，对方不带标记就不会被覆盖。
- 提示词新增 `<learned-skill-bodies>`：被标记技能的正文**整篇**注入（放不下就整篇不放），于是同名覆盖是**合并**而不是盲写；
  规则要求保留仍然成立的步骤，合并不了就不提案。候选路径同样受此约束：不得为手写名字落候选文件。
- 通知区分新增与覆盖：`Learned project skill:` / `Updated project skill:`（`/autolearn approve` 同理）。

## v0.3.0 — 2026-10-04

### 变更（破坏性命令面）

- 命令面按数据流层重排：一个参数住进**改变它的那一层**。`/memory` 新增 `on|off` 与 `max-memory <n>|default`，`/session-log` 新增 `on|off`、
  `write`，两者的无参调用各自打本层的状态行（`max-memory` 从伞形搬来，四个特性的 `on|off` 现在都有本层入口）。
- 伞形的 `on|off` 只剩**四特性批量**，且不接受目标：`/project-context off all` 这类旧写法会被拒绝并提示用裸 `on|off`。
  命令面**没有**扩展开关——整扩展禁用仍然只有 run 级 `--no-project-context` flag，文档与注册描述都写明这一点。
- `/context` 退役：context 文件行归 `/memory`（与 `status` 共用同一 `contextStatusLine()`，两处逐行一致），session index 与 session logs 两行归 `/session-log`（无参**只读**：
  pi 自己已在 `turn_end`/`agent_settled`/`session_shutdown` 写存档，读路径不再带写副作用，要立刻写用 `write`）。
- `/handoff` 动词 13 → 9：`threshold <auto|比例>` 合并 `auto` 与裸比例（`40`、`0.4`、`40%` 等价），
  `budget summary <n>`/`budget recent <n|off>` 取代 `target`/`keep`（两个数一个量摘要、一个量近期窗口，各自说出量的是什么），
  `mode <send|draft>` 取代两个裸词。裸比例**硬切**；`force-auto` 与 `language`/`run`/`force` 同义保持原样。
- 配置兼容不再常驻读路径：嵌套 `features.*`/`autolearn.*`/`handoff.*`、`memory/autolearn.json` 与全局 `~/.pi/agent/auto-handoff.json`
  改为某项目首次读配置时**迁移一次**（折进扁平键、整份写回、提示 moved from …）；此后读路径只看扁平键，新键不再获得回退项。
- autolearn 提示词补两条规则：技能只写本项目自己的持久事实（绝不搬他仓测量值），检查写成形态（如
  `[0-9]{2,3},[0-9]{3} chars`）而不是某一次跑出来的数字；并要求描述保持一行短句、已有技能覆盖时宁可不提案而非生成近似重复。

## v0.2.3 — 2026-10-04

### 修复

- 渲染边界：consolidation 提示词加一条规则——只写本项目自身的持久事实，绝不把其他仓的状态或测量值（提交距离、文件大小、研究数值、键数）搬进
  memory 或 context；点名他仓仅限于记录「谁拥有哪个未决项」。同时在 `<recent-conversation>` 块内首行加一句同义说明，
  因为异仓文本正是从那个块进入提示词的（三轮渲染把兄弟仓数值写回来的现场事实）。
- 命令措辞「一个事实一个名字」：伞形首行 `Project context:` → `Features:`；context 文件那一行在 `/project-context status` 与 `/context`
  里统一叫 `Context file:`。旧版同一个 `CONTEXT.md` 在两处分别叫 `Context:` 和 `Project context:`，而 `Project context:` 在伞形里指的是另一回事。

## v0.2.2 — 2026-10-04

### 修复

- memory 状态行单一化：`/project-context status` 与 `/memory` 改由同一个 `memoryStatusMessage()` 渲染，两套措辞合一。
  伞形状态行因此补齐了「journal 存在但无可用记录」的恢复提示（原先只有 `/memory` 有），`/memory` 的无参输出随共享文案统一。
- 测试：适配 pi 1.0.2 的 managed 安装树（读 `install/current-version`，依赖沿 `node_modules` 向上查找）。
  仅 `tests/`，运行时代码未变。

### 文档

- 锁归属更正扩散到主审计横幅与补审二模块表（19 个 `.lock` 属 Codex 移植，不是 `lock.ts` 的现场依据）。
- `docs/architecture.md`、`docs/configuration.md` 补两条语义：手工并回 `MEMORY.md` 不持久；cap 每次写入都生效。
- 全部文档按句读换行（无 >160 字符的行）；`docs/README.md` 索引不再钉死「当前 issue」。
- `docs/configuration.md` 补「入口关系」一段：伞形是权威开关入口，`/context` 不是 status 的子集，命令面有意不收束（无使用证据）。

## v0.2.1 — 2026-10-03

外部编辑采纳：重建回复期间落地的外部编辑不再被覆盖 —— 回复的 basisKey 与当前有效内容不一致时**拒绝发布**，
且拒绝时发布侧无任何副作用（无备份、无 cap/poison 日志、无成功通知），下一次 consolidation 从存活内容重建。
另：超出 cap 的回复在裁剪前先本地留档。

## v0.2.0 — 2026-10-03

分节渲染：consolidation 输出按固定四节（`Project` / `Invariants` / `Pitfalls` / `Index`）逐节预算渲染。
**破坏性改名**（无过渡期）：`/memory-learn` → `/memory update`、`/auto-handoff` → `/handoff`、`/context-update` 删除。

## v0.1.12 — 2026-10-01

`CONTEXT.md` 固定三节 schema（`Summary` / `Key points` / `Open tasks`）+ 逐节预算 + 截断标记；memory schema 与条目指针化。

## v0.1.11 — 2026-09-25

收口 R3 丢失面：autolearn 批准路径重新套用形状规则；handoff 手动 `target` 与触发线解耦；阈值拒绝点名原因而非归咎窗口。

## v0.1.10 — 2026-09-19

`/handoff auto` 阈值锚到保守拐点曲线。

## v0.1.9 — 2026-09-19

预留 reasoning 预算，尊重 finish reason。

## v0.1.8 — 2026-09-19

加强 memory 与 handoff 的恢复路径。

## v0.1.7 — 2026-09-17

关闭四条已登记残留并暴露陈旧 context；追加 `.gitignore` 行不再重复表头。

## v0.1.6 — 2026-09-17

handoff 携带会话设置跨越切换，目录树压平。

## v0.1.5 — 2026-09-16

handoff 切在回合中段，避免单个超长回合阻塞。

## v0.1.4 — 2026-09-16

handoff 跟随对话语言，replay 丢弃过期提示。

## v0.1.3 — 2026-09-16

内存改为「append-only journal + 渲染的 `MEMORY.md`」；写锁抗病理路径、备份有界；不可读的旧内存源会被报告。

## v0.1.2 — 2026-09-14

与 dsh 对齐：辅助调用走同一路由与配置字段；autolearn 共用新材料/轮次门；不可读的 JSON 回复不再写成 `MEMORY.md`。

## v0.1.1 — 2026-09-12

去掉 `package.json`，git 安装无需 npm。

## v0.1.0 — 2026-09-12

首个版本：archive / consolidation / autolearn / handoff 四项能力。
