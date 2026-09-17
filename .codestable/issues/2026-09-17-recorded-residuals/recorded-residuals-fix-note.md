---
doc_type: issue-fix
issue: 2026-09-17-recorded-residuals
status: confirmed
path: quick
fix_date: 2026-09-17
related: [recorded-residuals-report.md, recorded-residuals-analysis.md, recorded-residuals-review.md]
tags: [residuals, gitignore, handoff, context, status]
---

# 记录在案残余收口 修复记录

触发：owner「不是还有个残余项没修复吗？」→ 盘出 4 条记录在案、此前「接受/可选」未修项 → owner「all」要求全部修掉，
并查清 CONTEXT.md 停更原因。**本次改动含代码、测试与全部 artifact，尚未提交/推送**（等 owner 决定）。

## 1. 残余 1：gitignore header 大小写（`project-state.ts`）

- 改动：header 判定改为大小写不敏感（`[...lines].some((line) => line.toLowerCase() === MEMORY_GITIGNORE_HEADER.toLowerCase())`），
  忽略模式集本身仍保持大小写敏感（git 语义）。
- 探针（`tests/consolidation-test.mjs`）：预置 `# PROJECT-CONTEXT: LOCAL ARTIFACTS, DO NOT COMMIT` + `memory.jsonl` → 追加后仍只有那一条 header、
  原行保留、缺失行补齐、不出现小写标准 header。
- 变异：退回 `lines.has(...)` → 只有该探针变红。

## 2. 残余 2：会话头固定 64KB（`handoff.ts::readSessionHeader`）

- 改动：按 64KB chunk 读到第一个换行（先合并 Buffer 再解码，避免多字节字符被 chunk 边界切断）；上限约束**行长**：首行恰好 1MB 仍读入，
  超出即视为不可读（fail-open 回旧行为，第 1 轮复审的 off-by-one minor 已在此收口）；无换行的单行文件仍按已读内容解析。读取仍是「首行 + 提前退出」，不整文件读入。
- 探针（`tests/handoff-test.mjs`）：80KB 首行的祖先仍被解析为根（旧代码此处退化为「挂当前会话」）；首行恰好 1MB 可读；1.1MB 首行按病态上限回退为自身。
- 变异：把解码截断回 64KB → oversized 探针红；把 `>` 改回 `>=` → 「exactly at the cap」探针红。

## 3. 残余 3：staging 与切换之间崩溃的 marker（`handoff.ts::restoreHandoffSessionSettings`）

- 改动：`reason === "new"` 且前驱不匹配时，直接清掉 marker（旧代码留到 TTL）。只有那一个前驱的继任者能消费 marker，
  因此前驱不匹配 ⇒ 这次切换没发生（崩溃/取消/其它新会话），留着没有任何用途。
- 探针：`a foreign switch drops the stage instead of keeping it`（原断言是「留着等 TTL」，随语义变更改写）。
- 变异：把清理去掉 → 只有该探针变红。
- **语义变更（记录）**：此前「前驱不匹配的 marker 存留至 TTL 或下一个匹配继任者」→ 现在「前驱不匹配即清」。

## 4. 残余 4：`/project-context status` 缺记忆状态（`index.ts`）

- 改动：新增两行 —— `Memory: <source> (<n> chars)`（按 `unreadable`/`poisoned`/`damaged` 给可诊断文案）与
  `Context: <path> — updated <ISO> (<age> ago)`（无 CONTEXT.md 时为 `none yet`）。`loadMemory()` 是纯读路径，无写副作用。
- 探针：`tests/switches-test.mjs` 在一次真实 consolidation 之后断言两行；`tests/consolidation-test.mjs` 的 shape 段再断言一次（含 stale context 场景）。
- 变异：删掉这两行 → 4 条断言变红（两个测试各有 2 条）。

## 5. CONTEXT.md 停更：prompt 未给 context 的键名（`consolidate.ts`）

- 根因：`parseContext` 要求对象且含字符串 `summary`，而 prompt 只用自然语言描述 context，**从未写出键名与类型**；
  辅助模型 = 会话模型（`provider`/`model` 为空），换模型后回答形状变化（例如 Markdown 字符串、`keyPoints`）即被静默丢弃，
  既有 `CONTEXT.md` 保持不动，`errors.log` 无痕。本仓实测：MEMORY.md 09-17 22:12 更新，CONTEXT.md 停在 09-16 13:18。
- 改动三件：(i) prompt 明确写出 `context` 的键与类型并说明非该形状会被丢弃（措辞已与解析器对齐：`summary` 必需、列表缺省视为空、present-but-非数组整份丢弃）；
  (ii) `parseConsolidated` 增加 `contextUnusable` 标记（键缺失或 `null` 视为「无 context」，不算不可用；present-but-非数组的 `key_points`/`open_tasks` 算不可用）；
  (iii) 调用侧在 `contextUnusable` 时向 `errors.log` 记一次（每项目每进程最多一次，文案按有无既有 CONTEXT.md 区分）。未改写入语义：模型没给 context 时仍不覆盖既有 `CONTEXT.md`。
- 探针：`parseConsolidated` 的形状边界（字符串 context 标记 / 缺失与 `null` 不标记）；端到端段（`forceDedupeMs: 0` 强制跑两遍）断言
  「既有渲染不动 + errors.log 有记录 + 只记一次 + prompt 里出现 `key_points`/`open_tasks`/`memory_markdown` + status 两行」。
