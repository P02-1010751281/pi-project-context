---
doc_type: audit
subject: 设计复杂度补审三：autolearn/* 与 archive/*（收口全仓最后 18%）
created_at: 2026-10-04
related: [2026-10-03-design-complexity-audit.md, 2026-10-03-design-complexity-audit-addendum-handoff-config.md, 2026-10-04-design-complexity-audit-addendum-2-module-inventory.md]
tags: [process, design-review, complexity, evidence, autolearn, archive]
---

# 补审三：autolearn/* 与 archive/*

补审二把主审计「未查完」收口到只剩两族：`autolearn/*`（8 文件 729 行）与 `archive/*`（4 文件 687 行），
合计 1,416 行 = 全仓 18%。本文按同一判据过完，并把补审二的两处判定按新证据重判。

## 0. 判定变更（先写结论）

| 补审二判定 | 本轮结论 | 依据 |
| --- | --- | --- |
| D4「`migrateProjectState` 0/9 现场证据」 | **维持**，并记一次已排除的假设 | 见 §2 |
| D7「22 个陈旧 `.lock` = `lock.ts` 陈旧窃取路径的现场依据」 | **更正为「归属不明，不能作为依据」** | 见 §2 |

## 1. 探针

| 探针 | 做法 | 结果 |
| --- | --- | --- |
| P1 | `logError` 域键 vs 真机 errors.log（7 文件 / 1,563 行） | `[autolearn]` **55**、`[session-log]` **1**、`[session-index]` **1** |
| P2 | 现场归档产物清点（`session-logs/*/`） | 全机 ~440 个会话归档（QM 240 / 本仓 69 / pi-custom-providers 67 / UF 43 / CipherCat 16） |
| P3 | `skill-candidates/`（autolearn 写盘路径的产物） | 6 个仓共 ~40 个文件，最新 2026-10-04 |
| P4 | 归档不变性：归档是否为 pi 源文件的**前缀**（append-only 承诺的正确形式） | 239 前缀 / **67 非前缀**（见 N1） |
| P5 | 索引上限是否被现场触发（`MAX_INDEX_LINES=200`） | QM `INDEX.md` = **200 条索引行**（正好触顶） |
| P6 | 归属核查：谁会写 `session-logs/<id>/.lock` 与 `migration-manifest.json` | 见 §2（两条假设均被排除/改判） |

## 2. 两处判定的重判

### D4【维持】legacy 迁移仍无直接现场证据——但记一次已排除的假设

CipherCat（2026-09-19）与量子矩阵（2026-09-16）的 `.agents/memory/` 里**确实有 `migration-manifest.json`**，
初看像是「迁移真跑过、补审二 D4 判错」。核查后**否定**：

- 该文件名在当前代码里 **grep 0 命中**；`git log -S'migration-manifest'` 全历史只命中一处，且是一个
  **设计文档**（`.codestable/features/2026-09-15-codex-project-context-port/…-design.md`）⇒ 它是
  **Codex 移植（`codex-project-context`）**的产物，不是本扩展的。
- CipherCat 那两条是 `learned.md → skill-candidates/omp-learned.md`、`raw_memories.md → omp-raw-memories.md`，
  `status: copied`；量子矩阵那条是 `session-index.md → session-logs/INDEX.md`，`status: conflict-preserved`
  —— 都是 omp→新布局的搬运，属移植侧。
- 另查 9 个项目的 `memory.jsonl`：提及 migration/迁移的条目全部是审计讨论或无关主题（如 provider README 的
  「## 迁移」小节），**没有一条**是本扩展迁移事件的记录。

⇒ D4 维持：本机 9/9 无 `.pi/`/`.agents/memory/skills` 旧布局、`[migration]` 0 命中、journal 无迁移记录。
`migrate.ts` 的存在理由仍成立（它自述的旧事故：早先只要目标 `SKILL.md` 存在就删掉整个旧目录，连带更新的
手改正文与全部兄弟资产、无比较无备份无报告），但那是**代码级理由，不是现场事实** ⇒ 与补审二一致：
保留 + 定退役窗口，不再扩展。

### D7【更正】22 个陈旧 `.lock` 的归属查不出来，不能算 `lock.ts` 的依据

- `lock.ts` 的锁路径是 `${target}.lock`（`lock.ts:180`），当前全部调用点只锁三个目标：
  `memory/session-index.lock`、`MEMORY.md.lock`、`project-context.json.lock`。
- 全历史 `git log --all -p -- extensions/project-context/` 里 `withMemoryLock(...)` 只出现过
  `sessionIndexLockTarget(projectRoot)` 一种参数 —— **本仓从未锁过会话目录**。
- 兄弟移植用的是 OS 级 `fcntl.flock`（`codex-project-context/scripts/contextctl.py:317`），**不产生锁文件**。

⇒ `session-logs/<id>/.lock`（CipherCat，22 个 0 字节，2026-09-15 ~ 10-02）**无法归属**到本扩展或移植。
可能来自更早的工具链，但无证据。它仍证明「锁文件会孤儿化」这一**一般**现象，但**不能**作为
`lock.ts` 陈旧窃取路径的现场依据。**我补审二里把它写成本扩展的依据，是错的**（该结论当时未做归属核查）。
卫生问题本身保留：无人回收这些残留。

## 3. autolearn/*（8 文件 / 729 行）

### 机制概览（全部有顶部理由块）

`pass.ts`（251，单飞 + 节流 + 路由停泊）、`candidate.ts`（116，候选盘 + 准入/驳回）、`evidence.ts`（100，
证据回溯 + 字符预算）、`prompt.ts`（68）、`schema.ts`（60，`record_skill` 工具 schema）、`skill.ts`（54，
形态 + 安全校验）、`parse.ts`（47，宽容解析）、`inventory.ts`（33，技能清单注入）。

### 现场分布（P1）——55 条**全部**是辅助调用失败，没有一条机制报错

| 消息 | 条数 |
| --- | --- |
| `model call error: Connection error.` | 19 |
| `Codex error: usage limit reached` | 8 |
| `Insufficient Balance`（含带 request_id 变体） | 7 + 5 |
| `Stream ended without finish_reason` | 3 |
| `weekly usage limit` | 3 |
| `terminated` / `5-hour usage limit` / `insufficient credits` | 2 / 2 / 2 |
| `Request timed out` / `Token Plan quota` / `Authentication failed` / `fetch failed` | 各 1 |
| `This extension ctx is stale after session replacement or reload` | 1 |

⇒ 机制**确实在跑**（55 次辅助调用），失败全部来自路由/额度侧。

### 发现 N2【残留】两级降级里，第二级从未触发

`pass.ts` 自述的两个降级分支现场 **0 命中**：

- `:72`「MEMORY.md exists but cannot be read; continuing with an empty memory」—— 从未发生；
- `:189`「autolearn is disabled for this session after repeated auxiliary-model failures」—— 从未发生。

后者由 `modelAutoDisabled("autolearn", …)` 把关（`pausedAnnounced` 每进程只播报一次）。**真正在现场保护
本机的是它的上一级 `modelBlocked()` 停泊**——`run()` 开头注释写得很清楚：「A route that just failed stays
parked; without this the pass retried on every settle and one provider outage became a burst」，这与
`shared/call-policy.ts` 自述的现场事故（坏路由每次 settle 重试 + 每次上报 ⇒ 一次故障爆发同质失败）同源。

⇒ `:185-193` 这段（约 6 行 + 一个进程级 Set）是**未被触达的第二级降级**，保留（它是自动静默停用唯一的可见
信号），但记残留，不再扩。

### 其他判定

| 项 | 依据 | 判定 |
| --- | --- | --- |
| 候选写盘路径 | 现场 ~40 个候选文件、6 个仓、最新 2026-10-04 | 有据（现场） |
| 批准路径 | 本仓 16 条已跟踪 skill（`.agents/skills/`） | 有据（现场） |
| 节流（turns/interval/`autolearnAt` 持久化） | 3 周 55 次调用 = 有节流地跑，非每 settle 重试 | 有据 |
| `schema.ts` 恒为对象 + 空 name 表「无可提议」 | 理由块：`skill: null` 在严格 JSON schema 下无法表达（`makeStrictJsonSchema` 会把对象成员包成 `anyOf`，对象联合被拒） | 有据（API 约束） |
| `AUTOLEARN_INVENTORY_CHARS = 8000` | 量子矩阵有 35 个未跟踪 + 12 个已跟踪 skill，理论上可能触顶；但截断不打日志 ⇒ **不可验证** | 未证 |
| `evidence.ts` 的 `archivedSessionIds` 存在性校验 | 无现场记录（被引用的证据会话从不缺档）⇒ 防御性 | 残留（小） |

## 4. archive/*（4 文件 / 687 行）

### 现场证据很强（P2/P5）

全机 ~440 个会话归档，且：

- **`MAX_INDEX_LINES = 200` 恰好被现场触顶**：量子矩阵 `session-logs/INDEX.md` 正好 200 条索引行
  ⇒ 该上限不是想象出来的机制，它在最大消费者上已经生效并开始丢最老的索引行。
- 单位置的 `[session-log]` / `[session-index]` 各 1 条，来自同一起 2026-09-18 事故
  （`08:46:13` 与 `08:46:24`，相隔 11 秒）：「This extension ctx is stale after session replacement or
  reload.」——**这是 pi 侧的陈旧 ctx 风险**（会话替换/reload 后仍用被捕获的 ctx），不是归档机制的错误；
  归档本身活了下来。

### 发现 N1【重要·现场】pi 的 session JSONL **不是只追加的**，归档确实留住了源已丢的字节

`session-log.ts` 的承诺是「原始 JSONL 是权威，归档 = 逐字节副本 + 之后只追加尾巴」。按**前缀**检验
（P4）全机 306 个可比会话：

| 结果 | 数量 |
| --- | --- |
| 归档是当前 pi 源的前缀 | 239 |
| **不是前缀** | **67** |

且 67 例里**多数归档比源更大**（例：归档 2,220,568 B vs 源 2,216,394 B；4,529,602 vs 4,528,608；
10,808,579 vs 10,805,988）。抽样一例（`01a0c964…`，归档 128,884 B/47 行 vs 源 128,742 B/46 行）首个分歧
在 offset 122,897：

- **归档侧**多出一条 `{"type":"context_edit","id":"1eeb4e35","parentId":"644e7e94",…}`
- **源侧**该条不存在，而下一条 message 的 `parentId` **正是 `1eeb4e35`**（悬空引用）

⇒ pi 会从其会话文件中**丢掉**（或不再写出）某些条目，而归档保留了它们。这同时说明：

1. 归档层的核心价值有**直接现场证明**（不是理论值）；
2. `session-log.ts` 的 stamp/rebuild 逻辑（size+inode+mtime，加 256 字节边界复检）处理的是**真实发生**的情况；
3. 文件头已自述的已知盲区（「a rewrite that keeps that window and does not shrink is not detected」）
   是**已被现场触及的残差**，不是假想 —— 仍按残差接受。

### 其他判定

| 模块 | 依据 | 判定 |
| --- | --- | --- |
| `session-index.ts`（122） | 索引 200 行上限现场触顶；`normalizeLegacyIndex` 的搬运理由见下 | 有据（现场） |
| `import-archive.ts`（128） | 纯机械回填、无模型调用；CipherCat 有 2/15 归档会话在 `~/.pi` 找不到对应源（可能为回填或源已清理） | 有据（弱） |
| `archive.ts`（180） | 注册 + 启停 + 索引更新；索引锁落在 memory 目录（`.gitignore` 覆盖 `*.lock`） | 有据 |
| `session-log.ts`（257） | 见 N1 | 有据（现场） |

## 5. 收口与规模账

- 至此 **58/58 模块**全部过完（主审计 + 补审一 + 补审二 + 补审三）。
- 本轮净结果：**1 条更正**（D7 锁归属）、**1 条维持并附排除记录**（D4 迁移）、**1 条重要现场发现**
  （N1 pi 会话文件非只追加）、**1 条残留**（N2 autolearn 第二级降级从未触发）、**1 条未证**（inventory 8000 字符）。
- 两族均无死模块：`autolearn/*` 有 55 次真实调用 + ~40 个候选产物；`archive/*` 有 ~440 个归档 + 索引触顶。
- 记忆层教训（与补审二 D1 同族）：**「日志键 0 命中」只能证明该*错误*没发生，不能证明机制没运行**；
  本轮 D4 靠「找成功产物」（manifest）才发现要重新判定，而核查后 manifest 属兄弟移植 —— 两次都要落到产物上。
