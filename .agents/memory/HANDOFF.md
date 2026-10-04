# pi 会话 01a10519-1121-707e-a185-5691eece6634 的交接文档

- 生成时间：2026-10-04T10:49:03.234Z
- 项目：/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context
- 会话日志：.agents/memory/session-logs/01a10519-1121-707e-a185-5691eece6634/session.md
- 会话索引：.agents/memory/session-logs/INDEX.md

## 目标
- **本仓 pi-project-context 收口**（已基本完成）：关闭上一会话遗留的全部未关闭项，写出设计复杂度审计主文 + 补审一/二/三并双推。
- **本轮追加任务（进行中）**：按 owner 反馈修正文档质量与边界——① 超长段落补换行；② 清理陈旧信息；③ 版本变更信息应落到 CHANGELOG；④ 澄清 architecture 与 dataflow 的关系、以及「学到的事」是否该进 architecture；⑤ 精简 pi 内（skill description）过长的描述；⑥ **最新质疑：审计信息为何审到项目外**——需把消费仓的具体状态从本仓记忆层里剔除，只保留本仓教训 + 指向审计。
- **owner 裁定**：「交给对应的项目去解决吧？不长臂管辖」——UF 的 `maxMemoryChars`、兄弟仓推送一律交回各自项目，本仓不代决。

## 约束与偏好
- 全程简体中文；本仓提交用英文 Conventional Commits；UF 用中文 conventional commits；`.codestable` 正文中文、frontmatter 机读。
- 零 npm 依赖；测试 `node tests/run-all.mjs`（15 个文件）。
- 双推 URL：`ssh://forgejo@git.lentech.site/C02-1010751281/pi-project-context.git` + `ssh://git@ssh.github.com:443/P02-1010751281/pi-project-context.git`，每次用 `git ls-remote` 核验一致；保护分支禁止 force-push。
- 记忆文件（`.agents/memory/*`）是震荡文件，**禁用 edit 工具**，用 python 脚本 + 锚点断言改写。
- 记忆渲染提交独立成 `docs(memory): refresh the memory render` 切片；偶发渲染余波留工作树不提交。
- 兄弟仓（UniField/Quantum_Matrix）**只做本地提交、不推送**；不替 owner 选边。
- 审计判据：机制必须能追溯到现场事实（errors.log / journal / 配置 / 文件产物）、看膨胀信号与规模比，「未查完」必须诚实声明。
- 范围外：选项 M/N、D1、可配置 CONTEXT cap、读侧迁移、归档 vault/加密、autolearn 节流。

