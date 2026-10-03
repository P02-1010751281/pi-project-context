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
| R6 | revision 6（B 版，134 行，无重跑） | **CHANGES-REQUESTED** | 1 blocking（§2.3 `renderKey` 未定义 + 缺空守卫）+ 3 important（§2.2 落点三种读法、§2.4 拒绝态无法表达 + 跳过清单不全、repro 未传 `basisKey`）+ 6 nit + 1 suggestion。**无一条要求新机制** |
| R7 | revision 7（B 版 + R6 四修） | **CHANGES-REQUESTED** | **0 blocking** + 3 important（拒绝态 + 无 context 时命令回复谎称 context 已更新；§2.2 raw 比较在读取来源翻转时假陈旧；repro 的 exit 谓词不成立）+ 7 nit。**无一条要求新机制** |
| R8 | revision 8（R7 三修 + 7 nit） | **CHANGES-REQUESTED** | **0 blocking** + 1 important（既有测试 `consolidation-test.mjs:542` 的 mid-call-writer check 依赖"陈旧回复被发布"，修复后 run-all 13/14 ⇒ 改动面漏了它）+ 4 nit + 2 suggestion。**无一条要求新机制** |

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

## R6 轮次详情（revision 6 / B 版）

- 被审：`external-edit-adoption-overwritten-design.md`（revision 6，"B 版：最小修复面"，134 行）
- 沙箱：`/tmp/pi-context-rev33`（`cp -a` 自活仓库，HEAD `ae36c10`）；transcript 19717 字节
- 裁决：**CHANGES-REQUESTED**（1 blocking / 3 important / 6 nit / 1 suggestion）
- **本轮纪律生效**：每条发现都被要求标注【修正已有机制】或【新增机制】+ 对应 §1 现场事实编号，
  结果是 **1+3+6 条全部为【修正已有机制】，没有一条要求新机制**——这是审计判据（机制必须由现场证据触发）
  第一次在评审里被真正执行。

### R6-B-1（blocking，v7 已修）：§2.3 的 `renderKey` 无定义 + 缺空守卫

两种自然读法都坏：**带 `.trim()` 守卫**时 `memoryComparisonKey("") === "# Project Memory\n"`（probe 实测），
于是"文件起始 key"与"窗口 key"在**全新项目/文件缺失**下永不相等 ⇒ recheck 每次都触发 ⇒ 返回 `written:false` 并把
空 key append 进 journal；而"只有空 replace 的 journal"会让 `loadMemory` 报 `unreadable:true`
（`journal.ts:92-93` + `store.ts:96`）⇒ **正常路径自锁**；**不带守卫**时窗口内清空会误拦，直接违反 T6 与 §5 R-3。
R6 给的修复边界 = v5 step 8 的两段守卫 + **把判定抽成有名字、导出的纯函数**（否则 T6 无法 import）。

### R6-IM-1（important，v7 已修）：§2.2 的落点有三种读法，只有 v5 顺序同时满足 T2/T4

R6 用 probe 逐落点实测：字面"采纳块之后" ⇒ T4 红（种子先行、回复发布、编辑只留历史）；
字面"函数入口" ⇒ T2 的"编辑进 journal"红；"整个 `if/else` 之后" ⇒ 种子把读侧
`clipToLineBoundary(raw.trim())` 归一化成 `normalizeMemoryDocument` 形态，**无编辑也判陈旧**
（legacy / OMP 导入 / 手删 journal 的首次 pass 都踩）。v5 顺序（采纳 → 判据 → 种子）四场景全过。

### R6-IM-2（important，v7 已修）：§2.4 的拒绝态在 §3 接口里表达不出来

`written:false` 只发生在 `memoryChanged===true` 的路径上，而 `report.ts:169-173` 的锁回调把写结果丢掉了：
不补则 `/memory update` 落回 "…updated."、`lastWrite` 仍带 `capped/sectionsCapped/removed` 假信息。
R6 给出了完整的"应跳/不应跳"清单（v7 §2.4 表）并指出 `keepReason`（`report.ts:29`）与
`consolidateReply`（`:399-415`）需要新成员承载该态。

### R6-IM-3（important，v7 已修）：`repro-write-ordering.mjs:44` 两次调用都不传 `basisKey`

