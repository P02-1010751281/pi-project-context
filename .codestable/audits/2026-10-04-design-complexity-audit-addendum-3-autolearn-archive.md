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
| P6 | 归属核查：谁会写 `session-logs/<id>/.lock` 与 `migration-manifest.json` | 锁 = **Codex 移植**的 flock 文件（已坐实并清理）；manifest = 移植产物（假设已排除）见 §2 |

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

### D7【更正 + 归属已坐实】陈旧 `.lock` 是 Codex 移植的 flock 锁文件，不是 `lock.ts` 的

- `lock.ts` 的锁路径是 `${target}.lock`（`lock.ts:180`），当前全部调用点只锁三个目标：
  `memory/session-index.lock`、`MEMORY.md.lock`、`project-context.json.lock`。
- 全历史 `git log --all -p -- extensions/project-context/` 里 `withMemoryLock(...)` 只出现过
  `sessionIndexLockTarget(projectRoot)` 一种参数 —— **本仓从未锁过会话目录**。
- **归属在清理时坐实：来自 Codex 移植**。`codex-project-context/scripts/contextctl.py:317` 的 `file_lock()`
  用 `os.open(path, O_RDWR|O_CREAT|O_NOFOLLOW, 0o600)` 打开后 `fcntl.flock`，**从不 unlink**；它锁的正是
  `session_dir / ".lock"`（`:987` `render_session`、`:1300` 维护检查、`:1476/:1527/:1539` 经 `request_path.parent`）。
  目录命名同样对得上：`:105-106` 生成 `s-{urlsafe_b64(session_id)}`，与现场 `s-MDFhMDdiOTYt…`
  （解码 `01a07b96-384e-7ab0-9763-75e9c253cd1f`）一致；同目录里的 `maintenance-request.json` 由 `:1299` 写出，
  而该文件名在**本扩展现码 0 命中**。

⇒ **补审二 D7 的归属是错的**：这些不是 `lock.ts` 陈旧窃取路径的现场依据，`lock.ts` 的依据仍只有代码级理由。
（顺带更正本节初稿的另一处错：移植并不「不产生锁文件」—— flock 本身不必留文件，但移植的 `file_lock()` 带
`O_CREAT`，**每次 `render_session` 都在会话目录留一个 0 字节文件**，数量以会话目录数为上界。
另：我先前记的「CipherCat 22 个」数字不准确，现场实测 CipherCat 15、codex-project-context 3、本仓 1。）

**已清理**（owner 指令「3 清理了吧」，2026-10-04）：共 **19 个 0 字节 `.lock`**。删前逐项核验三件事：
未被 git 跟踪（并被 `.agents/memory/session-logs/.gitignore` 的 `*/` 覆盖）、无进程持有（`fuser`）、
全部 0 字节且 mtime 超 1 小时；删后会话目录本体完好（`session.jsonl` 68 / 14 / 0 份）且三个仓的
`git status` 未受影响。**归属已正，故本条不再是「无主残留」。**

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
- 本轮净结果：**1 条更正并把归属坐实**（D7 陈旧锁 = Codex 移植的 flock 文件，非 `lock.ts`，已清理 19 个）、
  **1 条维持并附排除记录**（D4 迁移）、**1 条重要现场发现**（N1 pi 会话文件非只追加）、
  **1 条残留**（N2 autolearn 第二级降级从未触发）、**1 条未证**（inventory 8000 字符）。
- 两族均无死模块：`autolearn/*` 有 55 次真实调用 + ~40 个候选产物；`archive/*` 有 ~440 个归档 + 索引触顶。
- 记忆层教训（与补审二 D1 同族）：**「日志键 0 命中」只能证明该*错误*没发生，不能证明机制没运行**；
  本轮 D4 靠「找成功产物」（manifest）才发现要重新判定，而核查后 manifest 属兄弟移植 —— 两次都要落到产物上。

## 6. 未关闭项处置（owner 授权「处理掉所有未关闭项」，2026-10-04）

| 项 | 处置 | 依据 |
| --- | --- | --- |
| N2：autolearn 第二级降级（约 6 行 + 进程级 Set） | **保留**，记为已裁定残留 | 现场 0 命中，但它是「本会话静默停用」唯一的可见信号；删掉会让上层 `modelBlocked()` 停泊变成无声，且属行为变更（需另开 release），收益为负。 |
| 「合并式采纳」（外部编辑采纳不防内容被写丢） | **不建**，记为有据候选 | 现场事实成立（UF 父提交丢 61 行），但归因复核显示该仓记忆层的主要侵蚀者是 **pi 自身的重投影**（130 → 87 行，丢 106 行）；pi 自己写的内容不是「外部编辑」，该机制对主要丢失向量无效。日后若动，先解决重投影时的内容保留（上限/合并策略），而不是采纳路径。 |
| D1「`maybeTrigger` / `runHandoff` 无测试」 | **已关闭**（更正，非缺陷） | 见补审二 §D1 的测试位置表；不需要 `wontfix` —— 它从来不是代码问题，只是被写错的事实。 |
| 选项 M（把超限压缩重试改瞄 `record_memory`，使被接受的回复落到 `renderMemoryDocument`） | **未采纳**（会话级候选） | 未落入设计，本轮无新增现场事实支持新增机制。 |
| 选项 N | **已否决** | 会话记录在案。 |
| `AUTOLEARN_INVENTORY_CHARS = 8000` 截断不可观测 | **未证，保留** | 截断不打日志 ⇒ 无法验证；量子矩阵「35 未跟踪 + 12 已跟踪」skill 使其在最大消费者上可能触顶。要可观测就得加日志，属新机制、无现场需求支撑。 |
| 陈旧 `.lock`（原 22 个说法） | **已清理并归属** | 见 §2：Codex 移植的 flock 文件，实测 19 个已删。 |

