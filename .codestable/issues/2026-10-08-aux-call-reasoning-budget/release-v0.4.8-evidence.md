# v0.4.8 发布证据（2026-10-08）

## 版本与 tag

| 项 | 值 |
| --- | --- |
| 变更集 | ① 不透明回复的拒绝条件真正覆盖现场（第 14 轮 blocking B1：先剥规范标题 `# Project Memory`，再要求正文自带结构）；② 截断重试带上实测的隐藏思考用量；③ 上限告警计入 reasoning 预留；④ `/memory update` 等待前先提示 |
| 代码修订 | `099ebf3`（`memory/pass.ts` + 夹具）、`068b7e8`（`shared/output-budget.ts` + `index.ts` + `memory/report.ts` + 夹具）；范围 `5f76996` 之前的六个提交，其余为 CHANGELOG、docs、技能与 `.codestable` 记录 |
| tag | `v0.4.8` → tag 对象 `47fc7fc1f5cf8a13994de81a2591afdc29d90e73`，peeled `5f769962bfc7c3f2474014d8e3dbab237228c450`（`5f76996`） |
| 双远端 | forgejo 与 github 的 `refs/tags/v0.4.8` 均为 `47fc7fc…`、`v0.4.8^{}` 均为 `5f76996…`、`master` 均为 `5f76996…`（`git ls-remote` 实测） |
| pin | `~/.pi` 仓库 `20ceda8`：`agent/settings.json` + `README.md` 的 `pi-project-context@v0.4.8`（备份 `/tmp/settings.json.before-v0.4.8-1791462483`） |
| 安装副本 | `~/.pi/agent/git/git.lentech.site/C02-1010751281/pi-project-context`：`describe=v0.4.8`、`HEAD=5f76996`（= peeled tag）、工作区干净 |
| `pi update --extensions` | `* tag v0.4.8 -> FETCH_HEAD` → `HEAD 现在位于 5f76996` → `Updated packages` |

## 装内验证（不看版本标签，看树）

| 检查 | 结果 |
| --- | --- |
| 本版新增的判据标记 | 安装树 `memory/pass.ts` 命中 `replyHasStructure`（2 处：声明与使用，单行子串） |
| 本版新增的等待提示 | 安装树 `memory/report.ts` 命中 `Memory: consolidating`（1 处） |
| 装内 `consolidation-test.mjs` | `ALL OK`：`the retry carries the hidden reasoning the first attempt actually spent`、`the forced pass says it is consolidating before the wait`、两条现场串断言、`#.` 伪标题、40 字符边界、fresh 项目写入全绿 |
| 装内 `memory-ops-test.mjs` | `ALL OK`：`a reasoning route is charged for its hidden thinking`、`the warning names the reserve on a reasoning route` |

## 真机 settings 探针（默认设置，临时项目）

项目 `/tmp/probe-v048-1791462505`（`git init`），未传 `-ne`/`-e`：`pi -p` exit 0，写下
`.agents/memory/.gitignore`、`session-logs/.gitignore`、`session-logs/INDEX.md` 与一条 session 归档，**无 `errors.log`**。

**探针不覆盖本版四条修复**：自动 consolidation 需 ≥6 轮且 ≥5 分钟，一次性 `-p` 都不满足；四条修复由上面两条装内测试覆盖。

## 与审查链的关系

第 14 轮在**冻结的发布修订 `0450fc4`（v0.4.7）**上给出 CHANGES-REQUESTED：2 条 blocking（B1 拒绝不覆盖现场、B2 现场用例漏了
header）与 1 条 important（I3 记录自相矛盾），外加 4 条 nit；这四条已按上表处理，B1 的 5 条变异各恰红对应断言。
I1（称删除 `!renderRead.changed` 后全绿）**未能复现**：按「把该合取项换成 `true`」重测 2/2 都确定红
`read race: the journal's fold stands instead of the older bytes`，基线 2/2 全绿；I2（mtime+size 启发式）则与本报告已登记的残留一致。

**本版同样没有独立审查轮的 PASS**：v0.4.7 的缺口被第 14 轮证实并修掉，但 `5f76996` 这个修订本身尚未被审查轮看过；
若要正式收口，仍需对冻结修订再跑一轮。

**需要重启才生效**：运行中的 pi 进程仍持旧模块（tag、pin、安装树均已 v0.4.8），重启前 `errors.log` 里可能继续出现混版噪声。
