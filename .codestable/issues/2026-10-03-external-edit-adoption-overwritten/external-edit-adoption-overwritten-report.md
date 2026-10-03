---
doc_type: issue-report
issue: 2026-10-03-external-edit-adoption-overwritten
status: open
created_at: 2026-10-03
related: [audit.md, repro-write-ordering.mjs, ../2026-09-30-auxiliary-call-noise-and-memory-cap/over-cap-reply-persistence-fix-note.md]
tags: [memory, memory-journal, external-edit-adoption, lost-update, write-ordering, consumer-repos]
---

# 外部编辑采纳后被旧内容覆盖 问题报告

**一句话**：「采纳」只把外部编辑写进 journal 历史，**不改变生效内容**——同一次
`recordMemoryDocument` 调用紧接着 append 本次 pass 的 render 并写进 `MEMORY.md`，而那个 render 是
**编辑前的旧内容**。`errors.log` 的 `adopted an externally edited MEMORY.md into the memory journal`
在覆盖发生**之前**就已写出，读起来像"编辑已生效"。

**已确定性复现**（无需模型调用、无需第二个进程）：

```bash
node .codestable/issues/2026-10-03-external-edit-adoption-overwritten/repro-write-ordering.mjs
# 退出码 0 = 复现成功
```

## 1. 触发与来源

上游是兄弟仓库记忆漂移的审计：`.codestable/issues/2026-10-03-consumer-repo-memory-drift/audit.md:224`
记「写入顺序问题**未修、未立项**」，并指出两个仓库的 journal 都呈「一次采纳紧接一次另一版写入、
间隔 70–450 ms」，因此"护栏变绿/采纳是否守得住"未知。本报告把它立为独立 issue 并给出复现。

## 2. 现场证据

两个仓库的 `memory.jsonl` 各只有 5 条 `replace` 记录，形态完全同构（长度 / md5 前 12 位）：

| # | Quantum_Matrix | UniField |
| --- | --- | --- |
| 1 | `09:02:23.956` 11009 `e4daf7fbba87` | `08:41:35.918` 31883 `51d2b2a63daa` |
| 2 | `09:03:07.058` 17998 `f0014bf23455` ← 采纳 | `08:44:17.862` 32960 `8563da428ff8` ← 采纳 |
| 3 | `09:03:07.127` 11009 `e4daf7fbba87` ← 顶掉（**69 ms 后**） | `08:44:18.308` 26931 `2f6022482e7e` ← 顶掉（**446 ms 后**） |
| 4 | `09:29:25.473` 17998 `a8da09386b85` ← 采纳 | `08:48:46.372` 34994 `0de468d6f582` ← 采纳 |
| 5 | `09:29:25.553` 11009 `e4daf7fbba87` ← 顶掉（**80 ms 后**） | `08:48:46.701` 26931 `2f6022482e7e` ← 顶掉（**329 ms 后**） |

三点关键事实：

1. **顶掉采纳的那条记录，与更早的一条记录逐字节相同**：QM 的 `[1]≡[3]≡[5]`，
   UF 的 `[3]≡[5]`。也就是说覆盖它的不是"基于采纳内容重新生成的回复"，而是**编辑前的旧内容被原文写回**。
2. **间隔极短**（69/80/329/446 ms）——不足以容纳一次模型调用，只够同一个函数里的两次 append。
3. `errors.log` 的采纳行数与之匹配：QM **142** 条、UF **35** 条（末条分别为
   `2026-09-30T09:29:25.553Z`、`2026-10-01T08:48:46.633Z`）。采纳不是偶发事件。

好版本的字节并未灭失：`backupMemoryBeforeWrite` 在每次写入前留档，兄弟仓库的
`MEMORY.md.memory-backup-*` 里正存着它们（QM `…09-29-25-468Z-7e391801` = 17998，
UF `…10-01T08-48-46-062Z-6f6410ac` = 34994）。**丢的是"生效"，不是"字节"。**

## 3. 机制（代码级）

`extensions/project-context/memory/store.ts` 的 `recordMemoryDocument()` 是**一次调用、两次 append**：

| 行 | 动作 |
| --- | --- |
| `:61-71` | 折叠 journal 得 `foldedView`，读 `MEMORY.md`；若 `render ≠ fold` **且** `render.mtime > journal.mtime` → `:68` `appendMemoryOp(replace, external)` **← 采纳写入历史**，`:70` `logError("adopted …")` |
| `:77` | `appendMemoryOp(replace, rendered)` —— **本次 pass 自己的 render** |
| `:80` | `writeAtomic(MEMORY.md, rendered)` —— **生效内容 = pass 的 render** |

`foldMemoryJournal` 取末条 `replace` 为折叠结果，所以 `:77` 的那条 append 直接决定了生效内容。
代码注释自称的意图是"its bytes enter the journal's history **instead of being silently overwritten**"
（`:64-66`）——**历史确实保住了，生效位置没有**。

prompt 侧并不陈旧：`loadMemory` 在 `store.ts:114` 同样按"render 更新且与 fold 不同"返回**外部编辑**，
所以读取侧认这份编辑。真正的时间窗是**模型调用期间**：

1. pass 开始，`loadMemory` 给出**编辑前**的内容，据此构造 prompt；
2. owner 在这段时间里改 `MEMORY.md`（新 mtime）；
3. pass 拿到回复，调用 `recordMemoryDocument(root, reply)`；
4. `:68` 采纳外部字节写进历史；
5. `:77/:80` 把**由第 1 步快照生成的**回复写成生效内容——第 2 步的编辑被顶掉。

