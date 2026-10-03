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
