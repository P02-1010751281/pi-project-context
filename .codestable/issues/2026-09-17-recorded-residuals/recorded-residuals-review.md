---
doc_type: issue-review
issue: 2026-09-17-recorded-residuals
status: confirmed
path: quick
created_at: 2026-09-17
rounds: 2
related: [recorded-residuals-report.md, recorded-residuals-analysis.md, recorded-residuals-fix-note.md]
tags: [residuals, gitignore, handoff, context, status]
---

# 记录在案残余收口 修复 Review

## 审查方式

- lane A：独立 `pi -p --no-session --no-extensions --no-skills --no-prompt-templates --tools read,bash --provider deepseek --model deepseek-v4-pro --thinking off`，
  在 `/tmp` 只读沙箱副本上运行（含 `.git`），零写入校验：进入/退出 `git status --porcelain` 逐字比对 + 变异文件 md5 与仓库一致。
- 第 1 轮：完整 diff 的独立审查（沙箱 `/tmp/residuals-review`，`git status` 13 行 → 13 行无差异；复审自做 5 处变异-还原，
  `project-state.ts`/`handoff.ts`/`consolidate.ts`/`index.ts` md5 与仓库逐一一致）。
- 第 2 轮：closure 聚焦复审（沙箱 `/tmp/residuals-review2`，`git status` 13 行 → 13 行无差异；2 处变异-还原后 md5 一致）。
- 转录：`recorded-residuals-review-round1-independent.txt`、`recorded-residuals-review-round2-independent.txt`；两轮的 prompt 亦入库。
- 沙箱制作时的已知假象：为节省体积 `rsync` 排除了 `.agents/memory/session-logs/`，因此沙箱 `git status` 会出现
  `session-logs/.gitignore` 的「删除」——第 1 轮曾被记为 minor #5，第 2 轮已在 prompt 中说明并非仓库改动（仓库工作树无该删除）。

## 轮次记录

| 轮次 | 结论 | 发现 | 处置 |
|---|---|---|---|
| 1 | **无 blocking、无 important** | minor ×5：①`readSessionHeader` 的 1MB 上限 off-by-one（`>=` 把「恰好等于」也算作超限）；②`parseContext` 只强制 `summary:string`，`key_points`/`open_tasks` 类型漂移仍被静默置空（与 prompt 的「exactly these keys」不对称）；③「没有既有 CONTEXT.md」时 errors.log 文案仍写「previous CONTEXT.md is kept」；④`MEMORY.md`（工作树）里对 64KB 截断 / header 大小写敏感 / 残余未修的描述过期；⑤`session-logs/.gitignore` 显示为删除 | ①②③ 本轮修（见下）；④记录（由扩展自己的 consolidation 重写，见 fix-note §10）；⑤确认是沙箱假象 |
| 2 | **无 blocking、无 important** | minor ×2：M1 同一处 prompt 措辞与解析器实际严格度仍不对称（`title` 可缺省、列表可缺省、额外键被忽略）；M2 混合数组（如 `["a",123]`）中非字符串元素被逐项静默丢弃。另有一条**范围提示**：diff 里有 3 处不在第 1 轮 5 条 minor 内的改动（`status` 两行、header 大小写不敏感、前驱不匹配即清 marker） | M1 复审后按建议把 prompt 措辞改为与解析器一致（见下「复审后的唯一改动」）；M2 接受（与既有逐项规整一致，非回归）；范围提示确认：那 3 处正是第 1 轮清单里的残余 1/3/4 修复本身（第 2 轮 prompt 只列了 5 条 minor，故复审未见其背景） |

## 第 1 轮 minor 的修法与探针

| minor | 修法 | 探针 | 变异验证 |
|---|---|---|---|
| ① 1MB off-by-one | 上限改为约束**行长**：`while (read <= MAX)` + `if ((newline < 0 ? read : newline) > MAX) return undefined;` —— 恰好 1MB 的行读入，1MB+1 与 1.1MB 仍 fail-open | `a header exactly at the cap is still read`（`exact.length === cap`） | `>` 改回 `>=` → 该探针红（`oversized`/`pathological` 保持绿） |
| ② 键类型漂移 | `parseContext` 对 present-but-非数组（`undefined`/`null` 视为缺省）的 `key_points`/`open_tasks` 直接返回 undefined → 走 `contextUnusable`（保留既有渲染 + errors.log 一次） | `a wrong-typed context list is flagged`、`absent lists are not flagged` | 去掉该守卫 → 只有前一条红 |
| ③ 文案不准 | `kept = existingContext.trim() ? "the previous CONTEXT.md is kept" : "only a placeholder context was written"` | `without a previous render the placeholder is written`（新开一个无 CONTEXT.md 的项目跑一遍，断言 fallback 占位已写 + 文案） | 文案退回恒写 → 该探针红 |

第 1 轮另外三条（④⑤ 与 M2）无需代码改动，原因见上表。

## 复审后的唯一改动

第 2 轮 M1（prompt 措辞与解析器严格度不对称）在复审之后按下述建议改掉了：prompt 现在写
`context must be an object: summary (string, required), title (string), key_points (array of strings), open_tasks (array of strings). A context written as a Markdown string, or with key_points/open_tasks present but not arrays, is discarded…`，
与 `parseContext` 的实际语义（`summary` 必需、列表缺省视为空、present-but-非数组整份丢弃）一致。
**这是一处纯文案改动，发生在第 2 轮之后**：已有的 `the prompt names the context keys` 探针仍覆盖它，`node tests/run-all.mjs` 9/9 通过；
是否再跑一轮独立复审由 owner 决定。

## 探针灵敏度（两轮合计）

- 第 1 轮复审自做 5 处变异-还原：残余 1/2/3/4 与 `contextUnusable` 各自**只有**对应探针变红，无恒真、无误伤、无既有探针被改弱。
- 本仓另做的 10 处变异自检（M1–M10，见 fix-note §6）结论一致；第 2 轮复审复核了 ①（cap 边界）与 ②（键类型漂移）两处，结果与自检一致。

## 结论

- **可以发版**（两轮均无 blocking、无 important；两轮复审各自的沙箱零写入声明成立）。
- 仍被接受、记录在案的 minor：M2（混合数组的逐项丢弃，与既有 `trimLine` 规整行为一致）、`title` 非字符串时默认 `"Untitled session"`、以及 `status` 的年龄文案在极端未来时间戳下落到「less than a minute」分支（不影响语义）。
