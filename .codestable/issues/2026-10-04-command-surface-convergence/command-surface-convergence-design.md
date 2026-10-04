---
doc_type: design
issue: command-surface-convergence
status: design-draft
revision: 1
date: 2026-10-04
decides: /context 与 /session-log 的归宿（合并 / 改名 / 保留），以及路径查询的家落在哪
supersedes: 上一轮口头选项 A/B/C（把两条路径塞进 status / 退役 / 改名 /paths）
---

# 命令面收束设计（调整后）

## 1. 现场事实（全部实测，非回忆）

1. **owner 报告**：`/context` 与 `/project-context` 容易混淆——这是本设计唯一的现场事实（不是使用量）。
2. **命名重载已修（v0.2.3）**：旧版 3 条字符串覆盖 2 个事实，`Project context:` 同时指"特性开关"和 `CONTEXT.md` 文件。
   现在伞形首行是 `Features:`，文件那行在两条命令里都是 `Context file:`。
3. **实测输出**：`/project-context status` 6 行 / 761 字符；`/context` 3 行 / 379 字符。
   两者**只重合一条**（context 文件路径）；**session index 与 session-logs 目录只在 `/context`**。
4. **使用量不可测**：`session.jsonl` 存展开后的消息，没有字面 `/cmd`，4 仓约 900 MB 搜索 0 命中 ⇒
   "没人用 `/context`"永远不能作为删除理由；本设计的删除理由只能是**零独有输出**（可机器证明）。
5. **pi 无 alias 机制**：`RegisteredCommand`（`dist/core/extensions/types.d.ts`）只有 `name` / `description` /
   `getArgumentCompletions` / `handler`，没有 aliases。**别名 = 再注册一条命令 = 用户面反而变多**，
   所以"改名 + 过渡期"这条路在本机不存在；本仓历史也是"破坏性改名、无别名、无提示"。
6. **`/session-log` 的"长"是数据不是命令**：名字 11 字符（`/project-context` 15）、1 个动词、裸调用输出 1 行 143 字符；
   真正的体量在它写的东西——本仓 `session-logs` 136 MB / 77 会话，最大单会话 8.7 MB，且全在未跟踪目录。

## 2. 目标 / 非目标

**目标**：一个事实一个名字（v0.2.3 已达成）；**一个功能一个入口**；命令**数量不增**，能减则减。

**非目标**：

- 不合并 `/project-context on|off`、`/handoff on|off`、`/autolearn on|off`：它们写同一批键（`setFeature`），
  是**入口重复**不是逻辑重复；合并属破坏性用户面变更，而使用量不可测（同事实 4）。
- 不动 `/handoff`（12 动词）与 `/autolearn`（5 动词）的动词集。
- 不做归档体积 / retention 策略（那是数据问题，见 §6 Stage 3）。
- 不引入 alias、不保留过渡期。

## 3. 调整（相对上一轮的口头 A/B/C）

| 上一轮选项 | 本轮调整 | 理由 |
| --- | --- | --- |
| A：把另两条路径补进 `status` | **改为新增 `/project-context paths` 动词** | `status` 的定位是总览；补进去会让它从 6 行涨到 8 行，等于把"路径查询"混进"总览"。路径需要一个自己的家，不是被塞进另一个命令 |
| B：退役 `/context` | **保留为 Stage 2，前提是 Stage 1 先落地** | Stage 1 之后 `/context` 零独有输出，"删除"第一次有了机器可证的依据（等式测试），而不是"没人用" |
| C：改名 `/context` → `/paths` | **弃用** | pi 没有 alias（事实 5），改名要么硬切（那不如直接退役）、要么留别名（用户面变多） |

**结论一句话**：路径查询的家 = 伞形的 `paths` 动词；`/context` 在它落地后退役；`/session-log` 保留。

## 4. Stage 1（加法，无破坏，可单独发版）

- 伞形新增动词 `paths`，输出**与 `/context` 逐字节相同的三行**：`Context file:` / `Session index:` / `Session logs:`。
- 动词常量表、`getArgumentCompletions` 列表、`docs/configuration.md` 命令表各加一处；usage 串同步。
- **测试（等式钉子，同 v0.2.2 formatter 手法）**：在同一临时项目上分别调 `/project-context paths` 与 `/context`，
  断言两条通知正文**逐字节相等**；再加一条反向对照（只改一侧的标签 → 等式断言必须变红）。
- 验收：`/project-context status` 行数不变（仍 6 行）；补全列表出现 `paths`；等式测试绿。
- 影响面：`extensions/project-context/index.ts` 约 8–12 行 + `tests/` 2 个断言点 + docs 一行。
  属 `extensions/` 改动 ⇒ **需 tag + pin + 重启**，建议搭下一次 extensions 改动一起发，避免为一个动词单独发版。

## 5. Stage 2（破坏性，需 owner 拍板）

- 删除 `/context` 注册；`docs/configuration.md` 的改名说明新增一条：`/context` → `/project-context paths`（无别名、无提示）。
- `tests/registration-test.mjs` 里"context 无参数补全"的断言随命令删除。
- 依据：Stage 1 的等式测试即"零独有输出"的机器证明 + owner 报告的混淆现场事实。
- 验收：`pi.commands` 中不存在 `context`；docs 与补全列表里没有 `/context`；全套测试绿。
- 同样需 tag + pin + 重启。回退 = 恢复注册行，无数据影响。

## 6. Stage 3（独立问题，不在本设计内）

`/session-log` 的体积来自存档本身（事实 6）。要动就是 retention / 归档收敛策略（何时裁、裁什么、是否压缩），
需要它自己的现场事实与设计；**命令名不动**。

## 7. 取舍与备选（记录，不实现）

| 备选 | 为什么不做 |
| --- | --- |
| 把 3 条路径都塞进 `status` | 总览变长；且"路径查询"与"总览"是两件事 |
| `/context` 改名 `/paths` | 无 alias 机制 ⇒ 硬切；硬切不如退役（功能已有新家） |
| 保留 `/context` 双入口 + 一别名 | 用户面变多，与"一个功能一个入口"相反 |
| 用 session.jsonl 统计使用量再决定 | 已证明不可测（事实 4） |

## 8. 待决（owner）

1. Stage 1 是否现在做（还是与下一次 `extensions/` 改动搭车）？
2. Stage 2 是否退役 `/context`（依 §5 的证据）？
3. `/session-log` 是否确认为"保留"（若你要的是名字更短，那属于另一个诉求，请明说目标形态）。
