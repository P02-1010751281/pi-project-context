# 配置与命令

## 配置文件

配置位于 `<project>/.agents/memory/project-context.json`。pi 与 dsh 共享大部分字段；`handoffMode`、`handoffGuard`、`handoffLanguage` 是 pi 侧交接差异。

```json
{
  "archiveEnabled": true,
  "autoConsolidate": true,
  "autoLearn": true,
  "handoffEnabled": true,
  "autolearnAt": 0,
  "autolearnTurns": 20,
  "autolearnIntervalMs": 1800000,
  "consolidateTurns": 6,
  "consolidateIntervalMs": 300000,
  "forceDedupeMs": 15000,
  "maxTokens": 8192,
  "maxOutputTokens": 32768,
  "maxMemoryChars": 32000,
  "provider": "",
  "model": "",
  "handoffAdaptive": true,
  "handoffThresholdRatio": 0.4,
  "handoffTargetTokens": 64000,
  "handoffKeepTokens": 20000,
  "handoffSummaryThinking": "off",
  "handoffMode": "send",
  "handoffGuard": "wait",
  "handoffLanguage": "auto"
}
```

## 常用字段

| 字段 | 作用 |
|---|---|
| `archiveEnabled` | 是否自动存档会话 |
| `autoConsolidate` | 是否自动更新 memory/context |
| `autoLearn` | 是否自动沉淀项目 skill |
| `maxMemoryChars` | `MEMORY.md` 正文 cap；4000–200000，默认 32000；可用 `/project-context max-memory <n>` 修改 |
| `provider` / `model` | consolidation/autolearn 的辅助模型路由；空值使用会话模型 |
| `maxTokens` | consolidation/autolearn 输出上限；默认 8192，最低 256 |
| `maxOutputTokens` | 辅助输出自适应上限；默认 32768 |
| `consolidateTurns` / `consolidateIntervalMs` | 整理的轮数/时间节流 |
| `autolearnTurns` / `autolearnIntervalMs` | 沉淀的轮数/时间门槛 |
| `forceDedupeMs` | 强制整理的去重窗口 |
| `handoffAdaptive`、ratio、target、keep | 交接预算；详见 [handoff 预算与恢复](handoff.md) |
| `handoffMode` | `send` 自动发送 successor continuation，或 `draft` 留在编辑器 |
| `handoffGuard` | 遇到待回答问题时 `wait`/`draft`/`send`/`skip` |
| `handoffLanguage` | `auto`、`zh` 或 `en` |

### memory cap

`maxMemoryChars` 限制的是 `MEMORY.md` 正文，不是简单的裸字符切片：

```text
正文头段（整行边界）
正文尾段（整行边界）      ← 被丢弃的是中段
_[memory truncated at N characters: M dropped]_
```

marker 行不计入正文 cap。超限时保留头尾、丢弃中段，在每项目每进程写一次 `errors.log`，并在通知、显式 consolidation 回复和 `/project-context status` 中提示（含所需字符数与 `/project-context max-memory` 建议）。journal 写入、fold、外部编辑比较、load、legacy 读取和 OMP migration 使用同一个显式 cap。

`MEMORY.md` 的顶层结构收敛到固定的 4 节：`Project` 20% / `Invariants` 40% / `Pitfalls` 25% / `Index` 15%（份额与每节说明定义在 `memory/schema.ts`）。consolidation prompt 先扣掉固定开销（`# Project Memory` 标题 + 4 个 `##` 节标题及其空行）再按 `maxMemoryChars` 算出每节字符预算，保证“逐节刚好填满”也不会超 cap；并要求长解释指针化到版本化 `docs/`（只指向**已存在且确实承载该细节**的路径，不虚构）。这是 prompt 的收敛目标：已有自由结构的记忆照常读、渲染、剪裁，schema 不是存储闸门，按节优先序丢（S4）与符合度可见性仍待后续。