## 进展
### 已完成
- **陈旧 `.lock` 归属与清理**：实测 19 个（CipherCat 15 / codex-project-context 3 / 本仓 1，非先前记的 22），全部是 Codex 移植 `codex-project-context/scripts/contextctl.py:317` 的 `fcntl.flock`（`O_CREAT` 后从不 unlink）；已清扫，`6707376`。
- **审计收口**：补审三 §6 未关闭项处置表 `9c5a548`；新 skill `pi-project-context-audit-claim-verification` 修正（原写「移植用 flock ⇒ 不写锁文件」等 4 处错）`47598f8`。
- **记忆渲染切片**：`8d6162a`、`8697d94`、`af1f9d3`、`7b245b3`。
- **兄弟仓记忆并回**：发现 pi 新渲染丢策展内容——UF 21 个受检键丢 13（`41.5/19.9/49.8/53.6/56.7/0.0777→0.0473/28.5/2.06→2.46/13.9/α -31.39` 及 `S1/S2/S3` 标签）；QM 丢自身「有损摘要 / 数字一律指向登记表」声明。已按「并入当前版」原则并回（UF 44,910 字符 / 168 行、18 键全在位；QM 11,049 → 后被并发会话重渲染至 18,146 字符且保住声明）。
- **兄弟仓 skills 本地提交**：UF `f2824f7`（12 skill，+478 行）、QM `59b886f`（36 文件，+1,370 行）；记忆层刻意不提交。
- **审计补审三 §7**：记录第二次现场丢内容（`12ca850`）；`14ad27a` 写入归属移交（UF 上限与两仓推送交回各自项目）。
- **文档传播点清扫**：主审计 `:96`、补审二 `:148`/`:190`、MEMORY.md 的 22→19 计数全部更正，`9d8c677`。
- **文档缺口补写**：`docs/architecture.md` 记忆节 +1 条「手工并回不持久」；`docs/configuration.md` cap 节 +1 段「cap 每次写入都生效」。
- **`docs/README.md` 索引去钉死**：原把「当前」钉在 2026-09-19 issue（实际已 14 个、最新 2026-10-03），改为布局描述并补 `audits/`、`attention.md`，`66cddc0`。
- **修真 bug**：pi 自更新到 **1.0.2** 改用 managed 安装树（`/home/user/.pi/agent/install/releases/1.0.2/node_modules/@earendil-works/pi-coding-agent`），`tests/harness.mjs` 找不到 pi 包 ⇒ 15/15 全红。改为读 `install/current-version`（认 `PI_CODING_AGENT_DIR`）+ 新增 `findDep` 向上搜（npm 把 jiti/typebox/pi-ai 提升到 release 顶层）+ 导出 `PI_AI_DIST` 供 `tests/sections-test.mjs` 复用；变异自证三方向均变红（jiti 坏 → 14/15 红；pi 发现抛错 → 15/15 红；pi-ai 坏 → module-not-found），`e3585ce`。
- **pi Tab 补全问答**：有——键位 `tui.input.tab` = `tab`（描述 "Tab or autocomplete"），触发字符 `/` 与 `@`，`autocompleteMaxVisible` 默认 5（钳制 3–20），`shift+tab` 循环 thinking level，扩展 API `autocompleteProvider`/`autocompleteProviderWrappers`；**无** shell 补全。
- **状态**：HEAD `66cddc0be8f9` 双 URL 一致，工作树 0 脏，测试 15/15，`extensions/` 相对 v0.2.1（`ab0984c`）**0 差异**（仅 tests/ 3 处 + docs）⇒ 不需要新标签。
- **自曝两处**：误用 `git checkout tests/harness.mjs` 撤掉未提交修复（当场 15 全红暴露，已重做并改 /tmp 备份法）；`af1f9d3` 提交信息误列 `MAX_INDEX_LINES` 为「幸存常量」（实测两版均无该串，已口头自纠，不重写历史）。

### 进行中
- [ ] **「审计审到项目外了」的边界修正**（最新 owner 质疑，已盘点未动手）：
  - 盘点结果：`MEMORY.md` **10 行**、`CONTEXT.md` **11 行**提到外部项目；`docs/architecture.md` 1 行；`docs/configuration.md` 0 行；审计 4 文件（属证据，应保留）。
  - MEMORY.md 待改写行：L15（消费仓提交数/领先量）、L40、L67（UniField `maxMemoryChars` 具体值）、L69（19 个 .lock 三仓拆分）、L70（`migration-manifest.json` 在 CipherCat/QM）、L71（UF 2026-10-03 重写，父提交 `1df6dc6` 63 行 / 7,036 字节、UF `4d54838`）、**L72（UF 自身研究数值 pc_ch 41.5、2.06/2.46、53.6/49.8、36.3、15.37、29.71、0.005、13.9、20.7 —— 最明确越界，应删）**、L73、L76、L98。
  - CONTEXT.md 待改写行：L7、L12、L13、L17、L21、L22、L23、L25、L29、L30、L35。
  - 处置原则：证据留在审计；本仓记忆只留「本仓教训 + 指向审计」；`docs/architecture.md` 去掉 UniField 现场出处。
