---
doc_type: fix-note
issue: command-surface-convergence
date: 2026-10-04
released_in: v0.3.0
decision: owner 五问 + 兼容链议题全部答定（2026-10-04），并要求「一步到位，不拖到 v0.4.0」
---

# 修复说明：命令面按层收束 + 配置旧形态一次性迁移

## 现场事实（为什么动）

命令面审计（`.agents/skills/pi-project-context-command-surface-audit/`）给出的四条可机检事实：

1. **同一事实两个渲染点**：memory 状态行在 `index.ts` 与 `report.ts` 各一份（v0.2.2 才统一），
   而 CONTEXT.md 那一行在 `/project-context status` 与 `/context` 里各写一遍，两处措辞已不同。
2. **一个参数住在不改变它的层**：`max-memory` 与四个特性开关挂在伞形命令下，但四层的参数语义是各层自己的。
3. **`/session-log` 无参是唯一「读会写文件」的路径**，而 `archive/archive.ts` 已经在
   `turn_end` / `agent_settled` / `session_shutdown` 归档 —— 手动裸写是冗余的副作用。
4. **`/handoff` 的裸比例与 `auto` 并列成两个动词**，`target`/`keep` 只给数字不说量的是什么
   （一个量摘要上限、一个量保留窗口）。

配置兼容链的实测（本仓 `.codestable/` 记录，不写进 curated 面）：全机 9 个 `project-context.json` 全部扁平 23 键、
0 个旧分文件、全局旧文件不存在，扁平化提交 `b5d825d`（2026-09-25）之后新增的 8 个键从来没有回退项；
共享同一 config 面的兄弟实现也只读扁平键。⇒ 链**长但静态**，可以一次性收掉，不必留常驻读路径。

## 改动

| 文件 | 改动 |
| --- | --- |
| `shared/config.ts` | 三条旧形态（同文件嵌套、`<memory>/autolearn.json`、全局 `auto-handoff.json`）收进唯一一个 `legacyConfigPatch()`；`getConfig` 首次读时 `migrateLegacyConfig()` 折进扁平键并整份写回（走 `updateConfig` 的跨进程锁），记下 `takeConfigMigrationNotice()`；`parseConfig` 只读扁平键；删 `legacyDefaults` |
| `index.ts` | 裸 `on\|off` 变四特性**批量**且拒绝目标（`The batch form takes no target; /project-context off sets all four features.`）；删本地 `max-memory`；描述改 `cross-layer settings`；补全表去掉特性值与 `max-memory` |
| `memory/report.ts` | `/memory` 动词 `update` / `on\|off` / `max-memory <n>\|default`；无参打 `Project memory: …` + `Context file: …`；`session_start` 消费迁移通知并 `notify` |
| `memory/status.ts` | 新增 `contextStatusLine(projectRoot)`（`Context file: … — updated …`），两个入口共用；截断提示改指 `/memory max-memory <n>` |
| `archive/archive.ts` | 删 `/context` 注册；`/session-log` 无参**只读**（`Session archive:` + `Session index:` + `Session logs:`）、`write`、`import`、`on\|off` |
| `handoff/run.ts` | `threshold <auto\|比例>`、`budget summary <n>`、`budget recent <n\|off>`、`mode <send\|draft>`；删裸比例 / `auto` / `target` / `keep` / `send` / `draft`；保留 `force-auto`、`language`、`run\|force`；状态行 `· summary budget 64k` |
| `shared/complete.ts` | 新增 `completeSubValues(prefix, head, sub, choices)`（三级补全：`budget summary\|recent`） |
| `shared/output-budget.ts` | `capCeilingWarning(cap)` 从 `index.ts` 提为导出 |
| `handoff/threshold.ts` | 点名句改 `/handoff budget summary` |
| `autolearn/prompt.ts` | 见「顺带」 |

规模：16 个文件，+569 / −259。

## 用户可见变化

- `/context` **退役**，三行按归属拆：context 文件行 → 裸 `/memory`（与伞形共用 `contextStatusLine()`，不可能漂移），
  session 索引与日志目录 → 裸 `/session-log`。
- `max-memory` 与特性级 `on|off` 移入本层命令；伞形 `on|off` 只做无目标批量，**不是扩展开关**
  （唯一整扩展禁用仍是 run 级 `--no-project-context`）。