`CONTEXT.md` 同样收敛到固定的 3 节：`Summary` 40%（另受 `MAX_SUMMARY_CHARS=6000` 约束，散文摘要保持短小）/ `Key points` 35% / `Open tasks` 25%，定义在 `memory/context-schema.ts`。consolidation prompt 与渲染器共用同一张表：先扣掉固定开销（`# Project Context`、`Last updated` 行、3 个节标题及空行、最坏情况的尾部 `<!-- latest-session-title -->`，以及截断标记的预留）再按份额给出每节字符预算；渲染器按同一预算裁剪（列表按 `MAX_LIST_ITEM_CHARS=800` 截单项、按 `MAX_LIST_ENTRIES=50` 截条目，再丢尾项；`dropped` 以归一化但未 trim 的完整渲染为基准，因此单项截断与条目上限的损失也计入标记），任一小节被裁就在文末追加严格标记 `_[context truncated: N characters dropped]_`，并在每项目每进程写一次 `errors.log`。这是与 `MEMORY.md` 同级的收敛目标：已有自由结构的 CONTEXT.md 照常读、注入。

cap 能否装进模型输出上限也做静态校验：稠密（CJK）正文按 1 token/字符最坏估算，`maxMemoryChars + 1024` 超过输出上限的上界 `max(maxTokens, maxOutputTokens)` 时 `status` 与 `max-memory` 命令都会告警（默认 32000 对 32768 已贴边）——否则回复很可能在闭合前被截断。模型自身的 `maxTokens` 更小、reasoning 预留或大 context 可能比这个上界更紧，那些情况由 pass 自己的 `clipped` 诊断兜底。

## 命令

| 命令 | 用法 |
|---|---|
| `/project-context` | `status`；`on|off <archive|memory|autolearn|handoff|all>`；`model <provider>/<id>|off`；`max-tokens <n>|default`；`max-memory <n>|default` |
| `/memory-learn` | 立即跑 consolidation，重写 `MEMORY.md` 和 `CONTEXT.md`；别名 `/context-update` |
| `/memory` | 显示项目 memory 路径和状态 |
| `/context` | 显示 context、session index、session log 路径 |
| `/session-log` | 写当前存档；`import <session.jsonl|目录>…` 导入历史 session |
| `/autolearn` | 立即沉淀；`list`、`approve <name>`、`reject <name>`、`on`、`off`。`approve` 会重新套用与提案路径相同的形状规则（描述/体积上下限、注入检测），不满足则拒绝并点名原因 |
| `/auto-handoff` | `status`、`on`、`off`、`auto`、裸比例、`target`、`keep`、`thinking`、`guard`、`lang`、`send`、`draft`、`now` |

说明：`/auto-handoff auto` 是自适应模式（无参数，阈值取**两项**——模型的质量拐点：保守 MRCR 拟合曲线，≤~400K 诚实窗口取自身边界、500K 以上收敛到 157K 平台——与窗口末点取小；caps 只降不升），`/auto-handoff target 64k` 是手动设定的**目标摘要量**，不参与触发公式，被护栏压掉时 `status` 会点名；裸 `/auto-handoff 0.6` 是固定 60% 模式，`handoffThresholdRatio` 只用于固定模式（旧配置同时有 `handoffAdaptive: true` 与 ratio 时，auto 忽略 ratio；要比例请用裸 `/auto-handoff 0.6`）。`/auto-handoff` 写入时只提交自己拥有的 handoff 键，因此不会覆盖 `/project-context off memory` 之类的开关、另一个实例的改动或手改的字段。

## flags

```text
--no-project-context
--handoff-ratio 0.4|auto|off
--no-auto-handoff
```

flags 只影响当前运行；`--no-project-context` 不改项目配置。功能开关控制自动行为，显式命令仍可执行。

## 路由与输出预算

整理、沉淀、handoff 摘要默认使用会话模型。配置 `provider` 与 `model` 后使用指定路由；路由解析失败或未授权时退回会话模型，并按进程去重告警。`maxTokens` 可按 artifact token 率自适应抬高，但不超过模型上限和 `maxOutputTokens`。reasoning 模型（`reasoning: true`）会额外预留隐藏思考 token，正文预算相应收紧；若回复被输出上限截断，会自动按更高预算重试一次，仍失败则显式报告截断并保留旧 memory。

pi 的 handoff 摘要使用宿主 `generateSummaryWithUsage`，其输出 reserve 不随 `maxTokens` 改变；具体预算和小 aux 模型 cap 见 [handoff 预算与恢复](handoff.md)。

## 兼容迁移

旧配置只读兼容：

- `features.*`、`autolearn.*`、`handoff.*` 嵌套布局；
- `memory/autolearn.json` 的 `enabled`/`at`；
- 全局 `~/.pi/agent/auto-handoff.json`。

下次保存时重写为扁平布局。旧 memory/session 数据的路径与冲突策略见 [架构与数据模型](architecture.md)。
