---
doc_type: review-report
issue: 2026-10-19-context-refusal-publish
reviewer: deepseek/deepseek-flash (independent pi -p process)
sandbox: /tmp/pi-context-rev-ctx2 (round 1), /tmp/pi-context-rev-ctx3 (round 2)
---

# 独立审查：拒绝态不再发布 context 段

## 轮次表

| 轮 | 修订 | 判定 | blocking | important | 性质 |
| --- | --- | --- | --- | --- | --- |
| R1 | `07b77a2`（`11bd38a` 的修复 + 文档） | CHANGES-REQUESTED | 0 | 2 | 诊断措辞：fresh 项目声称不存在的旧文件/占位符；shape warning 早于拒绝判定；另有 5 条 nit（陈旧文档、变异计数、severity、死分支、表格中断） |
| R2 | `7732749`（R1 修复） | CHANGES-REQUESTED | 0 | 2 | recovered 回复被说成"没带 context 段"；shape warning 在 `writeAtomic` 之前声称占位符已写；另有文档谓词、夹具断言、severity 未钉等 nit |
| R3 | `69c114f`（R2 修复） | CHANGES-REQUESTED | 0 | 2 | fresh recovered 拒绝同时发两条互相矛盾的诊断；拒绝/形状诊断声称 pass 读到的旧快照仍生效（竞写已换掉磁盘文件）；另有架构谓词、夹具标签、缺 fresh-absent-published 与写失败夹具等 nit |
| R4 | `a5e70f1`（R3 修复） | CHANGES-REQUESTED | 0 | 2 | recovered 发布线仍说"没带 context 段"；existing-context 的 unusable 措辞未被钉住（恢复旧串仍全绿）；另有 fresh-absent 静默、thrown 夹具、架构谓词、T2、CHANGELOG 等 nit |
| R5 | `c855f2e`（R4 修复） | CHANGES-REQUESTED | 0 | 4 | `!memoryRefused` 抑制未被钉住（删掉仍全绿）；架构称拒绝态 unusable 由拒绝诊断"覆盖"（实际 shape warning 也发）；首条 bullet 缺发布态限定；fix-note commit 过期；另有 "never closed" 对 malformed-closed 回复不成立等 nit |
| R6 | `78bad89`（R5 修复） | CHANGES-REQUESTED | 0 | 5 | parser 在 JSON 已解析但 memory_markdown 非顶层字符串时仍走 raw recovery（valid 回复被报成不可解析、丢掉可用 context）；"the file on disk was left untouched" 在竞写下不成立；fix-note 表格仍是 round-4 的说辞、commit 元数据过期、cut 夹具未断言旧 "never closed" 缺席 |
| R7 | `fe00482`（R6 修复） | CHANGES-REQUESTED | 0 | 2 | no-write 诊断仍有全局 "no CONTEXT.md was written"（竞写可证伪），文档引用旧串；refused caveat 的 "never closed"、`left untouched` 后缀、non-string-nested parser 用例未钉住 |
| R8 | `921ff8f`（R7 修复） | CHANGES-REQUESTED | 0 | 3 | shape 分支的 no-write 短语未被源特定断言（skip 行满足它）；refused-recovered/fresh-absent/published-missing 三支未拒绝旧短语；fresh-absent skip 行不含 pass-scoped 短语；fix-note 变异计数过期 |
| R9 | `fe6ca60`（R8 修复） | CHANGES-REQUESTED | 0 | 2 | 共享负断言漏掉 "is kept/stays stale" 家族；stale 拒绝 toast/reply 未钉住；shape 正短语非源特定；external-edit 未用 helper；变异计数/§2.2 引用/CHANGELOG 归因过期 |
| R10 | `4dd688e`（R9 修复） | CHANGES-REQUESTED | 0 | 3 | 自动（非 silent）拒绝 toast 未覆盖；shape 的"源特定"检查是整条日志计数；fix-note 变异矩阵计数过期；另有 T2c 未用 helper、CHANGELOG 归因等 nit |
| R11 | `7c64497`（R10 修复） | CHANGES-REQUESTED | 0 | 2 | shape 行断言选了首个 `could not be used` 行；自动 toast 夹具缺负控（把门扩成 `contextUnusable` 仍全绿）；矩阵计数/commit 元数据 nit |
| R12 | `76c09af`（R11 修复） | CHANGES-REQUESTED | 0 | 2 | 架构把"整条回复都不发布"写成无条件（semantic-empty/short 的 R1 反例）；自动 toast / stale 回复未拒绝假 "Memory: updated/context updated" 前缀；负控仅 fresh 项目、store 第二条拒发行未覆盖 |
| R13 | `0226d43`（R12 修复） | CHANGES-REQUESTED | 0 | 2 | 自动 `!memoryChanged` toast 未拒绝假 "Memory: updated"；架构未记 clear/blank/delete + same-key 例外（设计 R-3）；store 第二拒发行的覆盖缺口未在 fix-note 引用 |
| R14 | `97c71cc`（R13 修复） | CHANGES-REQUESTED | 0 | 2 | 自动 `!memoryChanged` toast 在仅 prompt 被裁时谎称 rewrite 缩短；设计 R-2 引用缺失；架构 clear/blank 例外归因不准；keep-memory 夹具只断言 toast |
| R15 | `c352bcf`（R14 修复） | CHANGES-REQUESTED | 0 | 3 | 夹具只证 toast 不证效果（无条件 clip 说明、clipped 跳过 context 均全绿）；设计 R-2 仍未具名；架构 "fold 移动后被清空 recheck 拒绝" 说错（空 key guard 放行）；另有命令回执 clipped 措辞、legacy clear、CHANGELOG 遗漏等 nit |
| R16 | `d4ff8a3`（R15 修复） | CHANGES-REQUESTED | 0 | 1 | clip 负控仍是表面特定（默认 updated toast、非 clipped 命令回执、stale 句均接受 clip 说明）；另有架构 R1 标签过宽、R-14、legacy 字节、CHANGELOG 夹具句等 nit |
| R17 | `60e11ec`（R16 修复） | CHANGES-REQUESTED | 0 | 3 | clip 负控仍按短语/表面（自动 stale toast、`rewrite also shortened` 等短语不红）；legacy clear 只断言子串；架构/fix-note 的 R1 范围不一致；nit: changelog 顺序、fix-note 元数据、清理句 |

