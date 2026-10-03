# pi 会话 01a1002b-39a0-75d5-bad1-6550a3c82e76 的交接文档

- 生成时间：2026-10-03T08:47:38.915Z
- 项目：/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context
- 会话日志：.agents/memory/session-logs/01a1002b-39a0-75d5-bad1-6550a3c82e76/session.md
- 会话索引：.agents/memory/session-logs/INDEX.md

## 目标
- 完成 `pi-project-context` 的「结构化 consolidation 输出」+ 破坏性发版（命令改名）——`v0.2.0` **已发**。
- 发版后收口：**B**（文档状态漂移）、**D**（记录在案小债）、**E**（其他仓库 owner 操作）、**F**（记忆渲染 churn）。
- 当前焦点 **E**：兄弟仓库 `Quantum_Matrix` / `UniField` 的 `.agents/memory/MEMORY.md` 漂移处置。
- 用户最新指令：**「qm修复迁移。uf三审三校后采纳」**。

## 约束与偏好
- 全部用简体中文回复；提交用英文 Conventional Commits；文档用简体中文。
- **零 npm 依赖是硬约束**（项目无 `package.json`）。
- 评审协议：`.agents/skills/pi-project-context-sandboxed-independent-review/SKILL.md` —— 字节级 `/tmp` 沙箱 + 前后 `git status --porcelain -uall` / `find … stat` 双快照证明零写入；**空 transcript = provider 失败，必须重跑**。
- 动手前先用工具核实文件状态；不重做已完成工作；不替用户选选项。
- 范围外：S4、可配置 CONTEXT cap、CONTEXT.md 读侧迁移、归档 vault/加密、autolearn 节流/准入、handoff summary 路径。
- 兄弟仓库 skill `pi-project-context-sibling-repo-memory-sync`：**不替 owner 选边**、**不替 owner 提交**（leave git commits to the owner）。
- QM 自有护栏 `MAX_CHARS = 18_000` / `MAX_LINES = 100`，docstring 明写「必须恢复而不是放宽上限」。
- 项目根：`/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context`。

