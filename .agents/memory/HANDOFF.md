# pi 会话 01a0f2ba-f08a-75f6-9452-fabd2ee7aa17 的交接文档

- 生成时间：2026-10-01T00:34:13.282Z
- 项目：/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context
- 会话日志：.agents/memory/session-logs/01a0f2ba-f08a-75f6-9452-fabd2ee7aa17/session.md
- 会话索引：.agents/memory/session-logs/INDEX.md

## 目标
- 恢复 pi-project-context 项目上下文，检查 `.agents/memory/session-logs/` 会话归档是否有缺漏，继续未完成的施工链条。
- 修复会话归档 `session.jsonl` 的相邻重复条目缺陷。
- 落地 S1+S3（记忆固定 schema + 指针化），走三审三校独立评审。
- （最新）重新确认扩展中**其他部分**的 schema。

## 约束与偏好
- 用简体中文回复；commit 用英文 Conventional Commits（`type(scope): imperative summary`）；文档与面向用户写作用简体中文。
- 方案 (b)：**不配置** `provider`/`model`（不做 A1），保留“连续失败自动停用本次会话”兜底。
- 改动必须附各自测试；记忆/压缩协议边界（M2/M5、S1/S3）须走 `.agents/skills/pi-project-context-sandboxed-independent-review` 独立只读评审，**三审三校共 6 轮**。
- 评审须用真实 headless pi、字节级 `/tmp` 沙箱、before/after `git status` + `stat` 快照证明零写入；命令 `pi -p --no-session --no-extensions --no-skills --no-prompt-templates --tools read,bash "$(cat <prompt>)"`。
- 除运行中代码外不允许 patch/hook；S 层须**向后兼容**已有自由结构（不得重排/丢事实）。
- 项目根：`/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context`。

## 进展
### 已完成
- [x] 核对交接：`eef592c` 已推送、session-log round1–3 已归档、注释搬迁已提交；提交扩展刷新的记忆产物 `3980099`（`CONTEXT.md` 补回丢失的 context 段）并推送。
- [x] session-log 修复（早前 3 轮评审：CHANGES→CHANGES→PASSED）已推送 `eef592c`。
- [x] **S1/S3 落地**（`a3f8370`…`0b81099`）：
  - 新增 `extensions/project-context/memory/schema.ts`：`MEMORY_SECTIONS`（`Project 20% / Invariants 40% / Pitfalls 25% / Index 15%`，各带 `description`）、`memorySchemaOverheadChars()`（= 76：`MEMORY_HEADER` + 各 `## 标题\n\n` + `MEMORY_SECTION_GAP_CHARS=2`）、`memorySectionBudgets(cap)`（先扣开销再按份额 floor）。
  - `memory/prompt.ts`：`budget` 改为必填；注入 4 节 + 每节预算 + 指针规则（一行事实 + `docs/<topic>.md`/`file.ts:123`，只指已存在且确实承载细节的路径，不虚构；无归属细节一行内联）。
  - `memory/document.ts`：导出 `MEMORY_HEADER` 供复用（`exceedsMemoryCap`、`normalizeMemoryDocument` 未改）；`memory/pass.ts:133` 措辞改为 “fit at or under”。
  - 测试 `tests/memory-budget-test.mjs`：12 条新断言（含构造满预算文档不超 cap、开销恰为 76、预算随 cap 缩放、指针规则三子句）。
  - 文档：`docs/architecture.md` 加 `schema.ts`；`docs/configuration.md` 更新 memory cap 段。设计：`.codestable/issues/2026-09-30-auxiliary-call-noise-and-memory-cap/auxiliary-call-noise-and-memory-cap-s1-s3-design.md`（`status: implemented-pending-owner-review`）。
- [x] S1/S3 **6 轮独立评审**：round1 CHANGES、round2 CHANGES、round3 PASSED、round4 REVIEW-SOUND、round5 CHANGES、round6 REVIEW-SOUND；12 份 transcript 存 issue 目录 `…-s1-s3-review-round{1..6}-*`。
- [x] `node tests/run-all.mjs` **12/12**（多次）；变异矩阵（去 schema 块/补偿份额/ceil/+1/乱序/开销归零或低估/cap 硬编码/描述增删/指针三子句）全部被杀死。
- [x] 推送两远端：`master = 0b81099`（`f34c4a9`→`c23cf5f`→`7fa5e3a`→`cfa4b6f`→`7ed538f`→`f81531f`→`cc625c9`→`a3f8370`）。

### 进行中
- [ ] 用户要求“其他部分的 schema 也再重新确认”。已读：`memory/context-doc.ts`、`memory/parse.ts`、`autolearn/parse.ts`、`autolearn/candidate.ts`、`autolearn/skill.ts`、`handoff/prompt.ts`。**待读**：`handoff/summary.ts`、`archive/session-index.ts`、`shared/config.ts` 等，然后逐个报告并修正不一致。

### 受阻
- （无严重阻塞）GitHub mirror 分歧已用 merge `42f0956` 化解。

