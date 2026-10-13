# 结构性发现：线上 baseline 把 pi 自己的 system 估算减掉了

（2026-10-13，operator 侧只读探针；`probe-system-estimate-in-baseline.mjs` / `.txt`；不改代码）

## 事实

`measureContext` 的 `plain` 累加分支里**全部** message 条目的 `estimateTokens`，其中含 system 消息；
而 pi 导出的 `estimateTokens` 对 system 消息算 `content + Σsections + JSON(toolsAdded)`（compaction.js:201-222），
即 **pi 已经算好了 system prompt + 工具定义的估算**。于是 `baseline = prompt − atRate(plain)` 把这一项**减掉**了：
线上 `baseline` 不是「非对话开销 B_true」，而是「估算残差」。

代码路径（逐条读过）：
- `sessionEntryToContextMessages` 对 message 条目直接返回该消息，system 也算 —— session-manager.js:166-178
- `getBranch()` 是纯父链遍历，无 role 过滤 —— session-manager.js:1062-1072
- 本扩展 `threshold.ts:144-174` 对每个条目 `plain += estimateTokens(...)`
- pi 的 system 分支估算 —— compaction.js:201-222

## 实测（生产函数 + 真实会话条目）

用 `tests/harness.mjs` 加载生产 `measureContext`，喂真实会话条目；对照 = 保留条目 id/parentId、把 system 消息清零
（等价于把 system 从 `plain` 排除）。三个会话的 samples 数完全一致，差额只来自 system 项：

| 会话 | ① 线上 baseline | ② 排除 system | ② − ① | atRate(system 估算) |
| --- | ---: | ---: | ---: | ---: |
| probe 沙箱（01a1331c） | 7,879 | 17,760 | 9,881 | 9,881 |
| ctl 沙箱（01a1331d） | 1,133 | 11,015 | 9,882 | 9,882 |
| 活树会话（01a13385，83 条目 / 33 样本） | 6,515 | 36,227 | 29,712 | 29,713 |

② 与 `probe-true-baseline.md` 记录的 B_true（17,766 / 11,021 首条 prompt；B_ext 17,753 / 11,008）同口径，差 ±10 取整。
活树会话 system 估算 25,823（sections 48,391 字符 + toolsAdded JSON 54,901 字符 / 36 工具）。

## 影响

- `floor = baseline + keep + MIN_DROP`（threshold.ts:298）**系统性偏低** ≈ atRate(system 估算)：probe 差 9.9k、
  ctl 差 9.9k、活树差 29.7k ⇒ **过早起跳**（fail-open）。方向与 R2 的 I-1 相同，但**每个会话都发生**，量级更大。
- `dropTokens = tokens − baseline − keep`（threshold.ts:342）同量高估可丢弃量。
- 为什么两轮审查没抓到：测试夹具里 **0 个 system 条目**（`grep -c 'role: "system"' tests/handoff-test.mjs` = 0），
  R1/R2 的夹具也是合成的 ⇒ 所有契约与变异都在生产里不存在的分支形状上验证；
  `probe-true-baseline.md` 的 est 只算消息 ⇒ 现场事实一直指向正确语义，代码没跟上。
- 推论：R1 那条「baseline 不可能是 0」的前提在**现语义**下不成立（估算吻合时残差就是 0），
  守卫形状之争有一半是这次语义错位的副产品；`plain` 只算消息后该前提才重新成立。

## 候选修法（待 operator 定，未动手）

- **C（最小）**：把 system 消息从 `plain` 里排除（只统计对话消息）⇒ `baseline` 回到 B_true 语义，与 probe、
  floor 的用途、R1 守卫前提全部一致。契约钉：probe 沙箱会话 `baseline` = 17,760（± 取整）。
- **D**：直接拿 pi 的 system 估算当 baseline（零样本也能算，第一轮与 compaction 后尤其有用）；但它本身是
  `chars/4`，对 `toolsAdded` JSON 偏低估（54.9k 字符 → 13.7k 估算，真实约 18–22k）⇒ 需 rate 校正或保守余量。
- **I-1（异质前缀）与 A（锚点 + 精确增量）是独立问题**，C/D 之后依然成立。

## 与 A/B 决定的关系（实测；A 单独不够）

三个变体在真实会话上逐样本对测（`probe-variant-comparison.mjs` / `.txt`；两个沙箱有 provider 真值，
活树会话是 handoff 会话）：

| 变体 | probe 沙箱 | ctl 沙箱 | 活树会话 |
| --- | ---: | ---: | ---: |
| ① 线上（`plain` 含 system） | 7,879 | 1,133 | 6,515（模块自身，33 样本） |
| ② 排除 system（即 C） | 17,760 | 11,015 | 36,227（同样本集合） |
| ③ A＋C（锚点 chars/8） | 17,763 | 11,018 | 131,433（不可用，见第 3 点） |
| 真值 B_true | 17,753 | 11,008 | 未知（`probe-true-baseline.md` 期望活树 30–39k） |

1. **A 必须配 C。** A 的锚点估算把「首条 usage 记录之前的内容」按 `chars/8` 折算；若其中含 system
   （两个沙箱为 9,887 / 9,888 估算字符），就要减掉 `4×9,887/8 = 4,944` ⇒ probe 沙箱读成 **12,822**，
   比真值低 **4,931**（fail-open）。所以 A 的估算量必须只覆盖**消息**字符，system 不能进这个分母 —— 这正是 C。
2. **D（直接用 pi 的 system 估算当 baseline）不可行。** 两个沙箱的 system 估算几乎相同（**9,881 / 9,882**），
   而两者真值差 **6,745** —— 那正是本扩展注入的记忆块。⇒ `estimateTokens(system)` **看不到扩展注入的内容**；
   且它本身是 chars/4，base 部分还低计约 1.1k（9,881 估算 vs 11,008 真值）。用它当 baseline 会低读 ≥6.7k。
3. **任何方案都要先定义「记录合格性」。** 活树会话早期 usage 记录是 predecessor 重放：首样本 prompt **131,434**
   而本地分支只有 **1** 个估算 token ⇒ A 若锚在首条记录上会读出 131,433；单一 rate 复算下逐样本读数跨度
   **137,354**（含负值 −3,916）。A 的增量只对本地记录成立，需按「本地分支非退化」过滤记录（与 R2 已登记的 RR-2 同源）。

**结论：C 是 A/B 两种选择都要的前置**（修掉 9.9k–29.7k 的系统性低读）；A 在此之上把读数变成构造性不漂移
（两沙箱 +10 以内，fail-closed），但需要 (1) A+C、(2) 记录合格性规则。B（接受现状 + 收窄措辞）与实测不符。