## 进度
### 已完成
- [x] `v0.2.0` 发版：`a562d7e`/`afccf5c`/`e90dace`/`a870dc3`(tag object `cc85efd`)；双远端一致。`pi-config` pin `@v0.1.12`→`@v0.2.0`（`1ae281a`）。
- [x] **B**（`4506f77`，含 `7976ebb`/`d4cdad3`）、**D2**（`1f0672c`：`memory/report.ts` 新增 `saveOverflowReply()` 写 `memory-overflow-<ISO>.md`；`shared/gitignore.ts` 加 `"memory-overflow-*.md"`）、**D3**（`1163255`，保持 `deferred`）、**D4**（`65b2699`，`tests/sections-test.mjs` 加 strict resolver 6 断言）、**F**（`e7701ce`/`1b6554f`）。
- [x] **E 审计报告** `.codestable/issues/2026-10-03-consumer-repo-memory-drift/audit.md`（`c4e7a43` → 更正版 `078742c`，11768 字节/185 行，已 push；本仓库 HEAD = 远端 = `078742c`）。
- [x] E 无损清理：两仓库 `MEMORY.md` 备份到 `/tmp/<Repo>-MEMORY.md.before-sync-20261003-123107`；QM 5 个 0 字节陈旧 lock 已删，UF 本就 0。
- [x] 纠正 cap 误判：`wc -c` 是字节、cap 量**字符** ⇒ QM **11009**、UF **26931**，都没超 cap（32000/36000）。
- [x] 好版本身份由 owner 物证裁决：QM `tests/test_memory_index_guard.py` × 当前版 **FAIL**（丢 `['静态投影不动点事实']`）× 富版 17998 **2 passed**；UF `/home/user/unifield-MEMORY-good-20261001-37124b.md` md5 `0de468d6f582f5d58ed3ee5488692d78` 与备份 `MEMORY.md.memory-backup-2026-10-01T08-48-46-062Z-6f6410ac` 逐字节相同。
- [x] 两版是**分叉非新旧**：QM 富版独有 73 行 / 当前版独有 48 行；UF 富版独有 69 行 / 当前版独有 71 行（含 §37.119–§37.124）。
- [x] 三次合并尝试 + 特征 token 覆盖率判据（`ratio()` → 包含度 → 双向特征保全），前两版判不合格（丢 42/145 特征），并抓出真 bug：解析器丢了 `# Project Memory` 与首个 `## ` 之间的**前言段**。
- [x] 内容审计：**QM 好版本几乎无废话**（1 对近重复实为两个不同事实；装置/清单类 24 行/6598 字符 37%；`§L29` 跨 7 行/3203 字符）；**UF 好版本有 35%（12352 字符）临时状态**、装置/清单 59%、小数读数 51%、真重复 1 处（`Encoder/Decoder 对称` 包含度 0.91）。
- [x] **关键结构判定**：UF 当前版是**良性压缩**（10 节全在、条目全在除改标题、多 4 条新纪律；§37.111–124 段 16911→8733）；QM 当前版是**真丢**（6 节→5 节，48→31 条，7→6 策划标记，丢 `当前状态速查`/`方法清单` 两整节）。
- [x] `CLAUDE.md` P1 确认：`Encoder/Decoder 对称 = 2026-09-28 用户裁定取消`；MEMORY.md 里说了 3 遍（`[6]`/`[7]`/`[131]`）。
- [x] **QM 修复已执行**：备份 `/tmp/QM-MEMORY-damaged-20261003-134829.md`(18525 字节) → `git checkout HEAD -- .agents/memory/MEMORY.md` → **17998 字符 / md5 `a8da09386b85`**，护栏测试 **2 passed**，git 干净。
- [x] **QM 迁移审计完成**：损坏版真正新增仅 **3 条 / 739 字符**，且全部已有 canonical 归属 ⇒ **无需迁移**：D47→`docs/PROJECT_STATUS.md:311`；D48→`tests/test_adoption_gate_consumption.py:18` 与 `:41` + `docs/analysis/audit_pass1_2026-09-23/d4_findings.md:44`；D63→MEMORY.md 前言 `[3]/[4]`。
- [x] QM 守卫 skill 已加 1 条迁移内容：`.agents/skills/qm-memory-md-lossy-rewrite-guard/SKILL.md`（42→44 行）——「整套 pytest 跑动期间也会发生 ⇒ 跑完全量测试后同样 `git diff .agents/memory/MEMORY.md`」。
- [x] **UF 采纳候选已构建**：`/tmp/UniField-MEMORY-adopted.md`，**26848 字符**（省 83），130 行，10 节完整，3 处修改（删 `[131]` 重复行、`[7]` 去重尾巴、`[47]` 修正过期自述 `~34994 字符 / 54 条 §37.x` → `26931 字符 / 57 个 §37.x`）。
- [x] 评审路由确认可用：`pi -p --no-session --no-project-context --no-skills --no-prompt-templates --tools read,bash --model "commandcode/deepseek/deepseek-v4.1-flash-fast"`。

### 进行中
- [ ] **UF 三审三校**：第 1 轮（审：事实保全 / 校：数字与锚点）已跑，沙箱 `/tmp/uf-mem-review-r1`，输出 `/tmp/laneA-uf-mem-r1.txt`（9990 字节）。**结论未读完（输出被截断）**：节级保全 OK（10 节一致，candidate == current + `diff.txt` 3 hunk），(a) 类抽样已在活仓库 docs 查到，但审出 **(b) 类真丢失 6 条**：
  1. `good L71` 判决规则阈值（`retention ≥0.8 且 cos ≥0.5 ⇒ 分支 A；retention <0.3 ⇒ 先修出口`）→ cand L74 只剩「写死；实测落第三格」
  2. `good L31` 证伪点细节 → cand L32 只剩「证伪点写死；」
  3. `good L81` **D-C ✗ 裁决全库唯一出现点被删** → cand L81 只剩「剩 D-A / D-B / D-C」，与自身 L21/L85 冲突
  4. `good L79`「R² 类必须与 dB 合取」→ cand L80 无
  5. `good L23`「`shared_scale` 只解锁行间相对尺度，每行均值仍未解锁」→ cand L23 无
  6. `good L78`「塌缩与外包增益可分开」→ cand L79 只剩「互斥」
- [ ] 剩余第 2、3 轮评审（每轮 审+校）未跑。
- [ ] 第 1 轮**零写入校验未通过**：沙箱内出现 `./.agents/memory/{.gitignore,MEMORY.md,memory.jsonl,CONTEXT.md}`（4 文件，mtime 同为 `1791008765`）——需确认是否 `--no-project-context` 未阻止写入。
- [ ] 评审 skill 配方与实操冲突待修：skill 写 `--no-extensions`，实为会注销 provider（`Model not found`），必须改 `--no-project-context`；`-m` 不存在（`Error: Unknown option: -m`），须用 `--model`。

