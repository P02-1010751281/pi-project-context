---
doc_type: audit
subject: 设计复杂度补审二：全量模块清单（把「未查完」清空）
created_at: 2026-10-04
related: [2026-10-03-design-complexity-audit.md, 2026-10-03-design-complexity-audit-addendum-handoff-config.md]
tags: [process, design-review, complexity, evidence, module-inventory, dead-code]
---

# 补审二：全量模块清单

补审一清空了主审计「未查完」里的四个文件，但 §6 又留下一份「第三轮」清单（`threshold.ts`、`session-settings.ts`、
`session-lineage.ts`、`file-ops.ts`、`state.ts`、`shared/llm.ts`、`shared/lock.ts`、`memory/*`、纯函数层）。
本文把**全部 58 个 `.ts` 模块（7,772 行）**逐个过一遍，判据仍是主审计的三条，并沿用「机制必须能追溯到现场事实」。

## 0. 先更正补审一的一处误判（重要）

> **D1【已更正】「`maybeTrigger` 与 `runHandoff` 无测试」是错的。**

`tests/handoff-test.mjs` 第 10 行的自述即「the `runHandoff` call sites are pinned through a stubbed summarizer plus a
`newSession` mock (review round 5, F3/F5)」。实测覆盖：

| 行为 | 测试位置 |
| --- | --- |
| `maybeTrigger` 触发并发出 `/handoff force-auto` | `runHandlers(auto,"agent_settled")` → 断言 `auto.sentMessages`（:368-370） |
| 触发不叠加（冷却） | 负断言 `auto.sentMessages.length === 1`（:377） |
| `runHandoff` 跳过路径 | 空会话 / keep 窗口内（:321-345） |
| `runHandoff` 成功路径 | `captureNewSession`（:750、:803） |
| `runHandoff` cancel / throw | `:1021`、`:1032` |
| 阈值数学与拒绝文案 | `resolveThreshold` ×11、`thresholdRefusal` ×4、`statusText` ×2 |

误判来源：把「这两个函数**没有直接导出**给测试」读成了「没有被测试」。补审一 §1 表 P7 与 §2.4 已就地更正；
项目记忆里同一条错误结论一并更正（§4）。**这是本次审计最该记住的一条：残留项也会被抄进记忆，审查残留本身要复核。**

## 1. 方法（四探针 + 逐文件读「存在理由」）

| 探针 | 做法 | 用途 |
| --- | --- | --- |
| P1 | 解析 `from "./x.ts"` 建引用图；统计导出符号在全仓（含 tests）的出现次数 | 死模块 / 死导出 |
| P2 | 抽出代码里 `logError(...)` 的第二参数，与真机 7 个 `errors.log`、1,563 行的 `[域]` 键对照 | 机制是否真在跑 |
| P3 | 真机 9 份 `project-context.json` 逐键与 `DEFAULT_CONFIG` 比对 | 旋钮是否被用过 |
| P4 | 按测试实际 `loadNamespace` 的模块建覆盖表（测试走 barrel，按文件名查会低估） | 测试面 |

## 2. 发现

### D2【死代码】`memory/journal.ts::newestMemoryArchiveSync` 无调用者

`P1`：该符号在全仓出现次数 = 1（只有定义本身）。它的 JSDoc 写着「for prompt assembly (`loadMemorySync`)」，
而 `loadMemorySync` 已不存在（grep 全仓 0 处）。**8 行死代码，可删。**

### D3【残留】`handoff/session-settings.ts` 的三个 `logError` 键真机 0 命中

`[memory]` 369 次、`[autolearn]` 55 次、`[session-log]`/`[session-index]` 各 1 次，而
`handoff:stage-session-settings`、`handoff:restore-model`、`handoff:restore-thinking` **各 0 次**；
真机也从未出现过 `handoff-session-settings.json`（TTL 10 分钟 + 消费即删，0 是预期的）。

文件本身有硬依据（`ctx.newSession()` 没有 model/thinking 选项，头注写明），但其中
`HANDOFF_SETTINGS_FOREIGN_GRACE_MS`（2 分钟宽限）+ `foreignStageReported`（每进程一次的告警去重）是为
**两个交接同时在飞**的竞态加的分支——注释自述这是推理出的竞态（「clearing it there silently denied the other
handoff its model and thinking level」），不是现场事故。按判据 1 记**残留**：约 15 行，无现场证据，不建议再扩。

### D4【持续成本】`migrateProjectState` 每次 `session_start` 都跑

`memory/report.ts:319` 在 `session_start` 里**无条件**调用它（只在有迁移时才 notify）。本机 9/9 项目都没有旧布局
（无 `.pi/`、无 `memory/skills`），`[migration]` 键 0 命中 ⇒ 每个会话都付一次目录扫描，换来 0 次收益。
它是**面向外部安装的兼容**（公开发布品），所以结论与补审一 §2.2 相同：保留但定退役窗口，别再往这层加东西。

