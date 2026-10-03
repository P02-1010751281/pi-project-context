# v0.2.0 发版证据

发版日：2026-10-03。

## 1. 提交与 tag

| 项 | 值 |
|---|---|
| 实现 | `a562d7e` `feat(memory): render consolidation output from structured sections` |
| 文档 | `afccf5c` `docs: document the sectioned memory path and the renamed commands` |
| 证据（设计/评审） | `e90dace` `docs(codestable): record the structured-output design, reviews, and naming decisions` |
| 记忆渲染 | `a870dc3` `docs(memory): refresh the memory render` ← **tag 所在提交** |
| 注释 tag | `v0.2.0`（tag object `cc85efdd`，peel 到 `a870dc3df47fbf41449b3e4b6ab6201071e7e7ae`） |
| 双远端 | `ssh://forgejo@git.lentech.site/.../pi-project-context.git` 与 `ssh://git@ssh.github.com:443/.../pi-project-context.git`，两者的 `refs/tags/v0.2.0` 均为 `cc85efdd…`，`master` 均为 `a870dc3d` |
| pi-config pin | `1ae281a` `chore(settings): pin pi-project-context to v0.2.0`（`agent/settings.json` + `README.md`），已推送 |

版本号取 `v0.2.0` 而非 `v0.1.13`：本次含**用户可见的破坏性变更**（命令改名 + 删除 `/context-update`），minor 进位以显式标示。

## 2. 发版前核对

- `node tests/run-all.mjs` → **All 14 tests passed**；`git diff --check` 干净。
- 代码侧独立评审 **7 轮**，全部归档于本目录：R1–R5 为 `CHANGES-REQUESTED`（发现全部修复），**R6、R7 连续 `VERDICT: PASSED`**，且 R7 覆盖的正是被 tag 的代码。R7 后唯一的改动是一条**测试**用例（评审指出的不具区分度用例），已用变异检查自证（移除 `run.length >= openFence.run.length` 条款后该用例 FAIL）。
- 每轮沙箱均以 `git status --porcelain -uall` + `find … stat` 双快照 `diff` 证明**零写入**。

## 3. 装机克隆校验

`pi update --extensions` 后：

| 检查 | 结果 |
|---|---|
| 克隆路径 | `~/.pi/agent/git/git.lentech.site/C02-1010751281/pi-project-context/` |
| `HEAD` | `a870dc3df47fbf41449b3e4b6ab6201071e7e7ae` = tag peel ✅ |
| 工作树 | 干净（0 处改动）✅ |
| 版本标记 | `INVISIBLE_RE` / `isHeadingOnlyDocument` / `record_memory` / `UNTERMINATED_TAG_RE` 均存在于装机 `extensions/project-context/memory/sections.ts` ✅ |
| 装机克隆自测 | `node tests/run-all.mjs` → **All 14 tests passed** ✅ |

## 4. 真实 settings 探针

**第一次（无效，如实记录）**：默认设置（默认 provider 为 `deepseek`）在 `/tmp/pc-v020-probe-QKH5` 启动，模型返回 `402 Insufficient Balance`。按项目不变式，**402 不得记作验证成功**。该次的观察：扩展 fail-closed，**未**写出 `MEMORY.md`/`CONTEXT.md`，只在 `errors.log` 记了一条 `model call error` —— 这是正确行为，但不构成本次发版的验证证据。

**第二次（有效）**：`/tmp/pc-v020-probe2-bKO8`，`pi -p --model commandcode/deepseek/deepseek-v4.1-flash-fast "Create a file named notes.md containing exactly one line: hello world. Then reply DONE."`

产物：

```
.agents/memory/MEMORY.md          ← 四分节 schema（Project / Invariants / Pitfalls / Index），全 bullet
.agents/memory/CONTEXT.md         ← Summary / Key points / Open tasks（含 latest-session-title 注释）
.agents/memory/memory.jsonl       ← 追加日志
.agents/memory/.gitignore
.agents/memory/session-logs/…     ← 归档
```

`MEMORY.md` 渲染为**固定四节 + bullet 条目**（即结构化路径的产物形态），`CONTEXT.md` 三节齐备，**没有 `errors.log`**。

与 v0.1.12 探针（`/tmp/pc-v0112-probe-1X2T`）的差异：那次没有 `project-context.json`（本次也没有——两者都走默认配置，未写该文件属正常）。

**注释**：探针用 `--model` 指定了可用模型（默认 `deepseek` 余额为 0）。这不是 `-ne`/`-e` 的隔离模式，扩展按 settings 正常加载，所以仍是「settings 装机」路径；但**模型不是默认值**这一点如实记录。

## 5. 用户可见的破坏性变更（release notes 必列）

| 旧 | 新 |
|---|---|
| `/memory-learn` | `/memory update`（无别名、无过渡期） |
| `/auto-handoff` | `/handoff`（无别名、无过渡期） |
| `/context-update` | **删除**（无别名、无过渡期） |
| `/context` | 不变（`CONTEXT.md` 是 consolidation 产物，不是会话日志） |

其余命令（`/memory`、`/session-log`、`/project-context`、`/autolearn`）不变；所有存留命令都注册了 `getArgumentCompletions`。

## 6. 需要重启

`pi update --extensions` 只换磁盘上的克隆；**已在运行的 pi 进程仍在使用它们启动时加载的代码**。要吃到 v0.2.0 必须重启 pi。状态行里没有 `· summarize …` 也说明进程是旧的。

## 7. 本次接受并已记录的残余风险

均在决策 6 / D7 与 `implementation-note.md` 中记录，方向为 fail-open（跳过写入）或 fail-safe（保守拒写），**不触及静默覆盖真记忆的路径**：

- fail-open：散文前言包裹骨架、`---` setext 骨架、info-string fence 行保持代码块打开；
- fail-safe：孤行 `<T>` / `<hN>…</hN>` / `<tel:…>`、4 空格缩进的 fence 关闭符、纯标点/emoji 正文会被保守拒写；
- 性能：`TAG_SPAN_RE` 在病态 `<` 串上为 O(n²)，因回复受 token 上限约束，实测最坏约 2 秒；
- 未验证项：strict 模式真正生效时的端到端证据仍缺（本机可用路由不支持或未验证 strict）。
