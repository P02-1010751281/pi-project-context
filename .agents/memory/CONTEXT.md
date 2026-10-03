# Project Context

Last updated: 2026-10-03T05:11:18.128Z

## Summary

本轮做兄弟仓库记忆同步（Quantum_Matrix / UniField），结论改了两次才收敛，最终决定：两个仓库都不落地写入。第一轮用逐字行集做差，把分叉误读成单向丢失（「QM 缺 73 行、UF 缺 69 行」）；实测当前版也有独有内容——QM 48 行（含整节「采纳门禁消费点测试」）、UF 71 行（含 §37.119–§37.124，比好版本新）。好版本身份由 owner 自己的产物钉死：QM 自己的 `tests/test_memory_index_guard.py` 在当前版 FAIL（丢「静态投影不动点事实」）、在好版本 2 passed；UF 的保护副本 `/home/user/unifield-MEMORY-good-20261001-37124b.md` 与好版本备份 md5 逐字节相同，且当前版正文自称它「最新」。合并试了三次：逐字并集虚高（QM 27479 / UF 55285）；`SequenceMatcher.ratio()` 判改写失败、特征覆盖 QM 88.1% / UF 82.0%（丢 42/145 个特征）被否；改为双向特征保全后 QM 21985 / UF 43954，覆盖≈100%，并抓出一个真 bug——我的 `## ` 解析器丢了前言段（QM 前言正是它自己的恢复说明）。容量是硬约束：QM 护栏 18000 而好版本已 17998（余 2 字符）⇒ 任何无损并入都让护栏变红，护栏 docstring 又明禁放宽；UF cap 36000，好版本 34994 装得下、并入 12 条新事实约 38.1k 超。结论：QM 正确合规动作只有 `git checkout HEAD -- .agents/memory/MEMORY.md`（17998，护栏 2/2 绿），UF 恢复保护副本（34994 < 36000），新版独有事实（QM 10 条 / UF 12 条）另列清单。两仓库我都没写入：各有成文写入纪律，且恢复可能守不住——两仓库 journal 都是「一次采纳紧接一次另一版写入」，间隔 70–450 ms（QM 80 ms、UF 329 ms），`errors.log` 在同一毫秒记 adopted，`MEMORY.md` 的 mtime 与长度都等于后者。所以下一步应先在本仓库立项修「采纳后被旧内容覆盖」。审计已按更正版写入 `.codestable/issues/2026-10-03-consumer-repo-memory-drift/audit.md` 并推送（`078742c`）。

## Key points

