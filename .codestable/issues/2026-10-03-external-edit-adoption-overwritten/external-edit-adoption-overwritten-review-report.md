# 外部编辑采纳后被旧内容覆盖：独立设计评审记录

- 议题：`.codestable/issues/2026-10-03-external-edit-adoption-overwritten/`
- 被审工件：`external-edit-adoption-overwritten-design.md`（设计文档，非代码 diff；该 issue 当时尚无实现）
- 协议：`.agents/skills/pi-project-context-sandboxed-independent-review/SKILL.md`（字节级 `/tmp` 沙箱 + 前后双快照证明零写入）
- 路由：`pi -p --no-session --no-project-context --no-skills --no-prompt-templates --tools read,bash --model "commandcode/deepseek/deepseek-v4.1-flash-fast" "$(cat TASK.md)"`
- 沙箱：`/tmp/pi-context-rev28`（`cp -a` 自活仓库，HEAD `f7cedc2`）

## 轮次表

| 轮 | 被审候选 | 裁决 | 该轮发现 |
|---|---|---|---|
| R1 | 设计 v1（活仓库 md5 `60ae6b48870b`） | **CHANGES-REQUESTED** | 2 blocking + 8 important + 3 nit + 1 suggestion；见下 |
| R2 | 设计 v2.1（v2 + 开轮前自纠；沙箱 HEAD `0118cab`） | **CHANGES-REQUESTED** | **0 blocking** + 5 important（IM-1…IM-5）+ 10 nit + 4 suggestion + 3 learning；R1 的 B1/B2/I1/I3/I7/I8 判「已解决」，I2/I4/I5/I6 判「部分解决」 |
| R3 | 设计 v3（沙箱 HEAD `8907b3a`） | **CHANGES-REQUESTED** | **1 blocking**（B-1）+ 1 important + 12 nit。R2 的 IM-1…IM-5 判「已解决」（契约/类型层面）；B-1 是 v2→v3 重排时**丢掉了 R1 修复边界里明写的那个动作** |
| R4 | 设计 v4（沙箱 HEAD `06f0903`） | **CHANGES-REQUESTED** | **0 blocking** + 2 important（IM-1 发布侧副作用未以 `written:true` 为门；IM-2 §8 句表缺一格）+ 11 nit。R3 的 B-1/IMPORTANT-1/12 nit 除 N-2 判「部分解决」外全部「已解决」，且 B-1 用 probe 在 7 种编辑形态上验证闭合 |
| R5 | 设计 v4.1（沙箱 HEAD `2ef637a`） | **CHANGES-REQUESTED** | **0 blocking** + 3 important（class 1 谓词过宽；§9 漏 `:228-230`；T9 断言与设计自相矛盾）+ 12 nit。四时序探针 41 断言无数据丢失/活锁/倒置；no-edit 与今天逐 op/text 及字节一致；R4 的 11 nit 中 10 条真解决 |

### R1 发现（按评审分桶）

**blocking**

| # | 内容 |
|---|---|
| B1 | `attempt 2 = consolidateProjectState(force)` 会命中 pass 层去重（`pass.ts:149-151` 的 `throttle` 与 `forceDedupeMs`，默认 15000 ms）⇒ 返回**同一个 outcome 对象**、模型调用 0 次 ⇒ 回放陈旧回复并再次顶掉外部编辑，**原 bug 重演**。评审用 probe2 实测（`v2===v1`、`sameObject=true`），probe7 实测 `MEMORY.md` 变成陈旧的 C。核心承诺在主路径上按设计 v1 不成立 |
| B2 | TOCTOU：采纳读取（`store.ts:62-64`）之后、发布（`store.ts:77-80`）之前落地的外部编辑被静默顶掉，且**字节不进 journal、不进写前备份**（备份在 `report.ts:170`，早于 `store.ts:62` 的读取）。probe5 演示成立；本机窗口约 1 ms，但现场同一次调用两次 append 间隔 69–450 ms ⇒ 目标慢盘上窗口量级相当 |

**important**