第 5 步写成的是旧内容而非新回复，正与"顶掉记录与更早记录逐字节相同"吻合：该回复是旧记忆的
重述（prompt 里就带着旧记忆）。

## 4. 复现

脚本 `repro-write-ordering.mjs` 用 `tests/harness.mjs` 直接加载 `memory/store.ts`，不启动 pi、
不调用模型：

- **S1**（pass 产出新回复 C）：journal `A → B → C`，`MEMORY.md` = C，`errors.log` 声称已采纳，
  外部编辑 B 不生效。
- **S2**（pass 产出编辑前的旧内容 A，**即兄弟仓库的实际形态**）：journal `A → B → A`，
  `MEMORY.md` = A，`errors.log` 声称已采纳，B 不生效。

实测输出（本机）：

```
=== S2：pass 产出编辑前的旧内容（A）——兄弟仓库的实际形态 ===
journal 记录顺序： A → B → A   （每条长度 119/144/119）
最后两条记录间隔： 1 ms
MEMORY.md 现在生效的是： A
errors.log 末行： … adopted an externally edited MEMORY.md into the memory journal
采纳记录进入 journal： true
外部编辑仍然生效：   false
errors.log 声称已采纳： true
判定：已复现——外部编辑被采纳进历史，但在同一次调用里被顶掉，没有生效
```

本机两次 append 间隔 **1 ms**，现场是 70–450 ms。差 80–450 倍，解释是现场文档大 100 倍
（11009–34994 字符 vs 119/144 字符）且落在慢速外置盘上。**这是推断，不是实测**；结构性结论
（同一次调用内的相邻两条 append、无第二次模型调用）不依赖该推断——现场的原始三条证据
（逐字节相同的回退、ms 级间隔、无并发进程迹象）已足以排除"另一个进程"和"第二次模型调用"。

## 5. 影响

1. **外部编辑（手改 / `git checkout` 恢复 / 旧版本 build）不能靠"被采纳"守住。**
2. **生效条件恰好是反的**：`report.ts:132` 的 `memoryChanged` 决定写不写——
   `!outcome.semanticEmpty && (sectioned || memoryText.length >= 40)`。因此：
   - pass **成功产出内容** → 采纳被顶掉；
   - pass **失败/产出空内容**（模型超时、heading-only、opaque 且 < 40 字符）→ 不写 → 采纳**反而生效**。
   即"越成功的 pass 越会毁掉 owner 的编辑"。
3. **日志误导**：`adopted …` 在覆盖**之前**写出，且措辞是完成态。142/35 条这样的行不能被当作
   "编辑已生效"的证据。
4. **恢复路径仍然存在**（这一点是好消息）：编辑字节同时留在 journal 历史与
   `MEMORY.md.memory-backup-*` 里，可人工回捞。丢失的是生效状态与可观测性。
5. **对刚落地的兄弟仓库处理有直接后果**：两个仓库现在都处在"下一次 pass 会被顶掉"的配置
   （QM `render 17998 ≠ fold 11009` 且 `render.mtime 10-03 13:48 > journal.mtime 09-30 17:29`；
   UF `render 27354 ≠ fold 26931` 且 `10-03 16:46 > 10-01 16:48`）。**下一次成功的 consolidation
   pass 会把它们改回 11009 / 26931**；若该次 pass 失败则保持现状。这是可验证的预测，也是本 issue
   的验证点。

## 6. 候选修法（未选，待 owner 定）

| | 做法 | 代价 / 风险 |
| --- | --- | --- |
| A | 检测到采纳时**放弃本次写入**，让外部编辑生效 | 一次编辑换掉本次 consolidation 结果；需要保证"采纳标记"在 render 被自己写回后自然消失（fold 与 render 一致即不再触发），否则可能连续跳过多次 pass |
| B | 仍写入，但**把日志改成诚实措辞**（例如 `an external edit was adopted and then superseded by this pass's reply`） | 最便宜；只修可观测性，不修行为 |
| C | 把 pass 的**基线**（`loadMemory` 当时返回的内容指纹）带进 `recordMemoryDocument`，发现"基线 ≠ 采纳内容"时判定回复已陈旧，按 A 处理或**重跑一次 consolidation** | 最贴近正确语义；需要新增一个参数与一轮额外的模型调用（成本、以及重跑本身可能再次踩同一个窗口） |

A 与 C 需要一个判据来区分"owner 有意改的"与"旧版本 build 的退化写入"——现有代码只用
`render.mtime > journal.mtime` 且内容不同，**不足以区分意图**；这个判据怎么定属于 owner 决定。

## 7. 残留与未做项

- 本报告**只做诊断与复现**，不改代码：修法需要在 `store.ts`（写入顺序）与 `report.ts`（日志措辞）
  之间选定，属行为变更，应有独立设计 + 评审。
- 复现脚本是**单元级**的（直接调用 `recordMemoryDocument`），不覆盖"编辑在模型调用期间落地"这一
  真实时序；真实时序的证据来自第 2 节的现场 journal，而非脚本。
- 本机与现场的间隔差（1 ms vs 70–450 ms）只作了推断解释，未做压测验证。
- 未在兄弟仓库做任何写入；未替 owner 决定是否提交、是否回捞备份。

## 8. 关联文档

- `audit.md` —— 漂移审计（第 2 节证据的来源，`:224` 记本问题未立项）
- `repro-write-ordering.mjs` —— 复现脚本
- `../2026-10-03-consumer-repo-memory-drift/unifield-adopt-review-report.md` —— UF 四轮审校与采纳记录
