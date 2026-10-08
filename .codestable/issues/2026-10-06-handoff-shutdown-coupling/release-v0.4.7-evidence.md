# v0.4.7 发布证据（2026-10-08）

## 版本与 tag

| 项 | 值 |
| --- | --- |
| 变更集 | 两处 tag 之后的代码修复：① **不透明回复不再替换整篇记忆**（完全没有 markdown 标题、≥ `OPAQUE_DOCUMENT_MIN_CHARS`=40、且存储为可解析四节文档 ⇒ 跳过写入并写 `carried no entries` 诊断）；② **`loadMemory` 只读一次**（登记残留 R-L1） |
| 代码修订 | `b7e2a31`（`memory/store.ts` + 夹具）、`95d29fc`（`memory/pass.ts` + `memory/report.ts` + 夹具）；范围 `dbddb52..0450fc4` 共 11 个提交，其余为记录、技能与记忆渲染 |
| tag | `v0.4.7` → tag 对象 `4936eacb4b2c018b612383d1de1456f2292c57ff`，peeled `0450fc4c339ac167141d2be789700a5f19317188`（`0450fc4`） |
| 双远端 | forgejo 与 github 的 `refs/tags/v0.4.7` 均为 `4936eac…`，`refs/tags/v0.4.7^{}` 均为 `0450fc4…`（`git ls-remote` 实测） |
| pin | `~/.pi` 仓库 `0c33b0f`：`agent/settings.json` + `README.md` 的 `pi-project-context@v0.4.7`（备份 `/tmp/settings.json.before-v0.4.7-1791456581`）；该仓另有两个与本次发布无关的未提交文件，未一并提交 |
| 安装副本 | `~/.pi/agent/git/git.lentech.site/C02-1010751281/pi-project-context`：`describe=v0.4.7`，`HEAD=0450fc4`（= peeled tag），工作区干净 |
| `pi update --extensions` | `* tag v0.4.7 -> FETCH_HEAD` → `HEAD 现在位于 0450fc4 …` → `Updated packages` |

## 装内验证（不看版本标签，看树）

| 检查 | 结果 |
| --- | --- |
| 本版新增的守卫标记 | 安装树的 `extensions/project-context/memory/pass.ts` 命中 `conversationalOpaque`（2 处：声明与使用）；用单行子串匹配，避免跨行注释返回 0 命中的陷阱 |
| 装内测试（本次修复的承重面） | `node tests/consolidation-test.mjs` → `ALL OK`，其中 `a conversational reply leaves the stored memory byte-identical`、`a conversational reply is reported as carrying no entries` 与正向对照 `an opaque reply that is a document is still accepted` 全绿 |
| 装内测试（交接面） | `node tests/handoff-test.mjs` → `handoff: all checks passed.` |

## 真机 settings 探针（默认设置，临时项目）

项目 `/tmp/probe-v047-1791456654`（`git init`），未传 `-ne`/`-e`：

| 运行 | 结果 |
| --- | --- |
| `pi -p "Add a short docstring to this project README …"` | exit 0，正常回答；模型看见了 `.agents/memory/`（上下文注入生效） |
| 产物 | `.agents/memory/.gitignore`（207 B）、`session-logs/.gitignore`（62 B）、`session-logs/INDEX.md`（229 B）、`session-logs/<id>/session.md`（138.7 KB）与 `session.jsonl`（106.1 KB） |
| 干净度 | **无 `errors.log`**、无 `MEMORY.md`、无 `memory.jsonl` |

**探针不覆盖本次两条修复**：自动 consolidation 需同时满足 ≥6 轮与 ≥5 分钟两个节流，一次性 `-p` 两者都不满足，
退出只做不调模型的 flush（在一个尚无记忆文件的项目里无事可做）。所以探针正面验证的是「加载 + 归档 + 不留错误」，
而不透明回复拒绝与 `loadMemory` 的单次读取由上面那条装内 `consolidation-test.mjs` 覆盖。

## 与审查链的关系

第 6 轮在 `c212fcf` 给过代码层 PASS；第 7–13 轮全部 CHANGES-REQUESTED 且没有代码层发现，链按停止规则关闭，
**未取最终 PASS**。本次发布的两个修复都落在收链之后：各自带变异检查（R-L1 变异后恰红 1 条且正向对照保持绿；
不透明拒绝恰红 2 条且正向对照保持绿），但**没有独立审查轮覆盖**。
现场事实、修法与变异结果见 `shutdown-flush-review-report.md` 的「收链后的修复」小节。

**需要重启才生效**：已经在跑的 pi 进程仍持有旧模块 —— 本仓的 tag、`~/.pi` 的 pin 与安装树的 checkout 都已是 v0.4.7，
但运行中的进程不会热替换模块，重启前 `errors.log` 仍可能有混版噪声。
