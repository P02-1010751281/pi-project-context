# pi 会话 01a10294-cac8-75d5-bad1-65ca09b88da1 的交接文档

- 生成时间：2026-10-03T16:39:13.980Z
- 项目：/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context
- 会话日志：.agents/memory/session-logs/01a10294-cac8-75d5-bad1-65ca09b88da1/session.md
- 会话索引：.agents/memory/session-logs/INDEX.md

## 目标
- **item 4（已完成）**：向用户解释兄弟仓 UniField 的 `MEMORY.md` 分歧（并回 / 还原 / 保持现状 三选一）；owner 已选**并回**。
- **item 5 第二轮（已完成）**：补审 `handoff/*`、`shared/*`、`memory/*` 等全部 58 个模块，写补审二并提交双推。
- **第三轮（进行中）**：审计 `autolearn/*`（8 文件 729 行）与 `archive/*`（4 文件 687 行），判据同主审计（机制必须能追溯到现场事实），写补审三 + 提交双推。
- **配带任务（已完成）**：UF 记忆并回 + 本地提交（不推）。

## 约束与偏好
- 全程简体中文；提交用英文 Conventional Commits（pi-project-context）；UF 用中文 conventional commits。
- `.codestable` 正文中文、frontmatter 机读。
- 零 npm 依赖；测试 `node tests/run-all.mjs`（15 个）。
- 审计判据：①机制必须能追溯到现场事实（errors.log / journal / 配置 / 文件产物）；②膨胀信号；③规模比。
- 「未查完」必须诚实声明。
- 兄弟仓只做**本地提交、不推送**；只提交 git 已跟踪的记忆文件；不替 owner 选边。
- 记忆文件是震荡文件，**禁用 edit 工具**，用 python 脚本 + 锚点断言改写。
- 范围外：M/N、D1、可配置 CONTEXT cap、读侧迁移、归档 vault/加密、autolearn 节流。

## 进展
### 已完成
- [x] **item 5 第二轮收口**：`.codestable/audits/2026-10-04-design-complexity-audit-addendum-2-module-inventory.md`（14,494 B）已写入并提交 `25df85f`，forgejo + github mirror + local **三处一致** `25df85f938d1`；测试 15/15；工作树仅 `.agents/memory/*` churn。
- [x] **重要更正（D1）**：补审一/项目记忆里「`maybeTrigger` 与 `runHandoff` 无测试」是**错的**。`tests/handoff-test.mjs` 用 `newSession` mock 覆盖 `runHandoff` 跳过/成功/cancel/throw 四路径（:750/:803/:1021/:1032），并断言 `maybeTrigger` 触发（:368-370）+ 不叠加（:377）。已在补审一 §2.4、主审计摘要、`MEMORY.md`（渲染后落到 `:59`）三处更正；journal 已采纳（1 命中）。
- [x] **item 4 解释已给出**，并**自行更正**：「`41.5` 只在父提交、重渲染即永久丢失」**不准确**。逐行核对 `docs/discussion-log.md`（UF 权威记录）已含 41.5（10 处）、2.06/2.46（各 11 处）、53.6/49.8/20.7/36.3/15.37/29.71/0.005/13.9 等；真正只在 MEMORY.md 有记录的只有 3 行：FC→PC→FC⁻¹ **56.7 dB**、w-L1 **0.0777→0.0473** 与波形 PSNR **28.5→15.5** 那一组。
- [x] **UF 并回完成**：`UniField/.agents/memory/MEMORY.md` 16,636 → **18,976 字符**（上限 `maxMemoryChars=36000`，余量 17,024；字节 25,695 → 28,883）。插入位置 = `## Project` 段末 + `## Invariants` 内 §37.123 ① 锚点后 + Index 的 discussion-log 锚点后。本地提交 **`84fe9a9`**（amend 自 `ee3532b`），**未推送**（领先 origin/master **200**）。保护副本刷新为 `/home/user/unifield-MEMORY-good-20261004-merged.md`（28,883 B）。
- [x] **UF 并回附带的发现**：pi 自身 2026-10-04 重投影又把 130 行版砍到 87 行（**丢 106 行**），其中 3 行含讨论日志查不到的事实，已一并补回（§37.123 ① 四臂读数 α −31.39 / none −6.27 / d32_3k −1.3273 / gauss0 −4.7230，哨兵 18.680924 ✓；survey §37 收录 MGFlow arXiv 2609.35763、RDM/iRDM 2607.02375；ADR §10.11 已在 Index 覆盖故未重复）。据此判：**本仓记忆层的主要侵蚀者是 pi 自己的反复重投影，不是外部写入者**。
- [x] **第三轮探针（现场证据）已取全**：
  - 12 个文件全有顶部理由块。
  - `[autolearn]` **55** 条**全是 model call error**（连接 19 / Codex 周限 8 / 余额 7 / 无 finish_reason 3 / 周限 3 / terminated 2 / 5 小时限 2 / 无额度 2 / 其他），pass.ts 自身两个降级日志键（「MEMORY.md exists but cannot be read」、「autolearn is disabled for this session after repeated auxiliary-call failures」）**0 命中**。
  - `[session-index]` 1 条 + `[session-log]` 1 条，均为 2026-09-18T08:46「This extension ctx is stale after session replacement or reload」。
  - **归档层现场强**：QM 240 会话目录 / 235 jsonl / 237 md / `INDEX.md` **201 行** ⇒ `MAX_INDEX_LINES=200` **真的被现场触发**。
  - **`migration-manifest.json` 存在**：`CipherCat`（801 B，2026-09-19，条目：`/home/user/.omp/agent/memories/...CipherCat--/learned.md` → `skill-candidates/omp-learned.md`，status `copied`）、`Quantum_Matrix`（3,827 B，2026-09-16，条目：`session-index.md` → `session-logs/INDEX.md`，status `conflict-preserved`）⇒ **补审二 §D4「migration 0/9 现场」需更正**。
  - **`skill-candidates/` 有现场**：pi-custom-providers 12 个、CipherCat 2+、HWCup-Math-A 1、pi-project-context 1 ⇒ candidate.ts 有据。
  - `.agents/memory/.gitignore` 存在（gitignore.ts 有据）。
  - `autolearn/pass.ts`：`registerAutolearn` 内 `active` 单飞、`pausedAnnounced` Set、`throttle` Map；`run()` 依次查 `runIsDisabled()`、`config.autoLearn`、`modelBlocked("autolearn", projectRoot)`（call-policy 停车，防一次故障变风暴）。

