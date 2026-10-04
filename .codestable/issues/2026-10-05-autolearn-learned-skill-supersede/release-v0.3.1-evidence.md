# v0.3.1 发布证据

日期：2026-10-05
范围：autolearn 可取代**本管线生成**的技能（来源标记写进技能正文）

## 提交与标签

| 项 | 值 |
| --- | --- |
| 行为提交 | `2d562ce` `feat(autolearn): let the pipeline supersede a skill it generated, and only one of those` |
| 文档提交 | `12c6390` `docs(architecture,configuration): describe how a learned skill is identified and superseded`（发布内容提交） |
| tag 对象 | `28070bd998e523c092b9a845ec9bfd4faad6e15d` |
| tag 指向（peeled） | `12c63908d499` |
| forgejo | master 与 tag 均在 `12c63908d499` / `28070bd998e5` |
| github 镜像 | master 与 tag 均在 `12c63908d499` / `28070bd998e5` |

## pin 与安装

| 项 | 值 |
| --- | --- |
| `~/.pi` pin 提交 | `aada74a362e1`（`agent/settings.json` 与 `README.md` 改 `@v0.3.1`，已推送） |
| 安装命令 | `pi update --extensions` |
| 安装副本 HEAD | `12c63908d499`，`describe --tags` = `v0.3.1`，脏文件 0 |
| 到位抽检 | 副本内 `autolearn-generated` ×2（`autolearn/skill.ts`）、`learned-skill-bodies` ×3（`autolearn/prompt.ts`） |

**需要重启 pi 才生效**：运行中的会话仍加载旧模块。

## 验收

- `node tests/run-all.mjs`：**15/15 绿**（`autolearn-test.mjs` 66 条断言，本次 +10）。
- 单侧变异矩阵（4 组，实测）：

| 变异 | 预期打红 | 实测 |
| --- | --- | --- |
| gate 去掉 `autolearn` 条件 | 候选路径 2 条 | FAIL 2 |
| approve 退回一律拒绝 | approve 2 条 | FAIL 2 |
| 不注入既有正文 | 合并提示词 1 条 | FAIL 1 |
| 晋级文档丢标记（共享渲染器） | 来源相关全部 | FAIL 8 |

- 范围抽检：`globalSkillsDir()` 只用于 `collectSkills(..., "global")`，不参与任何写入；手写/导入技能无标记，两处判定都拒绝。

## 已知残留

- v0.3.1 之前晋级的技能没有标记（晋级时证据注释被丢、候选文件被删）→ 暂时不可更新；不做猜测式 backfill。
- 本仓当前带标记的技能为 0，所以 `<learned-skill-bodies>` 这一轮实际不占提示词预算；首个带标记技能出现后才会生效。
- 待处理的现行候选：`.agents/memory/skill-candidates/pi-project-context-legacy-config-one-time-migration.md`（未跟踪，属管线状态，等 owner 决定 approve/reject）。