### D5【测试面】`handoff/handoff.ts` 是 17 行的测试专用 barrel

`P1`：无任何运行时代码 import 它；唯一消费者是 `tests/handoff-test.mjs`。运行时入口 `index.ts` 直接 import `run.ts`。
成本极低（仅 re-export），保留有意义（它把「测试面」和「实现面」分开），但要知道**它不是运行时路径**。

### D6【现场】journal 轮转未发生、备份/日志轮转已发生

| 机制 | 阈值 | 真机现场 |
| --- | --- | --- |
| `journal` 轮转归档 | 512 KB / 保留 5 | **0 次**（最大 `memory.jsonl` = 373 KB） |
| `backup` 写入前备份 + 剪枝 | 保留 5 / 最少 20 / 1 小时 | **43 份** `*.memory-backup-*` |
| `errors.log` 轮转 | 1 MB / 留 64 K | **2 份** `errors.log.*`（合并日志 1,563 行） |
| D2 溢出副本 | 溢出时才写 | 0 份（v0.2.1 尚未在任何进程加载，0 是预期的） |

结论：轮转/备份/日志三条都有现场或预期解释 ✓；journal 轮转是防文件无界增长的预防性机制（有单测），
**无现场**但成本是一次大小比较，保留。

### D7【已更正】陈旧锁确实存在，但**不能**归属给 `lock.ts`

> **2026-10-06 补记（第二族锁名）**：`.agents/memory/` 下另有 `.memory.lock` / `.index.lock` / `.migration.lock`
> 一族。`grep` 本仓 TS 与 pi dist 均 **0 命中**，而 **Codex 移植**（`codex-project-context`）三处各命中 1 个文件
> ⇒ 与第一族（`session-logs/s-*/​.lock`）同源，仍不是本扩展的产物。锁卫生项至此**两类锁都已归属并关闭**。

> **更正（2026-10-04，补审三 §2 归属核查）**：本节原文把 CipherCat 那 22 个 0 字节 `.lock` 当作
> `lock.ts` 陈旧窃取路径的现场依据，**是错的**。核查：`lock.ts` 的锁路径是 `${target}.lock`，当前全部
> 调用点只锁 `memory/session-index.lock`、`MEMORY.md.lock`、`project-context.json.lock`；
> `git log --all -p -- extensions/project-context/` 全历史里 `withMemoryLock(...)` 只出现过
> `sessionIndexLockTarget(projectRoot)` 一种参数 ⇒ **本仓从未锁过会话目录**；兄弟移植不是「不产生锁文件」（见下）
> ——本节的归属判定当时只做了“排除”，未做“坐实”，而排除的一半是错的。

事实部分保留：CipherCat 的 `.agents/memory/session-logs/*/` 下确有 **22 个 0 字节 `.lock`**
（2026-09-15 ~ 2026-10-02），**无人回收**（卫生问题）。它可以作为「锁文件会孤儿化」的一般现象，
但**不能**作为本扩展的现场依据；`lock.ts` 的存在理由回到它自己的代码依据（陈旧窃取 + inode 绑定 + 持有者自删），
**不再声称有现场证据**。

> **归属已坐实 + 已清理（2026-10-04）**：这些锁是 **Codex 移植**的
> `contextctl.py:317` `file_lock()` 用 `O_CREAT` 打开 `session_dir / ".lock"`（`:987` / `:1300` / `:1476`）
> 后 flock、从不 unlink 留下的 0 字节文件；目录命名 `s-{urlsafe_b64(session_id)}`（`:105-106`）与现场一致。
> 现场实测共 **19 个**（CipherCat 15 / codex-project-context 3 / 本仓 1，原文「CipherCat 22 个」数字不准），
> 已按 owner 指令核验（未跟踪、无进程持有、0 字节且超 1 小时）后全部删除。
> 详见 `2026-10-04-design-complexity-audit-addendum-3-autolearn-archive.md` §2。

### D8【已核非复杂度】`maybeTrigger` → `/handoff force-auto` 的消息往返是 API 约束

`run.ts` 用 `pi.sendUserMessage("/handoff force-auto")` 而不是直接调用，是因为 `newSession()` 只能从
`ExtensionCommandContext` 取得，而 `agent_settled` 事件只给 `ExtensionContext`。这是**约束**，不是冗余分支；
代价是阈值在 `maybeTrigger` 与 `runHandoff` 各算一次（函数纯、无副作用，可接受）。

## 3. 逐模块结论（58 个 / 7,772 行）

判定口径：**有据** = 注释/文档能指到现场事实、API 约束或既有 owner 决策；**残留** = 追不到现场事实但不建议扩；
**死** = 无调用者。

