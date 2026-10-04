---
doc_type: fix-note
issue: autolearn-learned-skill-supersede
date: 2026-10-05
released_in: v0.3.1
decision: owner 会话指令「autolearn 更新/合并既有技能」＋范围约束「不要扩大到 autolearn 自动生成以外的 skill」；载体取「标记写进 SKILL.md」
---

# 修复说明：autolearn 可以取代自己生成的技能（且只限那些）

本主题没有独立设计文档：不涉及用户面命令/动词/开关，唯一的设计分叉（来源标记的载体）由 owner 现场选定，
取舍记录在下面第 2 节。

## 1. 现场事实（为什么动）

- 管线此前**只能新增**：`candidate.ts` 对重名一律拒绝（gate），`pass.ts` 只在空位写盘，`approveCandidate` 对已存在目标也拒绝。
  于是「学到的东西后来被推翻/写错了」只能人手修，而覆盖同一领域的提案被当作近似重复丢掉。
- 两条真实发生过的现场事实：
  - `.agents/memory/skill-candidates/` 里出现过一条**已被晋级技能取代**的近重复候选（MEMORY 索引里有记录）；
  - 一个**晋级技能的正文**带着兄弟仓测量值和用某一次运行数字搭的守卫正则，只能事后手改。
- 范围难点：`.agents/skills/` 同时住着**三类**技能 —— 手写、旧布局导入（`shared/migrate.ts:99-101`）、本管线晋级 ——
  而 `SkillInfo` 只有 `name/description/scope`；晋级时 evidence 注释被丢掉、候选文件被删，**没有**任何东西能区分它们。
  所以「更新/合并」的第一件事不是放宽重名，而是给来源一个可判定的事实。

## 2. 决定：来源标记写进技能正文（而不是侧挂 JSON）

两条路都能跨机器（只要被 git 跟踪），差别在**漂移方向**：

| 载体 | 危险的一侧 |
| --- | --- |
| 侧挂 JSON 清单（唯一来源） | 条目会漂：技能被删/改名后名字被**手写**技能占用，旧条目会把对方标成可覆盖 → autolearn 静默覆盖手写文件。用内容指纹能堵住，但代价是**手改过的 autolearn 技能也变成不可更新**——而「手改过仍能继续合并」正是本能力要的 |
| 标记写进 `SKILL.md` 正文 | 标记跟文件同生共死 → 结构上不可能把非本管线生成的文件判成自己的 |

选后者。标记是 body 里的一行 HTML 注释而不是 frontmatter：pi 启动**只注入 name/description/path**（`docs/skills.md:43`），
未知 frontmatter 键行为未定义。代价是晋级文件多一行注释（不占会话提示词），写盘前要把模型可能抄回来的旧标记剥掉，保证只有一条。

## 3. 改动

| 文件 | 改动 |
| --- | --- |
| `autolearn/skill.ts` | `autolearnProvenance()` 判定、`withoutAutolearnProvenance()` 剥标记、`skillBody()` 取正文、`promotedDocument()` 渲染（frontmatter ＋ 标记 ＋ body）；`skillDocument(skill,false)` 走它；`SkillInfo` 增加 `autolearn` 与可选的 `body` |
| `autolearn/inventory.ts` | `collectSkills()` 读标记，只给**带标记的 project 技能**保留正文；`inventoryText()` 标注 `(project, learned)`；新增 `learnedBodiesText()`（整篇注入，放不下就整篇不放，预算 `MAX_SKILL_BODY_CHARS`） |
| `autolearn/candidate.ts` | gate：重名只在「project ＋ autolearn」时放行（否则照旧 `already exists`）——候选路径同样受约束，不会为手写名字落候选文件；`approveCandidate`：目标是带标记的 `SKILL.md` 才覆盖，否则照旧拒绝；`candidateBody()` 改走共享的 `skillBody()` |
| `autolearn/pass.ts` | 发布路径读**目标文件本身**的标记决定「覆盖 or 拒绝」；通知区分 `Learned` / `Updated project skill:` |
| `autolearn/prompt.ts` | 近似重复规则加唯一例外（inventory 里标 `learned` 且正文在 `<learned-skill-bodies>` 里的技能，可复用同名做合并）；名字规则同义收紧；新增「覆盖是整篇重写，保留仍然成立的步骤，合并不了就什么都不提」；新增 `<learned-skill-bodies>` 段 |
| `tests/autolearn-test.mjs` | 新增断言组 E3 与 D 的手写 fixture（+2 条候选路径断言） |

判定点两处、都读**产物本身**（gate 读清单、写入读目标文件），不是缓存列表：清单只决定「能不能提」，
真正动手前再读一次要被替换的文件。

