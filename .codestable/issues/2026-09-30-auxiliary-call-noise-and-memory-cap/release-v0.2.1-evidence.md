---
doc_type: release-evidence
version: v0.2.1
tag: v0.2.1
tag_object: d69ae4885125dc2cd17ece0b3d336c4a81eaed07
peeled_commit: ab0984cdc2e4b576bdc1bcf323f7860eaa193da6
date: 2026-10-03
pin: ssh://forgejo@git.lentech.site/C02-1010751281/pi-project-context.git@v0.2.1
pin_commit: 3bd224e (pi-config)
installed_head: ab0984cdc2e4b576bdc1bcf323f7860eaa193da6
restart_required: true
---

# v0.2.1 发版证据

## 1. 装了什么（`v0.2.0` → `v0.2.1` 的 3 个扩展代码提交）

| 提交 | 内容 |
| --- | --- |
| `1f0672c` | **D2**：opaque 路径超 cap 时，先把**未裁剪的原始回复**落到 `.agents/memory/memory-overflow-<时间戳>.md`（best-effort），并加进 memory 目录的 `.gitignore` |
| `00bf797` | **外部编辑采纳**：pass 携带构造 prompt 时的 `basisKey`；判据 + 发布前 recheck 不一致 ⇒ **不发布**陈旧回复，更新字节保持生效；拒绝态不产生任何"已写"类副作用 |
| `dd2adcc` | 修复批次：`consolidation shortened` 日志补 `!memoryRefused` 门（拒绝态曾谎报"存量被缩短"）；补三条回归线 + clipped+拒绝夹具（带对照）+ 拒绝重放；断言 47 → 69 |

其余是 `.codestable/` 文档、skills 与 memory render 的文档提交（`git log v0.2.0..v0.2.1 -- extensions/` 只列出上面三个）。

## 2. 评审轨迹（release gate）

- **设计侧 9 轮**：R1–R5（v1–v5，"重跑"版）→ owner 判过度复杂 ⇒ 重写 B 版 → R6（1 blocking）→ R7（0）→ R8（0/1 important）→ **R9**（审已实现的 revision 9：0 blocking + 2 important）。
- **代码评审 2 轮**：轮 1（审 `00bf797`）：0 blocking + 2 important；轮 2（审 `dd2adcc` 修复批次）：**0 blocking + 0 important** + 3 nit（全部为文档类，已处置）。
- R6–R9 与两轮代码评审**没有一条**要求新机制；两条 important 由设计轮 R9 与代码评审轮 1 **独立同判**后被修，轮 2 用**自己的 probe 与四枚变异**独立复核通过。
- 路由：R1–R8 走 `commandcode/…flash-fast`；R9 与两轮代码评审走 `deepseek/deepseek-v4-pro`（前者 429 周限至 2026-10-08）。原"本机唯一路由"的结论已被实测推翻。

## 3. 发版时实测

- `node tests/run-all.mjs` → **All 15 tests passed**；`git diff --check` 干净。
- 新增 `tests/external-edit-test.mjs` → **69 条断言全绿**；`repro-write-ordering.mjs` → **退出 0**（两场景 journal `A → B`、生效 = B、日志含"未发布"）。
- 变异矩阵（轮 2 独立复跑）：撤 `!memoryRefused` → 恰 1 条红；§2.2 退回 raw（带 trim 恰 2 条 / 不带 trim 恰 4 条）→ 红；去掉 `publishKey` 排除项 → 恰 1 条红。

## 4. 安装与校验

| 项 | 值 |
| --- | --- |
| 注释 tag | `v0.2.1` → tag object `d69ae48`，peeled commit `ab0984c` |
| 远端 | forgejo 与 github mirror 都拿到 `refs/tags/v0.2.1`（tag object 同一个） |
| pin | `~/.pi/agent/settings.json` + `~/.pi/README.md` → `@v0.2.1`，pi-config 提交 `3bd224e` 并推送 |
| `pi update --extensions` | 拉到 `v0.2.1` → `HEAD 现在位于 ab0984c` |
| 已安装克隆 | `HEAD = ab0984c`、工作树干净、`describe`（fetch --tags 后）= `v0.2.1` |
| 代码标记 | `nextRenderSupersedes` ×2、`saveOverflowReply` ×2、`!memoryRefused && (memoryChanged || update)` ×1 —— 三个提交的代码都在 |
| 克隆自带测试 | `node tests/handoff-test.mjs` → `handoff: all checks passed.` |
| 真实探针 | 废弃目录 `/tmp/v021-probe`、**默认设置**（无 `-ne`/`-e`）跑 `pi -p`：生成 `.agents/memory/{MEMORY.md,CONTEXT.md,memory.jsonl,session-logs/}`，`MEMORY.md` 是规范四节文档，**`errors.log` 为空**（无 cap/poison/stale 行） |

## 5. ⚠️ 需要重启

`pi update --extensions` 只换磁盘上的代码；**已经在跑的 pi 进程仍加载旧代码**（旧进程会继续按旧逻辑覆盖外部编辑）。
要让修复生效，需**重启 pi 会话/进程**。消费方仓库（QM / UF）同理：升级 + 重启之前它们仍暴露在覆盖风险下。

## 6. 已知残留（随版本发布，不再加机制）

外部编辑修复的 R-1…R-15（见 `../2026-10-03-external-edit-adoption-overwritten/external-edit-adoption-overwritten-design.md` §5），其中与本次最相关的：
R-1（mtime 回退/同刻的外部编辑不可见）、R-6（recheck → rename 之间的 μm–ms 窗口）、R-13（发布成功但 overflow 副本缺失的崩溃窗）、
R-14（手删 journal 且有 rotation 归档时读侧优先归档）、**R-15（既有谎言：`update === undefined` 且未拒绝时，命令回复仍说 "…and context updated."）**。
R-15 与 R-14 是**既有行为**，本版未引入也未扩大。
