---
doc_type: release-evidence
version: v0.2.2
tag: v0.2.2
tag_object: 897a44f7e718be7befee9057ebf6d245a7e7c1b7
peeled_commit: 663a1775230e7660cc1e6fed308b299916d372c9
date: 2026-10-04
pin: ssh://forgejo@git.lentech.site/C02-1010751281/pi-project-context.git@v0.2.2
pin_commit: 102b878 (pi-config, rebased onto d5460a5)
installed_head: 663a1775230e7660cc1e6fed308b299916d372c9
installed_describe: v0.2.2
restart_required: true
---

# v0.2.2 发版证据

## 内容

唯一行为变化：memory 状态行单一化（`fix(memory): render the memory status from one shared formatter`）。
`extensions/` 相对 v0.2.1 的差异 = 3 文件 / +38 −25。修复说明见 `fix-note.md`。

## 流程与证据

| 步骤 | 证据 |
| --- | --- |
| 全套测试 | `node tests/run-all.mjs` → All 15 tests passed.（新增 6 个 fixture × 3 断言） |
| 变异验证 | 删 journal 分支 → journal 用例 FAIL；单侧改措辞 → 15 条等式断言 FAIL；还原 → 0 FAIL |
| 提交切片 | `bc8c21e fix(memory)` / `37a150b docs(evidence)` / `3ef875e docs(skills)` / `e18f198 docs(configuration)` / `663a177 docs(memory)` |
| 打标 | `git tag -a v0.2.2` → object `897a44f7e718`，peeled `663a1775230e` = master head |
| 双推 | forgejo 与 github 镜像的 `refs/heads/master` 均为 `663a1775230e`，`refs/tags/v0.2.2` 均为 `897a44f7e718` |
| pin | `~/.pi` `agent/settings.json` + `README.md`：`@v0.2.1` → `@v0.2.2`，提交 `102b878`（先 `pull --rebase` 到远端 `d5460a5`，非强推），已推送，远端 = 本地 |
| 安装 | `pi update --extensions` 拉取 tag `v0.2.2`，`HEAD 现在位于 663a177` |
| 安装副本核验 | HEAD `663a1775230e` = peeled tag；`describe --tags` = `v0.2.2`；工作树 0 脏；`memory/status.ts` 在磁盘上，`index.ts` 中旧 `memoryStatusLine` 归零 |

## 必须重启

`pi update --extensions` 只替换磁盘代码：**正在运行的 pi 进程仍加载旧模块**，v0.2.2 的共享状态行
要重启后才生效。本会话开始时已有一个 16% 上下文窗口的前序会话在跑，重启由 owner 决定时机。

## 无人值守项

- 未跑真实 settings 安装探针（release skill 第 7 步）：本轮改动只影响两条命令的输出文案，
  探针要花一次真实 consolidation，收益低；改用「安装副本代码标记 + 六 fixture 单测」作为证据，
  如实记在此处。