- [ ] **上一轮 5 条文档批评的其余部分**：
  - 超长段落：`docs/configuration.md` 有 7 行 >200 字符（L58 395、L68 222、L72 508、L74 567、L76 270、L93 413、L107 251），需按句/分号换行；我新增的行均 ≤200 字符。
  - CHANGELOG：**仓内无 `CHANGELOG.md`**；已有 tag `v0.1.0`(2026-09-12) … `v0.1.12`(2026-10-01)、`v0.2.0`/`v0.2.1`(2026-10-03)；应新建并按版本收录变更，「学到的事/事故史」放这里而非 architecture。
  - architecture vs dataflow：`docs/architecture.md` 已分节（`## 数据流`/`## 数据布局`/`## memory 与 context`/`## 记忆写入与恢复`/`## consolidation 的安全语义`/`## 旧数据迁移`/`## 源码模块`），需据此回答并决定是否调整索引措辞。
  - skill description 精简：本项目 18 个 skill 描述偏长，最长 `pi-project-context-memory-cap-budget-change` 361、`sibling-memory-divergence-audit` 296、`write-lock-hardening` 282、`memory-recovery` 276、`memory-clip-path-triage` 272、`auxiliary-alert-storm-triage` 261、`audit-claim-verification` 235（每会话都进系统提示）；pi 文档要求 description = 「做什么 + 何时用」的路由描述。

### 受阻
- （无）。历史中断原因：会话路由 `scnet/DeepSeek-V4.1-Flash-Event` 403；`commandcode` 周限 429（复位 `2026-10-08T08:37:39.517Z`）。
- 一次全盘 `grep` 超时（600s），之后已收窄范围。

## 关键决策
- **主要丢失向量 = 「渲染 + 上限」而非「外部编辑采纳」**：故**不建**「合并式采纳」守卫（G）；真要动先动重投影内容保留与 cap 策略。第二次现场（UF 并回后不到一天再丢）作为归属证据记入补审三 §7。
- **兄弟仓只本地提交、不推送**：UF origin 第二 push URL 是公开站 `git@gitcode.com:c021010751281/UniField.git`，推 = 207 提交 / 18 天未发表研究上网且不可撤回；QM 仅私有 forgejo。owner 裁定「不长臂管辖」后归属写进 `14ad27a`。
- **陈旧 `.lock` 归属 Codex 移植**，`lock.ts` 依据回到代码级（陈旧窃取 + inode 绑定 + 持有者自删）。
- **记忆渲染提交惯例**：MEMORY.md 的 deliberate 更新按 `docs(memory): refresh the memory render` 独立切片提交，不塞进 audits 提交。
- **测试发现逻辑改为结构化解路径**（读 `install/current-version` + `findDep` 向上搜），不再硬编码机器路径；`PI_PKG` 仍优先。
- **D4 维持原判**（`migration-manifest.json` 只出现在 Codex 移植设计文档，代码 0 命中）；**N2 autolearn 第二级降级保留**（静默停用唯一可见信号，收益为负）。

## 下一步
1. 回答「审计信息怎么审到项目外了」：说明机制——本扩展**自身无运行时**，现场证据必然产自消费仓（CipherCat/QM/UF/pi-custom-providers），**只读取证合法**；越界在于把消费仓具体状态**抄进了本仓记忆/文档**。据此执行修正。
2. 用 python + 锚点断言改写 `MEMORY.md` 那 10 行（尤其删除 L72 的 UF 研究数值），并改写 `CONTEXT.md` 的 11 行；`docs/architecture.md` 去掉 UniField 现场出处；本仓只留教训 + 「见补审三 §7」指针。
3. 复查修复后的渲染是否又丢内容（对照前一版键值），再按 `docs(memory): refresh the memory render` 提交 + 双推。
4. 新建 `CHANGELOG.md`（按 tag `v0.1.0`…`v0.2.1` 从 `git log`/tag 日期取材，Keep a Changelog 风格），并把「学到的事/事故史」从 architecture 迁到 changelog，普及「版本级变更进 CHANGELOG、语义留 docs」。
5. 重排 `docs/*.md` 中 >120~200 字符的长段落为多行；回答 architecture vs dataflow（同文件不同节，非同义）；精简 18 个项目 skill 的 description 至 ~150 字符内（what + when）。
6. 每步 commit（英文 Conventional Commits）+ 双推 + `git ls-remote` 核验 + `node tests/run-all.mjs` 15/15；`extensions/` 无改动 ⇒ 仍不发新标签。