### 进行中
- [ ] **写第三轮补审文档**：建议 `.codestable/audits/2026-10-04-design-complexity-audit-addendum-3-autolearn-archive.md`。内容：探针表（`[autolearn]`/`[session-log]`/`[session-index]` 键 vs 真机命中、归档产物计数、manifest、skill-candidates、`.lock`）、发现、更正（D4 迁移有现场、陈旧锁归属）、未查完声明。
- [ ] **更正补审二**：§D4（`migration` 有现场证据，`migration-manifest.json` 在 CipherCat/QM 实存）；§D7（22 个陈旧 `.lock` 归属不确定，不能作为 lock.ts 的现场依据）。
- [ ] **提交 + 双推** pi-project-context（`ssh://forgejo@git.lentech.site/C02-1010751281/pi-project-context.git` + `ssh://git@ssh.github.com:443/P02-1010751281/pi-project-context.git`，用 `git ls-remote` 分别验证）。

### 受阻
- （无）。历史中断原因：会话自身路由 `scnet/DeepSeek-V4.1-Flash-Event` 返回 403；`commandcode` 周限 429（复位 `2026-10-08T08:37:39.517Z`）。

## 关键决策
- **UF 并回落在「当前 pi 渲染版」而非 130 行提交版**：因为 pi 已把工作树重渲染为 87 行，那才是扩展读取的基准。后果：提交 `84fe9a9` 同时记录了 pi 的重投影（87 insertions / 118 deletions）。
- **并回内容范围**：父版（`1df6dc6`）被删的早期 S1/S2/S3 量化结论 + pi 重投影新丢的 3 行。
- **归因修正**：UF 记忆层主要侵蚀者 = pi 自身反复重投影（UF 记忆自述曾被压到 3806 / ≈9580 字符 ✗）。
- **陈旧 `.lock` 归属**：当前代码锁目标只有 `session-index.lock` / `MEMORY.md.lock` / `project-context.json.lock`（`lock.ts:180` `` `${target}.lock` ``）；archive 历史只用过 `sessionIndexLockTarget`；`codex-project-context` 是 Python 移植（`scripts/contextctl.py`，无 `.ts`、无 `.lock`）⇒ 22 个 `session-logs/<id>/.lock` 归属不确定（疑 omp 时代或该仓自有工具）。
- **autolearn 降级路径定性**：`modelAutoDisabled` 二级降级 0 命中，说明 call-policy 的停车（`modelBlocked`）才是真正生效的机制；记残留，非死代码。

## 下一步
1. 写补审三文档（`autolearn/*` + `archive/*` 全量结论 + 探针表 + 更正）。
2. 就地更正补审二 §D4、§D7（保留原文 + 更正标记）。
3. 提交 pi-project-context 并双推，`git ls-remote` 验证两 URL 一致。
4. 向 owner 汇报：UF 并回已完成（未推）、第三轮结论、以及仍然开着的 owner 侧事项。

