---
doc_type: issue-review
issue: 2026-09-17-handoff-session-continuity
status: passed
path: quick
reviewer: independent pi CLI (lane A, read-only sandbox copies)
rounds: 3
created_at: 2026-09-17
---

# handoff 设置继承与会话树扁平化 修复 Review

## 审查方式

- lane A：独立 `pi -p --no-session --no-extensions --no-skills --no-prompt-templates --tools read,bash --provider deepseek --model deepseek-v4-pro --thinking off`，
  在 `/tmp` 只读沙箱副本上运行（含 `.git`），零写入校验：进入/退出 `git status --porcelain` 与沙箱时间戳逐轮比对。
- 第 1 轮：全量改动的独立审查（沙箱 `/tmp/pc-review-round1`，`git status` 前后 **0 行差异**，无文件被写）。
- 第 2 轮：closure 聚焦复审（沙箱 `/tmp/pc-review-round2`，`.review-stamp` 之后被改文件 **0 个**，`git status` 前后 **0 行差异**），逐条核对 F1–F6 是否真的关闭 + 修复增量回归。
- 转录：`handoff-session-continuity-review-round1-independent.txt`、`handoff-session-continuity-review-round2-independent.txt`、`handoff-session-continuity-review-round3-independent.txt`。
- 第 3 轮：发布后跟进的聚焦复审（沙箱 `/tmp/pc-gitignore-review`，`git status` 前后 **0 行差异**；复审在内自主做了变异-还原，沙箱 `project-state.ts` 与仓库 md5 一致 **79d943dd…**），仅看 `ensureMemoryGitignore` 的 header 去重改动。

## 逐轮记录

| 轮 | 结论 | 主要发现 | 处置 |
|---|---|---|---|
| 1 | **无 blocking**；important ×2、minor ×4 | F1 marker 未被 gitignore（含绝对路径，可能被提交）；F2 `getProjectRoot`（git 子进程）在 `session_start` 里早于 `reason==="new"` 判定；F3 `setThinkingLevel` 失败静默吞掉；F4 `setModel` 抛错与返回 false 混为「no authentication」；F5 会话头 >64KB 时不扁平化；F6 `newSession` 抛错（非 cancel）不清 staging，之后 `/new` 可能继承 | F1 修：`handoff-session-settings.json` 进 `MEMORY_GITIGNORE_LINES`，导出 `ensureMemoryGitignore` 并在 staging 前调用；F2 修：guard 提到函数首行；F3 修：catch 补 `logError`；F4 修：抛错分支带真实错误 + `logError`，`=== false` 才提示无认证；F5 接受（头行仅 id/timestamp/cwd/parentSession，退化行为=旧代码）；F6 修：`.catch()` 先清 staging 再 rethrow。新增 3 条探针（gitignore / 提前退出 / 抛错清 staging）与 3 个变异 |
| 2 | **无 blocking**；无新增 important | F1–F6 逐条判定：F1–F4、F6 **resolved**，F5 认同「接受」（无现实触发场景、退化为旧行为）；修复增量无回归（`.catch` 语义：`withSession` 内层自带 try/catch 不 rethrow，故 reject 只意味「替换未建立」，清 staging 幂等且无「已成功却被误清」窗口；guard 提前不改变 marker 清理语义；`ensureMemoryGitignore` 导出仅复用既有内部机制、进程内去重幂等；文案改动不破坏既有断言） | 新探针鉴别力确认：`quietExecs === 0` 用全新 cwd 制造 cache miss、非恒真；`memoryGitignore.includes(...)` 在该测试中无更早写入路径、非恒真；F5 记入 fix-note 残余 |
| 3 | **无 blocking**（发布后跟进：`ensureMemoryGitignore` 重复 header） | 逐项复核：(a) 文件缺失/空文件/只有 header/无尾换行/CRLF/二次调用等 9 种状态下写出均正确幂等、不丢用户行；(b) 5 处调用点与 README/测试/文档均不依赖旧 header 位置；(c) 两条新探针不恒真，复现变异后仅 1 条变红；(d) 无新增 blocking/important。唯一 minor：用户手写 header **大小写不同**时会再写一条（预存行为；注释行无语义影响；修正需额外的折叠集合） | minor 记为接受残余（见 fix-note §7） |

## 关键验证（复审方实际执行）

- `node tests/handoff-test.mjs` 全绿（含 29 条 handoff 段新增/既有断言）；`node tests/run-all.mjs` **9/9**。
- 变异矩阵（第 2 轮复核，作者侧数据）：m1 去 staging → 5 红；m2 去 predecessor 匹配 → 2 红；m3 去 TTL → 1 红；m4 去祖先扁平化 → 2 红；m5 去 `reason==="new"` → 3 红；m6 去等值跳过 → 1 红；m7 去 gitignore 调用 → 1 红；m8 guard 后移 → 1 红；m9 去抛错清 staging → 1 红 —— 九道闸门一一正交，无假红、无恒真探针。
- pi 侧事实复核：`agent-session-runtime.js:150-171` 的 `newSession` 时序（`setup` → rebind/`bindExtensions` 发 `session_start` → `withSession`）、`agent-session.js:2050-2057` 的运行时绑定（`session_start` 里 `pi.setModel` 安全）、`agent-session.js:1254-1262`（无认证时 `setModel` 抛错而非返回 false）、`session-selector`/`session-manager` 按 `parentSession` 建树。

## 结论

- 两轮均 **无 blocking**；第 1 轮的 2 条 important 与 3 条可修 minor 全部关闭，F5 记录为接受的残余。
- 第 3 轮（发布后跟进的小改动）同样 **无 blocking**，唯一 minor 记录为接受残余。
- 真机 A/B（RPC，两次连续 handoff）：新代码 **11/11**，已装 v0.1.5 旧代码 **4/11**（见 fix-note §4）。
- 未提交：等待 owner 决定提交与是否发版。
