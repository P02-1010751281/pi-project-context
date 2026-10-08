# 独立审查轮记录：退出 flush（issue 2026-10-06-handoff-shutdown-coupling）

## 轮次表

| 轮 | 日期 | 冻结修订 | 判定路由 | VERDICT | transcript | 零写入证明 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 2026-10-06 | `6d76e61`（`d4d7ed3..6d76e61`） | `deepseek/deepseek-flash` + thinking `high` | CHANGES-REQUESTED | `shutdown-flush-review-round1-independent.txt` | ✓：沙箱文件表与基线逐行一致；仅扩展自身在 `.agents/memory/` 的启动写入（skill 约定豁免）；live tree 被审两文件 md5 前后一致 |
| 2 | 2026-10-06 | `f43193a`（`6d76e61..f43193a`） | `deepseek/deepseek-flash` + thinking `high` | CHANGES-REQUESTED | `shutdown-flush-review-round2-independent.txt` | ✓：文件表与基线逐行一致；status 只多出扩展自身改写的 `.agents/memory/MEMORY.md`（豁免项）；live tree 被审两文件 md5 前后一致 |
| 3r | 2026-10-06 | `284039e`（重跑） | `deepseek/deepseek-flash` + thinking `high` | CHANGES-REQUESTED | `shutdown-flush-review-round3-rerun-independent.txt` | ✓：沙箱 `git status` 只多 `.agents/memory/`（豁免项） |
| 4 | 2026-10-06 | `e7e8178`（`284039e..e7e8178`） | `deepseek/deepseek-flash` + thinking `high` | CHANGES-REQUESTED | `shutdown-flush-review-round4-independent.txt` | ✓：文件表与基线逐行一致；status 只多 `.agents/memory/`（豁免项） |
| 5 | 2026-10-06 | `5d6db4b`（`e7e8178..5d6db4b`） | `deepseek/deepseek-flash` + thinking `high` | CHANGES-REQUESTED | `shutdown-flush-review-round5-independent.txt` | ✓：文件表与基线逐行一致；status 只多 `.agents/memory/`（豁免项） |
| 6 | 2026-10-06 | `c212fcf`（`5d6db4b..c212fcf`） | `deepseek/deepseek-flash` + thinking `high` | **PASSED** | `shutdown-flush-review-round6-independent.txt` | ✓：文件表零写入；status 只多 `.agents/memory/`（豁免项） |
| 7 | 2026-10-07 | `d87261a`（`c212fcf..d87261a`） | `deepseek/deepseek-flash` + thinking `high` | CHANGES-REQUESTED（**blocking**） | `shutdown-flush-review-round7-independent.txt` | ✓：文件表零写入；status 只多 `.agents/memory/`（豁免项） |
| 8 | 2026-10-07 | `ba0147c`（`c212fcf..ba0147c`） | `deepseek/deepseek-flash` + thinking `high` | CHANGES-REQUESTED（**blocking**，出自策展） | `shutdown-flush-review-round8-independent.txt` | ✓：文件表零写入；status 只多 `.agents/memory/`（豁免项） |
| 9 | 2026-10-08 | `896808f`（`ba0147c..896808f`） | `deepseek/deepseek-flash` + `high` | CHANGES-REQUESTED（记录层） | `shutdown-flush-review-round9-independent.txt` | ✓ |
| 10 | 2026-10-08 | `6dcec6f`（`896808f..6dcec6f`） | 同上 | CHANGES-REQUESTED（记录层） | `shutdown-flush-review-round10-independent.txt` | ✓ |
| 11 | 2026-10-08 | `efe3780`（`6dcec6f..efe3780`） | 同上 | CHANGES-REQUESTED（记录层） | `shutdown-flush-review-round11-independent.txt` | ✓ |
| 12 | 2026-10-08 | `5522370`（`efe3780..5522370`） | 同上 | CHANGES-REQUESTED（1 important + 4 nit：字符类去重与本 pass 的待办合并已落，表格行序与括号嵌套在本轮修复） | `shutdown-flush-review-round12-independent.txt` | ✓ |
| 13 | 2026-10-08 | `d48f5d3`（`5522370..d48f5d3`） | `deepseek/deepseek-flash` + `high` | CHANGES-REQUESTED（记录层） | `shutdown-flush-review-round13-independent.txt` | ✓ |
| 14 | 2026-10-08 | `0450fc4`（= annotated tag `v0.4.7`，冻结的**发布**修订） | `deepseek/deepseek-flash` + `high` | CHANGES-REQUESTED（**2 blocking + 1 important**，自第 6 轮以来第一个代码层轮次） | `shutdown-flush-review-round14-independent.txt` | ✓：`git status` 与 457 条文件表均与基线一致；被审四文件 md5 前后相同 |
| 15 | 2026-10-08 | `5f76996`（= annotated tag `v0.4.8`，冻结的**发布**修订） | `deepseek/deepseek-flash` + `high` | CHANGES-REQUESTED（2 important：上限门的 `reasoning` 取自会话模型、`/autolearn` 强制 pass 无前置提示；B1/B2/N1/N2/N3 确认已关，I1 被独立复核为**不成立**） | `shutdown-flush-review-round15-independent.txt` | ✓：`git status` 空、460 条文件表与基线逐行一致、被审六文件 md5 前后相同 |
| 16 | 2026-10-08 | `8674fd2`（`v0.4.8` 之上的 `v0.4.9` 修复集） | `deepseek/deepseek-flash` + `high` | CHANGES-REQUESTED（**0 blocking**；1 important 属文档：两处 docs 仍写「会话模型」并在括号里断言只读路径不解析辅助路由；3 nit 格式/措辞；S-1/S-2） | `shutdown-flush-review-round16-independent.txt` | ✓：`git status` 与基线一致、465 条文件表逐行一致、8 个被审文件 md5 前后相同 |
| 17 | 2026-10-08 | `73da214`（`v0.4.9` 修复集 + 第 16 轮文档修复） | `deepseek/deepseek-flash` + `high` | CHANGES-REQUESTED（**0 blocking**；1 important 属措辞：第 16 轮新加的「重试只让它更早更清楚地失败」与 `fitMemoryInput` 的裁短路径相反；1 nit 属记录；S-1 复核登记诚实） | `shutdown-flush-review-round17-independent.txt` | ✓：`git status` 与基线一致、文件表逐行一致 |
| 18 | 2026-10-08 | `63a825f`（残留清理集：R-A/R-F2 收窄 + R-2 + 看门狗） | `deepseek/deepseek-flash` + `high` | CHANGES-REQUESTED（**0 blocking**；5 important：判据围栏/形状/诊断 + `hasConfiguredAuth` 硬依赖 + 撤回记录悬空引用；4 nit） | `shutdown-flush-review-round18-independent.txt` | ✓：`git status` 与基线一致、470 条文件表逐行一致 |

| 3 | 2026-10-06 | `284039e`（`f43193a..284039e`） | `deepseek/deepseek-flash` + thinking `high` | CHANGES-REQUESTED | 原 transcript 丢失（只存在于已被清理的 `/tmp`，会话日志里只有截断版；转述见 `shutdown-flush-review-round3-recovered-excerpt.txt`）；同一冻结修订的**重跑**完整文本见 `shutdown-flush-review-round3-rerun-independent.txt` | ✓：文件表与基线逐行一致；status 只多出 `.agents/memory/` 下扩展自身的启动写入（豁免项）；live tree 被审两文件 md5 前后一致 |
第 9–12 轮无代码层发现：删 append 前复核实测 7 红（race×4 + 借键×3）在第 12 轮被独立复现，门禁与归属脚本经反例验证非空转；这些轮次的条目全部落在记录、门禁与模型渲染的 `CONTEXT.md` 上（后者每次 settle 由模型重渲染，手改只保证当次一致）。