| 目录 | 模块（行） | 依据 | 判定 |
| --- | --- | --- | --- |
| 入口 | `index.ts` (237) | 只做注册（3 个注册点 + 路由到各子系统） | 有据 |
| handoff | `run.ts` (538) | 现场栈（`run.ts:262`）+ 5 条路径有测试 | 有据 |
| handoff | `threshold.ts` (278) | **2026-09-19 issue**：owner 决策「保守曲线 A」`knee(W)=W−(W−157K)·σ(ln(W/450K)/0.04)` | 有据（决策） |
| handoff | `prompt.ts` (199) | 补审一 §3.1：与 pi 真模板 9 行完全对齐 | 有据 |
| handoff | `session-settings.ts` (163) | `newSession()` 无 model/thinking 选项；竞态分支见 D3 | 有据 + **残留** |
| handoff | `language.ts` (125) | 交接语言采样（`resolveLanguage` ×13 断言） | 有据 |
| handoff | `text.ts` (109) | replay 首条必须是 user（Anthropic/Gemini 拒），orphan 工具结果折进摘要 | 有据（现场） |
| handoff | `settings.ts` (107) | `Object.assign` 原地采纳有实测注记（模块互操作） | 有据（实测） |
| handoff | `summary.ts` (72) | 仅对 token-cap 截断重试（与 D2 同源），thinking 默认 off | 有据 |
| handoff | `file-ops.ts` (67) | **parity**：镜像 pi 自己的 compaction 文件索引（`fromHook` 去重） | 有据（对齐） |
| handoff | `session-lineage.ts` (65) | **50/59、87/90、123/126** 会话带 `parentSession`；注释记真实事故「截断读丢整条祖先链」 | 有据（现场） |
| handoff | `state.ts` (50) | 失败退避 5 分钟有现场栈；30 秒冷却防每次 settle 重触发 | 有据（现场） |
| handoff | `question.ts` (37) | 交接不得替用户回答问题（guard 默认 `wait` = 生效中） | 有据（设计目标） |
| handoff | `handoff.ts` (17) | 测试专用 barrel（D5） | 有据（低价值） |
| memory | `report.ts` (458) | 现场：216 次外部编辑采纳、36 次无 context、8 次 cap 丢尾、7 次不可解析 | 有据（现场） |
| memory | `sections.ts` (385) | 注释自述「整篇 60/40 裁剪砍掉中段 = 本项目耐久教训所在」；现场「middle dropped」2 条 | 有据（现场） |
| memory | `pass.ts` (346) | 现场：regression 守卫 3+2 条、condense 重试、单飞节流 | 有据（现场） |
| memory | `journal.ts` (218) | 追加型真相源 + 轮转（D6：现场 0 次，预防性）；**`newestMemoryArchiveSync` 死** | 有据 + **死** |
| memory | `poison.ts` (158) | 注释自述旧版本把不可解析回复写进 `MEMORY.md`；现场 7 条 | 有据（现场） |
| memory | `document.ts` (149) | 截断标记「自我说明」（8 条 cap 丢尾、2 条两端保留） | 有据（现场） |
| memory | `context-schema.ts` (119) | prompt 与 renderer 共用一张表（防漂移） | 有据 |
| memory | `input.ts` (107) | 现场：`cut off by the model output limit` 1 条 | 有据（现场） |
| memory | `context-doc.ts` (94) | CONTEXT.md 渲染（section 预算见现场 1 条 clipped） | 有据 |
| memory | `parse.ts` (83) | 容忍式解析 + 逐字段裁决 | 有据 |
| memory | `backup.ts` (82) | 现场 43 份备份；剪枝保留 5 / 上限 20 / 1 小时 | 有据（现场） |
| memory | `prompt.ts` (63) | 固定规则 + 装入文档 + 真实字符上限 | 有据 |
| memory | `schema.ts` (46) | 同 `context-schema.ts` | 有据 |
| memory | `store.ts` (204) | 已过两轮独立代码评审（含四向变异矩阵） | 有据（评审） |
| memory | `migrate.ts`→`shared/` | 见 D4 | **可退役窗口** |
| shared | `llm.ts` (275) | 失败契约（provider 失败抛错）+ tools 粘性降级，`callAux` 有专项测试 | 有据 |
| shared | `lock.ts` (209) | ~~**现场**：22 个陈旧 `.lock`（D7）~~ **已更正**：那些锁属 Codex 移植（补审三 §2）⇒ 依据是**代码级**（陈旧窃取 + inode 绑定 + 持有者自删）+ write-lock-hardening skill | 有据（代码级；现场依据已撤回） |
| shared | `config.ts` (302) | 补审一 §2.1/§2.2：旋钮面与 legacy 链 | 有据 + **可退役** |
| shared | `files.ts` (147) | 原子写 / 合并回滚 / 临时物清理（`errors.log` 里无残留 tmp） | 有据 |
| shared | `error-log.ts` (116) | 现场 1,563 行日志 + 2 次轮转；去重窗口 10 分钟 | 有据（现场） |
| shared | `call-policy.ts` (114) | **注释自述现场事故**：坏路由每次 settle 重试+上报 ⇒ 故障风暴；errors.log 里 model call error 大量佐证 | 有据（现场） |
| shared | `paths.ts` (97) | 路径单点 + 两个名校验 | 有据 |
| shared | `output-budget.ts` (90) | 现场：`cut off by the model output limit`；reasoning 与正文共享输出上限 | 有据（现场） |
| shared | `text.ts` (81) | 稠密脚本（CJK）token 率 + 代理对安全裁剪 | 有据 |
| shared | `complete.ts` (52) | pi 的补全协议（固定动词、前缀过滤） | 有据（API） |
| shared | `limits.ts` (24) | 字符预算表；`MIN/MAX_MEMORY_CHARS` 与现场 `maxMemoryChars=36000` 一致 | 有据 |
| shared | `migrate.ts` (140) | 有 3 个测试覆盖；D4 的成本问题 | **可退役窗口** |
| shared | `conversation.ts` (24)、`gitignore.ts` (36)、`notify.ts` (19)、`redact.ts` (14)、`project-state.ts` (19)、`error-log`… | 单点小工具（gitignore 现场：UF 有 `.agents/memory/.gitignore`） | 有据 |
| autolearn | `pass.ts`(251)、`candidate.ts`(116)、`evidence.ts`(100)、`prompt.ts`(68)、`schema.ts`(60)、`skill.ts`(54)、`parse.ts`(47)、`inventory.ts`(33) | 现场 55 条 `[autolearn]`（全为路由/额度错误，非机制错误）；有 issue `2026-10-01-structured-consolidation-output` | **未逐行审（见 §5）** |
| archive | `session-log.ts`(257)、`archive.ts`(180)、`import-archive.ts`(128)、`session-index.ts`(122) | 现场各 1 条；有 issue `2026-09-30-session-log-append-duplication`、`2026-10-01-session-log-durability` | **未逐行审（见 §5）** |