- 审计更正 1：不是「缺 73 / 69 行事实」，是两版分叉。QM 当前版独有 48 行（含整节「采纳门禁消费点测试（AUD-51 余项 / AUD-85⑥，2026-09-30 已补回）」），UF 当前版独有 71 行（含 §37.119–§37.124，好版本只到 §37.118 ⇒ UF 当前版更新）。正确动作是「以好版本为底 + 并入新版真正新增的事实」。
- 审计更正 2：好版本身份有 owner 自己的判据，不必猜。QM 护栏测试 × 当前版 FAIL（`丢了人工策划条目 ['静态投影不动点事实']`）、× 好版本 17998 为 2 passed；UF `/home/user/unifield-MEMORY-good-20261001-37124b.md` md5 `0de468d6…` 与备份 `…08-48-46-062Z-6f6410ac` 逐字节相同；UF 保护副本序列单调增长 37121→29057、37122→30733、37123→31726、37124→34614、37124b→34994。
- 合并判据：不得丢任一版本特有的特征 token（反引号标识符 / `--flag` / `§编号` / 文件名 / 小数 / md5 / `AUD-xx`）。三次尝试：①逐字并集 QM 27479 / UF 55285（改写当新增，虚高）；②`ratio()` 判改写 → 覆盖 QM 88.1% / UF 82.0%，丢 42 / 145 个特征，判不合格，且重复 `§L29 下降侧`、`已否决/中性`；③双向特征保全 → QM `21985` 字符 / 108 行、UF `43954` 字符 / 161 行，覆盖≈100%。
- 尝试 ③ 抓出真 bug：我的 `## ` 解析器把 `# Project Memory` 与首个标题之间的前言段整段丢弃，而 QM 前言正是「本文件是有损摘要…恢复 = `git checkout HEAD -- .agents/memory/MEMORY.md`」那段自述。任何后续实现都必须保留前言，且每次改动后重跑特征审计。
- 容量硬墙：QM 护栏 18000 字符 / 100 行，好版本本身 17998 ⇒ 只剩 2 字符余量 ⇒ 任何并入都让护栏变红，而 docstring 明写「不要放宽上限」。UF 好版本 34994 < cap 36000 装得下，但并入 12 条新事实后约 38.1k 超；cap 是设置项（可抬到 ~40000），但记忆注入每个会话，38k 字符 ≈ 19k token 常态开销属 owner 取舍。
- 决定：两个兄弟仓库都不落地写入。QM 正确且合规的动作只有 `git checkout HEAD -- .agents/memory/MEMORY.md`（17998，护栏 2/2 绿），新版独有 10 条（L7 pipeline、L23 retirement、§L29/§L31/§L32、五轴已关、已否决/中性、合成数据集、文本锚点隐藏耦合、MEMORY-plugin self-note 等）另列清单。UF 最小正确动作是恢复保护副本 34994，12 条新事实（D-B2 knob、tone corpus、audio two-axis cancellation、§37.119–§37.124、image-subset 与 tone-control protocols 等）另列清单。
- 不写入的理由不是保守：(a) 两仓库各有成文写入纪律（UF：「替换限定窗口 + 写盘前断言；跨段 `find` 删 ~13k 字符事故」；QM：护栏 docstring 指定的恢复流程）；(b) 恢复可能守不住，见下条。
- 新发现的产品面疑点（本仓库该修的东西）：两仓库 `memory.jsonl` 都是同一形态——一次采纳紧接一次另一版本写入，QM [3] 09:29:25.473→17998、[4] 09:29:25.553→11009（80 ms）；UF [3] 08:48:46.372→34994、[4] 08:48:46.701→26931（329 ms）。两条 `errors.log` 末行都在 [4] 同一毫秒记「adopted an externally edited MEMORY.md」，`MEMORY.md` 的 mtime 与长度都等于 [4]。A（采纳被覆盖）/ B（正确采纳收缩）都仍与证据相容，但 QM 护栏在当前版失败、好版本通过，而该测试（2026-09-28）正是为这一失败模式写的——偏向 A。
- 审计已按更正版追加写入 `.codestable/issues/2026-10-03-consumer-repo-memory-drift/audit.md` 并推送：提交 `078742c docs(codestable): correct the consumer memory-drift audit and record the capacity wall`，`c4e7a43..078742c master -> master`。
- 两仓库本轮未被写入：QM 11009 字符、UniField 26931 字符，与 session 起点一致；它们 `MEMORY.md`/`CONTEXT.md` 上的 ` M` 早于本轮。

## Open tasks

- 先在本仓库立项：修「外部编辑采纳后被旧内容覆盖」的写入顺序问题，附可复现脚本（这条是执行两个仓库恢复的前置条件）。
- Quantum_Matrix（前置条件修好后）：`git checkout HEAD -- .agents/memory/MEMORY.md` → 17998，护栏 2/2 绿；把新版独有 10 条事实列成清单交 owner（不进记忆，护栏无余量），或改由 `docs/` 承载。
- UniField（前置条件修好后）：恢复保护副本 `/home/user/unifield-MEMORY-good-20261001-37124b.md` → 34994 < 36000，无需改设置；12 条新事实列成清单交 owner。
- 按 sync skill 的清理项，待合并被接受后执行：删 QM `.agents/memory/` 与 `session-logs/*/.lock` 的零字节陈旧锁、归档 QM `errors.log.2026-09-15-poison-episode`、复核 UniField `errors.log`；任何 `git checkout HEAD -- .agents/memory/MEMORY.md` 之前先取新的 `/tmp` 备份。
- 不在 `Quantum_Matrix` / `UniField` 内提交，兄弟仓库的提交留给 owner。
- v0.2.0 遗留：重启 pi 让 v0.2.0 成为加载中的代码；strict-mode 端到端证据缺口；已推迟的廉价修复（section-aware memory clipping、持久化超 cap 的 consolidation 回复）；session-log 体积/保留策略。

<!-- latest-session-title: Sibling-repo memory sync: audit corrected, capacity wall blocks any merge, sibling writes deferred -->