- `/handoff` 公开动词 **13 → 9**；裸比例与裸 `send`/`draft` **硬切**（不设别名、不提示、不兼容）。
- 裸 `/session-log` 只读；写走 `write`。
- 首次读旧配置的项目会收到一条通知：`project-context config written in the flat layout (migrated from …)`。
- **配置键一个都没改**，所以没有键迁移。

## 回归钉子

`tests/switches-test.mjs`（命令面与迁移）、`tests/memory-ops-test.mjs`（`/memory max-memory` 五处）、
`tests/handoff-test.mjs`（阈值/预算/mode 落键）、`tests/registration-test.mjs`（四项补全、`/context` 不再注册）、
`tests/autolearn-test.mjs`（提示词四条）。测试文件数不变，只加断言。

变异验证（本轮实测，每组只打红自己的断言）：

| 变异 | 期望 | 实测 |
| --- | --- | --- |
| 改 `/memory` 的 `Context file:` 标签（共享 helper 的**单侧**调用方） | 2 条逐行断言红 | FAIL 2 行 |
| 给 `handoff.maxTokens` 加回旧形态回退项 | 冻结断言红 | FAIL 1 行 |
| 让裸 `/session-log` 重新写文件 | 只读证明红 | FAIL 1 行 |
| 删 autolearn 跨仓边界规则 | 边界断言红 | FAIL 1 行 |
| 删 autolearn 形态模式规则 | 形态断言红 | FAIL 1 行 |
| 全部还原 | 15/15 绿 | FAIL 0 |

注意：改**共享函数本身**（`status.ts`）会让两个入口一起变，等式钉子不会红 —— 所以共享渲染点的钉子必须靠**单侧**变异验证。

## 配置迁移的边界

- 扁平键已有的值永远优先（`put()` 对 `raw[key] !== undefined` 直接返回），所以迁移**不可能覆盖当前设置**。
- 空 patch 也会重写文件，这正是丢掉已无用的嵌套键的方式；`updateConfig` 在锁内重读，无丢更新问题。
- 冻结是**结构性**的：迁移之后没有任何读路径认识旧形态，所以「新键顺手加个回退项」不可能发生；
  用一条断言钉住（嵌套记录里的 `handoff.maxTokens` 必须被默认值压过）。
- 迁移只发生在**首次读配置**；同轮已在缓存里的项目不会再迁移。

## 发布含义

代码落在 `extensions/`，所以这是新 tag（v0.3.0）+ `~/.pi` pin 更新 + **重启 pi** 的发布；
`pi update --extensions` 只替换磁盘代码，不热替换已加载模块。见同目录 `release-v0.3.0-evidence.md`。
设计文档同目录，已改 `status: design-frozen` 并在 banner 记实现提交。

## 非目标与残留

- **不按层拆 `model`/`max-tokens`**：全机只有 1 个值偏离默认、8 个 handoff 开关从未被碰过，
  且伞形自己的暂停提示就把它称作一条专用路由；将来若出现「某一层单独被配额卡住」的现场事实，再做可选覆盖 + 继承默认。
- **不做归档 retention**：`/session-log` 的体积在它写的存档里，属保留策略，不是命令面问题。
- **不加命令别名**：pi 的 `RegisteredCommand` 没有 alias 字段，改名只能是硬切或二次注册；本仓取硬切。
- **autolearn 只能新增技能**（`candidate.ts` 拒绝重名）：提议「更新/合并既有技能」需要候选 schema 决策，
  记为非目标；现场事实只有一条技能，不足以立设计。

## 顺带（同一轮，非本修复）

- **autolearn 提示词补三条**：只写本项目自己的持久事实（绝不搬他仓测量值）、检查写成**形态**
  （如 `[0-9]{2,3},[0-9]{3} chars`）而非一次测量值、描述限定一行短句且已有技能覆盖时宁可不提案。
  触发事实：生成的技能正文里出现兄弟仓测量值 + 由一次运行数字搭的守卫正则。
- **技能整合**：`command-retire-rename` 并入 `command-surface-audit`；`consolidation-prompt-rule` 修掉两处违规
  （兄弟仓测量值、字面数字守卫）并去掉会腐烂的 tag 哈希，从未跟踪收编为 tracked。技能目录 18 → 17。
- **记忆渲染**：`docs(memory)` 单独提交（五命令面、批量非总开关、迁移不变式、autolearn 边界）。
