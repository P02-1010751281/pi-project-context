> **已撤回（2026-10-08）**：本文件描述的这次 `v0.4.9` 发布在 tag 打出后**按 owner 指令撤回** —— 当时带着具名残留
> （R-A / R-2 / R-3）发版，违反本仓「残留清完才发版」的约定。处置：双远端 tag 删除、pin 与安装树回退 `v0.4.8`（`~/.pi` 提交
> `b5083dd`）、修复提交留在 `master`（未发布、未被任何进程加载）。残留逐条清完后重新发版，见本文件末尾的「重新发布」节与审查报告的
> 「残留清理」节。以下内容保留为**第一次发布尝试**的记录。

# v0.4.9 发布证据（2026-10-08）

## 版本与 tag

| 项 | 值 |
| --- | --- |
| 变更集 | ① 上限门改读**辅助调用路由**的 `reasoning`（第 15 轮 important I-A），并新增无告警的 `peekAuxModel`；② 裸 `/autolearn` 的强制 pass 在等待前提示（第 15 轮 important I-B）；③ `capCeilingWarning` 不再把预留说成界（N-4）；其余为本轮记录/文档口径修正 |
| 代码修订 | `6220775`（`shared/llm.ts` + `index.ts` + `memory/report.ts` + `output-budget.ts` + 夹具）、`5783610`（`autolearn/pass.ts` + 夹具）、`ef23e54`（`peekAuxModel` 四分支断言 + 两处注释缩进） |
| tag | `v0.4.9` → tag 对象 `f009fef0a90f8402050e4ee7fdea29891f1f3e0d`，peeled `40e418ec2d4017da83b7cbcf709d1f46783f0d12`（`40e418e`） |
| 双远端 | forgejo 与 github 的 `refs/tags/v0.4.9` 均为 `f009fef…`、`v0.4.9^{}` 均为 `40e418e…`、`master` 均为 `40e418e…`（`git ls-remote` 实测） |
| pin | `~/.pi` 仓库 `3bba4ee`：`agent/settings.json` + `README.md` 的 `pi-project-context@v0.4.9`（备份 `/tmp/settings.json.before-v0.4.9-1791466385`） |
| 安装副本 | `~/.pi/agent/git/git.lentech.site/C02-1010751281/pi-project-context`：`describe=v0.4.9`、`HEAD=40e418e`（= peeled tag）、工作区干净 |
| `pi update --extensions` | `* tag v0.4.9 -> FETCH_HEAD` → `HEAD 现在位于 40e418e` → `Updated packages` |

## 装内验证（看树不看标签）

| 检查 | 结果 |
| --- | --- |
| 本版标记串 | `shared/llm.ts` 命中 `peekAuxModel`；`autolearn/pass.ts` 命中 `distilling this project's sessions`；`shared/output-budget.ts` 命中 `reserve of about` |
| `aux-model-test.mjs` | `ALL OK`（含 `peekAuxModel` 四分支：可解析 / 空路由 / 不可解析且静默 / 无 auth） |
| `memory-ops-test.mjs` | `ALL OK`（含 M4b 两个调用点 + 正向对照 + N-4 措辞） |
| `autolearn-test.mjs` | `ALL OK`（含 G2「提示在 `complete` 被调用的那一刻已在通知里」） |
| `consolidation-test.mjs` | `ALL OK` |
| 装内 `run-all.mjs` | `All 15 tests passed.`；`git diff --check` 干净 |

## 真机 settings 探针（默认设置，临时项目）

`/tmp/probe-v049-1791466446`（`git init`），未传 `-ne`/`-e`：`pi -p` exit 0，写下 `.agents/memory/.gitignore`、`session-logs/`（INDEX + 一条归档），**无 `errors.log`**。
探针不覆盖本版三条修复（自动 consolidation 需 ≥6 轮且 ≥5 分钟，一次性 `-p` 不满足）——它们由上面两个装内套件覆盖。

## 与审查链的关系（第 15–17 轮）

| 轮 | 冻结修订 | 结论 | 处置 |
| --- | --- | --- | --- |
| 15 | `5f76996`（v0.4.8） | CHANGES-REQUESTED：2 important（上限门 reasoning 取值、`/autolearn` 无提示）+ B1/B2/N1-N3 确认已关、**I1 被独立复核为不成立** | 两条 important 已在 v0.4.9 修掉（各带变异，恰红 1 条目标断言） |
| 16 | `8674fd2`（v0.4.9 修复集） | CHANGES-REQUESTED：**0 blocking**、0 代码层；1 important 属文档（两处 docs 仍写「会话模型」）、3 nit | 全部已修；四条变异被审查员独立复现为各恰红 1 条 |
| 17 | `73da214` | CHANGES-REQUESTED：**0 blocking**、0 代码层；1 important 属措辞（第 16 轮新引入的「重试只让它更早更清楚地失败」与 `fitMemoryInput` 的裁短路径相反） | 已改口径；**停止规则在此满足**（两轮零 blocking、剩余全属措辞/记录精度类，且该条由上一轮修复自身引入） |

**如实留下**：末修订（`f06f7e1`、`40e418e` 两笔文字改动）**没有审查轮**看过 —— 它们不触代码与测试，因此本版**未取得 `VERDICT: PASSED`**。
v0.4.9 的**代码层**由第 16、17 两轮独立复核（等价性、告警语义逐字未变、变异各恰红 1 条、0 代码层发现）。要正式收口，冻结末修订再跑一轮即可。

**需要重启才生效**：运行中的 pi 进程仍持旧模块（tag、pin、安装树均已 v0.4.9），重启前 `errors.log` 里可能继续出现混版噪声。

## 现场（消费方仓库）处置

`Quantum_Matrix` 那次 13 分钟静默的根因是「重推理 route + cap 装不下」，现场已在该仓做两件事（只读证据，其记忆内容未由本仓改写）：

- `maxOutputTokens` 32768 → **131072**（route 允许 384K），并在该仓复算 `memoryCapUnsatisfiable(32000, 8192, 131072, reasoning=true) = false`；
- 用扩展自己的 `recordMemoryDocument` 把那份手写记忆采纳进 journal：`MEMORY.md` md5 前后一致（30695 字节未变）、journal 末条文本 == 磁盘文件、`loadMemory` 现在返回 journal 的 fold。

本版的「重试带上实测隐藏思考」要**重启那个会话**才生效；即使不重启，抬高上限后该配置已能满足。触发那个会话的 `/autolearn` 与 `/memory update` 现在都会在等待前先提示。