## 收尾（stop rule）

R16、R17 连续两轮 0 blocking，剩余 important finding 都属于夹具/措辞/规格精度类（同一文档再改一轮无法提出新的
可退役项）。按 skill 的 stop rule 关闭链条：**没有取得 PASS**，R17 的三个 important 已在 `v0.4.14` 的测试/文档里
修复并由变异矩阵钉住（共享 `noClipClaim` 覆盖自动 stale toast/默认 toast/命令回执/stale 句；legacy clear 用归一化 key；
架构与 fix-note 的 R1 范围一致；CHANGELOG 恢复 newest-first）。未独立复核这些修复本身，记录为残余。

残余（接受）：D-R2（recheck 接线无集成测试，设计 §2.3/T6 不是集成覆盖）、R1（context-only lost update，含
semantic-empty/short 与 clear/key-equal publish）、R3/R4（context 写入无锁/无 CAS）、R-14（无 journal + rotation
归档优先级）。

R1 全文：`review-round1-independent.txt`（路由 `deepseek/deepseek-flash`，sandbox `/tmp/pi-context-rev-ctx2`，
零写入：`git status --porcelain` 空、HEAD `07b77a2`）。

## R1 发现与处置

| # | 严重度 | 发现 | 处置 |
| --- | --- | --- | --- |
| I1 | important | 拒绝态诊断在 fresh 项目上说 "the previous CONTEXT.md stays effective"（文件不存在），并把 `fallbackUpdate` 叫作 "the refused reply's context section" | 诊断按 `outcome.result.context`/`contextUnusable` + `existingContext.trim()` 分三支；fresh 写 "no CONTEXT.md was written"；回复没带 context 时写 "the reply carried no context section" |
| I2 | important | `contextShapeWarned` 在 `memoryRefused` 之前运行，fresh 项目会谎称 "only a placeholder context was written" | 把 shape warning 移到 memory 决策之后，措辞按 `contextWritten`/`existingContext` 分支；设计 §2.4 的该行理由同步更正 |
| N1 | nit | 设计 §2.4 的 shape-warning 理由、旧 `contextWritten: Boolean(update)` 片段、stale 句 true 分支、T2 验收行、architecture 措辞、CHANGELOG 措辞均已过期 | 全部更新；设计 §2.4 的已取代注记补齐并移到表格之后 |
| N2 | nit | fix note 的变异计数按旧测试写（4 条），实际按当时是 3 条 | 按最终测试重测：consolidation 6 条、external-edit 2 条，已写回 |
| N3 | nit | `/memory update` 的拒绝回执以 info 显示 | 命令回执的 warning 条件加入 `keepReason === "stale"` |
| N4 | nit | `staleKeepSentence(true)` / `LastWriteInfo.contextWritten` 已成死分支 | 删除参数与字段；stale 句不再带 context 前缀 |
| N5 | nit | 已取代的 blockquote 插在 §2.4 表格两行之间，孤立最后一行 | 移到表格之后 |
| S1 | suggestion | 缺 fresh 项目的诊断夹具 | 新增三个 fresh 夹具（带/不带/不可用 context），断言不声称旧文件/占位符 |
| S2 | suggestion | 登记 context-only race | 已写入 fix note §6 R1 |
| R1–R4 | residual | context-only lost update、dedupe、lastWrite 并发、context 无 CAS | R1 已登记；R2–R4 为既有残留，记录在 fix note |

## 验收边界（R1）

- 修复本身把"拒绝态不发布任何一侧"钉在唯一写入点，`fallbackUpdate` 也被门住。
- 未被本次修复覆盖的是 context-only race（`CONTEXT.md` 在模型调用期间被改而 memory 未变）——
  需要独立 context basis key，属新机制；登记为 R1 残留。
