---
doc_type: design
issue: command-surface-convergence
status: design-draft
revision: 3
date: 2026-10-04
decides: 命令面按层归位的完整契约（含命名修法与 /context 拆分）
supersedes: revision 2 的甲乙并列；owner 已定向「一块修」，本版按甲 + 命名 + 拆分写死
---

# 命令面收束设计（revision 3：完整契约）

## 0. 定向与判据

owner 定向：要完整表；命名问题一块修；`/context` 拆分或另法修掉。

判据：一个参数住哪，由**它改的东西属于哪一层**决定；只有被 ≥2 层共用的（`model`、`max-tokens`、`status`）
以及**跨层批量操作**（`on|off <feature|all>`）才住伞形。层内私有设置一律回本层命令。

## 1. 调整后完整命令面

| # | 命令 | 动词 / 参数 | 取值 | 效果（键 / 只读） | 层 | 调整 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `/project-context` | 裸 | — | = `status` | 跨层 | 不变 |
| 2 | | `status` | — | 只读六行总览 | 跨层 | 不变 |
| 3 | | `on\|off <feature\|all>` | `archive` `memory` `autolearn` `handoff` `all` | `archiveEnabled` `autoConsolidate` `autoLearn` `handoffEnabled` | 跨层批量 | **保留**，语义明确为批量入口 |
| 4 | | `model <provider>/<id>` | 或 `off` / `session` | `provider` `model` | 跨层 L6 | 不变 |
| 5 | | `max-tokens <n>` | 或 `default` | `maxTokens` `maxOutputTokens` | 跨层 L6 | 不变 |
| 6 | | ~~`max-memory <n>`~~ | — | `maxMemoryChars` | L2 | **移出 → `/memory`** |
| 7 | `/memory` | 裸 | — | 只读：`MEMORY.md` 状态 + **`Context file:` 路径（新）** | L2 | 加一行 |
| 8 | | `update` | — | 立即 consolidation（采集→装配→模型→解析→闸门→持久） | L2 | 不变 |
| 9 | | `on\|off` | — | `autoConsolidate` | L2 | **新增** |
| 10 | | `max-memory <n>\|default` | 整数 / `default` | `maxMemoryChars` | L2 | **移入** |
| 11 | `/handoff` | 裸 / `status` | — | 只读一行 | L3 | 不变 |
| 12 | | `on\|off` | — | `handoffEnabled` | L3 | 不变 |
| 13 | | 裸比例 | `0.4` / `40%` | `handoffThresholdRatio` | L3 | 不变 |
| 14 | | `auto` | — | `handoffAdaptive` | L3 | 不变 |
| 15 | | `target <n>` | token 数 | `handoffTargetTokens` | L3 | 不变 |
| 16 | | `keep <n>\|off` | token 数 / `off` | `handoffKeepTokens` | L3 | 不变 |
| 17 | | `thinking <off\|session\|level>` | 补全只列 `off` `session` | `handoffSummaryThinking` | L3 | 不变 |
| 18 | | `send` \| `draft` | 两个裸词 | `handoffMode` | L3 | 不变 |
| 19 | | `guard <wait\|draft\|send\|skip>` | 四选一 | `handoffGuard` | L3 | 不变 |
| 20 | | `lang <auto\|zh\|en>` | handler 亦认 `language` | `handoffLanguage` | L3 | 不变 |
| 21 | | `now` | handler 亦认 `run` / `force` | 立即交接（`newSession`） | L3 | 不变 |
| 22 | `/autolearn` | 裸 | — | 立即沉淀 | L4 | 不变 |
| 23 | | `list` | — | 列出候选 | L4 | 不变 |
| 24 | | `approve <name>` | 候选名 | apply → `.agents/skills/` | L4 | 不变 |
| 25 | | `reject <name>` | 候选名 | 删候选 | L4 | 不变 |
| 26 | | `on\|off` | — | `autoLearn` | L4 | 不变 |
| 27 | `/session-log` | 裸 | — | 只读：存档状态 + **`Session index:` + `Session logs:`（新）** | L5 | 由「写」改为「读」¹ |
| 28 | | `write` | — | 立即写当前存档 | L5 | **新增**（承载原裸调用动作）¹ |
| 29 | | `import <path…>` | 文件 / 目录，可多个 | 回填存档 + 重建索引 | L5 | 不变 |
| 30 | | `on\|off` | — | `archiveEnabled` | L5 | **新增** |
| 31 | `/context` | — | — | — | — | **退役**（三行按 §2 拆分） |

¹ 若不想动裸调用语义，退回最小版：裸调用保持「写」，写完再印 `Session index:` / `Session logs:` 两行（无 `write` verb）。
推荐 ¹ 的方案：裸调用只读与 `/memory`、`/handoff`、`/project-context` 一致；写动作由 `write` 显式触发，
而 pi 侧 `turn_end` / `agent_settled` / `session_shutdown` 本来就会自动写。

## 2. `/context` 拆分：三行的去向

