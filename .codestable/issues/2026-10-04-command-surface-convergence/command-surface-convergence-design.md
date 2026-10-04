---
doc_type: design
issue: command-surface-convergence
status: design-draft
revision: 2
date: 2026-10-04
decides: 参数按数据流层归位（命令面收束）；/context 与 /session-log 的归宿
supersedes: revision 1 的 Stage 1「新增 /project-context paths」——owner 指出伞形不该装路径（跨层混装），撤销
---

# 命令面收束设计（revision 2：按层归位）

## 0. 本轮现场事实（owner 两条判断）

1. `/project-context` 的参数"像是别的命令的"：不同层的东西混在一个命令里。
2. `/context` 到底干啥、对应啥；看起来都是归档层，为什么不和 `/session-log` 放一块。

两条都成立。但第 2 条的前提要更正：`/context` **不是**纯 L5（见 §2）。

## 1. 判据与层归属实测

判据：一个参数住哪，由**它改的东西属于哪一层**决定；只有被 ≥2 层共用的才住伞形。

| 参数 | 它改什么（模块） | 属于哪层 | 现在住哪 | 判定 |
| --- | --- | --- | --- | --- |
| `on\|off memory` | `autoConsolidate`（`memory/pass.ts` 自动 pass） | L2 记忆 | 伞形 | ❌ 层内私有开关跑到伞形 |
| `on\|off archive` | `archiveEnabled`（`archive/archive.ts` 写存档） | L5 归档 | 伞形 | ❌ 同上 |
| `on\|off handoff` | `handoffEnabled`（`handoff/run.ts`） | L3 交接 | 伞形 + `/handoff on\|off` | ⚠️ 重复入口 |
| `on\|off autolearn` | `autoLearn`（`autolearn/pass.ts`） | L4 自学 | 伞形 + `/autolearn on\|off` | ⚠️ 重复入口 |
| `max-memory <n>` | `maxMemoryChars`（`memory/store.ts` 裁剪） | L2 记忆 | 伞形 | ❌ L2 私有设置 |
| `model` / `max-tokens` | `shared/llm.ts` 的路由与预算，被 L2 pass / L3 summary / L4 提取**共用** | 跨层（L6） | 伞形 | ✅ 唯一正确归属 |
| `status` | 只读总览（六行，各层一行） | 跨层 | 伞形 | ✅ |
| `paths`（rev 1 拟加） | 只读路径（L2 + L5 的产物） | L2 + L5 | 伞形（拟） | ❌ rev 2 撤销 |

`FEATURE_FIELDS`（`shared/config.ts:27`）：`archive→archiveEnabled`、`memory→autoConsolidate`、`autolearn→autoLearn`、`handoff→handoffEnabled`。

## 2. `/context` 到底是什么（代码级答案）

- **注册层**：L5 —— `archive/archive.ts:171`，描述 "Show the project context and session log locations"。
- **输出的三行，一行一层的产物**：
  - `Context file: <CONTEXT.md>` → **L2 产物**（CONTEXT.md 由记忆层写）；
  - `Session index: <INDEX.md>` → L5；
  - `Session logs: <dir>` → L5。
- 四个路径 helper 都住在底座 L6：`shared/paths.ts`（`memoryFile` / `contextFile` / `sessionIndexFile` / `logsDir`）。
- `/memory` 裸调用**不印** `contextFile()`（只印 `memoryStatusMessage`）；`/session-log` 裸调用只印 `Session log written: <dir>`。

所以"都是 L5 怎么不放一块"的答案是：**L2 的那一行不在 L2 命令里，被 L5 的命令托管了**。这是层内缺位（§3 D2）的症状，不是两类东西该并在一起。

## 3. 三个结构缺陷

- **D1 跨层混装**：伞形同时担四种身份——跨层设置（`model`/`max-tokens`）、L2 私有设置（`max-memory`）、四层开关的批量入口、只读总览。
- **D2 层内缺位**：L2 缺 `on|off`、`max-memory`、CONTEXT.md 路径；L5 缺 `on|off`、session index / logs 路径。
- **D3 注册层 ≠ 内容层**：`/context` 注册在 L5，内容 1×L2 + 2×L5。

补一条根因：伞形的**名字**就是 `context`，而 `CONTEXT.md` 是 L2 的产物、`/context` 又印这个产物。v0.2.3 修的标签重载只是症状。

## 4. 方案甲：层归位（推荐）

| 命令 | 调整后 | 变化 |
| --- | --- | --- |
| `/memory`（L2） | 裸调用 = `Project memory: …` + `Context file: <path>`；`update`；**`on\|off`**；**`max-memory <n>\|default`** | 收 L2 缺的三格 |
| `/session-log`（L5） | 裸调用 = `Session log written:` + `Session index:` + `Session logs:`；`import <path…>`；**`on\|off`** | 收 L5 缺的两格 |
| `/handoff`（L3） | 不动（已有 `on\|off` 与 12 动词） | — |
| `/autolearn`（L4） | 不动（已有 `on\|off` 与 5 动词） | — |
| `/project-context` | 只剩 `status`、`model <p>/<id>\|off`、`max-tokens <n>\|default`，以及**批量** `on\|off <feature\|all>` | 去掉 `max-memory`；把 `on\|off` 明确定义为跨层批量入口 |
| `/context` | **退役** | 三行各归其层 |
| `paths` 动词 | **撤销**（rev 1 的 Stage 1 作废） | — |

代价：一次破坏性版本（4 条命令受影响）。收益：每条层内命令自足，伞形只剩跨层设置 + 总览。

## 5. 方案乙：最小（只并路径，不动开关）

- `/memory` 裸调用加 `Context file:` 一行；`/session-log` 裸调用加 index / logs 两行；退役 `/context`；`paths` 计划作废。
- 伞形保持现状（`max-memory`、`on|off` 不动）。
- 修掉 D2/D3，保留 D1；影响面最小（改 2 条命令 + 删 1 条）。

## 6. 验收（逐行覆盖，不是逐块相等）

实测细节：`status` 的 `Context file:` 行带更新时间（`index.ts:77` 的本地 `contextStatusLine`），与 `/context` 的裸路径行**本来就是两种渲染**，所以"零独有输出"只能按**逐行**判定：

- 对 `/context` 的三行分别断言：同一路径字符串出现在目标层命令的通知里，且由同一个 `shared/paths.ts` helper 生成。
- 反向对照：删掉某一层命令的该行 → 对应断言必须变红。
- `/project-context status` 行数不变（6 行）；`pi.commands` 里不存在 `context`。

## 7. 非目标 / 待决

**非目标**：不动 `/handoff`、`/autolearn` 其余动词；不引入 alias（pi 命令层无 alias 字段，只有 handler 内同义词：`language`→`lang`、`run|force`→`now`）；不做归档 retention；不合并 `on|off` 的批量语义本身。

**待决**：①方案甲 vs 乙；②若选甲，是否拆两步发（先乙后甲）；③版本号——破坏性命令面变更建议 v0.3.0。
