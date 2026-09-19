---
doc_type: issue-report
issue: 2026-09-18-memory-cap-and-adaptive-threshold
status: confirmed
path: quick
created_at: 2026-09-18
related: [memory-cap-and-adaptive-threshold-fix-note.md]
tags: [memory, truncation, maxMemoryChars, context, handoff, threshold]
---

# 记忆截断 + auto 阈值偏低 问题报告

触发（2026-09-18）：owner 报告两件事——「MEMORY.md 的最后一行被截断」与「auto 的阈值问题（自适应明显偏低）」，
一句「all」要求全修。排查过程中又定位出第三条：`CONTEXT.md` 静默停更。

## ① MEMORY.md 末行被截断（用户可见症状 → 数据静默丢失）

- 现象：`.agents/memory/MEMORY.md` 结尾停在半句：
  `- Code review gates: lane A needs an independent reviewer — … snapshot \`git status\` + file`
- 根因：`project-state.ts::normalizeMemoryDocument` 用裸 `.slice(0, MAX_MEMORY_CHARS)`（`MAX_MEMORY_CHARS = 24000`）
  把整份文档切在字符数上，注释却写着 "keeping every line"。它同时作用于：journal 记录写入、`foldMemoryJournal`、
  外部编辑比较键 `memoryComparisonKey`、legacy 读取路径——即**手改 `MEMORY.md` 也突破不了这个上限**。
- 证据：
  - `memory.jsonl` 三条 `replace` 记录长度全部恰好 24001 字符（24000 + 换行），尾部分别停在 `grep the live ses` /
    `snapshot git status + file` —— 不可能是模型自然输出。
  - 已提交的 render（`0586d47` 与三个备份）同样是 24k 截断态；当前 render 相对 `0586d47` 丢了 3 条 bullet
    （`Sandbox-review hygiene` / `Long reviewer runs should be backgrounded` / `Headless end-to-end validation …`）。
  - 自锁：模型每轮读到的是被切过的记忆，再整份重写，超出部分每轮再被切掉 —— 丢失静默累积，且**模型永远不会再看到被丢的内容**。
  - `MAX_MEMORY_CHARS` 在 tests/ 下零覆盖。
- 关联旧账：`2026-09-15-consolidated-memory-json-poison` 的分析已把「`MAX_MEMORY_CHARS=24000` 与 `maxTokens=8192` 不匹配」
  记为次根因；v0.1.3 修了输出预算自适应，这个 cap 与它的静默截断留到了现在。

## ② auto 阈值明显偏低（owner 直接判定）

- `resolveThreshold` 的自适应分支：`tokens = baseline + keep + min(handoffTargetTokens, 会话余量/2)`。
  它是**绝对 token 预算**，与窗口大小无关：在 1M 窗口上（本机 `scnet/DeepSeek-V4.1-Flash`）阈值 ≈ `baseline + 20k + 64k`，
  约 10% 窗口就换会话，窗口远没用完。实测状态行出现过 `threshold auto 64.0k (6.4%)`（另一个项目/参数）与
  09-17 两次真实交接落在 16% / 22%。
- 连带问题：自适应模式下 `handoffThresholdRatio`（默认 0.4）完全不生效，看着像「配置了 40% 却在 6% 就交棒」。
- 新发现的边界：阈值抬上去以后，被摘要的「older 前缀」就是摘要调用的输入，而 pi 的 `generateSummaryWithUsage`
  **不会把输入裁到模型窗口内**。若 aux 路由（摘要模型）窗口小于会话模型，前缀过大会让摘要调用直接失败 → 交接永远失败。

## ③ CONTEXT.md 静默停更（排查中定位）

- 现象：`CONTEXT.md` 停在 `2026-09-16T13:18:26Z`，而 `memory.jsonl` 在 09-17 14:41 / 14:47 仍有两次写入；
  `errors.log` 里没有任何 context 相关记录，注入的项目上下文停留在 v0.1.3/v0.1.4 收尾状态。
- 根因（v0.1.7 修复留下的洞）：`consolidate.ts` 只在「`context` 键存在但形状不可用」（`contextUnusable`）时记一条 trace。
  模型**整个省略 `context` 键**（或回复在输出上限处被截断、只剩 `memory_markdown` 能恢复）时：
  `update = undefined` → 保留旧 CONTEXT.md → 无警告、无日志、年龄只能靠 `status` 的 `Context: … updated …` 看出来。
- 与 ① 同源：记忆贴着字符上限 → 模型必须把整份记忆 + context 塞进输出预算 → 回复被截断在 `memory_markdown` 之后，
  context 段根本没输出；`parseConsolidated` 的恢复路径（`readJsonStringField` 容忍未闭合字符串）只返回 `{ memory }`，不报任何异常。

## 范围

- 三条全修，含探针与变异自检；① 的上限改为可配置并默认上调。
- 走完整仓库流程：全量测试 → 变异矩阵 → lane A 独立复审（只读沙箱、零写入）→ artifacts → owner 发话后提交/推送/发版。

## ④ 最终 headless RPC 验证

使用临时 sandbox `/tmp/pi-project-context-real-rpc-pgqde64t`，仅加载项目 extension 与 custom-provider extension：

```bash
pi --mode rpc -ne -ns -nt --thinking off \\
  -e <repo>/extensions/project-context/index.ts \\
  -e ~/.pi/agent/git/git.lentech.site/C02-1010751281/pi-custom-providers/extensions/custom-providers/index.ts \\
  --provider commandcode --model poolside/laguna-s-2.1-free
```

sandbox 配置 `handoffAdaptive=true`、ratio `0.1`、`handoffKeepTokens=0`、`handoffLanguage=en`、`maxMemoryChars=5000`；真实 JSONL RPC 先切换到 `commandcode/inclusionai/ling-3.0-flash-sante:free`，再发送 `/auto-handoff now`。

结果：handoff 成功创建 successor session `01a0b7ac-f60e-7454-a958-044a89a89712`；`HANDOFF.md` 已生成，`memory.jsonl` 有两条 `replace`，memory backup 与 `CONTEXT.md` 均生成/更新，未产生 `errors.log`。父 session 最后使用 `inclusionai/ling-3.0-flash-sante:free`，successor 启动先落到默认模型后又通过 `model_change` 恢复到该模型，`get_state` 一致确认。
