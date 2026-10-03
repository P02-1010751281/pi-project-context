---
doc_type: data-report
issue: 2026-10-01-session-log-durability
status: confirmed
path: quick
created_at: 2026-10-03
related: [session-log-durability-decision.md]
tags: [session-log, archive, retention, survey, deferred]
---

# 同类项目调查：会话转录怎么存，以及保留策略

本文件回答 `session-log-durability-decision.md` §后续调查问题 的三问。

**它不改变任何决定。** 该 decision 仍是 `deferred`，在 owner 选之前**不改归档行为**。本文件只把 owner 当时要求「调查同类项目」的材料补齐，让那个决定可以真的拍下来。

检索日 2026-10-03，用 Tavily 检索 + 原文抓取。

## Q1：同类工具怎么存会话转录？默认本地还是同步？有保留策略吗？

有一篇把这六款 CLI 都实测过（含 pi 自身）的横评，逐条对过磁盘：

| CLI | 路径 | 格式 | 保留策略 |
|---|---|---|---|
| Claude Code | `~/.claude/projects/<slug>/<id>.jsonl` | JSONL 明文 | **`cleanupPeriodDays`，默认 30 天**，启动时删 |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | JSONL | **无** |
| Cursor CLI | `~/.cursor/chats/.../store.db` | SQLite | 无 |
| Amp CLI | 服务端 + `~/.local/share/amp/threads/T-*.json` | 每线程 JSON | 仅服务端 |
| opencode | `~/.local/share/opencode/opencode.db` | SQLite | 无 |
| **pi** | `~/.pi/agent/sessions/<cwd-slug>/<id>.jsonl` | JSONL 树形 | **无** |

来源：`allaboutcoding.ghinda.com/where-ai-coding-clis-store-session-logs`（作者同机装了六款，并对结论做过四个 agent 的「反驳式」复核）。

**读出来的三条：**

1. **默认本地是绝对主流。** 六款里五款纯本地，一款（Amp）另有服务端副本。没有一款默认把转录同步到跨机的位置。⇒ 本项目「本地 only」与同类一致，不是异常。
2. **默认保留策略几乎不存在。** 只有 Claude Code 有（30 天）。其余全是「一直留」。⇒ 本项目「没有任何清理」同样属于同类常态——但下面这条说明这个常态是**已知坏**的。
3. **不清理的代价有实测记录，而且是同一个病灶**：
   - Codex CLI 有一个 issue 记录单会话文件到 **732 MB**，拆解为 `compacted` 记录 337.8 MB + `function_call_output` 原始输出 230.8 MB；该 issue 标题即「session logs grow to 700MB–2GB from repeated compaction history and raw tool output」。
   - Claude Code 社区有「`~/.claude` 四周涨到 1.3 GB」的实测贴。
   - ⇒ **增长来自原始 tool 输出与压缩历史**，与本项目 108 MB 的形态相同。这不是「用得久」，而是「记录原始 tool 输出」的必然结果。

## 本项目的实测基线（同日）

| 指标 | 值 |
|---|---|
| 会话数 | **58** |
| 实际占用 | **108.1 MB**（含派生的 `session.md`；`session.jsonl` 本身 52.7 MB） |
| 最大单会话 | **8.7 MB** |
| **最老会话** | **仅 17.9 天** |
| 增长速度 | 约 3.2 会话/天、约 6 MB/天 |

## 关键结论：**按天数的保留策略在本项目等于没做**

从上表算：

| 策略 | 回收 |
|---|---|
| 保留 30 天 | **0.0 MB**（58/58 个会话都在 30 天内） |
| 保留 60 / 90 天 | **0.0 MB** |
| 保留 14 天 | 50.8 MB（34/58 个） |
| 保留 7 天 | 77.5 MB（41/58 个） |
| 保留最新 30 个 | 44.6 MB |
| 保留最新 10 个 | 91.1 MB |

⇒ 照搬 Claude Code 的 `cleanupPeriodDays = 30` **一点空间都省不出来**，因为增长是**量驱动**（会话数与单会话体积），不是时间驱动。任何有效策略必须是**按个数**或**按体积**的，或者干脆是「按体积触发」。

## Q2：有没有成熟的「结构最小化 + 脱敏投影 + 私有 vault」可借鉴？

**没有找到可直接借用的成熟形态。** 检索到的只有两类，都不对口：

- 托管产品侧的「服务端最小化/保留策略」（企业合规语境），不是个人 CLI 的可复用实现；
- 加密本身的做法（见 Q3），但同样没有针对「agent 转录」的成品。

这反过来印证了本项目 decision 里那条**已被 decision 记下的**结论：结构最小化会砍掉 autolearn 证据（`autolearn/evidence.ts:78-88` 读归档），所以它不是免费的。

## Q3：加密归档的密钥管理在个人工作流里现实吗？

**检索不到把它做成个人默认的成熟做法。** 结果分两类，都不构成「个人工作流里的现实选项」：

- 企业侧的 KEK / Key Vault 信封加密（依赖托管身份与云 KMS）；
- 通用 GPG 指南（口令、轮换、指纹核对）——可行，但其代价是**每次读归档都要过一道密钥操作**，而归档是**读多写少且经常被后台 pass 读**的东西。

⇒ 与 decision 里对方案 D 的排序一致（「最强；引入密钥管理」），也支持把它继续留在「不建议做默认」。

## 生态侧的第三条路：显式清理命令，而不是自动删除

Claude Code 自己的做法值得注意——它除了默认 30 天自动删（社区有 issue 抱怨「静默删除」，`anthropics/claude-code#62476`），还提供了**显式命令**：

```bash
claude project purge --dry-run
```

并支持 `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1` 完全停止写转录。社区还因此长出了第三方清理器（`claude-clean`、`claude-cleaner`），共同形态是：**`status` 报告占用 → `--dry-run` 预览 → 按天数/类别执行**。

⇒ 这是「不改变默认行为、但给用户一个可控出口」的成熟形态，与本项目 decision 的约束（不改归档行为）**不冲突**。

## 交给 owner 的选项（本文件不选）

| 选项 | 回收 | 代价 |
|---|---|---|
| 维持现状（不清理） | 0 | 继续以 ~6 MB/天增长；同类已证 700MB–2GB 可期 |
| **显式清理命令**（`/session-log prune`，带 `--dry-run` 与计数/体积阈值） | 按参数 | 不改变默认行为，符合现有 decision 约束；新增命令面 |
| 自动按个数保留（如最新 30 个） | ~45 MB | 改默认行为，与当前 `deferred` 冲突，需先改 decision |
| 自动按体积封顶（如超 100 MB 丢最旧） | 稳定 | 同上；需定义「丢最旧」是否含 `INDEX.md` 重建 |
| 归档时丢 `toolResult` | 最大 | **明确不建议**——砍 autolearn 证据（decision 已记） |
| 加密 + 私有 vault | 0（不省空间） | 个人工作流无成熟形态；读路径每次要密钥操作 |

## 状态

`deferred` **保持不变**。本文件只补齐 owner 要求的三问调查；归档行为未做任何改动。上面那张表是给 owner 拍的，不是本文件替他拍的。