| # | 内容 |
|---|---|
| I1 | 只在 `external` 分支比 `basisKey` 会漏判「编辑被对等进程先采纳」：peer 先采纳 B 并写入自己的回复 Q ⇒ 我们的写路径看到 render==fold==Q，采纳分支不触发 ⇒ 用旧基线的回复顶掉 Q，B 退回纯历史。修法：对「本次会读到的有效内容」（检出 external 取 external，否则取 foldedView）与 `basisKey` 做**无条件**比较 |
| I2 | 空 journal / 归档恢复分支（`store.ts:45-56`）**没有**陈旧检测 ⇒ 项目首次 consolidation 窗口内目标 1 不成立 |
| I3 | 「单次 pass 模型调用 ≤2」错：单 `consolidateProjectState` 最多 3 次 `callAux`（`:197` 首调 / `:221` 截断重试 / `:248` condense），外加 `callAux` 的 tools 被拒重发（`llm.ts:250-270`）⇒ 单 attempt ≤4 次 provider completion，重跑后 ≤8 |
| I4 | 日志归属自相矛盾：§6 中「discarded and re-run」「landed again during the re-run」只有 `report.ts` 知道；`store.ts` 在 `writeAtomic` 成功前也不能声称写入成功。修法：`store.ts` 只出中性事实，结果句由 `report.ts` 在循环后发出 |
| I5 | §5「attempt 1 side effect 限定为采纳 append + 写前备份」与现状不符：attempt 1 还会 `saveOverflowReply`（`report.ts:159-165`）、写 CONTEXT.md、`lastWrite.set`、消耗四个一次性警告集合、发 notify/errors.log ⇒ 陈旧 attempt 会留下 orphan overflow、陈旧 CONTEXT、被吃掉的一次性警告、说谎的 toast |
| I6 | 测试计划不可实现或断言错误：T5（`fold == MEMORY.md` 原始字节）对非 canonical render 不成立；T8（只改期望让复现脚本转绿）不可能——脚本两次调用都不带 `basisKey`；T2/T4 在 B1 修好前必红。缺 TOCTOU / peer-adoption / 空 journal / mtime 回退 / 空 render / `basisKey` 省略陷阱的用例 |
| I7 | §9 的「省略 `basisKey` ⇒ 永不判陈旧」是**实现纪律**而非接口保证：写成 `external !== options.basisKey` 会让 `undefined` 恒不等 ⇒ `migrate.ts:127` 与既有测试全走陈旧分支。必须显式 `options.basisKey !== undefined` |
| I8 | `written.set` 的 claim 语义：改成"最终 attempt 记账"时若把 set 移到写成功之后，两个并发 `consolidate()` 可能同时通过检查并重复写。version 一经确定仍须在任何 await 之前同步 claim |

**nit / suggestion**

- §3 F3、§4 `store.ts:63`、`pass.ts:160`、§5 `report.ts:125` 四处行号偏移（评审在 A 节逐条给出）。
- `repro-write-ordering.mjs` 头部"运行：…/2026-10-03-consumer-repo-memory-drift/…"路径与实际目录不符（**我已修**）。
- `memory-stale-<ISO>.md` 的时间戳建议照抄 `saveOverflowReply` 的 `replace(/[:.]/g,"-")`。
- praise：store 层机制本身正确——(a)(b)(c) 在真实原语上 5/5 形态验证通过；不猜意图、基线入写路径、上限 1 次、锁外重跑（`lock.ts:179` 确实不可重入）方向都对。

**residual-risk（评审列出，需在 v2 中收窄措辞或显式接受）**

- mtime 回退（`cp -p` / `rsync --times`）的编辑不被采纳、不留在历史；owner 清空 `MEMORY.md` 时回复会顶掉"清空"动作。
- cap>32000 时 rotation 用默认 32000 折叠（`journal.ts:111`）⇒ journal fold 长期落后 render（既有问题，与本设计共处同一状态机）。
- `activeConsolidation` 是模块级、不按 projectRoot 键（`pass.ts:79,135`）⇒ 两项目并发 pass 互串（既有）。
- 陈旧分支跳过 `rotateMemoryJournalIfNeeded` / `ensureMemoryGitignore`（`store.ts:78-79`）：journal 可暂超 512 KB，无损坏，可接受延迟。
- session_shutdown 的同步 pass 在重跑下最坏 8 次 provider 调用，退出变慢。

## 零写入证明（R1）

```
cd /tmp/pi-context-rev28
git status --porcelain -uall | sort | diff - /tmp/rev28-baseline-status.txt   → 无差异
find . -path ./.git -prune -o -path ./.agents/memory -prune -o -type f -print0 \
  | xargs -0 stat -c '%Y %s %n' | sort | diff - /tmp/rev28-baseline-files.txt → 无差异（332 文件基线）
md5sum -c /tmp/rev28-live-md5.txt                                              → 活仓库设计文件未变（60ae6b48870b）
```