沙箱 `/tmp/pi-context-rev1`（`cp -a` 字节一致副本，441 个文件的基线）。审查员自己在 `/tmp/pi-rev1-work.*` 跑了 5 组变异并
`node tests/run-all.mjs`（15/15）。

**另有一次非协议 pass**（同日、`deepseek/deepseek-v4-pro`、未传 `--thinking`）：路由漂移的产物，transcript 未入档。
它给出的问题类别与第 1 轮重叠（窗口丢失手改、`ctx.cwd` 二次读取、写回分支零覆盖、文档措辞超过代码承诺），这一点是交叉证据。

## 处置

| 发现 | 严重度 | 处置 | 落点 |
| --- | --- | --- | --- |
| B1 退出 handler 二次读 `ctx.cwd`，catch 自身抛出 → 重新制造逃逸链 | blocking | **已修**：cwd 只读一次且受保护，catch 不再触碰 `ctx` | `eff6a56` + 钉 `the memory exit handler does not reject when ctx.cwd throws` |
| I1 采纳读 → 写回之间的手改会被 fold 覆盖且从未进 journal | important | **已修**：采纳循环到稳定，绝不覆盖没折叠过的字节 | `eff6a56`（`store.ts`） |
| I2 每次退出无条件取跨进程锁（最多 5 s）、给从未用记忆的项目添状态 | important | **已修**：无 journal 时早于取锁直接返回；handler 另加 `runIsDisabled` / `memoryEnabled` 门 | `eff6a56` + 钉 `a journal-less project flushes to nothing` / `gains no memory state` |
| I5 写回缺备份 | important | **已修**：写回前 `backupMemoryBeforeWrite` | `eff6a56` + 钉 `replacing a render backs it up first` |
| I3 MEMORY.md 两处旧事实（Index 的 `report.ts` 行、issue 条目） | important | **已修** | 记忆渲染提交（`eff6a56` 之后） |
| attention.md 仍写「owner 未定、三选一」 | important | **已修** | 本目录记录提交 |
| `headless-runs` skill 写「exit 总是强制 consolidation」 | important | **已修** | 本目录记录提交 |
| I4 注释与 fix note 声称写回由「规范化差异」触发（按构造不可能） | important | **已修**：docstring 与 fix note 改为「缺失 / 陈旧撕裂」两个触发条件 | `eff6a56` + 本目录 fix note |
| N1 全损 journal 静默 no-op | nit | **已修**：留 `memory` 键诊断行 | `eff6a56` |
| N2 `adoptExternalEdit` 是无消费者的导出 | nit | **已修**：去掉 `export`；barrel 不再导出 `FlushResult` | `eff6a56` |
| N3 `session_start` 行「不写记忆内容」为假（legacy 导入会写） | nit | **已修** | 本目录记录提交（`docs/architecture.md`） |
| N4 CHANGELOG「自动写入只剩…」不严谨 | nit | **已修**：改为「自动**生成新内容**只剩…」 | 本目录记录提交 |
| N6 fix note 对「9 个用例」的描述与 diff 不符 | nit | **已修**：8 个用例改 `consolidateNow`，主 e2e 两者都跑 | 本目录记录提交 |
| S1 handler 级 stale-ctx 钉 | suggestion | **已做** | `eff6a56` |
| S2 `memoryEnabled` / journal 门 | suggestion | **已做**（journal 门在存储层，`memoryEnabled` 门在 handler） | `eff6a56` |
| S3 写回分支与「无模型调用」钉 | suggestion | **已做**：`Date.now` 拨过去重窗 + 退出回复带标记 + 三个写回钉 | `eff6a56` |
| R1 settle 路仍能把一段对话式回复整篇发布 | 本 issue 外 | **记录**（见残留风险），建议另开 issue | — |
| R2 fix note 的「8/8 仓逐字节一致」无法在沙箱外复验 | residual | **接受**：改按代码层不变量论证 | 本目录 fix note |
| R3 沙箱在审查期间被本机已安装的 v0.4.5 扩展改写 `.agents/memory/MEMORY.md` | residual | **接受**：那是扩展自身写入，非审查员写，零写入证明按约定豁免该目录 | — |

## 第 2 轮处置

| 发现 | 严重度 | 处置 | 落点 |
| --- | --- | --- | --- |
| I1 采纳循环的注释是强保证，但循环后到 `writeAtomic` 之间仍能覆盖未折叠字节（审查员用跨进程竞态探针实测 `{adopted:false,written:true}`） | important | **已修（做真保证）**：写回前对刚读到的 render 重新按 mtime 判定——比 journal 新就 `appendMemoryOp` 保住它并放弃写回，注释改成代码能兑现的「永不覆盖比 journal 新的 render」+ 明确残留窗口 | `eff6a56` 之后（本目录记录提交的代码提交） |
| I2 `headless-runs` skill 上一轮写入的反向承诺（退出无备份、裸项目无目录无锁） | important | **已修**：写明重发会先写 `MEMORY.md.memory-backup-*`；flush 自身跳过无 journal 项目，但存档层仍会取自己的锁并建 `.agents/memory/` | 本目录记录提交 |
| N1 全损 journal 的新诊断无测试 | nit | **已补钉**：`a fully damaged journal leaves a trace`（变异 M6 红） | 代码提交 + 测试 |
| N2 `runIsDisabled`/`memoryEnabled` 门无测试 | nit | **已补钉**：`memory off: the exit leaves the journal alone` / `... the hand edit in place`（变异 M5 红） | 代码提交 + 测试 |
| N3 采纳循环无测试（单次化仍绿） | nit | **接受**：该分支只在并发写入窗口可达，套件无法在不注入内部钩子的情况下构造；证据是本轮审查员的跨进程竞态探针（transcript 内），故不引入测试钩子 | — |
| N4 `CONTEXT.md` 渲染仍写「owner 未定」 | nit | **部分修**：第 2 轮改了摘要句、第 5 轮改回（该文件每次 settle 由模型重渲染，手工修正会被回退；持久事实改放 MEMORY.md + journal） | 记忆提交 |
| N5 MEMORY.md「adopt … re-render」压缩过度 | nit | **已修**：改为「republish the fold only when the render is missing or older」 | 记忆提交 |
| N6 `store.ts` docstring 把 flush 的约束写成整个 teardown 的 | nit | **已修** | 代码提交 |
| N7 `ctx.cwd` 返回 `undefined` 的理论洞 | nit | **已修**：守卫加 `typeof cwd !== "string"` 早退 | 代码提交 |

第 2 轮未新增 blocking；其结论「修复成立、无主路径回归，剩余为承诺多于代码」已按上表收口。 表中变异编号统一引用下面的合并矩阵；round-2 transcript 用的是那一轮自己的编号（其 M7 = `memoryEnabled` 门、M10 = 全损 journal 诊断）。R1（并发窗口残余）现在是**代码注释里写明**的已知残留，不再是未兑现的断言。

## 第 3 轮处置