## 关键决策
- **追加偏移用归档自身字节数** `cursor.dest.size`（杜绝 stat 陈旧导致重叠追加）；同会话进程内串行化 `rawFlights`（按 `projectRoot\0sessionId`）。
- **用 merge 而非 rebase** 解决 mirror 分歧（避免重写已 push 的 SHA）。
- **S1/S3 采用 schema C + 软强制 fail-open + 份额 20/40/25/15**；不改剪裁（沿用 M3 头尾），S4（按节优先序丢）与符合度可见性**明确出范围**；机制与常量解耦（改选只动 `schema.ts` 常量与 prompt 文案）。
- **失败关闭先例仅用于 context**（短状态可重建）；记忆是长期事实，故 fail-open。

## 后续步骤
1. 读完 `handoff/summary.ts`、`archive/session-index.ts`、`shared/config.ts` 等，产出“其他 schema 复核报告”（字段、校验位置、cap）。
2. 若发现不一致：修复并补测试；触及协议边界则走独立评审。
3. 等 owner 复核 S1/S3 三项默认（schema 形态 C / 软强制 / 份额）。
4. 发布：打包/打 tag/重装并重启 pi（现 PID 262684/263321/324402 仍跑 v0.1.11+ clone）。
5. 活项目 ops（UniField/Quantum_Matrix）需 owner 确认。

## 关键上下文
- 当前会话 id `01a0f260-f2d6-75f6-9452-faae0134cf0d`；原始 JSONL：`/home/user/.pi/agent/sessions/--run-media-user-6b058d20-a617-484d-b7c6-cd7146baf77c-Projects-pi-project-context--/2026-09-30T12-53-55-031Z_01a0f260-f2d6-75f6-9452-faae0134cf0d.jsonl`。
- Remotes：fetch `ssh://forgejo@git.lentech.site/C02-1010751281/pi-project-context.git`；push 再加 `ssh://git@ssh.github.com:443/P02-1010751281/pi-project-context.git`。最新 tag `v0.1.11`@`5ffec44`。
- 已确认 schema（本会话读到的）：
  - `MEMORY.md`：`# Project Memory` + 固定 4 节（`schema.ts`）。
  - `CONTEXT.md`（`context-doc.ts`）：`# Project Context` / `Last updated:` / `## Summary` / `## Key points` / `## Open tasks` / `<!-- latest-session-title: … -->`；caps `MAX_CONTEXT_CHARS`、`MAX_SUMMARY_CHARS`、`MAX_LIST_ITEM_CHARS`、`MAX_LIST_ENTRIES=50`；`parse.ts` 的 `ContextUpdate{title,summary,key_points,open_tasks}` 对错类型 list **fail-closed**。
  - autolearn（`autolearn/parse.ts`）：`Decision{skill:{name,description,body,evidence[],candidate,reason}|null, inspect[]}`；`candidate.ts` 的 `shapeRejection(description, body)` 共用同一套规则；`skill.ts`：`MIN_SKILL_BODY_CHARS=160`、`MAX_SKILL_DESCRIPTION_CHARS=1024`、`UNSAFE_SKILL_PATTERNS`。
  - handoff（`handoff/prompt.ts`）：`SUMMARY_HEADINGS`（zh/en 固定小节映射）。
- 测试命令：`node tests/run-all.mjs`（12/12）、`node tests/memory-budget-test.mjs`。已知偶发：handoff `ENOTEMPTY` 抖动。
- 评审沙箱/基线：`/tmp/pi-context-rev16…rev21`，`/tmp/rev{16..21}-baseline-{status,files}.txt`；输出 `/tmp/rev{n}-round{m}-out.txt`。
- 关键源文件：`memory/{schema.ts,prompt.ts,document.ts,pass.ts,parse.ts,context-doc.ts}`；`archive/{archive.ts,session-log.ts,session-index.ts}`；`tests/sync-test.mjs`。
- 历史数据：`session-logs/` 既有重复条目未回改（本地 `.gitignore` 忽略）；修复需重装发布才生效。

<read-files>
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.codestable/issues/2026-09-30-auxiliary-call-noise-and-memory-cap/auxiliary-call-noise-and-memory-cap-analysis.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/autolearn/candidate.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/autolearn/parse.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/autolearn/skill.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/handoff/prompt.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/memory/context-doc.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/memory/input.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/memory/parse.ts
/tmp/rev16-round1-out.txt
/tmp/rev17-round2-out.txt
/tmp/rev18-round3-out.txt
/tmp/rev19-round4-out.txt
/tmp/rev20-round5-out.txt
/tmp/rev21-round6-out.txt
</read-files>

<modified-files>
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.codestable/issues/2026-09-30-auxiliary-call-noise-and-memory-cap/auxiliary-call-noise-and-memory-cap-fix-note.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.codestable/issues/2026-09-30-auxiliary-call-noise-and-memory-cap/auxiliary-call-noise-and-memory-cap-s1-s3-design.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.codestable/issues/2026-09-30-session-log-append-duplication/session-log-append-duplication-fix-note.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/docs/architecture.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/docs/configuration.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/archive/session-log.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/memory/document.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/memory/pass.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/memory/prompt.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/memory/schema.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/tests/memory-budget-test.mjs
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/tests/sync-test.mjs
/tmp/rev15-round3-prompt.txt
/tmp/rev16-round1-prompt.txt
/tmp/rev17-round2-prompt.txt
/tmp/rev18-round3-prompt.txt
/tmp/rev19-round4-prompt.txt
/tmp/rev20-round5-prompt.txt
/tmp/rev21-round6-prompt.txt
</modified-files>
