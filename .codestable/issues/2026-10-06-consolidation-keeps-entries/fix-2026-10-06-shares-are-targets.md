# 修复：段配额降为目标值，硬上限只剩文档上限

日期：2026-10-06
前置：`acceptance-2026-10-06-v0.4.4-not-met.md`（v0.4.4 的提示层修复不足，四次真实 pass 各丢 10–15 条）
改动：`extensions/project-context/memory/sections.ts`（渲染器）、`prompt.ts`、`pass.ts`、`report.ts` 措辞
状态：已实现，待独立评审

## 决策

owner 定：**「总的不超配额就行；四段的数字本来就是预估」**。于是 share 从「硬配额」降为「目标值」，唯一硬约束
是文档的 `maxMemoryChars`。

## 机制

`allocationFor(targets, wanted)`（sections.ts，渲染器内）：

1. 每段先拿 `min(需求, 自己的目标)`——用不完的部分进池；
2. 池按各超额段的**超出量比例**分配（`floor(池 × 超额 / 总超额)`）；
3. 池能覆盖全部超额时，比例分配**精确等于**各自超额 → 一条不丢；只有池不够（即文档真的满）时才丢条目。

`text.length <= cap` 仍由构造保证：`Σ allowed ≤ Σ targets = body`。

好处：借用只在「邻居让出」时发生，所以 share 仍起平衡作用；同时不再出现「文档还有 1,839 字符空着却丢条目」。

## 钉子与变异矩阵（`tests/sections-test.mjs`）

| 变异 | 红点 |
| --- | --- |
| M0 未变异 | 0 红（套件 15/15） |
| M1 借用关掉（回到硬 share） | 4 红：`a section over its share borrows instead of dropping entries` / `every over-share entry survives the borrow` / `the over-share section takes the room its neighbours left` / `a borrowing section keeps a longer entry whole` |
| M2 每段直接取走自己的超额（不分池） | 1 红：`2000 random caps all fit`（worst margin −3119，即突破了上限） |
| M3 每项上限用目标而不是借用后的额度 | 1 红：`a borrowing section keeps a longer entry whole` |

新增两条与机制等价的断言：随机 2,000 组「内容量 ≤ 目标总量」的输入**必须 0 丢弃**（0 violations），以及
随机 2,000 个上限**永不超过**。

## 端到端实测（真实 flash 辅助调用，现场输入 137 条 / 31,774 字符）

| | 改前（v0.4.4） | 改后 |
| --- | --- | --- |
| 渲染器在此输入上的丢弃 | 9 条（三段超配额） | **0 条**（借用 866/251/553，Project 让出 1,839） |
| 四次真实 pass 的既有事实丢失（Inv+Pit diff） | 7 条（净条目 137 → 128/129） | **1 条 / 3 条**（净条目 137 / 136，且每次都有等量新增） |
| `errors.log` 上限行 | 每次都有 | 仍有，但只在**回复本身超过文档上限**时 |

改后仍报上限行的原因已量清：本仓记忆已占上限的 **99.3%**（31,774 / 32,000），模型每轮还会**新增**条目
（post1 新增 3、post2 新增 1），于是回复总量超过 31,924 的 body 上限 → 渲染器按新规则从超额段丢。丢的主要是
模型自己刚加的内容，既有事实的净损失 1–3 条。
**这是总量余量问题，不是分配问题**：分配问题（文档有余却丢）已由本次修复解决。

## 剩余项（给 owner）

- **记忆贴着上限**：要彻底不丢，要么抬 `maxMemoryChars`（`/memory max-memory <n>`，例如 36,000 ≈ 每会话多
  约 1,000 tokens 的注入），要么对记忆做一次人工裁剪。当前已记进 `.codestable/attention.md`。
- CONTEXT.md 不在此次改动内：它按段裁剪但**在文件里写明截断了多少**（`truncation marker`），且是每轮重写的
  会话状态，不存在「静默丢策展事实」的同一故障。
- 冷凝重试仍可能被拒（模型压不下来），但它的裁判现在是「文档是否装下」，比原来的「每段是否装下」可达得多。