| 发现 | 严重度 | 处置 | 落点 |
| --- | --- | --- | --- |
| I1 新一轮 mtime 复检自身的 TOCTOU：`onDisk` 读得版本 V1、随后 `stat` 得 V2，判定用 V2 的 mtime 而写进 journal 的是 V1 的 key —— 审查员注入竞态实测 `{adopted:true,written:false}`，journal 末行是陈旧 key，更新的手改因 journal mtime 被推新而永久压住 | important | **已修（读与 stat 同一版本）**：新增 `readRenderWithMtime`（stat → read → stat，两次 mtime/size 不一致即 `changed`）；`changed` 时既不入 journal 也不写回，留给下一次 pass。判定改为 `renderMtime > journalMtime` 才 keep，写入 journal 的 key 与所读字节同源 | 代码提交 |
| I2 该分支零覆盖（整块删除后两个相关测试仍全绿，实测 M11） | important | **已修（抽成纯表）**：决策抽成导出的 `flushActionFor(renderKey, renderMtimeMs, journalMtimeMs, foldKey, changed)`，`consolidation-test` 用 7 条断言覆盖每种时序，无需注入并发；变异 M7/M8 红 | 代码提交 + 测试 |
| I2 附带：抽表当场抓出真回归——`!renderKey` 被判 `none`，写回分支整个死掉（缺 render 不再重发） | — | **已修**：`!renderKey ⇒ publish`；`the exit republishes a missing render` 与表中一条同时变红 | 代码提交 |
| N1 `typeof cwd` 守卫不可红但并非多余（外层 catch 的 `join(undefined, …)` 会 reject） | nit | **接受**：保留 | — |
| N2 `runIsDisabled` 门仍无测试 | nit | **已补钉**：switches 的 `--no-project-context` 段在 journal + 更新手改在场时触发 `session_shutdown`，断言两者原封不动（变异 M9 红） | 代码提交 + 测试 |
| N3 架构文档 `:102`/`:105` 未跟进新分支 | nit | **已修**：表格行写出「比 journal 新的手改只入 journal、不写回」「读取期间被替换则都不动」；段落改为三条守卫并列出 `flushActionFor` 的四态 | 记录提交 |
| N4 同一报告内变异编号漂移（处置表 M10/M7 vs 矩阵 M5/M6） | nit | **已修**：统一用合并矩阵编号（第 1 轮 M1–M4、第 2 轮 M5–M6、第 3 轮 M7–M9），并注明 round-2 transcript 用那轮自己的编号 | 记录提交 |
| N5 「missing or older」不含相等（mtime 相等时也会重发 fold） | nit | **已修**：`MEMORY.md`、`docs/architecture.md`、`headless-runs` skill 改为「journal 不旧于它 / the journal is not older」 | 记忆 + 记录提交 |
| 现场发现：本轮工作区渲染把上一轮修正过的 shutdown 事实回退成旧措辞（journal 里没有那条） | — | **已修**：恢复修正措辞，并用扩展自己的 op 形状把它写进本地 journal（等同采纳路径），使后续渲染不再回退；这次回退本身记为「手改不持久」的又一实例 | 记忆提交 |

第 3 轮的完整 transcript 未能保全（见上表注记），本表的发现逐条对得上当轮读取到的报告正文与判决行。
第 3 轮无 blocking：I1 是上一轮修复自身引入的竞态（危害是 journal 被写脏 + 更新内容被永久压住，比修复前更重），I2 是那条分支零覆盖——两者都已收口，且抽表当场抓出「缺 render 不再重发」的真回归。

## 第 3 轮重跑（同修订 `284039e`）与第 4 轮处置

第 3 轮重跑（blocking 无，important 2）：其 I1「复检分支零覆盖」与 I2「读/stat 不同版本」正好是第 4 轮 B1/I3 的前身，
并给出关键线索——该竞态**不需要给生产代码加钩子**，测试侧可用 FIFO 或包装 `fs/promises` 确定性地构造。两者都在下面收口。

| 发现 | 严重度 | 处置 | 落点 |
| --- | --- | --- | --- |
| **B1**（第 4 轮）同一读—stat TOCTOU 仍在 `adoptExternalEdit`：FIFO 注入下 `{adopted:true,written:true}`，更新的手改在 journal 与磁盘双双消失 | blocking | **已修**：adopt 自读（`preRead.renderKey` 未提供时）改走 `readRenderWithMtime`，`changed ⇒ return false`；判据抽成 `renderIsNewerThanJournal` 一处，flush 表与 adopt 同读。新增**确定性**回归：FIFO 让读者拿到旧字节、而路径已是新文件，断言 exit `written:false`、journal 与磁盘都留新（变异 M10 三红） | 代码提交 + 测试 |
| I1（第 4 轮）`MEMORY.md:97` 的 Index 行被本轮渲染回退成「unthrottled model session_shutdown pass」 | important | **已修**：改为 `model-free session_shutdown flush since v0.4.6`；并把整篇修正 render 重新落进本地 journal（见下） | 记忆提交 |
| I2（第 4 轮）`CONTEXT.md` 回退成「owner 未定 / 待实现」 | important | **已修**：Open tasks 与 Key points 改成「已决定 + 已实现（v0.4.6）」；该文件本是每次 settle 重渲染的会话态，持久事实在 MEMORY.md 与 journal | 记忆提交 |
| I3（第 4 轮）报告编号：N1/N2 的 M5/M6 互换，M11 未入矩阵 | important | **已修**：N1→M6、N2→M5；M10（本轮 adopt 竞态）入矩阵，M11（第 3 轮自编号的「删复检整块」）注明已由 7 条表断言覆盖 | 记录提交 |
| I4（第 4 轮）证据链断裂：`shutdown-flush-review-round3-independent.txt` 实为第 1 轮报告，引用的重跑文件不存在 | important | **已修**：删除误导文件；重跑与第 4 轮 transcript 入档 | 记录提交 |
| N1（第 4 轮）架构文档措辞：`:102` 缺 `none`、`:106`「同一版本」范围、`:95` 与 `:99` 易读成矛盾 | nit | **已修** | 记录提交 |
| N2（第 4 轮）表断言未覆盖边界，注释「every ordering」过头 | nit | **已修**：补 3 条边界断言（不可 stat 的 render / journal、空 key 带时间），注释改为「每种时序 + 边界输入」 | 代码提交 + 测试 |
| N3（第 4 轮）`--no-project-context` 退出钉只有一条区分变异 | nit | **接受**：一条强断言足够 | — |
| R（两轮共同）settle 路仍可用对话式回复换掉整篇记忆 | 本 issue 外 | 记录，建议另开 issue | — |

第 4 轮全部处置完毕；新钉 M10 是本轮 blocking 的确定性复现（三红），其余红数见矩阵。

## 第 5 轮处置