`.agents/memory` 的 prune 是刻意的：`--no-project-context` 不阻止扩展在评审 cwd 自建该目录（既有实测）。
transcript：`external-edit-adoption-overwritten-design-review-round1-independent.txt`（19865 字节）。
本轮无 provider 失败（首跑即返回 `VERDICT`）。

## 处置

R1 的 B1/B2 属**设计缺陷**（不是实现细节）：v1 的重跑入口不存在、陈旧检测的位置与时机都不够。
设计据此改为 v2（新增 pass 层 `rerun` 入口与会话级去重说明、陈旧判据改为「有效内容」无条件比较并
覆盖空 journal 分支、发布前 recheck、副作用后置、日志归属拆分、调用上界重写、测试计划重列），
然后按协议**开 R2**（一个 PASSED 轮不覆盖其后的改动）。

R2 的 5 条 important 全是**结构性的**（报告级语义缺失、基线口径含糊、契约不完整、流程表把采纳块
并进 stale 分支），因此改为 **v3**：采纳块恢复为独立步骤（INV-1 与 T12 的 legacy 承诺）、
`basisKey` 定稿为 `loadMemory().text` 原值（不规范化、不用 `fitted.text`）、`resolveMemory()` 契约
覆盖空 journal/archive/legacy 回退、第 8 步空内容不触发、`written:true` 带 `adopted`、
陈旧两原因共用同一有界循环，并定稿了 v2 遗留的四个开放项（§17）。

## R2 轮次详情

| 项 | 值 |
|---|---|
| 被审候选 | 设计 v2.1（沙箱 HEAD `0118cab`） |
| 裁决 | **CHANGES-REQUESTED**（0 blocking + 5 important + 10 nit + 4 suggestion + 3 learning） |
| transcript | `external-edit-adoption-overwritten-design-review-round2-independent.txt`（18714 字节） |
| 沙箱 | `/tmp/pi-context-rev29`（336 文件基线） |
| provider 失败 | 无（首跑即返回 `VERDICT`） |

### R2 对 R1 的逐条复核

| R1 finding | R2 判定 |
|---|---|
| B1 pass 去重回放 | 已解决（`rerun` 跳过两条去重 + version 断言；probe 实测现状确被 `forceDedupeMs` 吞掉） |
| B2 TOCTOU | 已解决（窗口缩到 recheck→rename）；残留 empty-now 变体见 IM-1 |
| I1 peer 先采纳 | 已解决（probe：`current = Q ≠ basisKey = F` 判陈旧成立） |
| I2 空 journal | **部分解决**（判据位置对，但 `effectiveMemoryKey` 契约没写 entries 为空/archive/legacy 的内容规则 ⇒ IM-5） |
| I3 调用上界 | 已解决（probe 实测 4 completion/attempt 可达，≤8 真实） |
| I4 日志归属 | **部分解决**（`{written:true}` 不携带采纳事实 ⇒ IM-2；`external-edit-during-publish` 无结果句 ⇒ IM-1） |
| I5 副作用后置 | **部分解决**（方向可实现；keep-adoption 退出的语义未定） |
| I6 测试计划 | **部分解决**（T5 判据过弱、T13 在 rotation 下不成立、T2 无构造法、T14 需重写） |
| I7 `undefined` 守卫 | 已解决（写成接口级要求 + T12 钉 legacy 采纳行为） |
| I8 claim 同步 | 已解决（R-11）；stale-stop 是否释放未写 ⇒ v3 补为「保持 claim」 |
| R1 nits | 4 处行号已修；新增 2 处（`pass.ts:132`、`store.ts:50`）⇒ v3 已修 |
| R1 residual | 接受判定合理；⚠️ v2 漏记「陈旧分支跳过 rotation/gitignore」⇒ v3 补为 R-12 |

### R2 的 5 条 important（v3 全部按修）

