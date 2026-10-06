# v0.4.4 发布证据

日期：2026-10-06
范围：`issue: consolidation-keeps-entries`——合并通道不再把整条条目当消耗品丢掉：主提示与冷凝重试句都改为
「按段配额压缩」，删除只在可证过期时允许。

## 提交与标签

| 项 | 值 |
| --- | --- |
| 提示层修复（第一版） | `ed51eac`（主规则句＋注记＋测试；**根因诊断为错**，第 1 轮评审推翻） |
| 现场证据补充 | `65e9283`（F5/F6） |
| 对准段预算的修复 | `aaafd0b`（主规则改指段配额、重试句对齐、技能同步、说明重写） |
| 评审 nit/建议收口 | 发布定版提交（本文件所在提交，含 CHANGELOG v0.4.4） |
| tag 对象 / peeled / 双远端 | 见「发布后补记」 |

## 两轮独立评审（lane A，模型 `deepseek/deepseek-flash`，/tmp 冻结沙箱，只读＋零写入）

| 轮 | 冻结点 | 判定 | 抓到的东西 |
| --- | --- | --- | --- |
| R1 | `65e9283` | CHANGES-REQUESTED / RELEASE-OK: no | **I1 根因推翻**：丢条目发生在渲染器段配额裁切（`sections.ts::renderMemoryDocument`），不是模型删除；I2：验收项用 `memory regression` 行结构性无效（守卫跑在裁切前）；I3：重试句 `remove the least durable` 与主规则冲突；N1–N5 |
| R2 | `aaafd0b` | **PASSED / RELEASE-OK: yes** | 逐条复现更正后的根因（31,774 版三段超配额、渲染丢 9 条、丢的集合落在现场缺批内、把现场 sections＋`harness.mjs` 渲染逐字节复现现场文件）；确认两处对齐、采纳条件自洽、四格变异各红在本格；成本复现（+376 / 重试 +158）；nit 2 条＋建议 3 条（数字挂错版本、重试句未覆盖 opaque 路径、重试钉子不全）——全部在发布定版提交里收口 |

两轮 transcript 留档：`review-round1-*.txt`、`review-round2-*.txt`。

## 根因与修复（一句话版）

记忆文档写盘时按四段固定配额（0.2 / 0.4 / 0.25 / 0.15）裁切，**某段放不下的条目整条丢弃**；本仓现场是
Invariants/Pitfalls/Index 合计超 1,635、Project 空额 1,850 却借不过来，于是**总文档没贴上限也丢条目**。
提示层原本两处都在教「删」（主规则尾句 + 重试句），现在两处都改成「压到每段配额内、只删可证过期者」。

## 三校（机械核验）

- **套件**：`node tests/run-all.mjs` → `repo hygiene … ok` + **15/15**。
- **变异矩阵（单侧）**：M1 删主规则 3 红；M2 删注记 **恰 1 红**；M3 旧主措辞 4 红；M4 重试句回退 4 红（含 3 条
  哨兵串联动，已在测试注释与说明里注明）；还原后 0 红。四格都只红在 `memory-budget-test.mjs`。
- **成本**：主提示 **+376 字符**（v0.4.3 的 4,145 → 4,521，约 94 tokens/次合并）；重试句 **+158 字符**，仅段超配额时
  追加。两处都由评审用 `git archive v0.4.3` 复现。
- **验收（未完成，如实记）**：提示内容断言只证词在提示里，不证模型照做。渲染面验收＝之后若干次渲染中
  `errors.log` 不再出现 `memory exceeded a section budget: …`（`report.ts:215` 是这条路径的日志；
  `memory regression:` 行**不能**当验收，它跑在裁切之前）且条目数不缩水。当前状态：**已实现、未验收**。

## 记名残留（发布后处理）

- **第二层：固定段配额与本仓分布不符**（Project 空额 1,850 / 三段合计超 1,635）。可选「按分布重配 share」或
  「段间可借额度」（后者是机制改动，需独立设计）。已记 `.codestable/attention.md` 与修复说明 §6，待 owner 定。
- 手改 MEMORY.md 补条目必须**同时**满足段配额，否则下一轮必被裁回（本次已实测一次）。

## 发布后补记（2026-10-06）

| 项 | 值 |
| --- | --- |
| tag 对象 | `5982fd9f507265481e07e51837034e48a2f8ba3c` |
| tag 指向（peeled） | `009ccebab704d0a4877dd4e26d378c9387e7e507` |
| forgejo / github 镜像 | `ls-remote --tags 'refs/tags/v0.4.4^{}'` 两端同为 `009cceb` |
| `~/.pi` pin 提交 | `ed4a732`（`agent/settings.json` + `README.md` 改 `@v0.4.4`，已推 pi-config `origin`） |
| 安装命令 | `pi update --extensions`（`tag v0.4.4 -> FETCH_HEAD`，HEAD 落到 `009cceb`） |
| 安装副本 HEAD / describe / 脏 | `009cceb` / `v0.4.4` / 0 |
| 副本自测 | `node tests/run-all.mjs` → `repo hygiene … ok` + 15/15 |
| 到位抽检 | 新措辞命中（`until each section fits its budget above` 2 处、`merge duplicates within a section` 3 处、`overflowed a section budget` 2 处、`never to make room for a new one` 2 处）；旧删除授权 `remove the least durable` **0 处** |

**需要重启 pi 才生效**：运行中的会话仍加载 v0.4.3 的模块。

**验收结果：未通过**（2026-10-06，v0.4.4 冻结代码 + 真实 flash 辅助调用，四次 pass）。跟踪的 `MEMORY.md` 是完整版
（137 条，31,774 字符，超出三段固定配额），重启后的第一次合并就是验收点。沙箱实测：第一版回复与冷凝重试**都**
超配额，重试四次全部 `adopt=false`，渲染器每轮真实丢 10–15 条，`errors.log` 照旧出现
`memory exceeded a section budget: 3 section(s) … N whole entry(ies) were dropped`。结论：**提示层修复不足**，
卡点是固定 share 与本仓内容分布不符（需要 14.2/42.7/25.8/16.7%，总文档 31,753 < 32,000）——策略决策待 owner，
复现与选项见 `acceptance-2026-10-06-v0.4.4-not-met.md`。
