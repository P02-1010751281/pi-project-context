---
doc_type: fix-note
issue: sibling-skill-provenance-backfill
date: 2026-10-05
released_in: 无需发版（改的是各消费仓的数据文件，不是本仓代码）
decision: owner 惯例是只装全局技能、从不手写项目级技能 → 各仓现有项目级技能都出自沉淀，据此按名字补标记（不是目录级法则，判定始终看标记）
---

# 消费仓项目级技能补来源标记

## 1. 现场事实

- 五个仓有项目级技能（`<repo>/.agents/skills/*/SKILL.md`）：`形式化证明` 12、`HWCup-Math-A` 3、`pi-custom-providers` 13、
  `Quantum_Matrix` 52、`UniField` 30 —— 共 **110 条，全部没有来源标记**（v0.3.1 的能力因此对它们等于禁用）。
- 技能是否进 git 各不相同：`Quantum_Matrix` **跟踪** 52 个 SKILL.md；`UniField` 跟踪 25 个、另 5 个目录未跟踪；
  `pi-custom-providers` 的 `.agents/` 被 gitignore（纯本地）；`形式化证明`、`HWCup-Math-A` **不是 git 仓**（无版本网）。
- 五个仓都有 `.agents/memory/project-context.json`，且都还是**旧键名**（v0.4.0 之前）——重启后由各自的首次读配置自动迁移，不需要手工介入。

## 2. 做了什么

按「格式与管线逐字节相同」的方式插入一行标记（`promptedDocument` 的排布：frontmatter、空行、标记、空行、正文）：

| 仓 | 插入 | 备注 |
| --- | --- | --- |
| `形式化证明` | 12 | 非 git 仓 |
| `HWCup-Math-A` | 3 | 非 git 仓 |
| `pi-custom-providers` | 13 | `.agents/` gitignore，纯本地 |
| `Quantum_Matrix` | 52 | git：`52 files changed, 116 insertions(+)` |
| `UniField` | 30 | git：跟踪的 25 个显示为 M，另 5 个目录本就未跟踪 |

逐文件校验：旧正文原样保留（新内容以旧正文结尾）、标记恰好一份、与 `PROVENANCE_COMMENT` 逐字节相同（110/110）。
`Quantum_Matrix` 的 116 行里多出的 12 行是**补了 frontmatter 后的空行**（那 12 个文件原本紧跟 `---` 就是正文，
现在与管线写盘形态对齐）；其余 40+52+… 都是标准的 +2 行。

## 2b. 判据订正（owner 2026-10-05 追问）

先前这句写成了「项目级技能一律视为 autolearn 产物」，那是把 **owner 的实践**说成了**目录级法则**，不准确：owner 只装过全局技能
（`~/.agents/skills/`），从没给某个项目单独装过技能，所以这些仓的项目级技能才都出自沉淀 —— 结论不变（这 110 条可以标），
但理由必须记对。**判据始终是标记本身**：手写/导入/他人贡献的项目级技能不标、也不可覆盖；无标记 = fail-closed 拒写，
所以「漏标」的代价是暂时不可合并，而不是被误覆盖。规范 §5 X 已按此改定。

## 3. 未做 / 待定

- **没有在任何消费仓提交**：`Quantum_Matrix`（52 个已跟踪文件）与 `UniField`（25 个）的改动现在留在工作树里未提交，
  是否提交、以什么信息提交由各仓 owner 决定。其余三个仓无需提交。
- 消费仓里若有**手写**的项目技能，按本次裁定也会被标成可覆盖 —— 复核发现相反证据时按名字单独摘标记即可（v0.3.1 的 backfill 同款回退方式）。
- 全局 `~/.agents/skills/`（51 条）**未动**，也不会被标记：`collectSkills(..., "global")` 只读。

## 4. 生效条件

各仓共用 `~/.pi` 里那一份安装副本（已更新到 v0.4.0）→ **重启 pi** 后，标记即被识别；无需在各仓做任何安装动作。