## 4. 有据清单的用法（负结果同样是结论）

本轮 58 个模块里，**没有一个 `logError` 域键是「写了但机制根本不存在」的**：`[memory]`/`[autolearn]` 是现场主力，
`[session-log]`/`[session-index]` 各 1 条，零命中的三个（`handoff:stage-session-settings`、`handoff:restore-model`、
`handoff:restore-thinking`）都对应**防御性降级路径**（见 D3），不是死机制。

需要一并更正的两处项目记忆（`.agents/memory/MEMORY.md`）：
1. 「maybeTrigger and runHandoff are untested…」→ 错，见 D1；
2. 「Testing them needs a fake ExtensionContext and is an accepted residual」→ 错，该 fake 已在 `tests/harness.mjs`
   （`makeCtx`/`makePi`/`makeSessionManager`）里存在并被使用。

## 5. 未查完（第三轮，诚实声明）

| 范围 | 行数 | 说明 |
| --- | --- | --- |
| `autolearn/*`（8 文件） | 729 | 不在主审计 §6 清单内；现场 55 条全是路由/额度类错误，机制本身未见异常；有独立 issue 文档 |
| `archive/*`（4 文件） | 687 | 同上；有 `2026-09-30`/`2026-10-01` 两份 issue 文档，且 `session-log` 归档修复维护过 |

两者合计 1,416 行，占全仓 18%。要收口就再开一轮，判据同本文。

## 6. 规模账

- 全程审计（补审一 + 补审二）覆盖 **58/58 模块**：其中 44 个逐文件读过「存在理由 + 常量 + 导出」，
  14 个（`threshold.ts`、`session-settings.ts`、`session-lineage.ts`、`state.ts`、`question.ts`、`file-ops.ts`、
  `handoff.ts`、`handoff/text.ts`、`shared/llm.ts`、`shared/lock.ts`、`shared/files.ts`、`shared/error-log.ts`、
  `shared/call-policy.ts`、`shared/output-budget.ts`）**逐行读过**。
- 净发现：**2 条可删/可退役**（D2 死导出 8 行；D4 legacy 迁移每会话成本）、**2 条残留**（D3 竞态分支；journal 轮转无现场）、
  **1 条卫生问题**（陈旧 `.lock` 无人回收 —— 实测 19 个、归属 Codex 移植、已于 2026-10-04 清扫）、**1 条误判更正**（D1）。
- 没有发现新的「机制已死」模块：56/58 有内部引用，唯一两个无引用的是入口 `index.ts` 与测试 barrel `handoff.ts`。