| `/context` 的行 | 产物层 | 新家 | 渲染 |
| --- | --- | --- | --- |
| `Context file: <CONTEXT.md>` | L2 | `/memory` 裸调用 | `shared/paths.ts::contextFile()` |
| `Session index: <INDEX.md>` | L5 | `/session-log` 裸调用 | `shared/paths.ts::sessionIndexFile()` |
| `Session logs: <dir>` | L5 | `/session-log` 裸调用 | `shared/paths.ts::logsDir()` |

四行路径 helper 本来就都住底座 `shared/paths.ts`（L6），所以拆分只是换调用点，不新增 helper。

## 3. 命名

| 冲突面 | 现状 | 修法 |
| --- | --- | --- |
| **命令层**：`/context` vs `/project-context` | 两条命令都含 `context`，一条印产物、一条是控制面 | 拆分后退役 `/context`，命令层只剩一个含 `context` 的命令；歧义源头消失 |
| **产物称呼** | v0.2.3 前是 `Context:`（status）与 `Project context:`（`/context`）两套 | v0.2.3 已统一为 `Context file:`；本次不动 |
| **伞形名** | `/project-context` 听起来像「项目上下文」，实际是「设置 + 状态」 | **保留名字**，把注册描述改成 `settings and status for this extension`（补全菜单可见）。理由：pi 无 alias 字段，改名是硬切且零功能收益；扩展命名空间命令用扩展名是既有惯例（`/handoff`、`/autolearn` 同理） |

若 owner 仍要改伞形名：候选 `/settings`（表达准确，但与 pi 未来可能的 `/settings` 有撞名风险）、
`/pc`（短，需靠描述理解）。二者都是硬切，无过渡期，改则一并更新 §4 的连带字符串。

## 4. 连带修改（用户可见字符串与文档）

| 位置 | 现文 | 改后 |
| --- | --- | --- |
| `memory/status.ts` 截断提示 | `raise it with /project-context max-memory <n>` | `/memory max-memory <n>` |
| `index.ts` cap 上限告警 | `lower it with /project-context max-memory <n> or raise …` | 指向 `/memory max-memory` |
| `index.ts` max-memory 用法串 | `Usage: /project-context max-memory …` | `Usage: /memory max-memory …` |
| `memory/report.ts` 路由提示 | `Fix the route with /project-context model` | 不变（`model` 留伞形） |
| `handoff/settings.ts` 注释 | 引 `/project-context off handoff`、`off memory` | 不变（批量入口保留） |
| `docs/configuration.md` | 六命令表 + 入口关系段 + 改名说明 | 更新三行命令表；改名说明加 `/context` → 拆分去向；`max-memory` 行移到 `/memory` |
| `CHANGELOG.md` | v0.2.3 | 新增 v0.3.0（破坏性命令面变更） |

## 5. 验收

- **逐行覆盖**（不是逐块相等）：`/context` 的三行各断言出现在目标层命令的通知里，且由同一 helper 生成。
  原因：`status` 的 `Context file:` 行带更新时间戳（`index.ts:77` 的本地 `contextStatusLine`），与 `/context` 的裸路径行本来就不同渲染。
- **单侧变异**：删掉 `/memory` 或 `/session-log` 的某一行 → 对应断言必须变红。
- `pi.commands` 中不存在 `context`；`/project-context` 补全表不再含 `max-memory`；`/memory` 补全含 `on|off`、`max-memory`；`/session-log` 补全含 `write`、`on|off`。
- `status` 仍六行（`Memory cap warning:` 行仅在触发时出现，文本改指 `/memory`）。
- 全套 `node tests/run-all.mjs` 绿（只加断言，不新增测试文件）。

## 6. 工作量与发版

| 件 | 估计 |
| --- | --- |
| `index.ts`：去 `max-memory` 动词 + 补全 + 用法串 + 两处提示 | ~12 行 |
| `memory/report.ts`：加 `on\|off`、`max-memory`、裸调用加 `Context file:` 行 + 补全 | ~25 行 |
| `archive/archive.ts`：删 `/context` 注册、`/session-log` 裸调用改只读 + `write` + `on\|off` | ~25 行 |
| `memory/status.ts` 提示串 | 1 行 |
| 测试断言（registration + 覆盖/变异） | ~40 行 |
| docs + CHANGELOG | ~20 行 |

经验修正（本仓估计偏低约 1.7x）：预算 **~200 行**。属 `extensions/` 改动 ⇒ **tag + pin + 重启**；
破坏性命令面变更 ⇒ 版本号 **v0.3.0**。

## 7. 非目标与待决

**非目标**：不动 `/handoff`、`/autolearn` 的其余动词；不引入 alias（pi 命令层无 alias 字段，只有 handler 内同义词）；
不做归档 retention；不合并 `on|off` 的批量语义。

**待决**：①go / no-go（本版把甲 + 命名保留 + `/context` 拆分写死）；②`/session-log` 裸调用取「只读 + `write`」还是最小版「写完再印」；③若 go，一次发 v0.3.0。