按 §2.2 的 `undefined` 守卫，脚本永不触发判据 ⇒ 只把期望翻成"编辑生效"会让回归线**恒假红**。
必须同时改调用点（传 `{ basisKey: A }`）或改走 report 全链路。

### R6 的 6 条 nit（v7 已逐条处置）

① append 的是规范化键 `nowKey`、`kept` 取 `loadMemory().text`（同 §2.2 口径）；② `readOptional(...) ?? ""` 是死代码
（`files.ts:10-15` 永不返回 undefined）；③ v5 N-10 的 `publishKey` 排除项要保留；④ §5 残留补四条
（拒绝分支跳过 rotation/gitignore、cap 变更、rotation 默认 32000、⑥ 中途被杀）；⑤ 行号（外层 `if (renderRaw.trim())`
闭合于 `:72`，其余无误）；⑥ D2 fix note §4 的 overflow 落盘时机要同步改为"发布成功之后"。

### R6 对 R1/R3 blocking 的复核（v7 采信）

| 前轮 blocking | 判定 |
| --- | --- |
| R1-B1（重跑被去重吞掉） | ✅ **闭合（机制消失）**——没有 `rerun` 入口就没有第二次调用 |
| R1-B2（读取→发布之间的编辑） | ⚠️ 部分：窗口对，但判据不能照抄（见 R6-B-1），v7 §2.3 已重写 |
| R3-B1（检出却不 append） | ✅ 闭合（§2.3 返回前 append `nowKey`） |

### R6 的实测亮点

核心时序在 v5 落点下 probe 实测工作：journal `[A, B]`、`MEMORY.md` 保留编辑**原始字节**（CRLF 也保留）、
`fold === kept === loadMemory().text`、回复从不进 journal、`errors.log` 恰两行；
四个 fixture（普通 / `preserveMarker` / legacy 无 journal / 全新项目）的无编辑路径与真实
`recordMemoryDocument` 的 op/text 序列 + render **逐字节相同**。

### R6 零写入证明

```
cd /tmp/pi-context-rev33
git status --porcelain -uall | sort | diff - /tmp/rev33-baseline-status.txt   → 无差异
find . -path ./.git -prune -o -path ./.agents/memory -prune -o -type f -print0 \
  | xargs -0 stat -c '%Y %s %n' | sort | diff - /tmp/rev33-baseline-files.txt → 无差异（345 文件基线）
md5sum -c /tmp/rev33-live-md5.txt                                             → 活仓库 5/5 未变
```

### R6 处置

→ 设计改 **revision 7**（折入 B-1 / IM-1 / IM-2 / IM-3 + 3 条 nit 相关的 §3/§4 增补）。均为落点与文本修正，
代码增量仍约 60–70 行。按协议 revision 7 需再一轮（R7）。

## R7 轮次详情（revision 7）

- 被审：revision 7（B 版 + R6 的 B-1/IM-1/IM-2/IM-3 修正）；沙箱 `/tmp/pi-context-rev34`（HEAD `f4e9d7a`）
- 裁决：**CHANGES-REQUESTED —— 0 blocking** / 3 important / 7 nit / 1 suggestion；transcript 20988 字节
- 独立性：探针在 `/tmp/rev34-probes/`，含一份按 v7 顺序实现的**真实补丁副本**（`pc-patched-v7/memory/store.ts`）；
  另跑了 `repro-write-ordering.mjs` 与 `memory-ops` / `consolidation` 两个测试文件

### R7 对 R6 四条的复核

| R6 项 | 判定 | 依据 |
|---|---|---|
| B-1（`renderKey` 未定义 + 缺空守卫） | ✅ **真解决** | probe：`memoryComparisonKey("")` 返回 `"# Project Memory\n"`；全新项目无编辑 ⇒ `written:true`（无自锁）；窗口内出现编辑 ⇒ 拒发并保住；清空/删文件不拦 |
| IM-1（§2.2 落点） | ✅ **真解决** | 按 v7 顺序打补丁实测：核心时序 `journal=[A,B]`、`written:false kept=B`；T4 无 journal 编辑保住、journal 空；**无编辑四 fixture 与今天 op/text+render 逐字节相同**；R6 的三种坏落点均未复现 |
| IM-2（拒绝态表达 + 清单） | ⚠️ 基本解决，剩 IM-A | 回调带回写结果可行（`withMemoryLock<T>` 泛型），`:176`/`:275` 语义闭合；表格覆盖全部行；**缺口 = 拒绝态 + `update===undefined` 时前缀谎称 context 已更新** |
| IM-3（repro 未传 `basisKey`） | ⚠️ 调用点对、谓词表述不成立 | 传 `{basisKey:A}` 后两场景变 `adopted=true && bEffective=true`；但「`bEffective && adopted` 为 0」作为 JS 谓词有反读风险 |

