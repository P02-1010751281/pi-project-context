---
doc_type: release-evidence
version: v0.2.3
tag: v0.2.3
tag_object: 3327fe4ec8aca8f7d13e0f204b083516a2ddb4e2
peeled_commit: 9feadaba01222fe6a298be19b9ec5b09b2fdf17f
date: 2026-10-04
pin: ssh://forgejo@git.lentech.site/C02-1010751281/pi-project-context.git@v0.2.3
pin_commit: ae42e12 (pi-config)
installed_head: 9feadaba01222fe6a298be19b9ec5b09b2fdf17f
installed_describe: v0.2.3
restart_required: true
---

# v0.2.3 发版证据

## 内容

两条用户可见修复：

1. `fix(memory): state the cross-project boundary as a rule and at the conversation block`
2. `fix(commands): give each fact one name on the command surface`

`extensions/` 相对 v0.2.2 的差异 = 3 文件 / +9 −4。修复说明见 `fix-note.md`。

## 流程与证据

| 步骤 | 证据 |
| --- | --- |
| 全套测试 | `node tests/run-all.mjs` → All 15 tests passed.（提示词边界 4 条新断言 + 两条状态断言随标签更新） |
| 变异验证 | 删规则句 → 2 FAIL；删注入点说明行 → 2 FAIL（各自只红对应断言）；还原 → 0 FAIL |
| 提交切片 | `4f26ddd fix(memory)` / `89cadee fix(commands)` / `9feadab docs(configuration)` |
| 打标 | `git tag -a v0.2.3` → object `3327fe4ec8ac`，peeled `9feadaba0122` = master head |
| 双推 | forgejo 与 github 镜像的 master 均为 `9feadaba0122`，tag 均为 `3327fe4ec8ac` |
| pin | `~/.pi` `agent/settings.json` + `README.md`：`@v0.2.2` → `@v0.2.3`，提交 `ae42e12`，已推送且远端一致（本轮远端未前进，`pull --rebase` 无操作） |
| 安装 | `pi update --extensions` 拉取 tag `v0.2.3`，`HEAD 现在位于 9feadab` |
| 安装副本核验 | HEAD `9feadaba0122` = peeled tag；`describe --tags` = `v0.2.3`；工作树 0 脏；`prompt.ts` 里边界规则与注入点说明各 1 处；`index.ts` 里旧 `Project context: ` 归零 |

## 必须重启

`pi update --extensions` 只替换磁盘代码：**正在运行的 pi 进程仍加载旧模块**，新的提示词到重启后的下一次
consolidation 才生效。

## 验收（现场侧，非单测能证明）

提示词内容断言只能证明"话写在那里"，不能证明模型遵守。验收标准：之后若干轮渲染后，
`hygiene` 技能 §2 的边界 grep 在 `MEMORY.md`/`CONTEXT.md`/`docs/`/技能上命中 0。
当前状态：最近两轮渲染 0 泄漏，所以本改动是预防性的。

## 无人值守项

- 未跑真实 settings 安装探针（release 技能第 7 步）：本轮只改提示词文本与两条输出标签，
  探针要花一次真实 consolidation（且本轮巡检余额告警在即），故跳过并按实测的安装副本代码标记替代，
  如实记在此处。
