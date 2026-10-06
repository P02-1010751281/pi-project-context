# v0.4.2 发布证据

日期：2026-10-05
范围：一轮「应修尽修」的清扫——删除死符号与三处不可达分支；退役无行为读者的 `handoffThinking` 键与
`/handoff thinking` 动词；把 `session_shutdown` 失败回退的根选择抽成可测函数；审计、文档与记忆渲染对齐。
评审记录与逐轮 transcript：本目录；证据与更正史：
`.codestable/audits/2026-10-05-context-cost-and-progressive-disclosure.md` §9.7–§9.12。
用户可见变化只有 `CHANGELOG.md` 的 v0.4.2 段那几条（真实行为变化两条：退役硬切、fence 双视图修复）。

## 提交与标签

| 项 | 值 |
| --- | --- |
| 行为提交 | `bd9fd3a`（审3 nits + `handoffThinking` 退役 + `MIN_DROP_TOKENS` 更名）；`8f4eab7`（死符号删除 + 32 个仅内部使用的导出降级）；`5b01712`（三处 `!force` 不可达分支删除 + `shutdownErrorRoot` 抽出） |
| 评审修复提交 | 审1 `50fb893`；审2 `8b32dcb`；审3 `fa4c15b`；审4 `3a9ef26`；审5 `f2d27c8`；审6 `98aa3a1`；审7 `94f963e`；审8 `df7052a` |
| 记录/文档提交 | `0d2f62b`、`9c46943`、`f064362`、`2a7f7d0`、`15b65cb`、`0a95b4b`（技能晋级/退役）、`1553151`、`8824599`、`739af58`、`611fcef`、`82b06c1`、`4f14bc3`、发布定版提交（本文件所在提交） |
| tag 对象 / peeled / 双远端 | 见「发布后补记」 |

## 九轮独立评审（lane A，模型 `deepseek/deepseek-flash`，/tmp 字节级沙箱 + 零写入证明）

v0.4.1 先例是 3 轮；本轮 9 轮，因为每轮都在**发布文档/记忆渲染的事实面**上发现上一轮未修的同类问题（不是机制迭代）。
每轮都是新起的 `pi -p` 只读进程、冻结沙箱副本、前后零写入证明（`git status` 与 mtime/size 双 diff 空，仅剪掉扩展自身
启动写的 `.agents/memory`）。第 8 轮给出放行判定，第 9 轮确认其后 4 条 nit 的修复。

| 轮 | 冻结点 | 判定 | blocking | important | 该轮实际抓到的东西 |
| --- | --- | --- | --- | --- | --- |
| 审1 | `15b65cb` | CHANGES-REQUESTED | 0 | 2 | 退役理由写反（v0.4.1 里 `handoffThinking` 是已知键、值会持久化）；fence 旧 bug 损害叙述不实（v0.4.1 `splitSections` 本就 fence 感知） |
| 审2 | `1553151` | CHANGES-REQUESTED | 0 | 2 | v0.4.0 改名清单被退役编辑剪掉 `handoffAdaptive→handoffThresholdAuto`；fix-note 横幅留旧理由；矩阵 M7 误把 `FAILURES:` 汇总行计入 |
| 审3 | `8b32dcb` | CHANGES-REQUESTED / RELEASE-OK: no | 0 | 1 | 记忆渲染把 `shutdownErrorRoot` 指到错文件；M6 应 3 红（只跑单文件漏了持久化断言）；「dsh 读自己的 `handoffPendingQuestion`」无据 |
| 审4 | `0149d5a` | CHANGES-REQUESTED / RELEASE-OK: no | 0 | 2 | `git diff --check v0.4.1..HEAD` 不干净且提交信息/CONTEXT 谎称 clean；渲染 Index 三处死名 |
| 审5 | `8824599` | CHANGES-REQUESTED / RELEASE-OK: no | 0 | 2 | Index 归属错（`findCutPoint` 挂到 `handoff/text.ts`）；死名被「散文式替换」成不可 grep 的说法 |
| 审6 | `739af58` | CHANGES-REQUESTED / RELEASE-OK: no | 0 | 1 | 渲染说两处注入在 system prompt **开头**，代码/审计/新 skill 都是末尾 |
| 审7 | `611fcef` | CHANGES-REQUESTED / RELEASE-OK: no | 0 | 1 | 渲染把 archive 的块写成「第二个」，注册序（`index.ts:55-56`）显示它是第一个 |
| 审8 | `82b06c1` | **PASSED / RELEASE-OK: yes** | 0 | 0 | 四项硬门禁 + 按行归属 + 位置/序数全部成立；只余 4 条 nit |
| 审9 | `4f14bc3` | **PASSED / RELEASE-OK: yes** | 0 | 0 | 四处 nit 修复真落地、无新事实错误；仅余审计档案旧句等 nit |

九轮全部零写入（审查者未改动沙箱），transcript 逐轮留档；沙箱每轮归档后删除（本轮曾因 16 GB tmpfs 被历史沙箱占满而清理过
一批，见 MEMORY 的对应 pitfall）。

## 三校（机械核验）

### 校1 套件 + 单侧变异矩阵（冻结版）