| 发现 | 严重度 | 处置 | 落点 |
| --- | --- | --- | --- |
| **B1r** 借键路径（`recordMemoryDocument` → adopt）仍在读—stat 窗口；审查员用 FIFO + 真实 `basisKey` 语义复现「更新的手改在 journal 与磁盘双双消失」，并指出我新写的「由 pre-publish 复检兜底」承诺在真实时序下不成立 | blocking | **已修（结构收敛）**：adopt 不再区分自读/借键——一律用本调用的 `readRenderWithMtime` 做判定，并在 `appendMemoryOp` 前再核一次「文件仍是那串字节」，不满足就拒绝并记 `errors.log`。原来的 `read.changed` 早退被证明与其重叠（删掉它测试仍绿，见 M10 行），故删除，守卫只剩一处 | 代码提交 + 测试 |
| I1 `CONTEXT.md` 摘要仍写「owner 未定、未实现」 | important | **已修**：摘要句改为「已决定并已实现、已过五轮」；并如实把第 2 轮 N4 的处置改为「部分修」——该文件由模型每次 settle 重渲染，手工修正不持久 | 记忆提交 |
| I2 报告 M8 红数过时（写 2、实测 3，因第 4 轮补了边界断言） | important | **已修**：M8 → 3 条并注明来源 | 记录提交 |
| N1 M11 悬空（矩阵里没有） | nit | **已修**：矩阵补 M11（本轮单一承重守卫，6 条红） | 记录提交 |
| N2 FIFO 用例失败路径可能挂起而非失败 | nit | **已修**：写端 `open` 也套 10s `Promise.race` 超时；连跑 3 次稳定通过 | 代码提交 + 测试 |
| N3 fix note 状态行停在「等待第 2 轮」 | nit | **已修** | 记录提交 |
| N4 `CHANGELOG.md:13` 仍写「陈旧/撕裂」，未覆盖相等 mtime | nit | **已修**：改为「journal 不旧于它（含相等 mtime）」，并补「比 journal 新的手改只采纳、不改字节」 | 记录提交 |
| S1 FIFO 断言补 `adopted === true` | suggestion | **已做** | 代码提交 + 测试 |
| S2 为借键路径补确定性回归 | suggestion | **已做**：稳定文件 + 陈旧借键（拒绝）+ 当前键（接受）的正反对照，无需 FIFO | 代码提交 + 测试 |
| S3 adopt 静默放弃时留日志 | suggestion | **已做**：append 前复核拒绝时写 `errors.log` | 代码提交 |

第 5 轮判 blocking 的那条是同一类缺陷的第三个站点；本轮把「判定与写入必须基于同一版本」收敛成**一处守卫 + 两条确定性回归**，并把重叠的第二处守卫删除（删它测试不变，故不是承重守卫）。

## 第 6 轮：PASSED 与后续项

第 6 轮判 **PASSED**（无 blocking、无 important；`c212fcf` 通过）。它确认单一守卫（`adoptExternalEdit` 的 append 前复核）
同时覆盖自读与借键两条路径，删除重叠的 `read.changed` 早退没有回退（`changed` 仍有 `verify.changed` 与 `flushActionFor` 的
`render.changed` 两个读者），钉子确定性、删守卫必红（该结论在第 7 轮被自己改坏的夹具推翻，见下）。该轮点名的后续项（均不改被审生产语义，故在 PASS 之后按文档/记录单独收口）：

| 后续项 | 性质 | 处置 |
| --- | --- | --- |
| N1 FIFO 用例失败路径仍会挂起（`Promise.race` 取消不了阻塞 `open`） | 测试健壮性 | **登记**：成功路径确定、已连跑三次；失败路径当前不可达。真修需子进程硬超时或非阻塞打开 |
| N2 `architecture.md` 对借键路径的措辞与代码有细微出入 | nit | **已修**：改为「其 mtime 判定取本调用的自读，并在 append 前校验该 key 仍是文件当前字节」 |
| N3 三处漏写「render 为空」这一重发条件 | nit | **已修**：architecture.md / CHANGELOG.md / fix note 统一措辞 |
| N4 `CONTEXT.md` 摘要写「五轮」而 Open tasks 仍写「四轮」 | nit | **已修** |
| S1/S2 `loadMemory` 的纯读站点仍把旧字节与新 stat 配对 | suggestion / residual | **R-L1，已于 2026-10-08（`b7e2a31`）修复**：`loadMemory` 收敛到 `readRenderWithMtime`，`changed` 时回落到 journal fold；探针 `read race:` 三断言，变异后恰红 1 条 |
| S3 `readRenderWithMtime` 的 `changed` 是 mtime+size 启发式 | suggestion | **登记**：同尺寸同 mtime 的替换检测不到，属已记残留 |

**新登记残留 R-L1**：`loadMemory`（注入/提示/状态读路径）把 render 的字节与 `stat` 分开取，理论上可读到「旧字节 + 新 mtime」；
危害不升级，因为唯一的下游写路径用新的 `nowKey` 复检兜底。下次有空的改动窗口时按 S1 收敛到 `readRenderWithMtime`。

**停止规则**：第 6 轮 PASSED 即本 issue 的审查闭环；剩余项都是测试健壮性与读路径残留，不属于「承诺多于代码」的写路径缺陷。（**该结论已被第 7 轮推翻**：第 6 轮之后的两条 nit 收尾里，我把 FIFO 夹具的调度屏障换成了非阻塞打开，race 变成死覆盖 —— 见下。）

## 第 7 轮：一个 blocking、六条 nit，以及它抓到的两处「说得多于实测」

第 7 轮判 **CHANGES-REQUESTED**，blocking 只有一条，但它否掉的是**本修订唯一改测试的地方**：

| 发现 | 严重度 | 处置 |
| --- | --- | --- |
| **B1** 把 FIFO 写端从阻塞 `"w"` 换成 `open(..., O_RDWR)` 后，夹具不再制造竞态：`O_RDWR` 立即返回，写端会抢在扩展读端之前 `rm`+`writeFile`，读者打开到的是**替换后的普通文件**。审查员插桩实测：新夹具 3/3 次读到旧字节 **0 次**，删 append 前复核只红 **3 条**（借键），race 三断言恒绿 —— 即第 4 轮 blocking 的唯一确定性复现变成了死覆盖 | **blocking** | **已修**：恢复阻塞 `"w"`（它同时是调度屏障：写端在读者打开 FIFO 前不返回） |
| **I1** 我提交信息与报告里写「删守卫仍红 6 条」，而 HEAD 实测 3 条 | important | **已修**：修复后**实测** M11 = 6 红（race×3 + 借键×3），两处陈述与实测一致 |
| N1 `readRenderWithMtime` 注释结尾承诺过宽（把 publish 侧也记到 append 复核头上） | nit | **已修**：注释现在写清两条写路径各自的守卫 |
| N2 `architecture.md` 的 `publish` 行漏「render 为空」 | nit | **已修** |
| N3 `CONTEXT.md` 的 headroom 行仍是策展前的数字 | nit | **已修（后又修正）**：先写 29,999 / 2,001，第 8 轮指出那只是中间快照；现按 committed render 的实测重写，并如实说明门槛仍未满足 |
| N4 fix note 状态行停在「第 1–5 轮」 | nit | **已修**：改为「1–7 轮，每轮见报告」 |
| N5 看门狗 `process.exit(1)` 会跳过临时目录清理 | nit | **接受**：仅失败路径卫生问题，已记录 |
| N6 任务书写的 diff 范围与实际冻结修订不一致 | nit（流程） | **已修**：第 8 轮任务书写明精确范围 |

**本轮最重要的一课（已入记忆）**：阻塞 `open` 不只是「会阻塞」——它是让「读—替换」竞态确定发生的**调度屏障**；换成非阻塞打开后测试仍然全绿，
但竞态已经消失（只有删守卫的变异能看出来）。而**看门狗本身也不能用 `process.exit()`**：进程的 libuv threadpool 卡在该 FIFO open 上时
`process.exit(1)` 不会结束进程（实测：一直活到外层 `timeout`），必须用不可延迟的 `SIGKILL`（实测 2,101ms 返回 137）。

**诚实更正**：`d87261a` 的提交信息与当时的报告写「删守卫仍红 6 条」，但那次我并未在新夹具上重跑变异（旧夹具的 6 红结果被沿用）。
第 7 轮抓出这一点，属本仓明确禁止的「承诺多于代码」；修复后该数字已实测。

## 第 8 轮：修复成立，策展不成立