## 关键上下文
- **路径**：仓根 `/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context`；兄弟仓同级的 `UniField`、`Quantum_Matrix`。
- **本会话提交序列**：`6707376 → 9c5a548 → 47598f8 → 8d6162a → 12ca850 → 8697d94 → af1f9d3 → 14ad27a → 9d8c677 → e3585ce → 7b245b3 → 66cddc0`；HEAD `66cddc0be8f9` 双 URL 一致；tag 最高 `v0.2.1` = `ab0984c`（2026-10-03 23:27:02 +0800）。
- **兄弟仓现状**：UF HEAD `f2824f7`（领先 origin/master 207，记忆层脏 8；`MEMORY.md` 44,910 字符 > `maxMemoryChars=36000`，即超 8,910）；QM HEAD `a78351d`（另一活跃会话 12:08 在我 `59b886f` 之上提交 `docs: fold the memory index back under budget, keeping the AUD-51 and L32.8 facts`，领先 206，记忆层脏 2）。
- **pi 安装**：版本 **1.0.2**，managed 树 `~/.pi/agent/install/releases/1.0.2/node_modules/@earendil-works/pi-coding-agent`；文档在 `<pkg>/docs/`（`skills.md`、`keybindings.md`、`cli.md`、`configuration.md` 等）；旧路径 `~/.local/lib/node_modules/@earendil-works/` 已为**空壳**（含 `/usr/lib/node_modules/@earendil-works`，均无 `dist/index.js`）。
- **审计文档**：`.codestable/audits/2026-10-03-design-complexity-audit.md`（:96 已更正）、`2026-10-04-...-addendum-2-module-inventory.md`（:148/:190 已更正；58 模块 / 7,772 行）、`2026-10-04-...-addendum-3-autolearn-archive.md`（§7 第二次现场，尾部含归属移交段，总 209 行）。
- **模块数口径**：`extensions/project-context` 下 `.ts` 文件 **58** 个，唯一 basename **52** 个；architecture.md「源码模块」列 52 个 basename 与实际 0 差。
- **`.codestable/attention.md`**：CodeStable 技能必读入口，报告语言中文、评审路由是变量（`pi --list-models` 枚举 + `pi -p ... --model "<provider>/<model>"` 廉价探针）、`pi auth check` 对扩展注册 provider 一律 `provider_not_found`，无过期项。
- **关键配置常量**：`MAX_INDEX_LINES=200`、`AUTOLEARN_INVENTORY_CHARS=8000`、`MAX_LIST_ITEM_CHARS`、`MAX_SUMMARY_CHARS=6000`；`maxMemoryChars` 默认 32000、范围 4000–200000，UF 是全机唯一改过该值的仓。
- **测试工具**：`tests/harness.mjs`（`findPiPackage`、`findDep`、`PI_AI_DIST`、`jitiEntry`、`loaderUrl`）、`tests/sections-test.mjs`（用 `PI_AI_DIST`）；断言用 jiti loader、`moduleCache: false`。
- **探针/临时物**：`/tmp/harness-fixed.bak`、`/tmp/doc-mods.txt`、`/tmp/real-mods.txt`、`/tmp/all-errors.log`。
- **可用 mutating 证据**：UF `MEMORY.md.memory-backup-2026-10-04T04-05-29-803Z-*.md`（71 KB，证外部并回被采纳）；QM 12:06:53 重渲染保住声明行（证采纳路径有效）。

<modified-files>
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.codestable/audits/2026-10-03-design-complexity-audit.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.codestable/audits/2026-10-04-design-complexity-audit-addendum-2-module-inventory.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/docs/README.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/docs/architecture.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/docs/configuration.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/tests/harness.mjs
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/tests/sections-test.mjs
</modified-files>