## 4. 用户可见变化

- `/autolearn` 的提案可以复用**本管线生成**的技能名并覆盖它；通知是 `Updated project skill: <name> → <path>`（新增仍是 `Learned …`）。
- `/autolearn approve` 同名时只在目标带标记时覆盖并提示 `Updated project skill:`；手写/导入目标仍是 `already exists; remove the candidate manually`。
- 生成的技能文件多一行 `<!-- autolearn-generated: this skill may be superseded by a later autolearn pass -->`（正文，不注入会话）。

## 5. 回归钉子

`tests/autolearn-test.mjs` 新增 10 条断言（学到的技能带标记、标记不在 frontmatter、同名覆盖就位、通知是 Updated、
合并提示词含既有正文、清单标 `learned`、手写正文不进合并段、标记只有一份、候选不得为手写名字落盘、
approve 覆盖学到的且拒绝手写的）。变异验证（每组单侧，实测行数）：

| 变异 | 期望 | 实测 |
| --- | --- | --- |
| gate 去掉 `autolearn` 条件（只按 scope 判） | 候选路径两条红 | FAIL 2（候选落盘 + 拒绝文案） |
| approve 侧退回「一律拒绝」 | approve 两条红 | FAIL 2 |
| 不注入既有正文（合并变盲写） | 合并提示词一条红 | FAIL 1 |
| 晋级文档丢掉标记（**共享渲染器**一侧） | 全部来源相关断言红 | FAIL 8 |

前三条各自只打红自己的断言；第四条是共享渲染器，红 8 条，正好说明标记是所有判定的承重点。

## 6. 范围保证（owner 的约束）

- 只可能写 `.agents/skills/<name>/SKILL.md`，且仅当该文件带标记；**global 技能永不写**（`globalSkillsDir()` 只读）。
- 手写技能与 legacy 导入技能：无标记 → gate 与写入路径都拒绝，文案与 v0.3.0 一致。
- 标记缺失/读不到 → 退回 add-only（今天的行为），不会反向放宽。

## 7. 残留与非目标

- **存量标记已按 owner 口径补上**（`0ca0d91`，tag 之后，不改行为所以不重发版）：owner 的惯例是「这个仓的项目技能都是沉淀出来的，没有手打的」，
  于是 `.agents/skills/` 全部 17 条都补上了标记。**这是按名字给的出处，不是逐文件证据**：git 史上只提交过一条候选文件（`consumer-alert-triage`，已删），
  且多次整理提交的手写重写改过正文，所以盘上没有任何东西能证明某一条到底出自哪次 pass。记在这里，以便按名字单独回退。
  走**发货代码**验证（非肉眼）：`collectSkills` 报 17/17 为 learned 且带正文，`inventoryText` 显示 `(project, learned)`，
  `learnedBodiesText` 返回 18859 字符且已剥掉标记。
- **注入预算与真实覆盖率**（修正上一版写错的算术）：预算是**总量**而不是每条 —— `AUTOLEARN_LEARNED_BODY_CHARS = 20000`，
  而 17 条正文合计 **96975** 字符（均值 5704，最大 `memory-recovery` 13207、`independent-review` 12196）。
  按 inventory 顺序装得下的只有 **4 条**（`adaptive-handoff-threshold-review`、`audit-claim-verification`、`auxiliary-alert-storm-triage`、
  `gate-probe-mutation-check`，合 18857），其余 **13 条永远进不了提示词** —— 其中包括最胖的两条。
  即：补上标记让 17 条在**代码 gate** 上全部可覆盖，但只有 4 条的正文真的会被模型看到；其余 13 条是「可覆盖、但提示词里看不到原文」。
  提示词确实禁止复用「正文未被展示」的名字，但那是**提示词层**约束，代码 gate 只认标记。
- 眼下能覆盖那 13 条的唯一路径是 candidate/approve（人工确认的盲写）。是否改成**按需取正文**（复用已有的 `inspect` 跟进轮，
  第一轮只给清单，要点名的技能在第二轮注入其正文）由 owner 决定，本次未做。
- 不引入侧挂 JSON 索引（第 2 节理由）；不新增用户面动词；不改候选文件的形状（`candidate: true` 仍表示「等人确认」）。
- 提示词成本：本轮起每次 autolearn 调用都会带上约 18.9 KB 的技能正文（此前为 0）。

## 8. 发布含义

代码落在 `extensions/`，所以需要新 tag（v0.3.1）＋ `~/.pi` pin 更新 ＋ **重启 pi**。
见同目录 `release-v0.3.1-evidence.md`。