### 受阻
- **QM 护栏 18000 与任何并入冲突**：好版本本身 17998，只剩 **2 字符**余量 ⇒ 任何并入都让护栏变红，护栏明禁放宽 ⇒ 已定「不并入，新事实落 docs」。
- **UF 的 26931 是否「采纳」取决于第 1 轮那 6 条 (b) 类真丢失**：我在会话中曾判定「UF 无非丢条目」，**第 1 轮独立评审推翻了这个判断**（按 34 字符粗体标题比对漏掉了整条内容被压掉的情况）。
- UF HEAD 是 **3806 字符**坏压缩版（md5 `b517ce66b93e`），工作树 26931；采纳写入后是否提交留给 owner。
- 恢复持久性未证实：两仓库 journal 均为「一次采纳紧接一次另一版写入，间隔 70–450 ms」（QM 80 ms、UF 329 ms）。

## 关键决策
- **QM = 修复 + 迁移（已完成）**：修复 = `git checkout HEAD -- .agents/memory/MEMORY.md`（HEAD 即好版本 17998）；迁移 = 只把唯一无归属的观察写进守卫 skill，其余 3 条已在 canonical 文档 ⇒ 不写 memory（护栏无余量）。
- **UF = 采纳 current 压缩版 + 3 处小修，但须先过三审三校**；不以「好版本 34994」或任何 merged/merged2/merged3 候选为底。
- **QM/UF 的 merged/union/merged2/merged3 候选全部弃用**：它们以冗长版为底；UF 现成的压缩版质量更高。
- **不替 owner 提交兄弟仓库改动**（skill 明文）；写入留给 owner 决定是否 commit。
- **Encoder/Decoder 对称归一为一条**：它是 2026-09-28 已取消项，出现 3 遍即冗余，归属应为「已取消/勿重提」而非不变量正文。
- 审计文档已按更正版重提交（`078742c`）并 push。

## 后续步骤
1. 读完 `/tmp/laneA-uf-mem-r1.txt` 尾部取第 1 轮 `VERDICT:` 行。
2. 按第 1 轮 (b) 类 6 条真丢失**修正** `/tmp/UniField-MEMORY-adopted.md`（把阈值/裁决/D-C ✗ 等结论补回，或改以 `good.md` 为底只保留压缩版的读数删减）。
3. 跑 UF 第 2、3 轮评审（换角度：去重正确性 / P1 不变量 / 对抗性），每轮保持「审 + 校 + `VERDICT:`」格式与零写入双快照。
4. 处理第 1 轮零写入校验失败（查 `--no-project-context` 是否未阻止 `.agents/memory` 落盘），必要时在 skill 里记一条。
5. 修正 `.agents/skills/pi-project-context-sandboxed-independent-review/SKILL.md` 的配方（`--no-extensions` → `--no-project-context`；`-m` → `--model`）。
6. 三轮全 `PASSED` 后把候选写入 `UniField/.agents/memory/MEMORY.md`（**不提交**，交 owner）。
7. 收尾：归档 `errors.log`（QM 104628 字节、UF 53671 字节，末行均 `[memory] adopted an externally edited MEMORY.md into the memory journal`）、清理 `MEMORY.md.memory-backup-*`、提醒 owner 重启 pi。