| # | 内容 | v3 处置 |
|---|---|---|
| IM-1 | 窗口内**清空** `MEMORY.md` 时 `appendMemoryOp("replace","")` 对 fold 是 no-op（`journal.ts:91-93`）⇒ 实际生效的是被声称"未发布"的回复，日志与 fold 相反（INV-2/INV-3 双破）；非空编辑触发时也没有结果句与重跑决策 | 第 8 步加空守卫（空内容不触发，R-15）+ 陈旧两原因共用同一有界循环 + 补结果句清单 |
| IM-2 | `{written:true}` 不携带"本次是否采纳"⇒ report 无法产出常态采纳句；无条件输出即在多数 pass 上谎报采纳 | `{written:true; adopted?: string}`；采纳句只在 `adopted` 存在时输出 |
| IM-3 | v2 流程表把采纳块并进 stale 分支 ⇒ "编辑早于读取"时外部字节不再单独进历史（今天是 `A→B→C`，v2 会成 `A→C`），破 INV-1 与 T12 | 采纳块恢复为**独立第 2 步**（逐行等价于今天的 `store.ts:61-71`），陈旧只决定发不发布 |
| IM-4 | `basisKey` 口径在 v2 被删糊：用 `fitted.text` 会**永久自锁**（probe：29728→7585 字符裁剪，每次 pass 都判陈旧）；用规范化键在无 journal 项目会假陈旧一次 | 定稿 `basisKey` = 同一次 `loadMemory()` 的 `.text` **原值**，两侧都不规范化；T3 加 clip 与无 journal 两个 fixture |
| IM-5 | `effectiveMemoryKey` 契约不完整（只引 `store.ts:110-118`，漏 `:119-146` 的空 journal/archive/legacy 回退）⇒ I2 的修复会静默失效而 T5 仍绿 | 抽 `resolveMemory()`，契约写为"逐字节等于 `loadMemory().text`，含空 journal/archive/legacy 回退"；T5 判据收紧为"B 进 journal **且**重跑回复被发布" |

### R2 零写入证明

```
cd /tmp/pi-context-rev29
git status --porcelain -uall | sort | diff - /tmp/rev29-baseline-status.txt   → 无差异
find . -path ./.git -prune -o -path ./.agents/memory -prune -o -type f -print0 \
  | xargs -0 stat -c '%Y %s %n' | sort | diff - /tmp/rev29-baseline-files.txt → 无差异（336 文件基线）
md5sum -c /tmp/rev29-live-md5.txt                                              → 活仓库设计文件未变
```

## R3 轮次详情

| 项 | 值 |
|---|---|
| 被审候选 | 设计 v3（沙箱 HEAD `8907b3a`） |
| 裁决 | **CHANGES-REQUESTED**（1 blocking + 1 important + 12 nit） |
| transcript | `external-edit-adoption-overwritten-design-review-round3-independent.txt`（17608 字节） |
| 沙箱 | `/tmp/pi-context-rev30`（338 文件基线） |
| provider 失败 | 无 |

### R3 的 blocking：B-1（v3 第 8 步漏了"把新字节 append 进 journal"）

- **位置**：`design:120`（第 8 步只返回 `adopted:nowRaw`，不落 journal）vs `design:32`（INV-1）与 `design:168`（结果句 "the newer content was kept"）。
- **场景**（probe-v3sim combo 3b）：编辑落在 **第 3 步 `resolveMemory()` 读 render 之后、第 6 步 `appendMemoryOp(rendered)` 之前**——即 v3 声称的"唯一残留窗口（第 8 步 → rename）"**之外**：
  1. 第 2 步时文件仍是 A，不采纳；第 3 步读 A ≡ basisKey，不判陈旧；
  2. E 落在第 3→6 步之间 ⇒ E 的 mtime **早于**第 6 步刚 sync 的 journal；
  3. 第 8 步按字节捕获 E，返回 `{written:false, external-edit-during-publish}`，但 **E 从未 append**；
  4. 重跑的 `loadMemory()` 因 `E.mtime < journal.mtime` 返回**attempt 1 被丢弃的回复 C**（probe 输出 `attempt2 basisKey=C`）；
  5. 最终 `MEMORY.md=D`、journal `A→A→C→D` ⇒ **E 不在 journal、不是任何回复的基线、生效被顶掉**，日志却说 "kept"。