### R7 实测否证了设计自己交出去的一个假设（设计据此修正）

设计 §2.2 隐含假设「journal 存在时 `loadMemory()` 返回 fold」⇒ **为假**。实测规则是：
**journal 存在时，只有 render 非空 + key ≠ fold + render mtime 严格大于 journal mtime 才返回 render**，否则返回 fold。
但**结论仍成立**（§2.2 不必再 append）：原因是 §2.0 的 ②（采纳）先于 ③（判据）且 ② 把 journal 变成最新，
不是靠那个假设。真正「检出却不落 journal」的窗口只有 **① 入口读 / ② stat 之间**，实测自愈
（下一次写路径 ② 先采纳再发布），且 R3-B1 的伤害依赖「重跑拿被丢弃回复当基线」——**已随重跑取消而消失** ⇒ 不报 blocking。

### R7 三条 important（revision 8 已修）

- **IM-A**：拒绝态 + `update === undefined`（回复没带可用 context 且既有 `CONTEXT.md` 非空）时 CONTEXT **没写**，
  但 `report` 仍 `"updated"` ⇒ 命令回复输出「Project context updated; …」，与同一时刻 errors.log 的
  「the previous CONTEXT.md is kept and stays stale」（`:141-151`）矛盾。**这是 v7 自己在消灭的说谎方向，只是从 memory 换到 context。**
  修法：`lastWrite.contextWritten = Boolean(update)`，`consolidateReply` 的 stale 分支前缀由它决定。
- **IM-B**：§2.2 的 raw/raw 比较在**读取来源翻转**时假陈旧——journal 存在时 `loadMemory` 返回 fold（带尾换行），
  无 journal 时返回 `clipToLineBoundary(raw.trim())`（无尾换行），同一份 `MEMORY.md` 字节被读成两种形态
  （`probe-sourceflip.mjs`：journal 在 pass 读之后被删 ⇒ 假陈旧 + 假日志，尽管文件字节未变）。数据安全但违反 T3。
  修法：两侧都过 `memoryComparisonKey`（幂等）。
- **IM-C**：§4 的 repro 退出谓词「`bEffective && adopted` 为 0」按字面不成立，有把回归线做成**假绿**的风险
  （方向与 R6-IM-3 想消灭的假红相反）。修法：钉死 `fixed` 谓词 + `exit(fixed?0:1)` + 同步头部注释语义。

### R7 的 7 条 nit（revision 8 已逐条处置）

① §2.2 的「（mtime 回退等）」反了——mtime 回退时 `loadMemory` 返回 fold，§2.2 **判不出**陈旧、发布并覆盖（R-1）；
真正「留在 `MEMORY.md`」的是 ①/② 竞态。② 行号：`:189-192`→`:188-190`、`:193-199`→`:191-199`、`:261-265`→`:260-270`、
**`:211`→`:215`**（`lastWrite.removed`）。③ T6 的 CRLF/行尾空格方向要写实测值（`memoryComparisonKey` **保留**内部 `\r`
与内部行尾空格 ⇒ 触发；只吸收文档级首尾空白/尾换行 ⇒ 不触发）。④ `keepReason` 三元在已发布路径会置 `"short"`
（今天被 `memoryKept` 挡住，无可见谎言）。⑤ D2 fix note 要同步**两处**（`:72` 与 `:97`，非一处）；
`saveOverflowReply` 后置后必须落在 `:179` 记账之前，否则 `:198`/`:254` 的 `overflowPath` 插值失去指针。
⑥ T2 的「无 removal 行」需要夹具前置：`pass.ts:300-317` 的 `memory regression: …` 在 pass 层写出，report 层拦不住。
⑦ §2.3 拒绝路径没有 errors.log 行 ⇒ 两个拒绝原因在日志里不可区分（已补中性行）。

