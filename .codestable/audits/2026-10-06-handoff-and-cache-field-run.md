# 真机 RPC 现场跑：交接路径与缓存实测（2026-10-06）

本轮用 `pi --mode rpc -ne -ns -np --thinking off -e extensions/project-context/index.ts --model deepseek/deepseek-v4-pro`
在 `/tmp` 沙箱里驱动扩展自己的命令处理器（与 TUI 走同一个 handler），驱动脚本 `/tmp/drive-handoff2.mjs`、`/tmp/drive-floor.mjs`、`/tmp/drive-cache.mjs`。
数字只在本文件记账，不进 MEMORY/CHANGELOG。

## 1. 固定模式的两种拒绝都在真机复现

| 命令 | 现场回执 |
| --- | --- |
| `/handoff threshold 0.02` | `Usage: /handoff threshold <auto\|0.1-0.95\|10-95%> (e.g. threshold 0.6)` —— 越界先被**取值校验**挡住 |
| `/handoff threshold 0.9` | `Handoff ON · threshold 90% of window · ~60 recent carried · mode send · guard wait · lang en · context 0/1000k` |
| `handoffBudgetRecentTokens=99000` + `threshold 0.1` | `Handoff ON · threshold fixed 10% (the 100k-token threshold is below the 107k-token floor a worthwhile handoff needs at this baseline; raise /handoff threshold or lower /handoff budget recent) · ~99.0k recent carried` |
| 同上再 `/handoff now` | `Handoff: skipped — nothing older than the recent window to drop.` |
| 流式期间 `/handoff now` | `Handoff: skipped — the agent is busy.` |
| 短会话 `/handoff now`（keep=60、内容不足） | `Handoff: skipped — nothing older than the recent window to drop.` |

要点：**固定模式的地板拒绝现在有真机文本**（不再只有单测断言），且它给的是可执行的下一步（抬阈值或降 keep）；
三种 skip 也各有自己的说法，不是静默 no-op。

## 2. 真交接 + A 锚定（自动阈值路，keep=60）

```
Handoff: dropping ~2.1k of context, carrying ~234 recent...
Handoff: continued in a fresh session (previous was 0.2% full, kept ~234 recent; the dropped prefix stays in its session log).
```

- 配置 keep 只有 60，实际 `kept ~234` —— 这就是 **A+B 的 snap/锚定**在真机生效：窗口回退到最后一轮的起点，
  而不是从 60 token 的中间切开。
- `HANDOFF.md` 只有机械头部（`# Handoff from pi session …` / Created / Project / Session log / Session index），**没有摘要散文**，
  与 §8「交接零模型调用」一致。
- 后继会话 JSONL 的第一条 user 载荷是前一会话**最后一轮的原始提问**（`Write about the story of the colour teal in industrial design…`），
  即「最后一轮的问题以原文到达 successor」；同一份载荷里带文件清单与 `session-logs/` 指针。
- 本轮**没有**出现 `[turn prefix dropped during handoff]` 标记：切点落在回合起点，正是 snap 的预期结果（标记只在 true mid-turn 裁切时出现）。

## 3. 缓存：两项与一个反直觉结果

同一会话内逐轮 `cacheRead`（usage 字段，deepseek 直连线路）：

| 观测 | input | cacheRead |
| --- | --- | --- |
| 第 1 轮 | 1037/1185 | 640 |
| 第 2 轮 | 55/91 | 1792/2048 |
| 第 3 轮 | 94 | 1920 |
| 第 4 轮 | 154 | 2048 |
| **交接后（后继会话首轮）** | 2682 | **640** |
| 交接后第二轮 | 2864 | 640 |
| **同一会话内手改 MEMORY.md（+113 字节）后的下一轮** | 102 | **2432（未坍塌，反而增长）** |

- **会话内前缀复用在真机成立**：`cacheRead` 随轮次增长（640 → 1792 → 2048 → 2432），注入的记忆块被一起缓存。
- **交接确实付一次塌陷**：`2048 → 640`，但原因是后继会话的消息列表整段分叉，不是当时的记忆渲染；
  同一会话里单独改记忆块（体量与一次渲染同量级）**没有**让 `cacheRead` 塌陷。
- 解释：记忆块在 system prompt **末尾**，改它只会让「改动点之后」的字节失去命中，前面的系统/工具/技能前缀照旧命中，
  于是 `input` 只多了约百 token。
- 结论（对 §Recommended actions 的实测修正）：第 1、3 条的价值在本线路**测不到**——渲染的失效代价只剩它自己的字节，
  而交接的代价来自会话切换本身，抑制一次同刻渲染救不回来。第 2 条（块留在 system prompt 末尾）是本轮唯一有正收益的现状。
- 诚实边界：单线路（deepseek 直连）、沙箱、每格只跑一次；字段来自 provider 回报的 usage。中继线路是否透传 `cache_control` 仍未验。
