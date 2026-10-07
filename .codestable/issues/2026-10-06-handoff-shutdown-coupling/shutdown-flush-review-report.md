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
| 3 | 2026-10-06 | `284039e`（`f43193a..284039e`） | `deepseek/deepseek-flash` + thinking `high` | CHANGES-REQUESTED | 原 transcript 丢失（只存在于已被清理的 `/tmp`，会话日志里只有截断版；转述见 `shutdown-flush-review-round3-recovered-excerpt.txt`）；同一冻结修订的**重跑**完整文本见 `shutdown-flush-review-round3-rerun-independent.txt` | ✓：文件表与基线逐行一致；status 只多出 `.agents/memory/` 下扩展自身的启动写入（豁免项）；live tree 被审两文件 md5 前后一致 |

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
`render.changed` 两个读者），钉子确定性、删守卫必红。该轮点名的后续项（均不改被审生产语义，故在 PASS 之后按文档/记录单独收口）：

| 后续项 | 性质 | 处置 |
| --- | --- | --- |
| N1 FIFO 用例失败路径仍会挂起（`Promise.race` 取消不了阻塞 `open`） | 测试健壮性 | **登记**：成功路径确定、已连跑三次；失败路径当前不可达。真修需子进程硬超时或非阻塞打开 |
| N2 `architecture.md` 对借键路径的措辞与代码有细微出入 | nit | **已修**：改为「其 mtime 判定取本调用的自读，并在 append 前校验该 key 仍是文件当前字节」 |
| N3 三处漏写「render 为空」这一重发条件 | nit | **已修**：architecture.md / CHANGELOG.md / fix note 统一措辞 |
| N4 `CONTEXT.md` 摘要写「五轮」而 Open tasks 仍写「四轮」 | nit | **已修** |
| S1/S2 `loadMemory` 的纯读站点仍把旧字节与新 stat 配对 | suggestion / residual | **登记为 R-L1**，不在本 issue 修 |
| S3 `readRenderWithMtime` 的 `changed` 是 mtime+size 启发式 | suggestion | **登记**：同尺寸同 mtime 的替换检测不到，属已记残留 |

**新登记残留 R-L1**：`loadMemory`（注入/提示/状态读路径）把 render 的字节与 `stat` 分开取，理论上可读到「旧字节 + 新 mtime」；
危害不升级，因为唯一的下游写路径用新的 `nowKey` 复检兜底。下次有空的改动窗口时按 S1 收敛到 `readRenderWithMtime`。

**停止规则**：第 6 轮 PASSED 即本 issue 的审查闭环；剩余项都是测试健壮性与读路径残留，不属于「承诺多于代码」的写路径缺陷。

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
| M11 去掉 append 前复核（第 5 轮 B1r 的修复，单一承重守卫） | `store.ts` | 6 条（FIFO race 三断言 + 借键三断言含正向对照） |

## 对审查结论的两处更正

- 非协议 pass 把「裸项目出现 `.agents/memory/.gitignore`」归因给本次 flush。实测：**存档层自己的锁**
  （`archive/archive.ts` 的 `withMemoryLock(session-index.lock)` → `shared/lock.ts` 的 `ensureMemoryGitignore`）就会写它。
  flush 的真实增量是**取锁**（最多 5 s 等待）与无谓的状态写入，这两点已修；测试改为直接钉 `flushMemoryRender` 本身。
- `ctx.cwd` 抛错在旧代码的 catch 里同样存在，但旧 try 体不触碰 `ctx`（`consolidate` 自己在内部兜住），所以那时不可达；
  把 `getProjectRoot(pi, ctx.cwd)` 放进 try 才使它可达 —— 该项是本次引入的回归，审查判断成立。

## 残留风险

- **settle 路能用一段对话式回复换掉整篇记忆**（本 issue 之外，证据来自本轮现场）：审查期间沙箱里**本机已安装的 v0.4.5**
  在 `2026-10-06T15:11:47Z` 把 `MEMORY.md` 从约 29.9 KB 换成 119 字节的
  `# Project Memory\n\nI'll review the frozen revision against the code, tests, and my own probes, then record the outcome.`，
  同时留下 `memory regression guard skipped: this pass did not produce sections` 与一份备份 ⇒ 现有守卫不拒「带 header 的散文回复」。
  建议另开 issue（不在 ① 的范围）；重开条件＝再有同类现场，或 owner 指定。
- 写回的最后一个窗口：采纳循环结束到 `writeAtomic` 之间仍有极小窗口可丢失并发手改（与 `recordMemoryDocument` 的
  pre-publish 重读同级残留）。
- 超帽手改：journal 存裁剪键、磁盘保留原文（键空间相等、字节空间不等）——有意的非破坏行为，已写进 docstring。

## 第 2 轮

按本仓纪律，修改后的修订需要自己的审查轮。第 2 轮应跑在 `eff6a56` 之上的安全修订（冻结 + 字节一致沙箱 + 零写入证明），
判定路由同上（`deepseek/deepseek-flash` + thinking high）。