第 8 轮判 **CHANGES-REQUESTED**，但它独立复现并确认了第 7 轮的修复（praise 三条）：
阻塞 `"w"` 恢复后插桩实测读者拿到 `beforeSize=0` 的旧字节、随后 stat 到 `afterSize=62` 的 replacement、`changed=true`；
删 append 前复核实测 **6 红**；看门狗连跑 5 次不误触发、无读者最小复现下 ~10.2s 被杀（exit 137）。
blocking 出自**同一轮里的记忆策展**，与代码无关：

| 发现 | 严重度 | 处置 |
| --- | --- | --- |
| **B1** 策展把一条 pitfall 截成半句（`A /tmp sandbox of the built repo needs node_modules…` 丢掉 ``; the tests-only /tmp copies do not.``），且我的 token 存活检查查不出「句子被截断」 | **blocking** | **已修**：补回完整句；新增**结构检查**（每条 bullet 必须标点收尾，本次只命中这一行）并写进 `curated-surface-hygiene` skill |
| **I1** `CONTEXT.md` 称策展到 29,999、余量 2,001「已回到门槛之上」，与 committed render 不符（那是中间快照） | important | **已修**：按最终 render 重算并如实写「门槛仍未满足，下次策展须提出退休项而非只做格式压缩」 |
| **I2** 逐行比对 `c442b34` 后，9 条 durable 规则在 `ba0147c` 缺失（多数在模型渲染里就已丢，策展未按渲染自己的恢复规则补回） | important | **已修**：无家的规则全部写回（`RENAMED_KEYS` 复跑法、regression guard 的 3/12/8/24 只作 detector、knob 有无代码读者、`/session-log` 裸调用只读）；有 skill 家的合成一条总指针；词汇表的指针恢复；已闭环 issue 的 brief 指针按审查意见不再恢复 |
| **I3** fix note 仍称 `adoptExternalEdit` 不导出 | important | **已修**：改为「抽出并导出，供确定性借键回归驱动」 |
| **I4** 合并条目时丢掉「post-model `nowKey` 复核：文件已改则记 journal、不发布回复」 | important | **已修**：补回 |
| N1 报告 `:133` 的「审查闭环」结论未标注已被第 7 轮推翻 | nit | **已修** |
| N2 看门狗 10s 覆盖取锁+整段 flush，重载机器可能误杀 | nit | **已修**：抬到 30s（`run-all.mjs` 每测 60s） |
| N3 fix note 状态行措辞偏乐观 | nit | **已修** |
| N4 `console.error` 后立刻 SIGKILL 可能丢最后一行 | nit | **接受**：`run-all` 凭 exit≠0 仍判 FAILED |
| N5 SIGKILL 跳过临时目录清理 | nit | **接受**：仅失败态卫生 |
| S1 让夹具自检「确实制造了竞态」 | suggestion | **已做**：race 用例新增断言——`errors.log` 必须出现「a newer external edit arrived before the memory journal could record one」；夹具再被改成非阻塞打开会**自红**而不是静默假绿 |
| S2 把 `changed` 的 mtime+size 启发式残留写进记忆 | suggestion | **已做** |
| S3 curator 流程加机械检查 | suggestion | **已做**：`curated-surface-hygiene` §12（标点收尾、removed-line 分类、token 检查的边界） |

**本轮的两条教训**：一是**修复可以成立而策展不成立** —— 代码层被独立复现，记录/记忆层同时被砍内容；
二是**token 存活检查不足** —— 它只证明字面还在，证明不了句子完整、语义未被合并吃掉，故必须配 removed-line 分类与结构检查（已入 skill 与记忆）。

## 对新钉的变异矩阵（`/tmp/pi-flushfix-mut2` … `mut7`，按备份复位，不用 `git checkout`）

| 变异 | 位置 | 变红 |
| --- | --- | --- |
| M1 退出改回 `consolidate(ctx, true, true)` | `report.ts` | 5 条（含原本走场过的「无模型调用」「不合成内容」） |
| M2 写回内容换成错误 fold | `store.ts` | 2 条（缺 render 重发、陈旧 render 替换） |
| M3 去掉 cwd 保护读 | `report.ts` | 1 条（stale-ctx 不 reject） |
| M4 去掉无 journal 早退 | `store.ts` | 1 条（裸项目不留记忆状态）；「flushes to nothing」保持绿 = 单侧钉 |
| M5 删 `memoryEnabled` 门（第 2 轮补钉） | `report.ts` | 1 条（memory off 时退出仍写） |
| M6 删全损 journal 诊断（第 2 轮补钉） | `store.ts` | 1 条（诊断消失）；「flushes to nothing」保持绿 |
| M7 把「比 journal 新」放宽为 `>=`（第 3 轮） | `store.ts` | 1 条（mtime 相等的时序） |
| M8 缺 render 判成 `none`（第 3 轮，即抽表时抓到的回归） | `store.ts` | 3 条（写回钉 + 第 3 轮表断言 + 第 4 轮补的边界断言） |
| M9 删 `runIsDisabled` 门（第 3 轮补钉） | `report.ts` | 1 条（disabled run 下退出不再只读） |
| M10 取消 adopt 的一致性读（第 4 轮 blocking） | `store.ts` | 3 条（FIFO race 三断言）；此守卫在第 5 轮被并入 append 前复核（见 M11），该行保留为历史 |
| M11 去掉 append 前复核（第 5 轮 B1r 的修复，单一承重守卫） | `store.ts` | 6 条（第 5–8 轮实测，race×3 + 借键×3）；加夹具自检后为 **7 条**（race 四断言 + 借键三断言；借键的文件内容断言保持绿，因为 adopt 只写 journal）。第 9 轮实测 `FAILURES: 7`，此前写的 8 是数错了一行（把 `FAILURES: 7` 汇总行也当成断言） |

## 收链说明（2026-10-08）

第 7–13 轮连续七轮都是 CHANGES-REQUESTED，**没有一条代码层发现**：每一轮都独立复核了删 append 前复核的 7 红（race×4 + 借键×3）、
标点门的非空转性、§10 归属脚本 25/25、以及文档与代码的一致性；第 7 轮修夹具、第 8 轮修策展之后，到收链为止代码层再未改动（`7285eb2` 起只剩
测试门禁与记录/记忆）。这些轮次的条目全部落在**记录、门禁与模型每次 settle 重渲染的 `CONTEXT.md`** 上，并且其中多条是我自己改记录时引入的
（第 12 轮的表行孤立、第 13 轮的字符类重复）。

**上面那句只对收链时刻成立**：2026-10-08 收链之后又落了两处代码修复（见下「收链后的修复」），它们各自带变异检查，但没有独立审查轮覆盖。

**第 14 轮进一步说明**：对冻结的发布修订 `0450fc4` 跑的这一轮是收链以来第一个**代码层**轮次，它给了 2 条 blocking —— 其中一条直接指出「v0.4.7 那条拒绝并不覆盖它自己引用的现场」（回复带着规范标题 `# Project Memory`，判据只测「整篇没有标题」）。收链时的「无代码层发现」只对当时的修订与其审查范围成立，不能当成对随后代码的结论。

按本仓已记的停止规则（「每轮加机制就给下一轮加面；未收敛的增长是停下的信号」），本链在**第 13 轮停止**，方式不是 PASSED，而是：
第 13 轮的条目已全部修复并自验（表格连续性、字符类唯一性自检、状态位三处一致），此后不再追 `CONTEXT.md` 的措辞 ——
该文件是会话状态面，每次 settle 由模型重写，手改只保证当次一致，durable 事实在 `MEMORY.md` + journal 里。