### R7 零写入证明

```
cd /tmp/pi-context-rev34
git status --porcelain -uall | sort | diff - /tmp/rev34-baseline-status.txt   → 无差异
find . -path ./.git -prune -o -path ./.agents/memory -prune -o -type f -print0 \
  | xargs -0 stat -c '%Y %s %n' | sort | diff - /tmp/rev34-baseline-files.txt → 无差异（347 文件基线）
md5sum -c /tmp/rev34-live-md5.txt                                             → 活仓库 4/4 未变
```

### R7 处置

→ 设计改 **revision 8**（折入 IM-A/IM-B/IM-C + 7 nit）。新增残留 R-11（①/② 竞态，自愈、不补 append）、
R-12（`activeConsolidation` 模块级、跨项目 join）、R-13（overflow 副本后置的崩溃窗），并把 R-1 扩为「回退**或同刻**」。

## R8 轮次详情（revision 8）

- 被审：revision 8；沙箱 `/tmp/pi-context-rev35`（HEAD `f3aa5c3`）；裁决 **CHANGES-REQUESTED —— 0 blocking** / 1 important / 4 nit / 2 suggestion；transcript 14147 字节
- 独立性：R8 打了两份真实补丁树——`repo-v8/`（§2.0–§2.3 + 注入缝）与 `repo-v8-full/`（含 §2.4 的 report/pass 全链路），
  跑了 8 组探针（`probe-v8` 41/41、`probe-t1` 18/18、`probe-full` 14/14、`probe-overflow` 7/7、`probe-adv` 10/10、`probe-residual` 5/5 等），
  并在打补丁的全链路树上跑 `run-all`（**13/14**）与按 §4 改过期望的 repro（live 退出 1、v8 退出 0）

### R8-IM-1（important，revision 9 已修）：既有测试依赖"陈旧回复被发布"

`tests/consolidation-test.mjs:542` 的 `check("a mid-call writer is backed up", …)` 要求
`raceLog.includes("replaced a stored JSON reply")`，而 `:519-539` 的场景（模型调用期间写入裸 JSON 的 `arrived`）
**正是 §2.0 的核心时序** ⇒ 修复后必然走 §2.2 拒绝、`storedPoisoned` 的日志被跳（**跳得对**：`MEMORY.md` 仍是裸 JSON，
"已替换成 Markdown"是谎报）⇒ `run-all` 停在 13/14。设计 §0 与 T1 却仍写"14 文件全绿"。
修法（不动机制）：把该 check 拆开——保留"备份数量 1 + 备份字节 === `arrived`"，把 poison 修复断言移到**未发生拒绝**的用例，
本用例改断言 `adopted …` + `reply was not published`；并把 `tests/consolidation-test.mjs` 写进 §0 改动面。

### R8 对 R7 的 3 important + 7 nit 复核

| R7 项 | 判定 | 依据 |
|---|---|---|
| IM-A（`contextWritten`） | ✅ 真解决 | `:134` 的 `update===undefined` 与 `:217` 的 `if (update)` 等价；写抛错走 catch ⇒ `failed` 提前返回 ⇒ **update 为真 ⇔ CONTEXT 必写**；两例子回复都不含未发生的事实 |
| IM-B（双侧 `memoryComparisonKey`） | ✅ 真解决 | journal 建/删两向都不再假陈旧、无假日志；反方向检查：CRLF/内部行尾空格仍判不同，`decodePoisonedMemory` 参与后 poison-明文与同内容 JSON 同 key，peer 先发布场景仍被拒；幂等成立 |
| IM-C（repro 谓词/退出码） | ✅ 真解决 | 按 §4 逐字改：live 退出 **1**、v8 树退出 **0**，谓词/注释/方向三者自洽 |
| nit 1（mtime 回退措辞） | ✅ | `probe-residual` 复现"同刻/回退 ⇒ 发布覆盖"，与文案一致 |
| nit 2（行号） | ⚠️ 大体解决 | `:215`/`:188-190`/`:191-199`/`:260-270` 已对；残留三处**范围**近似（`report.ts:185-188` 应为 **185-187**、`consolidateReply` 实际 **399-429**、`store.ts:139-142` 应为 **138-143**）⇒ revision 9 已改 |
| nit 3（T6 CRLF 方向） | ✅ | 内部 `\r` ⇒ true、内部行尾空格 ⇒ true、文档级空白 ⇒ false |
| nit 4（`keepReason`） | ✅ | 已发布路径写 `{}`，与今天 `report.ts:214` 一致 |
| nit 5（D2 两处 + overflow 落点） | ✅ | 两处行号命中；`probe-overflow`：拒绝态无副本、发布态有副本且 `:191-199` 的日志指向它 |
| nit 6（T2 夹具前置） | ⚠️ 部分 | removal 行已点名；**同块还有 `pass.ts:303-305`/`:309-311` 两行**（opaque 夹具 / 存量非四节文档）也会出现 ⇒ revision 9 已点名三行 |
| nit 7（§2.3 中性日志） | ✅ | hook 实测该行存在且与 §2.2 行可区分 |

