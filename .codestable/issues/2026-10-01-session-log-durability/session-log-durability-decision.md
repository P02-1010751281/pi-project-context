---
doc_type: decision
issue: 2026-10-01-session-log-durability
status: deferred
created_at: 2026-10-01
related: [../2026-09-30-session-log-append-duplication/session-log-append-duplication-fix-note.md]
tags: [session-log, archive, privacy, durability, deferred]
---

# 会话归档持久化方向

owner 2026-10-01：**先都保留本机，暂不做离机持久化；等进一步调查同类项目后再决定。**

## 现状（已核实）

- 转录**原样**存在 `.agents/memory/session-logs/<id>/{session.jsonl,session.md}`，加派生 `INDEX.md`；目录自带本地 `.gitignore`（`*`）→ 机器本地、不进 git。
- harness 自己的副本在 `~/.pi/agent/sessions/...`，同样只在本地。
- 实测 2026-10-01：**91MB / 48 个会话，最大 4.3MB**。
- **没有任何代码清理会话目录**；只有 `INDEX.md` 的列表上限 200。
- `redactSecrets` **只作用于 `errors.log`**（`shared/error-log.ts`），**从不作用于归档内容**。
- 扩展**没有 git 写路径**：唯一 git 调用是 `shared/paths.ts:28` 的只读 `git rev-parse --show-toplevel`。

## 为什么「settle 时自动 commit/push 转录」被否决（默认行为）

1. 会在**用户的仓库里**制造 commit 与 push；
2. 会推送**未脱敏**的转录（原始工具输出、粘过的 key）；
3. 正则脱敏**无法保证**「不含秘密」：模式集有界、没有「不含秘密」的判定 oracle、存在可推导的秘密、隐私 ≠ 秘密；
4. git 历史**不可逆** —— 发布是一扇单向门。

## 新发现（本次，修正既有 MEMORY 表述）

既有表述：「丢 `toolResult` 不降级任何东西，只影响『之后从归档再派生』。」

**这条在这里不成立。** `autolearn/evidence.ts` 的 `sessionText()`（`:78-88`）正是**从归档 `session.jsonl` 读**：

```
readOptional(logsDir/<id>/session.jsonl)
  → parseSessionEntries → sessionEntryToContextMessages
  → convertToLlm → serializeConversation   → 作为「证据」喂给模型
```

（`collectEvidence` `:91-107`；预算 8000/会话、24000 总、最多 4 个会话。）

也就是说**归档是 autolearn 的活跃输入**，而工具输出往往正是「哪条命令、哪个路径、报什么错」——恰恰是技能值得沉淀的理由。**在归档写入时就丢 `toolResult`，会实打实变薄 autolearn 的证据。**

**因此正确的形态是「导出时最小化，而不是本地存储时最小化」**：本地保留完整归档（autolearn 与归档修复都要用），只对**送往 vault 的那份**做最小化 + 脱敏投影。

## 保留的选项空间（供后续调查）

| 选项 | 内容 | 代价 |
|---|---|---|
| A | **纯本地** + 加保留/体积策略（清旧会话目录） | 最小改动；解决 91MB 增长；不获得离机持久 |
| B′ | 本地保真 + **导出时**最小化投影 | 持久化的前提件；本地不动 |
| C | B′ + 私有、**不镜像**的 vault 仓库 | 真正离机持久；需一条 git 推送路径 |
| D | C + 加密归档 | 最强；引入密钥管理 |
| ~~B~~ | ~~本地就丢 `toolResult`~~ | **不建议**：砍 autolearn 证据（见上） |

## 绝不做的

只做正则脱敏就推到共享 / GitHub 镜像。

## 后续调查问题（owner 提出「调查同类项目」）

1. 同类工具（其他 coding agent / CLI）如何存会话转录？默认本地还是同步？有无保留策略？
2. 「结构最小化 + 脱敏投影 + 私有 vault」是否有人已经做成成熟形态可借鉴？
3. 加密归档的密钥管理在个人工作流里是否现实？

## 状态

`deferred` —— 等同类项目调查结论后由 owner 再定。在此之前**不改**归档行为（保持本地原样）。
