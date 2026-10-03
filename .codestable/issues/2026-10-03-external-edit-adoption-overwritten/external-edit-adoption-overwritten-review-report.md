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