## 关键上下文
- **仓库**：`/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/{pi-project-context,Quantum_Matrix,UniField}`；记忆路径 `<Repo>/.agents/memory/MEMORY.md`。
- **好版本文件**：QM `.agents/memory/MEMORY.md.memory-backup-2026-09-30T09-29-25-468Z-7e391801`(17998, md5 `a8da09386b85` = HEAD)；UF `.agents/memory/MEMORY.md.memory-backup-2026-10-01T08-48-46-062Z-6f6410ac`(34994, md5 `0de468d6`) = `/home/user/unifield-MEMORY-good-20261001-37124b.md`；前值 `…-37124.md`(34614)、`…-37123.md`(31726)、`…-37122.md`(30733)、`…-20260930-37121.md`(29057)。
- **QM 7 个 CURATED_MARKERS**：`不是线性预算旋钮` / `不是 M1 不动点`（当前版缺） / `不证明进程活着` / `纯 CSG vs` / `R·M·R` / `DWL` / `qm-memory-md-lossy-rewrite-guard`。
- **journal 时间线**：QM 11009→17998→11009→17998→11009（末条 ts `2026-09-30T09:29:25.553Z`）；UF 31883→32960→26931→34994→26931（末条 `2026-10-01T08:48:46.701Z`）。
- **QM MEMORY.md 前言**：`[3]` 有损摘要、数字指向登记表、目标 ≤100 行/≤20k 字符、cap = 32000；`[4]` 恢复 = `git checkout HEAD -- .agents/memory/MEMORY.md`、提交前必 `git diff`、耐久事实落 docs；`[6]`–`[11]` 权威文档层级（`AGENTS.md`→`RULES.md`→`docs/TERMINOLOGY.md`；`docs/PROJECT_STATUS.md`→`docs/CSG_COMPLEXITY_AND_METRICS.md`（数字唯一权威）→`docs/CSG_NEXT_LINES_PLAN.md`；审计 `docs/analysis/CODE_AUDIT_2026-09-18.md`）。
- **schema 重建最低 cap**：QM ≈**32549**（`Invariants` 为约束节）；UF ≈**74612**（`Invariants` 40% 约束）；`body_cap = cap - 76`；四节 `Project/Invariants/Pitfalls/Index` = `0.2/0.4/0.25/0.15`；节名只认英文。
- **当前裁剪实现**：`memory/document.ts` `clipToLineBoundaryBothEnds` = 头 60%（`CLIP_HEAD_SHARE`）+ 尾 40%，按整行收边，位置盲裁。
- **双远端**：forgejo `ssh://forgejo@git.lentech.site/C02-1010751281/pi-project-context.git`；github `ssh://git@ssh.github.com:443/P02-1010751281/pi-project-context.git`。
- **本仓库提交序列**：`a562d7e`/`afccf5c`/`e90dace`/`a870dc3`(tag `v0.2.0`, object `cc85efd`)/`6ef87e8`/`9d8e276`/`1b6554f`/`4506f77`/`e7701ce`/`65b2699`/`1f0672c`/`1163255`/`c4e7a43`/`078742c`。
- **测试**：`node tests/run-all.mjs`（14 文件）；计数惯例 opaque 门 74 / 整文件 136。
- **路由事实**：`deepseek/*` → `402 Insufficient Balance`；`commandcode/claude-sonnet-5` → `403 MODEL_NOT_IN_PLAN`；**唯一可用 = `commandcode/deepseek/deepseek-v4.1-flash-fast`**；评审命令**绝不可加 `--no-extensions`**。
- **沙箱配方**：`rm -rf /tmp/pi-context-revN && cp -a "$ROOT" /tmp/pi-context-revN`；双基线 `git status --porcelain -uall | sort > /tmp/revN-baseline-status.txt`、`find . -path ./.git -prune -o -type f -print0 | xargs -0 stat -c '%Y %s %n' | sort > /tmp/revN-baseline-files.txt`；已用到 rev27。
- **`/tmp` 交付物**：`/tmp/Quantum_Matrix-MEMORY-merged.md`(18889/103)、`-merged2.md`(19330)、`-merged3.md`(21985/108)、`-union.md`(27479/143)；`/tmp/UniField-MEMORY-merged.md`(35271/150)、`-merged2.md`(31899)、`-merged3.md`(43954/161)、`-union.md`(55285/220)、**`-adopted.md`(26848/130)**；`/tmp/QM-MEMORY-damaged-20261003-134829.md`。
- **`.agents/memory/.gitignore`** 忽略 `memory.jsonl`、`session-logs/`；跟踪 `CONTEXT.md`/`HANDOFF.md`/`MEMORY.md`/`project-context.json`/`.gitignore`。
- **docs 规模**：QM 59 个 docs 文件；UF 331 个。抽查「事实在 docs 里」：QM `文本锚点` → 0、`beam 臂数字` → 0；QM `deploy_longrun.sh` → 3；UF `§37.115`/`§37.111` → 各 3、`precheck_z_specificity_penalty` → 2。
- **工作树脏项（F 类，未提交）**：`M .agents/memory/HANDOFF.md`、`M .agents/memory/MEMORY.md`、`M .agents/memory/project-context.json`（仅 `autolearnAt` 时间戳）；另有未跟踪 `.agents/skills/pi-project-context-sibling-memory-divergence-audit/`。
- **会话 id**：原始 `01a0ffe8-b130-75d5-bad1-653433230515`；最近 `01a10009-ed71-75d5-bad1-6542db71ee0f`（JSONL 在 `/home/user/.pi/agent/sessions/--run-media-user-6b058d20-a617-484d-b7c6-cd7146baf77c-Projects-pi-project-context--/2026-10-03T04-33-33-041Z_01a10009-ed71-75d5-bad1-6542db71ee0f.jsonl`）。