## 7. 补记：并回后数小时内，pi 的重渲染又丢了一次内容（2026-10-04）

收口兄弟仓时发现两者的 `MEMORY.md` 工作树都是 **pi 的新一轮重渲染**，且都把策展内容丢了。这不是外部写入者干的，是**本扩展自己的渲染路径**：

| 仓 | 工作树渲染 | 丢掉的东西 |
| --- | --- | --- |
| UniField | 42,006 字符 / 149 行（vs HEAD 18,976 / 102） | 21 个受检数值键丢 **13** 个：`41.5` `19.9` `49.8` `53.6` `56.7` `0.0777` `0.0473` `28.5` `2.06` `2.46` `13.9` `α −31.39` 以及 `S1/S2/S3` 标签本身 —— 即 `84fe9a9` 刚并回的整块与 `§37.123 ①` 读数，**并回后不到一天再次消失** |
| Quantum_Matrix | 11,211 字符 / 117 行（vs HEAD 17,998 / 91） | 文件自述的「本文件是**有损摘要**」「数字一律指向登记表」两句；`qm-memory-md-lossy-rewrite-guard` 与 checkout 恢复行尚存 |

**机制（两条，均有据）**：

1. 渲染产自扩展自己的记忆状态与模型回复，**不产自外部文件当前的字节** ⇒ 手工/宿主的并回不是持久的：外部编辑采纳保护的是「回复不覆盖外部编辑」，但下一轮渲染重新生成整篇，被并回的行不在其记忆里就再次消失。
2. UF 这次渲染出来的文件 **本身超过该仓上限**（42,006 > `maxMemoryChars=36000`，UF 是全机唯一改过该值的仓），而超限路径是**裁尾**（现场 `[memory]` 报 8 次 cap 丢尾）⇒ 即便不再重渲染，下一次写入也会把尾部裁掉。

**处置**：把丢失行**并入当前版**（不覆盖新渲染）—— UF 回到 44,910 字符 / 168 行且 18 个受检键全部在文件内；QM 补回声明行（11,049 字符，远低于上限）。两仓**只本地提交 `agents/skills/`**，记忆层刻意**不提交**（损失版不入历史）。见 UF `f2824f7`、QM `59b886f`。

**对 §6 的后果**：这不是新机制需求，而是**归属证据**——它第二次证明主要丢失向量是「渲染 + 上限」而不是「外部编辑采纳」。故合并式采纳仍**不建**；真要动，先动重投影时的内容保留（并入当前版 + 上限策略），否则改采纳路径是治错了地方。

**归属（2026-10-04 owner 裁定「不长臂管辖」）**：§7 暴露出的两项收尾**不属本仓**，交回对应项目自决——

- **UF 的上限策略**（并回后 44,910 > `maxMemoryChars=36000`，超限即裁尾）：由 UniField 自己改它那份 `project-context.json` 或收敛渲染，本仓不代设。
- **两仓推送**（UF 的 origin 第二 push URL 是公开站 gitcode，推 = 207 提交 / 18 天未发表研究上网）：由各仓 owner 自己决定，本仓不代推。

本仓对兄弟仓的动作限于「把丢掉的策展行并入当前版 + 本地提交 `agents/skills/`」这一项（owner 先前许可），配置、上限、远端一律未动。

## 8. 补记：被跟踪的 autolearn 候选（2026-10-04 审阅后删除）

`.agents/memory/skill-candidates/pi-project-context-consumer-alert-triage.md` 是全机唯一**被 git 跟踪**的候选
（`candidate: true`，25 行），与 §3 的 P3 分布（候选是 autolearn 写盘路径的产物、各仓普遍存在）不符；它同时
已被提升为正式技能 `.agents/skills/pi-project-context-auxiliary-alert-storm-triage/`，而提升时**丢掉了
`<!-- evidence: … -->` 注释**，所以该候选是那两条会话 id 的唯一载体。

审阅结论：候选内容被正式技能完全覆盖（技能版把证据行换成通用触发描述，并已泛化邻居仓名），保留它只会让
「候选 = 未跟踪流水线状态」的约定出现例外，并使同一路由说明存在两份。

处置：把 provenance（`01a0f19c-40e0-75f6-9452-fa8df68590f0`、`01a0b4de-d116-75fb-b815-6d0fc812cdcb`）记入本
节，然后删除该文件（`git rm`）。此后 `.agents/memory/skill-candidates/` 回归「整目录不跟踪」。