## 关键上下文
- **仓库状态**：pi-project-context HEAD `25df85f`（三处一致）；测试 15/15；工作树仅 `.agents/memory/*` churn。UF HEAD `84fe9a9`（领先 origin/master **200**，未推；工作树另有 `CONTEXT.md`、`docs/discussion-log.md`、`scripts/probe_free_latent_reconstruction.py` 等脏项**未动**）。QM HEAD `7d68323`（领先 **201**，未推，脏 48 项）。
- **扩展安装版本**：`pi update --extensions` 只换磁盘代码；pin 与安装克隆仍 `pi-project-context.git@v0.2.1` / 安装克隆 HEAD `ab0984c`，**运行中进程未加载新代码**（owner 需重启）。
- **本轮提交序列**：`dd2adcc` → `ab0984c` → tag `v0.2.1` → `82ca162` → `7f977f8` → `d94a9b8` → `25df85f`。
- **已提交的审计文档**：`.codestable/audits/2026-10-03-design-complexity-audit.md`、`…-addendum-handoff-config.md`、`2026-10-04-design-complexity-audit-addendum-2-module-inventory.md`。
- **关键行号/常量**：`memory/report.ts:319`（`migrateProjectState` 调用点，`session_start`）、`report.ts:169`（`withMemoryLock(memoryFile(...))`）、`lock.ts:180`、`shared/migrate.ts:122`、`shared/config.ts:291`、`archive/archive.ts:69`（`withMemoryLock(sessionIndexLockTarget(projectRoot))`）、`handoff/run.ts:262`（`ctx.newSession`）、`run.ts:490`（命令入口）、`autolearn/schema.ts:59`（`strict:"prefer"`）、`memory/sections.ts:384`。
- **autolearn 常量**：`AUTOLEARN_INVENTORY_CHARS=8000`、`MIN_SKILL_BODY_CHARS=160`、`MAX_SKILL_DESCRIPTION_CHARS=1024`。
- **现场数字**：`[memory]` 369（其中 216 外部编辑采纳、36 无 context 节、8 cap 丢尾、7 不可解析、3+2 regression、2 中段丢弃）、`[autolearn]` 55、`[session-log]`/`[session-index]` 各 1；`*.memory-backup-*` 43 份；`errors.log.*` 2 份；journal 轮转 **0 次**（最大 `memory.jsonl` 373KB < 512KB）；22 个陈旧 0 字节 `.lock`（CipherCat，09-15~10-02）；`~/.pi` 会话文件总数 502。
- **探针产物**：`/tmp/all-errors.log`（合并 errors.log）、`/tmp/uf-parent-mem.md`、`/tmp/uf-130.md`、`/tmp/uf-mem-diff.txt`、`/tmp/uf-merge-msg.txt`。
- **保护副本**：`/home/user/unifield-MEMORY-good-20261004-merged.md`（28,883 B）；历史 `/home/user/unifield-MEMORY-good-20261001-37124b.md`、`…-37124.md`。
- **UF 权威记录**：`docs/discussion-log.md`（最新 §37.124）。
- **上一会话 id**：`01a10263-f936-75d5-bad1-65b5ae27b31f`；更早 `01a1027d-a9a8-75d5-bad1-65be3923cf9a`；JSONL 在 `/home/user/.pi/agent/sessions/--run-media-user-6b058d20-a617-484d-b7c6-cd7146baf77c-Projects-pi-project-context--/`。
- **会话配置**：`PI_PROVIDER=scnet`、`PI_MODEL=DeepSeek-V4.1-Flash-Event`、`PI_REASONING_LEVEL=high`。
- **owner 侧仍开着**：①重启 pi（含 QM/UF 升级+重启）；②UF 推 200 / QM 推 201；③可选 UF `.agents/memory/.gitignore`、`skill-candidates/` 跟踪决定，QM 35 个未跟踪 skill + 改过的 `qm-memory-md-lossy-rewrite-guard/SKILL.md`；④「合并式采纳」机制项（已有现场事实：UF 损失 61 行 + pi 自丢 106 行），owner 定夺。

<read-files>
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/UniField/.agents/memory/MEMORY.md
/tmp/uf-parent-mem.md
</read-files>

<modified-files>
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.codestable/audits/2026-10-03-design-complexity-audit-addendum-handoff-config.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.codestable/audits/2026-10-03-design-complexity-audit.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.codestable/audits/2026-10-04-design-complexity-audit-addendum-2-module-inventory.md
</modified-files>
