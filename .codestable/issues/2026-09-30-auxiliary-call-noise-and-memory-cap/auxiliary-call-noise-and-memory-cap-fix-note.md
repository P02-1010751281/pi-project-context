---
doc_type: issue-fix
issue: 2026-09-30-auxiliary-call-noise-and-memory-cap
status: fixed
path: standard
fix_date: 2026-09-30
related: [auxiliary-call-noise-and-memory-cap-report.md, auxiliary-call-noise-and-memory-cap-analysis.md]
tags: [memory, autolearn, alerts, errors-log, memory-cap, output-budget, call-policy]
---

# 辅助调用报警与记忆上限 修复记录

本次是跨两个会话的连续施工：上一会话落 1–2 步，本会话继续第 3 步纯代码部分。
**代码、测试、docs、本 artifact 与 render 提交分开处理**（render 按仓库惯例单独 commit）。
两个活项目（UniField/Quantum_Matrix）**未被动过**：配置、cap、MEMORY.md/journal 分叉与进程重启仍待 owner 确认。

## 1. 降噪（B1 + B2/B3）

- 新增 `shared/call-policy.ts`：`classifyModelFailure`（`auth`/`quota`/`transient`/`shape`/`other`）、
  `noteModelFailure`/`noteModelSuccess`、`modelCooldownRemaining`/`modelAutoDisabled`/`modelBlocked`；
  常量 `AUTH_COOLDOWN_MS=30min`、`QUOTA_COOLDOWN_MS=15min`、`TRANSIENT_BASE/MAX=5/30min`、
  `AUTO_DISABLE_AFTER=5`。
- `autolearn/pass.ts`：门禁加 `if (!force && modelBlocked("autolearn", projectRoot)) return;`；
  首个调用成功 `noteModelSuccess`，catch 里 `noteModelFailure` —— **修掉“每个 settle 重试一次”的六连发**。
- `memory/pass.ts`：throttle 后加 `modelBlocked` 旁路；`call()` 成功/失败分别记 success/failure。
- `memory/report.ts`：`memoryFailureNotice()` 按失败类给不同 toast；连续失败后一次性 `MEMORY_PAUSED_NOTICE`。
- 关键边界：`shape`（JSON 形状/截断）**不**触发路由冷却，避免把健康路由误判成故障。

## 2. 闸门层（M1 + M2 + M6）

- **M1** `memory/prompt.ts`：`buildPrompt` 新增 `budget` 参数，注入真实字符上限与当前字数
  （“must stay under {cap} characters; the stored memory is currently about {n}. That is a hard cap …”），
  取代无效的 “below 6000 words”。`memory/pass.ts` 以 `promptFor(input)` 统一注入。
- **M2** `memory/pass.ts`：回复 `exceedsMemoryCap` 时，先做**一次**有界压缩调用
  （保事实、并重复、删最不持久），成功且仍不超 cap 才采用；否则保留原回复并走原有 cap 告警。
- **M6** `memory/document.ts`：新增 `exceedsMemoryCap`（剥离 marker 后测量），复制的旧 marker
  不再把短回复误判为超限；prompt 常驻“不得写省略/截断标记”，从源头避免标记粘连。

## 3. 本次新增（B4 + M3 + M4 + M7）

- **B4** `shared/error-log.ts`：新增按 `(file, scope, headline)` 的 10 分钟去重窗口
  （`ERROR_DEDUPE_WINDOW_MS`，每文件最多 64 key）。窗口内相同记录只保留第一份并计数；
  同一 key 再次出现（新 episode）时先补一行 `N identical failure(s) suppressed between …`。
  仍然 append-only，不改轮转。
- **M3** `memory/document.ts`：回落剪裁从“只留头部”改为**保留头尾、丢弃中段**
  （`clipToLineBoundaryBothEnds`，头段 60%、尾段 40%，整行）。这样不再恰好丢掉排在最后的
  「工程教训 / 操作陷阱」，marker 的 dropped 数为中段实际丢弃量。
- **M4** 可见性：
  - `index.ts` `memoryStatusLine(memory, cap)` 显示 `chars, X% of the {cap}-char cap`；
    截断时提示 `/project-context max-memory <n>`。
  - `index.ts` 新增 `/project-context max-memory <n>|default`（`MIN_MEMORY_CHARS`–`MAX_MEMORY_CHARS_LIMIT`）。
  - `report.ts`：cap 告警与 `/memory` 状态都带占用比例、所需字符数与命令建议。
- **M7** `shared/output-budget.ts`：新增 `memoryReplyTokens` / `memoryCapUnsatisfiable`
  （稠密正文按 1 token/字符 + `REPLY_OUTPUT_MARGIN_TOKENS`）；`index.ts` 在 `status` 与
  `max-memory` 设置时对 `cap + 1024 > maxOutputTokens` 告警。

## 4. Docs

- `docs/architecture.md`：shared 模块树补 `call-policy.ts`；记忆写入段改述头尾保留与 M7 校验。
- `docs/configuration.md`：`maxMemoryChars` 行补命令入口；cap 说明改为头尾保留 + 所需字符数提示；
  新增 M7 静态校验说明；命令表补 `max-memory`。

## 5. 验证

- `node tests/run-all.mjs` → **12/12 全过**：新增 `tests/call-policy-test.mjs`、
  `tests/memory-budget-test.mjs`、`tests/memory-ops-test.mjs`；`git diff --check` 干净。
- 既有用例中 3 条断言随文案/形态变化同步更新（`consolidation-test.mjs` × 2、`switches-test.mjs` × 1），
  均为预期的对外文案变化，不是放宽断言。
- 无本地 tsc；类型由 jiti 运行时加载与测试执行间接验证。

## 6. 未完成 / 待办

- **A2/A3/A4**（动活项目）：改 `project-context.json`、调 QM cap、处理 `MEMORY.md`/journal 分叉与备份、
  重启 PID 3225/3278 —— 需 owner 确认。
- **S1 + S3**（固定 schema + 指针化）：改变记忆对外形态、需向后兼容已有自由结构，
  按惯例走 `.agents/skills/pi-project-context-sandboxed-independent-review`。
- **S2 + S5**（条目生命周期 + 增量 ops）：单独立项；S5=M5 属协议边界，需独立评审。
- **独立评审**：M2/M6 属记忆/压缩协议边界，尚未跑独立只读 sandbox 评审（本 fix-note 未附评审轮次）。
- 运行中的 pi 仍是已安装的 v0.1.11 clone；本改动要生效需重新打包/发布/重装并重启。