- 变异：去掉标记 → 3 条红；去掉「每进程一次」→ 1 条红；去掉 prompt 键名 → 1 条红。

## 6. 测试与变异矩阵（本轮）

| 变异 | 结果（红） |
|---|---|
| M1 退回大小写敏感 header | `a differently cased header is not repeated` 1 条 |
| M2 解码截断回 64KB | `oversized session header still resolves to its root` 1 条 |
| M3 前驱不匹配不清 marker | `a foreign switch drops the stage instead of keeping it` 1 条 |
| M4 去掉 `contextUnusable` 标记 | 形状边界 + errors.log + 只记一次 共 3 条 |
| M5 去掉「每进程一次」 | `the shape note is reported once per process` 1 条 |
| M6 删掉 status 两行 | status 2 条 ×2 个测试 |
| M7 prompt 去掉键名 | `the prompt names the context keys` 1 条 |
| M8 cap 边界退回 `>=`（第 1 轮 minor ①） | `a header exactly at the cap is still read` 1 条 |
| M9 去掉错类型列表守卫（第 1 轮 minor ②） | `a wrong-typed context list is flagged` 1 条 |
| M10 errors.log 文案退回恒写（第 1 轮 minor ③） | `without a previous render the placeholder is written` 1 条 |

- 全量：`node tests/run-all.mjs` **9/9 通过**（变异还原后复跑一次确认）。

## 7. 顺带清理（owner「all」含 /tmp）

- 本项目 `/tmp` 残留：上一轮已清零（658 项 / 1.6G），本轮复查仍为 **0**。
- 其它项目的陈旧临时产物：删 **3303 项 / 2.9G**（`/tmp` 3.2G → 334M），规则「仅删 mtime > 48h 的临时产物」，
  清单见 `recorded-residuals-cleanup-manifest.txt`（>1MB 条目逐个列出）。
  代表性大件：`ciphercat-readonly-cargo` 1.1G（cargo target）、`ciphercat-independent-review` 626M 与 `ciphercat-acceptance-20260912` 617M
  （已核对为**比 CipherCat 仓库更旧**的快照：仓库 mtime 09-13、快照 09-12，且仓库多出条目）、`pi-browser-chromium-*` 93M/45M/3M（调试 profile）、
  `ccsw` 77M 与 `academic-research-skills-audit-20260914` 58M 与 `cs-v2` 12M（干净 git 克隆）、`node-compile-cache` 43M、`jiti` 缓存、`.org.chromium.*`。
- 明确保留：`/tmp/uf-ckpt.tgz` 67M（UniField 训练 checkpoint `best.pt`，**不可重算**的成果，建议 owner 自行归档）、48h 内的条目（1019 项，可能在用）、
  系统/root 属主条目（`systemd-private-*`、`sddm-*`、`.ICE-unix`、root 属主的 `node-compile-cache` 分片）。

## 8. 独立复审

见 `recorded-residuals-review.md`（lane A 两轮，只读沙箱 `/tmp/residuals-review` 与 `/tmp/residuals-review2`，两轮 `git status` 前后逐字一致 + 变异文件 md5 与仓库一致）。

- 第 1 轮（完整 diff）：**无 blocking、无 important**，minor ×5 → ①②③ 本轮修、④ 记录、⑤ 确认是沙箱排除 `session-logs` 造成的假象。
- 第 2 轮（closure）：**无 blocking、无 important**，minor ×2（M1 prompt 措辞对称性、M2 混合数组逐项丢弃）+ 一条范围提示（那三处正是残余 1/3/4 的修复本身）。M1 复审后按建议对齐了措辞（纯文案，未再跑第三轮，owner 可定）；M2 接受。

## 9. 发布状态

- 待定：本轮是 4 条残余 + 1 条静默缺陷（CONTEXT.md 停更）的修复，其中残余 2/3 有真实行为变化（会话树扁平化对超大头的处理、marker 清理时机）、
  残余 4 新增命令输出，属「实质改动」→ 建议随 `v0.1.7` 发布（`v0.1.6` 已装副本不受影响）。
- owner 发话后：跑发布序（双远端 push → 注解 tag → 切 pin → `pi update --extensions` → 已装副本真机探针 → 发布记录）。

## 10. 文档一致性（复审 minor #4 / M1）

- `README.md`：`status` 那句补上了记忆来源与 `CONTEXT.md` 更新时间。
- `.codestable/issues/2026-09-17-handoff-session-continuity/…-fix-note.md`：新增 §9，逐条指向本轮的收口（F5 / staging 残留 / 大小写 header）。
- `.codestable/issues/2026-09-15-consolidated-memory-json-poison/…-fix-note.md`：§5「自愈可见性」由「部分解决」改为「已解决」并指向本轮。
- `.agents/memory/MEMORY.md`：工作树版本里仍写「read ≤64KB」「header 大小写敏感」「残余未修」等旧描述；它由扩展自己的 consolidation 重写（本轮不动，
  下一次 pass 会基于本会话内容折叠更新）。
- `prompt` 措辞与 `parseContext` 的严格度已对齐（见 review.md「复审后的唯一改动」）。

## 11. 接受残余（本轮之后）

- 会话头首行 >1MB 仍 fail-open 回旧行为（病态输入；无换行的单行文件正常解析）。
- `context` 无 schema 强制：present-but-非数组的列表已会让整份 context 被丢弃并记录，但混合数组（如 `["a",123]`）仍逐项丢弃非字符串元素（与既有 `trimLine` 规整一致）。