- **三重违反**：INV-1（编辑必须进 journal）、INV-2（重跑的 D 基于旧的 C）、INV-3（"kept" 说谎）。
- **评审给出并实测了修法**：第 8 步返回前先 `appendMemoryOp("replace", nowKey)`（`nowKey` 已保证非空且 ≠ `renderKey`）⇒ probe-v3fix 实测 `journal=A→A→C→E`、`attempt2 basisKey=E`、最终 `A→A→C→E→D`，三条 FAIL 全转 OK。
- **性质**：这正是 **R1 的 B2 修复边界里明写过的动作**（"把新 key 采纳进历史"），v2→v3 重排流程表时丢掉了。属"修复引入的回归"，即本仓库协议里那条已知模式。

### R3 的 important：IMPORTANT-1（T6 的 seam 注入点未钉死）

`design:204` 的类型名 `__testOnBeforePublish` 自然读作"`writeAtomic` 之前"（第 8 步之后），而那正是 R-2 的
残留窗口——注入的编辑会被第 9 步直接覆盖，T6 的非空断言必红；若实现者据此固定 seam，T6 就测不到第 8 步、
也覆盖不了 B-1 的窗口。修法：明写 seam 位于**第 3 步之后、第 6 步之前**。

### R3 的 12 条 nit（摘要）

1. 第 2 步"无条件执行"（`design:99`）与"逐行等价 `store.ts:61-71`"（`:114`）字面冲突——后者在 `entries.length === 0` 的 `else` 内；须写死"仅 `entries.length > 0` 时执行"。
2. §5 三处行号错（`loadMemory` 实际 `store.ts:87-159`；archive `:129-137`；`.pi` `:145-149`、OMP `:151-157`）——而 §4 声称"行号已复核"。
3. `modelBlocked` 的真正返回在 `pass.ts:154`（非 `:146-147`）。
4. §17.1 说 `lastWrite` 清空是"现有语义"**不实**：清空只发生在 `report.ts:115`；无写入时现行是 `lastWrite.set({memoryKept:true,…})`（`:204-216`）。
5. T2 的构造法仍含糊：`rerun` 会跳过去重，唯一确定性构造是让 `resolveAuxModel` 在重跑时返回 undefined。
6. `adopted` 字段语义重载（`written:false` 分支里它是"当前生效内容"，不是"本调用采纳过"）——建议改名或注释。
7. "第二次仍陈旧"沿用"did not produce a newer reply"不贴切（attempt 2 可能确实产出并 append 了，只是未发布）。
8. overflow 与 stale 留档的去重机制**没写**：最终 attempt 在 `written:false` 时会同时留两种档。
9. keep-adoption 的 toast 必须由 `!silent` 门控（`session_shutdown` 与 `/memory update` 都是 `silent=true`）。
10. `nowKey === memoryComparisonKey(rendered)` 是否纳入第 8 步触发条件**悬空**（须定稿）。
11. `basisKey` 的传递在 §11 未闭环（`report.ts:171` 今天只有三个实参）。
12. `journal.ts:91-93` 的跳过实际在 `:92-93`。

### R3 零写入证明

```
cd /tmp/pi-context-rev30
git status --porcelain -uall | sort | diff - /tmp/rev30-baseline-status.txt   → 无差异
find . -path ./.git -prune -o -path ./.agents/memory -prune -o -type f -print0 \
  | xargs -0 stat -c '%Y %s %n' | sort | diff - /tmp/rev30-baseline-files.txt → 无差异（338 文件基线）
md5sum -c /tmp/rev30-live-md5.txt                                              → 活仓库设计文件未变
```

### R3 处置

→ 设计改 **v4**：第 8 步补 append（B-1）、钉死 seam 调用点（IMPORTANT-1）、逐条修 12 条 nit，然后开 R4。

## R4 轮次详情

| 项 | 值 |
|---|---|
| 被审候选 | 设计 v4（沙箱 HEAD `06f0903`） |
| 裁决 | **CHANGES-REQUESTED**（**0 blocking** + 2 important + 11 nit） |
| transcript | `external-edit-adoption-overwritten-design-review-round4-independent.txt`（15396 字节） |
| 沙箱 | `/tmp/pi-context-rev31`（340 文件基线） |
| provider 失败 | 无 |

### R4 对 R3 的复核

- **B-1 已解决**：probe 复现 combo 3b（编辑落在第 3 步之后、第 6 步之前）→ `journal=A→A→C→E`、
  `attempt2 basisKey=E`、最终 `MEMORY.md=D`，无倒置；`probe-keyforms` 对 7 种编辑形态
  （无尾换行 / CRLF / 行尾空格 / 前后空行 / 超 cap / poison）全部满足 `fold==nowKey`、
  `loadMemory==fold`、`attempt2 basisKey==fold` ⇒ **append `nowKey` 而非 `nowRaw` 在 `fold` 的 `trim()` 下自洽**。
