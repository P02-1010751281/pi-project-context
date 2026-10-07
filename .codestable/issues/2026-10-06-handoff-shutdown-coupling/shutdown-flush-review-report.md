# 独立审查轮记录：退出 flush（issue 2026-10-06-handoff-shutdown-coupling）

## 轮次表

| 轮 | 日期 | 冻结修订 | 判定路由 | VERDICT | transcript | 零写入证明 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 2026-10-06 | `6d76e61`（`d4d7ed3..6d76e61`） | `deepseek/deepseek-flash` + thinking `high` | CHANGES-REQUESTED | `shutdown-flush-review-round1-independent.txt` | ✓：沙箱文件表与基线逐行一致；仅扩展自身在 `.agents/memory/` 的启动写入（skill 约定豁免）；live tree 被审两文件 md5 前后一致 |
| 2 | 2026-10-06 | `f43193a`（`6d76e61..f43193a`） | `deepseek/deepseek-flash` + thinking `high` | CHANGES-REQUESTED | `shutdown-flush-review-round2-independent.txt` | ✓：文件表与基线逐行一致；status 只多出扩展自身改写的 `.agents/memory/MEMORY.md`（豁免项）；live tree 被审两文件 md5 前后一致 |

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
| N1 全损 journal 的新诊断无测试 | nit | **已补钉**：`a fully damaged journal leaves a trace`（变异 M10 红） | 代码提交 + 测试 |
| N2 `runIsDisabled`/`memoryEnabled` 门无测试 | nit | **已补钉**：`memory off: the exit leaves the journal alone` / `... the hand edit in place`（变异 M7 红） | 代码提交 + 测试 |
| N3 采纳循环无测试（单次化仍绿） | nit | **接受**：该分支只在并发写入窗口可达，套件无法在不注入内部钩子的情况下构造；证据是本轮审查员的跨进程竞态探针（transcript 内），故不引入测试钩子 | — |
| N4 `CONTEXT.md` 渲染仍写「owner 未定」 | nit | **已修**：摘要与待办两行更新；该文件本是会话态渲染，下次 settle 会重写 | 记忆提交 |
| N5 MEMORY.md「adopt … re-render」压缩过度 | nit | **已修**：改为「republish the fold only when the render is missing or older」 | 记忆提交 |
| N6 `store.ts` docstring 把 flush 的约束写成整个 teardown 的 | nit | **已修** | 代码提交 |
| N7 `ctx.cwd` 返回 `undefined` 的理论洞 | nit | **已修**：守卫加 `typeof cwd !== "string"` 早退 | 代码提交 |

第 2 轮未新增 blocking；其结论「修复成立、无主路径回归，剩余为承诺多于代码」已按上表收口。R1（并发窗口残余）现在是**代码注释里写明**的已知残留，不再是未兑现的断言。

## 对新钉的变异矩阵（`/tmp/pi-flushfix-mut2` / `mut3`，按备份复位，不用 `git checkout`）

| 变异 | 位置 | 变红 |
| --- | --- | --- |
| M1 退出改回 `consolidate(ctx, true, true)` | `report.ts` | 5 条（含原本走场过的「无模型调用」「不合成内容」） |
| M2 写回内容换成错误 fold | `store.ts` | 2 条（缺 render 重发、陈旧 render 替换） |
| M3 去掉 cwd 保护读 | `report.ts` | 1 条（stale-ctx 不 reject） |
| M4 去掉无 journal 早退 | `store.ts` | 1 条（裸项目不留记忆状态）；「flushes to nothing」保持绿 = 单侧钉 |
| M5 删 `memoryEnabled` 门（第 2 轮补钉） | `report.ts` | 1 条（memory off 时退出仍写） |
| M6 删全损 journal 诊断（第 2 轮补钉） | `store.ts` | 1 条（诊断消失）；「flushes to nothing」保持绿 |

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