- `node tests/run-all.mjs`：**15/15**（本仓与安装副本各跑一次）；`git diff --check v0.4.1..HEAD` 空。
- 单侧变异 7 格（每格只改回一处、只数具名 `FAIL ` 行、跑全量套件）：M1 fence 标题判定 → **3 红**；M2 关闭 fence 长度 → **1 红**；
  M3 退役动词补全 → **1 红**；M4 退役二级补全 → **1 红**；M5 退役动词分支 → **1 红**；M6 `parseConfig` 补回退役键 → **3 红**；
  M7 shutdown 回退只查 `.agents` → **1 红**（抽取 `shutdownErrorRoot` 前该格全绿，见 §9.9/§9.11）。负向对照＝未变异树 15/15。
- 审 8/审 9 另各抽 2–3 格复核，红数与具名断言一致。

### 校2 声明—代码一致性

- 退役叙述七面（CHANGELOG、`docs/configuration.md`、词汇表、`config.ts` 两处注释、设计文档、测试注释、记忆渲染）口径一致：
  pi 侧零行为读者 + 回执承诺在本仓无据 + 跨仓见 R-2；v0.4.1 的「已知键、值会持久化」经 `git show v0.4.1` 复验；硬切语义与
  「`parseConfig` 只留已知键、`updateConfig` 整份重写」的代码事实一致（审 9 独立复现了写回后键消失）。
- `docs/handoff.md` 的公式（`T0 = min(KNEE, U−4000)`、`S` 只进 override 回执、物理下限是拒绝门、固定比例无下限）与
  `threshold.ts` 一致；已删机制在代码/文档/技能中无活动引用（`.codestable/` 冻结档案与 CHANGELOG 历史条目除外）。
- `docs/*.md` 无 >160 字符行；`.agents/skills/` 描述全部 ≤170 字符；渲染 Index 的按行归属检查 23 行 **0 不符**
  （脚本在 `.agents/skills/pi-project-context-curated-surface-hygiene/SKILL.md` §10）。

### 校3 发版机械核验

| 项 | 值 |
| --- | --- |
| 发布前 HEAD | `4f14bc3`（本地 master == forgejo == github） |
| tag 对象 | `1a3ddeec211eb8be115a3c412f4980c87ab79519` |
| tag 指向（peeled） | `4b4f9c3e5ef3bf8513fbac87a1174b53d4baafb8` |
| forgejo | `ls-remote --tags 'v0.4.2*'` → `1a3ddeec211e` + `4b4f9c3e5ef3^{}` |
| github 镜像 | 同上（两行均含 peeled） |
| `~/.pi` pin 提交 | `a170e37`（`agent/settings.json` + `README.md` 改 `@v0.4.2`，已推送 pi-config `origin`） |
| 安装命令 | `pi update --extensions`（拉取 `tag v0.4.2 -> FETCH_HEAD`，HEAD 落到 `4b4f9c3`） |
| 安装副本 HEAD / describe / 脏 | `4b4f9c3e5ef3bf8513fbac87a1174b53d4baafb8` / `v0.4.2`（`fetch --tags` 后；此前为 `v0.4.1-26-g…`）/ 脏文件 0 |
| 副本自测 | `node tests/run-all.mjs` → 15/15 |
| 到位抽检（副本 `extensions/`） | `shutdownErrorRoot` 3 处、`MIN_DROP_TOKENS` 12 处、`force-auto` 7 处；`MIN_SUMMARIZE_TOKENS`/`estimatedAfter`/`cleanHeaders`/`newestMemoryArchiveSync` 0 处；`handoffThinking` 仅剩 `shared/config.ts` 两处**退役说明注释** |
| 真实安装态探针 | `/tmp/pc-release-probe-v042`，默认设置：`pi -p "只回复两个字：收到"` → exit 0、回复「收到」；扩展生成 `.agents/memory/CONTEXT.md`（由整理 pass 渲染）、`session-logs/<id>/{session.jsonl,session.md}`（220 K）与 `INDEX.md`、`.gitignore`；`errors.log` 为空 |

**需要重启 pi 才生效**：运行中的会话仍加载 v0.4.1 的模块。

## 记名残留（发布后处理项）

> **2026-10-05 收口（v0.4.3）**：R-1 已修（固定比例模式改用同一条物理下限，状态行也不再隐瞒拒绝）；R-2 由 owner
> 在 dsh 仓处理，本仓不再挂账；autolearn 清单截断已改为在清单里显式标注。逐条见审计 §9.13。

- ~~**R-2**~~（已交接：owner 在 dsh 仓处理）：dsh 侧是否存在 `handoffThinking` 读者跨仓不可复验；若存在，硬切对
  dsh 用户是无提示的破坏性变更（关闭判据与影响面见审计 §9.12）。
- ~~**R-1**~~（v0.4.3 已修）：固定比例模式无最小可丢下限——现与自适应共用同一条拒绝门，见 `docs/handoff.md` 与 §9.13。
- ~~审计 §9.12 的过宽证据句~~（已加订正注）：按冻结档案体例保留原文并注明实测口径是两个键拼写。
- `.agents/memory/CONTEXT.md` 的会话快照停在 `2a7f7d0`（pi 再生成的文件，既有震荡）。
- ~~autolearn inventory 截断贴边（本机 7,892/8,000 字符）~~（v0.4.3 已可见化：截断时清单末尾给出标记；详见 §9.13）。

## 发布后补记

本次发布期间没有改代码或文档内容：tag 落点 `4b4f9c3` 相对最后一轮评审的 `4f14bc3` 只多一个 CHANGELOG 定版
（`未发布` → `2026-10-05`）与本证据文件本身，与 v0.4.1 的「tag 前只定版」先例一致。

**需要重启 pi 才生效**：当前运行中的会话仍加载 v0.4.1 的模块（`pi update --extensions` 只更新了磁盘上的副本）。
