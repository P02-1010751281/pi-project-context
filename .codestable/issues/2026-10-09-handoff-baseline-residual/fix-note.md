# 修复说明（v0.4.10）

issue `2026-10-09-handoff-baseline-residual`：`baselineTokens` 把「当前这一点的 usage 残差」当非会话基线，
残差里带着 `Σchars × (1/4 − 1/r)`（本仓实测 `r = 2.2–3.8`），于是物理下限随对话变长自己长高，越过质量拐点后自动交接被**无声**关掉。
本版把 baseline 换成「每条 usage 记录的密度上界的最小值」，并把它周围的三类误判收干净。设计演进与逐轮审查见 `design.md`、`review-report.md`。

## 每个文件的 why

- **`extensions/project-context/handoff/threshold.ts`**（唯一的行为改动面）
  - `measureContext`：逐记录取 `prompt − chars/8`（`chars/8 ≤ T_r ≤ chars` 的 densest 上界）并取最小 ⇒ 该值在**设定它的那条记录时刻**之上，
    由最空记录定下、不随分支增长；样本需自证是测量（`prompt > chars/8`）、区间需与常量 baseline 一致（`Δchars ≤ Δprompt × 8`，prompt 未缩小）、
    `chars` 跟随 pi 的投影（`context_edit` 就地改写、`convertToLlm` 排除的 `!!` 不计入、system 消息与图像块不计入）。
  - overhead re-anchor：`Δprompt > 2 × Δchars`（新增文本 ≤2 token/字符的假设）⇒ 从该记录重启最小值；仅此假设下可判定，所以是启发式（假阳性只抬高读数）。
  - compaction 失效：`entryTime(entry) <= compactionTime` 的记录不作样本 —— 镜像 pi core 的 `assistantIsFromBeforeCompaction`
    （`firstKeptEntryId` 保留的那条 prompt 属压缩前分支、`chars` 属压缩后投影）。
  - 无样本路径（首回合 / 只有 compaction）：保持历史公式逐字节不变。
- **`extensions/project-context/memory/store.ts`**：`readRenderWithMtime` 的 `changed` 判定抽成纯函数 `renderChangedAcrossRead` 并加入 `ctime` ——
  只比 mtime+size 时，「保留 mtime 的同尺寸替换」（`cp -p`、`rsync -t`）看不见，而发布侧正是靠该标志决定不写 ⇒ fail-open。
- **`tests/handoff-test.mjs`**：末节 38 条契约（含 ⑥ 的 3 条新契约与 ② 的现场夹具）；**`tests/consolidation-test.mjs`**：`renderChangedAcrossRead` 的 6 条边界。
- 文档面：`CHANGELOG.md`（行为变化 + 变异矩阵）、`docs/handoff.md`（取样语义）、`docs/architecture.md`（flush 一致性判定与平台限定）、
  `.codestable/issues/2026-10-09-handoff-baseline-residual/*`（design §9–§14、review-report R1–R10、探针与抄本）。
- 记忆面：`MEMORY.md` 两条 pitfall（读路径判定、SIGKILL 看门狗清理）按 journal op 重写，渲染 31,875 / 32,000 字符。

## 用户可见的变化

- 物理下限不再随对话变长自己长高 ⇒ 越过质量拐点后自动交接不再被无声关闭；读数相对「设定它的那条记录时刻」的真值**只高不低**（fail-closed）。
- `/handoff status` 的后缀明说取值口径：`· baseline <v> (chars/8 bound over <n> records; receipt at <r> c/t)`；
  无样本时 `(chars/4, no usable record)`，rate 未校准时 `receipt at chars/4, no usable delta`。
- 交接受 compaction 影响时不再引用压缩前计费的记录（有 compaction 的真实会话读数升高，R10 实测 `01a13317` 63,957→95,900、
  `01a13465` 58,763→140,917、`01a1354d` 77,841→124,191；其余会话不变）。
- MEMORY.md 的外部编辑采纳：保留 mtime 的同尺寸替换现在被认作「读期间变过」⇒ 该次 pass 不写、留给下一次。

## 变异矩阵（`node tests/run-all.mjs` 的 `^FAIL ` 行，本修订实测）

| 变异 | 红 |
|---|---|
| system 消息重新计入估计 | 3 |
| 上界退回 rate 缩放（`prompt − atRate(chars/4)`） | 14 |
| `min` 改 `max` | 9 |
| 去掉「记录不自证为测量」 | 1 |
| 后缀把未校准的 4.0 印成测得 rate | 1 |
| 图像字符重新计入估计 | 1 |
| 去掉区间一致性规则 | 1 |
| 忽略 `context_edit`（用原始前缀） | 1 |
| 去掉 rate 带下半 | 3 |
| 同一目标的编辑链式应用 | 1 |
| 计入被排除的 `!!` 输出 | 2 |
| `!!` slice 头退回 role 判定 | 2 |
| 排除判定退回严格 `=== true` | 2 |
| 去掉 overhead 增长 re-anchor | 2 |
| 允许压缩前记录作样本 | 2 |
| 记忆侧：去掉 `ctime` 子句 | 1 |

## 非目标（本轮明确不做，登记在 design §14）

- ① 最空记录自身字符数带来的高读（密度下界的固有代价）；③ 只有 predecessor 记录时的虚高（不可判，方向是拒绝）；
  ④ >8 chars/token 的偏稀疏锚点（无 tokenizer 不可判，量级已给）；⑤ 文件级陈旧锚点（pi 自身写者不可复现）；
  ⑦ 未达门槛的 overhead 增长压低 receipt 的 rate（只供 split-turn 预算，fail-closed）；⑧ 消息条目缺 `message.timestamp` 时比 pi 严（0/27,440 可达）；
  ⑨ Windows 上 `ctime` 是创建时间 ⇒ 原地同尺寸替换仍不可见。
- 两条口径差异：`contextTokensAtRate` 仍按 pi 原值计图像与 system（预算器件不得低报）、`branchSummary`/`!` 包装的十几 token 高读。
- 交接切点仍是 pi 的 `findCutPoint`（chars/4），CJK 重分支的实际承载量与 keep 预算可能有偏差。
- SIGKILL 看门狗路径的 fixture 临时目录清理**已在此前轮次修好**（rounds 18/19），本轮只更新了 MEMORY 的措辞。