**未取得最终 PASS 的事实如实留在上面**：第 6 轮在 `c212fcf` 给过 PASS（针对代码），此后没有再给。若将来需要正式收口，
可对冻结修订再跑一轮；此前的每一轮结论都留在同目录的 transcript 里。

## 收链后的修复（2026-10-08，收链之后落的代码改动）

| 项 | 现场事实 | 修复 | 钉它的探针与变异结果 |
| --- | --- | --- | --- |
| R-L1 `loadMemory` 的纯读站点 | 登记于本报告：render 的字节与 `stat` 分开取，理论上读到「旧字节 + 新 mtime」 | `loadMemory` 改用 `readRenderWithMtime`；读跨越替换（`changed`）时不采纳任何一版，journal fold 继续当家 | `read race:` 三断言，含稳定文件的**正向对照**（较新的外部编辑仍被采纳）；把实现还原成两读配对后恰红 1 条、其余 2 条仍绿 |
| v0.4.7 拒绝条件不覆盖现场（第 14 轮 blocking B1） | 第 1 轮就记录的现场串**带** `# Project Memory` 头；v0.4.7 只测「回复整篇没有任何标题」，因此放过了它，而 CHANGELOG/架构文/测试注释都把它写成已关（I3/B2） | 判据先剥规范标题再要求正文自己带结构（标题 / `- ` 条目 / 围栏），并明确取消「带标题的散文仍走原路」这条 v0.4.7 行为；回归用例改为逐字节现场串 + 无标题变体 + `#.` 伪标题 + 40/39 边界 + fresh 项目 | 5 条变异各恰红对应断言（去剥标题红 5、结构恒真红 11（第 15 轮实测更正；我自己当时只跑了部分断言）、`storedSections` 恒真红 1、`>=`→`>` 红 2、标题字符类红 2），全套件 15/15 |
| settle 时的不透明回复替换整篇记忆 | **现场**：装好的 v0.4.5 在审查沙箱里（审查员自己的会话）把会话开场白 `I'll review the frozen revision…` 当作整篇文档写入 `MEMORY.md`（119 字节替换 29.9 KB），只留下 backup 与 `memory regression guard skipped: this pass did not produce sections` | 不透明回复**完全没有任何 markdown 标题**、长度已达到「可能是文档」阈值（`OPAQUE_DOCUMENT_MIN_CHARS`，与 report.ts 单一来源）、而存储的是可解析的四节文档 ⇒ 视为无可写内容，走既有的 skip + `carried no entries` 诊断 | 新用例两条（存储记忆逐字节不变 + 留下 `carried no entries` 诊断）；**正向对照**：带标题的不透明 markdown 回复仍被采纳，测试 11 的「带标题但无条目」行为也保留；变异后恰红 2 条 |

两处修复各跑过一次变异矩阵，且都跑过全套件（15 项）与渲染标点门。

**对 R-L1「恰红 1 条」的精确化（第 14 轮 I1 的处置）**：第 14 轮称删掉 `!renderRead.changed` 早退后整套仍然全绿。我按「把该合取项换成 `true`」重测两次，二者都**确定变红 1 条**：`read race: the journal's fold stands instead of the older bytes`（基线同为 2/2 全绿），所以这条早退确实有可区分断言，I1 的「零覆盖」不成立；第 14 轮自己给的单点探针也显示该早退改变了 `loadMemory` 的返回（`source=MEMORY.md` 对 `source=memory.jsonl`），与「零覆盖」自相矛盾。它同时成立的另一半（I2）是本报告已登记的 mtime+size 启发式残留。收链时未取的 PASS 仍未取 ——
这两处改动恰好说明「冻结修订」只在收链那一刻成立。


## 第 15 轮处置（2026-10-08，冻结修订 `5f76996` / v0.4.8）

上一轮的三条 blocking/important 是本轮的验证对象；结果 **B1/B2 确认已关**，**I1 被独立复核为不成立**（审查员自己重做两种等价变异 —— `&& true` 与整体删除 —— 各恰红 1 条
`read race: the journal's fold stands instead of the older bytes`，与我的复测一致：第 14 轮那条是误报），**I3 基本关**。本轮真正的收获是两处 v0.4.8 新代码里的重要缺口。

| 第 15 轮条目 | 处置 |
| --- | --- |
| B1 / B2 / N1 / N2 / N3 | 审查员端到端与变异独立复现，**已关**，不改代码 |
| I1（零覆盖） | 见上：**误报**，不改代码 |
| I-A：上限门的 `reasoning` 取自 `ctx.model`（会话模型），而调用走 `resolveAuxModel` 的辅助路由 ⇒ 配置了重推理辅助路由时静默漏报 | **真缺陷，已修**：新增 `peekAuxModel`（与 `resolveAuxModel` 共用 `auxRouteFor` 单一决策点，前者不发 dead-route 告警），两个调用点改用它；`tests/memory-ops-test.mjs` 的 M4b 分别钉 `status`（`index.ts`）与 set-time（`report.ts`）两个入口，并带正向对照（清空辅助路由后同一 cap 静默）；两条变异各恰红 1 条 |
| I-B：`/autolearn` 空动词的强制 pass 无前置提示，同一条重推理路由上原样静默 | **真缺口，已修**：强制 pass 在辅助调用前回 `Autolearn: distilling this project's sessions…`；新用例断言的是「`complete` 被调用的那一刻提示已在通知里」，不是「日志里存在」；删提示恰红 1 条 |
| I-C：`release-v0.4.8-evidence.md` 在本轮沙箱里不存在 | **冻结点所致，无需处置**：本轮冻在 tag 上，而该证据按本仓惯例落在**打 tag 之后**的独立提交（`4d2bc43`），`master` 上有它 |
| I2 / N-3：`docs/architecture.md` 缺 mtime+size 盲点 | **已补**：写进 flush 守卫段。审查员是对的 —— 任务书当时声称「写在报告与 docs/architecture.md」不实（实际只在报告与本渲染里） |
| N-1：119 / 118 字节口径 | **已说明**：CHANGELOG 的 v0.4.8 条区分了磁盘字节（119，含尾换行）与 journal 的 `memory_markdown` 值（118） |
| N-2：变异矩阵「结构恒真红 3」低报 | **已更正**：实测 `replyHasStructure = true` 红 **11** 条（本报告第 14 轮处置表的那格已改） |
| N-4：`capCeilingWarning` 把 8192 预留说成界 | **已修措辞**：改 `plus a reserve of about N tokens`（不再 `up to`）；用例新增「含 `reserve of about` 且不含 `up to`」，变异恰红 1 条 |
| N-5：v0.4.7 历史条目仍写「无标题」 | **已加交叉引用**（v0.4.8 条证明它带规范标题） |
| R-A：结构测试接受面偏宽（带一条 bullet / 围栏 / 任意标题的散文仍可替换四节文档） | **登记为非目标**：这是第 14 轮 B1 指定的判据、文档如实写了接受面，且更窄的判据**没有现场事实**支撑（本仓规则：无现场事实的新机制进非目标）。重开条件＝出现「带 bullet 的会话回复替换了整篇记忆」的现场 |
| R-B：重试对被请求上限封住的配置补不上差额 | **成立且已写明**：那类配置靠抬高上限或换辅助路由解决；重试仍可在**裁短后的正文**上成功（`clipped`），只是补不上差额（第 18 轮 I-1/N-2 修掉了此处残留的绝对断言） |
| R-C：既登记的 R-F2/R-F3 等 | 不重登；审查员实测行为与文档一致 |

