---
doc_type: fix-note
issue: consolidation-keeps-entries
status: implemented
date: 2026-10-06
implemented_in: 待填（提交后回填）
relates_to: .agents/skills/pi-project-context-consolidation-prompt-rule/SKILL.md
---

# 合并通道不再丢策展条目（prompt 规则层修复）

## 1. 现场证据

- **F1** `.agents/memory/errors.log` `2026-10-06T04:30:56.155Z [memory] memory regression: 3 Invariants/Pitfalls
  entry(ies) are no longer present, e.g. Release evidence for a behavior-changing version must state that …` ——
  同一时刻的渲染（本会话起手时落在工作区的那份）被扩展自己的守卫记了一笔。
- **F2** 对那次渲染与已提交版本的逐条比对：**丢 11 条**（5 Invariants / 4 Pitfalls / 3 Index），同时**文档变短**
  30,202 → 29,920 字符。截断量级远小于上限（32,000），所以这些删除**不是被上限逼的**，是改写过程中的净损失。
- **F3** 同类事件的更早两条回归行：`2026-10-05T14:09:16.272Z`（14 条）与 `2026-10-05T16:46:30.185Z`
  （`memory exceeded a section budget: 3 section(s) exceeded their budget and 20 whole entry(ies) were dropped`）。
  也就是说这是**反复发生**的一类损失，不是单次意外。
- **F4** 授权该行为的提示原文只有一句：`When over budget, merge duplicates within a section, deduplicate across
  sections, then drop the least durable entries.` 它把「删除」写成超预算时的**默认收尾动作**，而 F2 表明模型
  在并未超预算时也照做了——规则读起来像许可，而不是最后手段。

守卫本身是**只记不拒发**（`memory/pass.ts:318` 记 `memory regression:` 后照常发布），所以除这一行日志外没有任何
拦截；把文件手工补回也**不持久**（下一次合并仍可能丢，采纳路径只保证外部编辑进 journal）。因此本 issue 修的是
**提示层**——按 `.agents/skills/pi-project-context-consolidation-prompt-rule/SKILL.md` 的做法，prompt 是唯一持久的杠杆。

## 2. 修复（两层放置，两处都钉）

1. **规则句**（`memory/prompt.ts` 规则列表，替换旧句）：

   > Keep every entry that is still true: outside a genuine budget overflow, no entry may disappear while
   > rewriting the document, and losing one is a defect rather than consolidation. Over budget, merge
   > duplicates within a section and deduplicate across sections first, then condense the wording. Delete only
   > what is superseded or already covered elsewhere.

   与 owner 选择的「压缩合并而非删除，**只删可证过期者**」一致：溢出是删除的**前提**，压缩是溢出的**首选**动作，
   删除的理由被限定为「已被取代」或「别处已覆盖」。
2. **内容进入点注记**（`<existing-memory>` 标签前一行，紧贴该块）：该块的内容正是回复要整体重写的对象，所以注记
   放在它入口处，说明「仍为真者必须复现，压力用压缩某个条目的措辞来回答，而不是丢条目」。

## 3. 钉子与变异矩阵（单侧，`tests/memory-budget-test.mjs`）

| 变异 | 红点 |
| --- | --- |
| M0 未变异 | 0 红（套件 15/15） |
| M1 删规则句 | 3 红：`makes compression the default over deletion` / `still allows deleting what is superseded` / `conditions the drop rule on being over budget` |
| M2 删注记 | **1 红**：`the keeping caption sits at the memory block it protects`（注记的守卫不被规则句代偿） |
| M3 把旧措辞放回 | 4 红：上述 3 条 ＋ `no longer offers dropping entries as the over-budget step`（负向钉子专用） |

注记断言按**行尾＋空行＋标签**的真实形状钉（`captionLine` 之后必须紧跟 `\n\n<existing-memory>`），不是钉一句前缀——
第一版写成前缀拼接时红点解释了这件事：前缀之后还有正文，断言当时是假阴性。

## 4. 成本

合并调用每次多 **+427 字符**提示（4,145 → 4,572，约 107 tokens），每 N 轮一次，不随会话长度增长。

## 5. 验收：说明清楚它能证明什么

- 提示内容断言只证明**这些话在提示里**，不证明模型照做。不得据它们宣布行为已修好。
- 真验收是**渲染面**：之后若干次合并的渲染里，(a) `.agents/memory/errors.log` 不再新增 `memory regression:` 行；
  (b) 渲染的条目数不低于上一版（除非确有「已被取代/别处已覆盖」的删除）。此法仍需后续现场样本才能收口，记为
  未完成的验收项。

## 6. 非目标（记录，不重建）

- **不**把渲染从「整篇重写」改成「合并」（技能已记为非目标：那修的是损失以外的东西，且是需独立设计的新机制）。
- **不**加「新增测量行」之类的预发布门禁（需维护外来名单，且会误伤合法数字）。
- **不**改 `maxMemoryChars` 与分段预算：本条修的是「未溢出也删」与「删除排在压缩之前」，与容量无关；容量另有
  待 owner 决定的记录（`.codestable/attention.md`）。