### R8 的两条 suggestion（revision 9 已记为残留）

- **R-14**：手删 journal 且存在 rotation 归档时，`loadMemory` 优先取归档（`store.ts:129-137`）⇒ 调用期编辑既不被 §2.2 也不被 §2.3 看见，回复照发、编辑被覆盖（`probe-residual` §1）。既有读侧优先级 ⇒ T4 的承诺应读作"无 journal **且无归档**"。
- **R-15**：published 路径的**既有**谎言——`update===undefined` 且未拒绝时命令回复仍说 "…and context updated." 而 CONTEXT 未写。本设计只在拒绝态消费 `contextWritten`，不引入也不扩大。

### 收敛观察（R6→R8）

| 轮 | 被审 | blocking | important | 性质 |
|---|---|---|---|---|
| R6 | B 版（134 行） | 1 | 3 | 机制落点未定义（`renderKey`、§2.2 落点、拒绝态接口、repro） |
| R7 | revision 7 | **0** | 3 | 拒绝态与既有控制流的边界（context 前缀谎言、来源翻转假陈旧、repro 谓词） |
| R8 | revision 8 | **0** | 1 | **账面同步**：既有测试依赖旧行为；另 3 处行号范围 + 2 条既有残留 |

**三轮的发现全部是【修正已有机制】，无一条要求新机制**——审计判据（机制必须由现场证据触发）在三轮里没有被违反，
也没有出现 R1–R5 那种"新机制带来新面"的膨胀。

### R8 零写入证明

```
cd /tmp/pi-context-rev35
git status --porcelain -uall | sort | diff - /tmp/rev35-baseline-status.txt   → 无差异
find . -path ./.git -prune -o -path ./.agents/memory -prune -o -type f -print0 \
  | xargs -0 stat -c '%Y %s %n' | sort | diff - /tmp/rev35-baseline-files.txt → 无差异（349 文件基线）
md5sum -c /tmp/rev35-live-md5.txt                                             → 活仓库 4/4 未变
```

### R8 处置

→ 设计改 **revision 9**（折入 IM-1 + 4 nit + 2 suggestion，新增残留 R-14/R-15）。

## 代码评审轮（待跑，被 provider 周限阻塞）

- 设计侧 8 轮已完成（R6 1 blocking / R7 0 / R8 0）。实现 = `00bf797`（对应设计 revision 9）。
- prompt 已存档：`external-edit-adoption-overwritten-code-review-round1-prompt.txt`。
- 沙箱配方与零写入证明（照 `pi-project-context-sandboxed-independent-review` skill）：
  `/tmp/pi-context-rev36`（`cp -a` 自活仓库，353 文件基线），
  `git status --porcelain -uall | diff` 与 `find … stat | diff` 前后**均为空**（`.agents/memory` 按 skill prune），
  活仓库 5 个待审文件 md5 未变。

### 两次启动记录

| 时间（UTC） | 结果 | 原因 |
| --- | --- | --- |
| 14:05 | 未启动 | `cp -a` 失败：`/tmp` **磁盘写满**（协议沙箱 `rev8…rev36` 各约 100 MB，累计填满 16 GB tmpfs）。已清理 `rev8…rev36` 与陈旧 transcript 后重做 |
| 14:12 | **0 字节 transcript** | `429 You've reached your weekly usage limit for your plan`（复位 **2026-10-08T08:37:39Z**） |