**本轮新增的可用规则**：任何只**读**一个模型属性（例如 `reasoning`）的调用方必须走 `peekAuxModel`，`resolveAuxModel` 只留给真正发起调用的路径；
两者共用 `auxRouteFor`，所以「机制对、取值错」这一类缺口不会因为两处各自演化而复发。

## 第 16 轮处置（2026-10-08，冻结修订 `8674fd2`）

**零 blocking、零代码层 finding**：第 15 轮的四条修复被独立复现（四条变异各恰红 1 条目标断言；`peekAuxModel` 与 `resolveAuxModel` 在四个分支等价、`resolveAuxModel` 的告警语义与告警串**逐字未变**），I2/N-3 的文档句与 N-1/N-2/N-5 的记录口径都被确认属实。本轮找到的全部落在**文档与格式精度**。

| 第 16 轮条目 | 处置 |
| --- | --- |
| I-1：`docs/architecture.md` 与 `docs/configuration.md` 仍写「**会话模型**声明 `reasoning`」，架构文档的括号还断言「配置的辅助路由不在这些只读路径里解析」——v0.4.9 恰好改了这一点 | **已修**：两处改为「**辅助调用路由**声明 `reasoning`」；架构文档括号改为「只读路径经 `peekAuxModel` 解析配置的辅助路由，不发 dead-route 告警」。这是「代码多做、文档说没做」的反向漂移，审查员的实测（reasoning 会话 + plain 辅助 ⇒ 静默）直接证伪了旧括号 |
| N-1：两处调用点注释首行缺 tab 缩进 | **已修**（4 个 tab，与下文一致） |
| N-2：`docs/architecture.md` 新插入的 R-B 子句把「（reserve 增大）」与它的先行词隔开 | **已修**：括号移回原句末，R-B 另起一句 |
| N-3：`docs/configuration.md` 只写 `/memory update` 的等待提示 | **已修**：改为「`/memory update` 与裸 `/autolearn` 都会在等待前先提示一句」 |
| S-1：`peekAuxModel` 的「不可解析」「有模型无 auth」两个分支没有直接断言 | **已做**：`tests/aux-model-test.mjs` 补四分支直接断言；变异（让 peek 走会告警的 `resolveAuxModel`）恰红 1 条 |
| S-2：两处等待提示措辞各自演化 | **登记为非目标**：两层提示各自命名本层动作是本仓词汇约定的**有意**行为（`Memory: consolidating…` / `Autolearn: distilling this project's sessions…`），不是漂移；共享子句只有「(a reasoning route can take minutes)」，抽常量的收益小于新增一层间接 |
| R-A / R-B / R-C | 审查员确认：非目标登记诚实、R-B 措辞与 `adaptiveOutputTokens` 的封顶行为一致、无需要新登记的变体 |

**停止条件**：第 15 轮有 2 条代码层 important（已修，各带变异证据），第 16 轮 **0 blocking** 且唯一的 important 属文档精度类 —— 符合本仓停止规则（最后两轮零 blocking、剩余 important 属规格/措辞/夹具类即停）。因此再跑一轮仅验证本轮这四条文档/格式修复，通过即收口并打 `v0.4.9`。

## 第 18 轮处置（2026-10-08，残留清理轮）

**0 blocking**，但这一轮的 5 条 important 全部落在**我这次收窄引入的问题**上 —— 收窄本身是对的方向，实现却既漏了围栏、又误拒了合法形状，还把两类原因说成一句话。

| 第 18 轮条目 | 处置 |
| --- | --- |
| I-1：`docs/architecture.md` 同一句里既写「重试不可能成功」又写「可能以 `clipped` 成功」自相矛盾（第 17 轮只改了后一个子句） | **已改口径**：改为「重试的预算仍被封在该上限内：它只能在裁短后的正文上再试（可能以 `clipped` 的缩短版成功），补不上这个差额」。`CHANGELOG` v0.4.8、`round15-fix-note.md` 与本报告第 15/17 轮行里的同款绝对断言一并改（N-2） |
| I-2：判据不认围栏 ⇒ 「围栏里含 `## Project\n- x`」的散文被判成文档（误收） | **已修**：扫描器加围栏状态机（同族才闭合）；用例 `structured-prose-fenced-document`；去掉围栏跟踪恰红 1 条 |
| I-3：收窄引入**误拒**（编号列表 / setext 标题 / HTML 标题下有条目的回复被拒），且诊断把它们说成「没有条目」 | **已修**：判据按本仓词汇认标题（ATX 任意级别 / setext / HTML）与条目（bullet 或编号列表）；两条诊断路径统一为 `not a writable memory document`（日志串与 toast 同步）。三种反向形状各有用例（必须**发布**而不是被拒）；去掉编号条目恰红 1 条、去掉 setext/HTML 标题恰红 2 条 |
| I-4：R-2 只把 `find` 改可选，`hasConfiguredAuth` 仍是硬依赖，注释的承诺不成立 | **已修**：两个方法都改可选（缺失即「视为可用」），注释说明理由；新增「两个方法都缺仍回退会话模型」用例，去掉 `?? true` 恰红 1 条 |
| I-5：撤回横幅引用不存在的「重新发布」节 | **已删悬空引用**；重新发布时再补该节 |
| N-1：看门狗把整个夹具根删掉，连诊断用的 artifacts 一起清 | **已收窄**：只清 FIFO 子目录（`race` / `adopt`），`flushMem` 下的 errors.log 与备份留作诊断 |
| N-2：两处旧句仍写「不可能成功 / 只让它更早更清楚地失败」 | **已改**（见 I-1 处置） |
| N-3：文档说「小节标题」，实现接受任意 ATX 级别 | **已对齐**：文档改为「标题（ATX 任意级别 / setext / HTML）」 |
| N-4：回复侧用例的存储是 2/4 节，保护它的是存储侧 OR 分支 | **已改**：回复侧用例改用规范四节存储；实测 M2（存储侧退回只认四节）**只红 1 条** —— 因为那些夹具的 `existing.text` 来自 journal fold（规范四节），耦合没有审查员推测的那么强，这一点如实记在此处 |
| S：三类诊断拆分 | **未采纳**：只把两条路径统一成一句对两者都为真的措辞（真无条目 / 形状读不出），不为它新增分支 |

**变异（本轮，副本里做）**：关掉回复侧判据红 **26**；去掉围栏跟踪红 **1**；条目不认编号红 **1**；标题不认 setext/HTML 红 **2**；存储侧退回只认四节红 **1**；去掉 `hasConfiguredAuth` 的 `?? true` 红 **1**。

## 残留清理（2026-10-08，v0.4.9 tag 撤回之后）

**起因（owner 指令）**：本仓的约定是「残留清完才发版」。`v0.4.9` 曾在带着具名残留（R-A、R-2、R-3）的情况下被打上 tag 并 pin —— 这违反约定，
tag 已在双远端删除、pin 与安装树回退到 `v0.4.8`、修复提交留在 `master`（未发布）。下面是逐条台账：**能修的都修了，修不了的说清为什么修不了**。