- **IMPORTANT-1 已解决**：seam 位置可同时覆盖"非空触发→进 journal"与"清空按 R-15 发布"两种接线。
- **R3 的 12 条 nit**：N-1/N-3/N-4/N-5/N-6/N-7/N-8/N-9/N-10/N-11/N-12 判「已解决」；
  **N-2 判「部分解决」**（`loadMemory` 实际闭合在 `store.ts:160`，且读侧的 clip 在 `:138-142`，
  v4 引的 `:119-127` 是 raw 读取）⇒ v4.1 已修。

### R4 的 2 条 important（v4.1 已修）

| # | 内容 | 修法 |
|---|---|---|
| IM-1 | §9 的"最终 attempt 执行发布侧副作用"没有以 `written === true` 为门 ⇒ 在 row 5（重跑产出但也被判陈旧）里，作为"最终 attempt"的 `written:false` 那次仍会消费四个一次性集合、并写出"关于一次并未发生的发布"的 cap/removal 日志与 notify | 改为"发布侧副作用**仅在 `written:true` 时**执行"；`written:false` 只允许 step-8 append、写前备份、`memory-stale` 留档、中性日志、keep-adoption 的 warning toast；退出形态由三种改四种；T9 加验收断言 |
| IM-2 | §8 的五句不完备：重跑若产出 `semanticEmpty` 或 opaque < 40 字符，`recordMemoryDocument` **根本不会被调用** ⇒ 无 `MemoryWriteResult`，五句无一命中，`"superseded"` 与"编辑被保住"的结果句缺失（INV-3 在该格不成立） | §8 补入该格（`…the re-run's reply carried nothing usable and was discarded`），明确它同样走 `"superseded"` 且不执行发布侧副作用 |

### R4 的 11 条 nit（v4.1 已逐条修）

`pass.ts:151` 的 forceDedupe 返回；`loadMemory` 闭合在 `:160`；读侧 clip 在 `:138-142`（`:119-127` 只是 raw 读取）；
清空守卫读侧在 `store.ts:106`（写侧才是 `:63`）；T2 断言应写 `outcome2 === undefined`；
`lastWrite.delete` 后 `consolidateReply` 拿不到 `info` ⇒ 命令回复文本要钉死；
row 5 的括注"回复留在历史"只对第 8 步陈旧成立；cap 在读/写之间被改 ⇒ 一次假陈旧（补 R-17）；
`kept` 是生效文本而非文件字节；D2 fix note 的 §4"写副本在前"也失效、且其 residual-1 要在 v0.2.1 落实；
step-8 的 append 在 rotation 之后 ⇒ journal 可暂超 512 KB（补 R-12b）。

### R4 零写入证明

```
cd /tmp/pi-context-rev31
git status --porcelain -uall | sort | diff - /tmp/rev31-baseline-status.txt   → 无差异
find . -path ./.git -prune -o -path ./.agents/memory -prune -o -type f -print0 \
  | xargs -0 stat -c '%Y %s %n' | sort | diff - /tmp/rev31-baseline-files.txt → 无差异（340 文件基线）
md5sum -c /tmp/rev31-live-md5.txt                                              → 活仓库设计文件未变
```

### 收敛观察（R1→R4）

| 轮 | blocking | important | 性质 |
|---|---|---|---|
| R1 | 2 | 8 | 入口不存在 / 窗口未处理（根本性） |
| R2 | 0 | 5 | 报告级语义、契约、流程表（结构性） |
| R3 | 1 | 1 | 重排时丢了一次 append（回归型）+ seam 位置 |
| R4 | **0** | **2** | 规格级澄清（副作用门、句表补格），其余为行号与措辞 |

### R4 处置

→ 设计改 **v4.1**（IM-1/IM-2 + 11 nit），然后按协议**开 R5**。

## R5 轮次详情

| 项 | 值 |
|---|---|
| 被审候选 | 设计 v4.1（沙箱 HEAD `2ef637a`） |
| 裁决 | **CHANGES-REQUESTED**（**0 blocking** + 3 important + 12 nit） |
| transcript | `external-edit-adoption-overwritten-design-review-round5-independent.txt`（16195 字节） |
| 沙箱 | `/tmp/pi-context-rev32`（342 文件基线） |
| provider 失败 | 无 |