按协议，**0 字节 transcript = provider 失败，不算一轮**，复位后重跑即可（prompt 与沙箱配方都已就位）。
`commandcode/deepseek/deepseek-v4.1-flash-fast` 是这台机器上唯一可用的评审路由，故本轮在复位前无法完成。

**结论**：本修复目前是"**已实现、已自测验证、未独立评审**"。`v0.2.1` 建议等这一轮通过再切。


## R9（设计，实现后）与代码评审轮 1

| 轮 | 被审 | 判定 | 发现 | 服务路由 |
| --- | --- | --- | --- | --- |
| R9 | 设计 revision 9（已实现于 `00bf797`） | **CHANGES-REQUESTED** | **0 blocking** + 2 important + 5 nit + 2 suggestion | `deepseek/deepseek-v4-pro` |
| 代码评审 1 | 提交 `00bf797` | **CHANGES-REQUESTED** | **0 blocking** + 2 important + 4 nit | `deepseek/deepseek-v4-pro` |

**两条 important 由两轮独立同判**（这是本轮最强的信号）：

1. **`report.ts` 的 `consolidation shortened` errors.log 漏了 `!memoryRefused` 门**（设计 §2.4 表把它列为"跳"）。
   影响：拒绝态 + `outcome.clipped` 时日志会声称存量被缩短，而那次发布从未发生 —— 正是本设计要消灭的谎报类别。
   两轮都用 probe 独立复现（R9 的 P5 全链路；代码评审的 `probe-clipped-refusal`）。**已修**（`report.ts:247`）。
2. **设计 §4 点名的三条回归线未落进 `tests/external-edit-test.mjs`**（来源翻转 / CRLF 与行尾空格方向 / 拒绝后抛错重放）。
   两轮都实测三条**行为正确**、但**没有回归线**：回退 §2.2 为 raw 比较时，当时 47 条断言无一变红。**已补**（+22 断言，47 → 69）。

**R9 的 nit/suggestion 处置**：N-1（约 20 处行号漂移）按 R9 的映射**全量回写**并在 banner 写明行号约定；N-2（H1 仍写
revision 8）、N-3（T2"恰两行"与不带 context 的子例自相矛盾）、N-4（§0 的 per-file 约数偏小）、N-5（T1 多一条
`MEMORY.md === arrived` 断言）、S-1（§2.2 的"清空"口径过宽）、S-2（repro 谓词比 §4 引文更严）均已同步。代码评审的 4 条
nit（重复注释、`nextRenderSupersedes` 注释未提 `publishKey`、提交信息措辞、设计 H1）同批处理。

### 路由变更（provenance）

R1–R8 由 `commandcode/deepseek/deepseek-v4.1-flash-fast` 服务；**R9 与代码评审轮 1 由 `deepseek/deepseek-v4-pro` 服务**
（前者 429 周限至 2026-10-08）。两轮的 prompt 里都写明了本轮路由。原结论"本机唯一可用评审路由是 commandcode"**已被实测
推翻**：另有 `deepseek/deepseek-flash`、`deepseek/deepseek-v4-pro` 可用（`scnet/*` 被 plan 门挡住、`openai-codex` 凭据失效）。

### 零写入证明与一处 provenance 纸伤

- 两轮沙箱 `rev37`/`rev38`：`git status --porcelain -uall` 与 `find|stat` 的**前后 diff 均为空**（`.agents/memory` 按 skill prune）；活仓库 5 个待审文件 md5 轮次前后一致。
- **纸伤**：轮次运行期间（14:28Z 起）我提交了 `7198c14`（skills / audit / attention 文档），活仓库 HEAD 从 `3448700` 移到 `7198c14`。沙箱仍是 `3448700` 的副本，被审的 5 个源/测试文件 md5 未变（`git diff 3448700 7198c14 -- extensions tests` 为空），因此不污染被审工件；记在这里以免后来者误读。
- 修复批次的验证：`node tests/run-all.mjs` **15/15**、`external-edit-test.mjs` **69 条断言全绿**、`repro-write-ordering.mjs` **退出 0**；新断言经**变异矩阵**证明各自钉住一个守卫（撤 `!memoryRefused` → T2c 变红；§2.2 退回 raw 比较（带/不带 trim）→ T1b 变红 2/4 条；去掉 `publishKey` → T6 变红）。