| 残留 | 处置 |
| --- | --- |
| **R-A**：结构测试接受面偏宽 —— 带一条 `- ` 条目 / 围栏 / 任意 `# 标题` 的散文仍能替换四节文档（第 15 轮实测 5 种形状） | **已修**：回复侧判据改为「**至少一个小节标题、其下带条目**」（比「任意标记」严，比「四节全解析」宽 —— 后者会把合法的部分文档 `## Project\n- x` 误拒）。6 种散文形状 + 非规范存储各有用例；把判据退回旧形态恰红 **13** 条 |
| **R-F2**：存储侧只认规范四节 ⇒ 手写的**非规范**记忆不受保护（现场那份六节文档正是此形，即 R-F2 并非只关乎 fresh 项目） | **已修**：存储侧改为「能解析成四节 **或** 剥离标题后 ≥ 40 字符」；空/极小存储仍放开（fresh 项目的首条记忆有专门用例）。变异退回「只认规范四节」恰红 **13** 条 |
| **R-F3**：短于 40 字符的回复由 `report.ts` 的长度规则拦写 | **不是残留**：那条规则给出更诚实的理由（`too short to be a change`）且不丢内容；39/40 两侧都有用例钉住 |
| **R-2**：只读状态路径新增 `ctx.modelRegistry.find` / `hasConfiguredAuth` 依赖 | **已收窄**：`find` 改为可选调用、缺失时回退会话模型，并加断言；去掉可选调用会使 `aux-model-test` 以 `TypeError` 硬失败（不是 FAIL 行，也记在这里） |
| **SIGKILL 失败路径留下临时目录**（~40 KB/次，纯外表） | **已修**：两个 FIFO 看门狗在 SIGKILL 之前同步 `rm -rf` 掉夹具的临时树 |
| **`readRenderWithMtime` 的 mtime+size 盲点**（同尺寸且在时间戳粒度内的替换看不见） | **修不了，且已收窄到次要检测器**：要检测必须**再读一次**，那正是 v0.4.7 修掉的 TOCTOU 类；发布决策本身走**内容键**（`memoryComparisonKey`/`basisKey`/`nowKey` 比较的是字节，不是 mtime），所以盲点只影响「要不要把上一次看到的版本当作基准」这一次级判断。已写进 `docs/architecture.md`、`store.ts` 注释与本节 |
| **写回窗口**（最后一次复核 → `writeAtomic` 之间可丢失并发手改） | **修不了**：POSIX 没有 compare-and-swap rename；能做的只是收窄窗口，而那要加机制 —— 按本仓的反增长规则不做。与 `recordMemoryDocument` 的 pre-publish 重读同级，已登记 |
| **超帽手改**（journal 存裁剪键、磁盘留原文） | **不是残留**：有意的非破坏行为，已写进 docstring 与文档 |
| **`CONTEXT.md` 被模型每次 settle 重渲染** | **不是残留**：会话状态面；手改只保证当次一致，durable 事实在 `MEMORY.md` + journal |

**发布口径（据此）**：可修的残留归零；上面两条「修不了」的在文档、代码注释与发布证据里点名，并且**不计入「未清残留」**——
它们是单次读取与 POSIX 文件 API 的物理边界，不是待办。

## 收链（第 17 轮之后，2026-10-08）

**停止规则已满足**：第 16、17 两轮**零 blocking**，剩余 important 全部属措辞/记录精度类（第 16 轮是两处 docs 的反向漂移，第 17 轮是第 16 轮改写时新引入的一句过强断言）。第 17 轮唯一的 important 由**上一轮的修复本身**引入 —— 正是本仓已记下的「每轮加机制就给下一轮加面；未收敛的增长是停下的信号」。

**这一版的代码层拿到两轮独立复核**：第 16 轮逐条复现了 v0.4.9 的修复（四条变异各恰红 1 条目标断言；`peekAuxModel` 与 `resolveAuxModel` 在四分支等价、告警串逐字未变、peek 不消耗告警名额），第 17 轮复核文档/格式层并给出 **0 代码层发现**。

**如实留下**：末修订（本节之后的提交）**没有审查轮**看过 —— 三处改动全是文字口径（`docs/architecture.md`、`CHANGELOG.md`、issue `brief.md`），不触代码与测试；因此 `VERDICT: PASSED` **未取得**。要正式收口，冻结末修订再跑一轮即可。

| 第 17 轮条目 | 处置 |
| --- | --- |
| I-1：「请求上限低于正文+实测隐藏思考时重试只让它更早更清楚地失败」——与 `fitMemoryInput` 的裁短路径相反（被封的只是请求上限，重试可带 `clipped` 成功） | **已改口径**：改为「重试只能在裁短后的正文上再试（可能以 `clipped` 的缩短版成功），补不上这个差额」；`CHANGELOG.md` 的 v0.4.8 同句一并改 |
| N-1：issue `brief.md` 仍把 cap 门的 reasoning 来源写成「会话模型」 | **已标注**：写明那是 v0.4.8 的行为、v0.4.9 改为辅助调用路由 |
| S-1（复核第 16 轮的 S-2 登记） | 审查员确认登记诚实：两条提示各自命名本层动作，唯一共享的是子句 `(a reasoning route can take minutes)` |
| R-2（只读状态路径新增 `ctx.modelRegistry.find` / `hasConfiguredAuth` 依赖） | **承接登记**：真实 pi 的 `ModelRegistry` 提供 `find`，`tests/harness.mjs` 的 mock 已补齐，不构成生产崩溃面，但**是**一条新的读路径依赖 |
| R-3（`readRenderWithMtime` 的 mtime+size 盲点、写回窗口等既有残留） | 承接，本轮代码未触碰 |

**本轮新增的可用规则**：「封住请求上限」**不等于**「重试必然失败」——`fitMemoryInput` 把正文裁到上限之内再试，可能以 `clipped` 的缩短版成功；任何把封顶与失败划等号的句子都必须对照这条路径。

## 对审查结论的两处更正

- 非协议 pass 把「裸项目出现 `.agents/memory/.gitignore`」归因给本次 flush。实测：**存档层自己的锁**
  （`archive/archive.ts` 的 `withMemoryLock(session-index.lock)` → `shared/lock.ts` 的 `ensureMemoryGitignore`）就会写它。
  flush 的真实增量是**取锁**（最多 5 s 等待）与无谓的状态写入，这两点已修；测试改为直接钉 `flushMemoryRender` 本身。
- `ctx.cwd` 抛错在旧代码的 catch 里同样存在，但旧 try 体不触碰 `ctx`（`consolidate` 自己在内部兜住），所以那时不可达；
  把 `getProjectRoot(pi, ctx.cwd)` 放进 try 才使它可达 —— 该项是本次引入的回归，审查判断成立。

## 残留风险

- **settle 路能用一段对话式回复换掉整篇记忆**：审查期间沙箱里**本机已安装的 v0.4.5** 在 `2026-10-06T15:11:47Z` 把
  `MEMORY.md` 从约 29.9 KB 换成 119 字节的 `# Project Memory\n\nI'll review the frozen revision …`，留下
  `memory regression guard skipped: this pass did not produce sections` 与一份备份。**v0.4.7 只关上了无标题变体（第 14 轮 B1），该现场形状直到 v0.4.8 才真正被拒**（判据先剥规范标题）。两条与判据同源的登记边界：存储的记忆本身不是四节文档时拒绝不生效（R-F2，代价是 fresh 项目仍能写下第一条散文记忆）；短于 40 字符的回复不走拒绝，由 report.ts 的长度规则拦住写入（R-F3，不丢内容）。
- 写回的最后一个窗口：采纳循环结束到 `writeAtomic` 之间仍有极小窗口可丢失并发手改（与 `recordMemoryDocument` 的
  pre-publish 重读同级残留）。
- 超帽手改：journal 存裁剪键、磁盘保留原文（键空间相等、字节空间不等）——有意的非破坏行为，已写进 docstring。

## 第 2 轮（已被上面的轮次表取代）

本节写在第 2 轮开跑之前，是当时的待办；轮次、判定与处置以本文上部的轮次表和逐轮处置节为准。