### R5 的核心结论（已按它改 v5）

**学习 L-1（改变了设计）：`written:true` 不是"回复未被丢弃"的充分谓词。**
`memoryChanged === false`（heading-only / opaque < 40 字符）是一条**既有的 no-write 路径**：`recordMemoryDocument`
根本不被调用、CONTEXT 照写、回复并未被丢弃。v4.1 把副作用按"写结果两态"门控，按行块圈定，于是同时**多**门掉
`!memoryChanged` 的 toast 与 `contextShapeWarned`（回归既有稳态）、**少**门 `:228-230`（写出关于一次并未发生
的发布的 errors.log）。v5 改为**三态**（published / superseded-discarded / no-write-as-before）+ "副作用 × 主体"表。

### R5 的 3 条 important

| # | 内容 | v5 处置 |
|---|---|---|
| IM-1 | class 1 谓词过宽：`!memoryChanged` 的 keep 类 toast 与 `contextShapeWarned` 被错归入"memory 发布" ⇒ 字面执行会回归 design 自己声明要保护的既有组合（probe：今天必发的 `Project context updated; project memory was kept unchanged` 消失、`contextShapeWarned` 永不消费） | 三态门控；`contextShapeWarned` 只在 superseded-discarded 态不消费；keep 类 toast 绑定 `memoryChanged===false` |
| IM-2 | class 1 清单漏 `report.ts:228-230` 的 `consolidation shortened…`（条件 `outcome.clipped && (memoryChanged \|\| update)` 在 stale 且 `update===undefined` 时仍成立） | 纳入 published 类；行号整理为 `:185-199` |
| IM-3 | T9 的验收线与 §9 class 2 **直接矛盾**，且 `pass.ts:315` 的 pass 侧 removal 日志使其在自然 fixture 下不可满足 ⇒ 实施者会为让 T9 绿而把 CONTEXT 也门掉（即 v4.1 避免的回归） | T9 拆两条用例 + 写明 fixture 前置（重跑回复不带 context / `update===undefined`）+ `/memory update` 断言改为命中 `consolidateReply("superseded")` 新分支；`pass.ts:315` 列为例外 |

### R5 的 12 条 nit（v5 已逐条处置）

`report.ts:227`（2 处）、`:202-203`（2 处）、`:185-199` 区间；§8 row 6 改 "carried no usable memory"；
重跑自身采纳只走中性日志（明示可见性损失）；step6→step8 崩溃窗口（新增 R-18）；
跨 project join 概率 1→2 与 version 断言限界（新增 R-19 + §7 注明）；R-16 措辞收紧；
`consolidateReply` 新分支是**必需项**而非短路顺序（`lastWrite.delete` 后 `info` 为 undefined）；
T6 固化 8 组时序；T10 具名常量；T11"留档失败不阻断"降级；T13 改 `loadMemory().text`。

### R5 零写入证明

```
cd /tmp/pi-context-rev32
git status --porcelain -uall | sort | diff - /tmp/rev32-baseline-status.txt   → 无差异
find . -path ./.git -prune -o -path ./.agents/memory -prune -o -type f -print0 \
  | xargs -0 stat -c '%Y %s %n' | sort | diff - /tmp/rev32-baseline-files.txt → 无差异（342 文件基线）
md5sum -c /tmp/rev32-live-md5.txt                                              → 活仓库设计文件未变
```

### 收敛观察（R1→R5）

| 轮 | blocking | important | 性质 |
|---|---|---|---|
| R1 | 2 | 8 | 入口不存在 / 窗口未处理（根本性） |
| R2 | 0 | 5 | 报告级语义、契约、流程表（结构性） |
| R3 | 1 | 1 | 重排丢了一次 append（回归型）+ seam 位置 |
| R4 | 0 | 2 | 规格级澄清（副作用门、句表补格） |
| R5 | **0** | 3 | 谓词精确性（三态 vs 两态）、漏一条 errors.log、测试前置条件 |

R4/R5 均无 blocking，且 R5 的探针（四时序 41 断言）确认核心机制闭合。**剩余发现的性质已从"机制"转为"规格措辞与测试前置"**。

### R5 处置

→ 设计改 **v5**（三态门控 + 12 nit）。R5 建议"§17 定稿后再开 R6"。
