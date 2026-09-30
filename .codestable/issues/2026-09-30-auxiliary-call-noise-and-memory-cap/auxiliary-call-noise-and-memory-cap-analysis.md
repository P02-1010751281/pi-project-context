---
doc_type: issue-analysis
issue: 2026-09-30-auxiliary-call-noise-and-memory-cap
status: confirmed
root_cause_type: retry-and-budget
created_at: 2026-09-30
related: [auxiliary-call-noise-and-memory-cap-report.md, auxiliary-call-noise-and-memory-cap-fix-note.md]
tags: [memory, autolearn, alerts, errors-log, memory-cap, output-budget]
---

# 辅助调用报警与记忆上限 根因分析

分两层：**报警**来自没有退避的失败重试；**很容易顶到上限**来自预算没进 prompt、cap 与输出上限不对齐。

## 1. 报警（调用面）

1. **辅助模型回退会话模型**：`provider`/`model` 为空时 `resolveAuxModel` 用会话模型，于是会话线路的
   quota/auth/网络故障直接打在 consolidation 与 autolearn 上。
2. **autolearn 完全没有退避**：失败后每个 `agent_settled` 再发一次，就是 03:13–03:19 六连发的成因；
   memory 有 5 分钟 throttle，handoff 有 `FAILURE_BACKOFF_MS`，只有 autolearn 裸奔。
3. **失败没有分类**：quota/auth（不会自愈）与 transient（可退避恢复）用同一套处理，toast 文案也一样。
4. **`errors.log` 只追加不去重**：同一个失败的每个副本都写一行，并推动轮转。

## 2. 记忆容易撞 cap（预算面）

1. **模型从来不知道字符预算**：`prompt.ts` 只写 “Keep memory concise and below 6000 words”；
   `maxMemoryChars` 从未注入。对中文，6000 words ≫ 32000 chars——模型满足明写约束照样超 cap。
2. **cap 只在写路径砍尾**：`normalizeMemoryDocument` → `clipToLineBoundary`，没有“超了就压缩”的第二阶段，
   增长被静默转成尾部丢失。
3. **每轮整篇重写**：没有每轮/每节预算，输出只涨不缩。
4. **截断标记会粘住**：body 已回到 cap 以内时仍接回旧 marker，导致假 cap 告警与陈旧自述行。
5. **cap 与输出上限无对齐校验**：32000 中文 ≈ 16k–32k token，叠加 context + 1024 脚手架 + reasoning
   reserve 正好撞 `MAX_ADAPTIVE_OUTPUT_TOKENS=32768`，又回到“整篇重写被截断”。

## 3. 为什么会长（结构面，本次只做兜底）

- 同一扩展在两个项目长成两种东西（UniField 知识库式 11 节/101 bullet，QM 索引式 5 节/50 bullet），
  说明**结构是模型每轮自由生成的**，没有固定 schema，无法挂每节预算。
- 0 条完全重复 → 不是靠重复膨胀，是靠**只增不删**；扁平 bullet 没有条目生命周期，
  prompt 的 “Replace or remove superseded entries” 无元数据时不可执行。
- **按位置丢尾恰好丢掉最持久的内容**：UniField 的「工程教训」、QM 的「操作陷阱」，而超大节反而留着。

结论（当时的施工顺序）：

1. B1 + B2/B3（降噪）
2. M1 + M2 + M6（闸门层）
3. S1 + S3 + M3/M4/M7（结构层 + 可见性）
4. S2 + S5 单独立项

本 issue 覆盖 1–3 中**不动用户活项目**的纯代码部分（B1/B2/B3 + M1/M2/M6 + B4 + M3/M4/M7）；
A2/A3/A4 运维条目（改活项目配置、调 QM cap、处理 MEMORY.md/journal 分叉、重启进程）与
S1/S3（固定 schema + 指针化，改记忆对外形态，需独立评审）仍待办。
