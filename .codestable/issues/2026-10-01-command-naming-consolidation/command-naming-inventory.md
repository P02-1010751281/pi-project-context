---
doc_type: inventory
issue: 2026-10-01-command-naming-consolidation
status: decided
created_at: 2026-10-01
related: [../2026-10-01-structured-consolidation-output/structured-consolidation-output-design.md]
tags: [naming, commands, flags, breaking-change]
---

# 命令 / flag / tool 命名盘点

触发：owner 2026-10-01「梳理一下工具名，现在乱七八糟的。重复的，auto-handoff 和 handoff，等等。」

## 盘点（全量，`grep -rn "registerTool\|registerCommand\|registerFlag" extensions/`）

### 命令（8）

| 命令 | 位置 | 作用 |
|---|---|---|
| `/project-context` | `index.ts:106` | 设置中心：`status` / `on\|off <feature\|all>` / `model` / `max-tokens` / `max-memory` |
| `/memory` | `memory/report.ts:226` | 显示记忆位置与状态 |
| `/memory-learn` | `memory/report.ts:245` | 强制 consolid（记忆 + 上下文） |
| `/context-update` | `memory/report.ts:254` | **`/memory-learn` 的逐字重复别名** |
| `/context` | `archive/archive.ts:168` | 显示 CONTEXT.md / session index / logs 路径 |
| `/session-log` | `archive/archive.ts:140` | 写会话日志；`import <path…>` 回填 |
| `/autolearn` | `autolearn/pass.ts:174` | 技能学习；`list` / `approve` / `reject` / `on` / `off` |
| `/auto-handoff` | `handoff/run.ts:373` | handoff 配置与触发：`status` / `on` / `off` / `auto` / `<ratio>` / `target` / `keep` / `thinking` / `send` / `draft` / `guard` / `lang` / `now` |

### Flag（3）

| Flag | 位置 |
|---|---|
| `handoff-ratio` | `handoff/run.ts:339` |
| `no-auto-handoff` | `handoff/run.ts:343` |
| `no-project-context` | `index.ts:37` |

### Tool（0）

**本扩展未注册任何 tool。** `Context.tools` 只用于辅助调用的局部 schema（见结构化输出设计），不进 pi 的工具注册表。

## 问题

- **P1 逐字重复**：`/context-update` 与 `/memory-learn` 的 handler 体完全一样（`report.ts:245-263`），是两个命令一份实现。
- **P2 同词反义**：`/context` = 「看路径」，`/context-update` = 「重写记忆和上下文」。同一个 `context` 词，一个只读一个写，且写的那条还不属于 archive 模块。
- **P3 `learn` 一词被占两次**：`/memory-learn`（记忆固化）vs `/autolearn`（技能学习）。
- **P4 handoff 三处名不一致**：命令 `auto-handoff` / 配置键 `handoff` / flag `handoff-ratio`。且命令已承载非 auto 的动作（`now`、`keep`、`send`），`auto-` 前缀是名不副实。
- **P5 一个功能三条关闭路径**：`--no-auto-handoff`、`/auto-handoff off`、`/project-context off handoff`。
- **P6 状态重叠**：`/project-context status` 已含 `Memory:` 行，与 `/memory` 重叠。
- **P7 归属不体现在名字上**：`/context` 由 archive 模块注册，但名字属于 memory/context 域。

## 建议方案（verbs-as-args，沿用已有 `/autolearn`、`/auto-handoff` 的写法）

| 现状 | 建议 |
|---|---|
| `/memory` | `/memory`（无参 = status） |
| `/memory-learn` | `/memory update` |
| `/context-update` | **删除** |
| `/context` | **不变**（见下：推翻原建议） |
| `/session-log` | 不变（无参 = 写，`import` 不变） |
| `/auto-handoff` | `/handoff`（与配置键 `handoff` 对齐） |
| `/project-context`、`/autolearn` | 不变 |

Flag 不变（`handoff-ratio` / `no-auto-handoff` / `no-project-context` 都准确描述 automatic 行为）。

**过渡**：owner 2026-10-01 决定**不留**（见「状态」）。

## 影响面

- **面向用户的破坏性变更**：改命令名会打断肌肉记忆与既有文档（`README.md`、`docs/`、`.agents/memory/MEMORY.md` 中的引用、`memory/report.ts` 的提示文案如 `/memory-learn`）。
- 需一次全仓引用清扫 + release note。
- **与结构化输出正交**：本盘点不碰 consolidation 逻辑；`record_memory` 是 tool 不是 command，不受影响。但因 owner 决定同发（见「状态」），两条施工线要一起走一遍评审与发版。

## Tab 补全（新发现，属本 issue 的施工面）

pi **有**补全：`tui.input.tab` = Tab autocomplete（`docs/keybindings.md:89`），输入 `/` 打开命令搜索菜单（`docs/slash-commands.md`），扩展还能给命令注册 `getArgumentCompletions(argumentPrefix)`（`dist/core/extensions/types.d.ts:1132`，返回 `AutocompleteItem[]`）。

**本扩展 8 个命令一个都没提供**（`grep getArgumentCompletions extensions/` 为空），只注册了 `description`。改成 verbs-as-args 后这件事从「锦上添花」变成「必要」：`/memory update`、`/handoff auto|<ratio>|target|keep|thinking|send|draft|guard|lang|now`、`/autolearn list|approve|reject|on|off`、`/project-context status|on|off|model|max-tokens|max-memory` 全是要背参数的形状。施工时给每个命令补 `getArgumentCompletions`。

## 状态

`decided`（owner 2026-10-01）——上表建议已采纳，四点决定：

1. **采纳 verbs-as-args**：`/memory-learn` → `/memory update`；`/context-update` **直接删除**（无别名、无提示）；`/auto-handoff` → `/handoff`；`/context` **不变**。
   - **`/context` 本条推翻原建议**：原清单写 `/context` → `/session-log status`，但 CONTEXT.md 是 consolidation 的产物、不是会话日志，塞进 session-log 语义不对；且重写入口既已改叫 `/memory update`，`context` 一词不再有读写反义（P2 自动消解）。
2. **不留过渡期**（Q2 = 「目前没必要」）：旧名不保留、不提示；被删的命令直接从 pi 的 `/` 菜单与 Tab 补全里消失。
3. **与结构化输出同一次发版**（Q3 = 「一块」，推翻原「分开两次」的建议）：本 issue 与 `../2026-10-01-structured-consolidation-output/structured-consolidation-output-design.md` 一起发。
4. **补参数补全**：见上节。

## 施工清单（owner 已拍板）

- 改名/删名 + 全仓引用清扫（`README.md`、`docs/`、`memory/report.ts` 提示文案）。
- 每个存留命令补 `getArgumentCompletions`。
- 与结构化输出同一发版（release note 写明破坏性变更）。
