# v0.4.5 发布证据

日期：2026-10-06
范围：issue `consolidation-keeps-entries` 的**策略修复**——段配额降为目标值，硬约束只剩文档上限；渲染器的池
按文档真实 body 计量。

## 提交与标签

| 项 | 值 |
| --- | --- |
| 策略修复（第一版） | `e2184af`（借用分配器；第 1 轮评审判 CHANGES-REQUESTED） |
| 池口径修正 + 全轮收口 | `59a53a4`（`memoryStructureOverheadChars()`；报告措辞分流；提示补条目形状；矩阵/记录更正） |
| 会话快照 | `14aac0c`（CONTEXT.md，与评审冻结树逐字节一致） |
| tag 对象 / peeled / 双远端 | 见「发布后补记」 |

## 独立评审（lane A，`deepseek/deepseek-flash`，/tmp 冻结沙箱，只读）

| 轮 | 冻结点 | 判定 | 抓到的东西 |
| --- | --- | --- | --- |
| R1 | `ae857ab` | **CHANGES-REQUESTED / RELEASE-OK: no** | B1：池用 `Σtargets`（31,922）而非真实 body（31,933），本仓提交的记忆仍被丢 3 条（文档余 7 字符）；I1：仅单项截断也报「到达文档上限」并指向不存在的 dropped 列表；I2：「剩余 1–3 条」归因不成立（模型整篇重写占主导；不带 `- ` 条目的回复走 opaque 绕过分配器）；N1–N6 |
| R2 | `59a53a4` 树（`git diff` 与上一行提交结构差为 0） | **CHANGES-REQUESTED / RELEASE-OK: no** | I1：命令回复（`/memory update` → `consolidateReply`）仍把「仅单项截断」报成「到达文档上限」并指向不存在的 dropped 列表（自动 toast 与 errors.log 已分流，命令路径漏了）；nit：边界注释算术、M2 变异写法歧义、数字口径未统一、CONTEXT 状态过期。B1 修复经其独立复核通过（`memoryStructureOverheadChars` 与渲染器实际结构逐一致；M3 恰丢那 3 条） |
| R3 | `1995a3a` | **CHANGES-REQUESTED** | B1：提示说「被丢条目列在 errors.log」而日志只有计数（守卫比较的是裁剪前的回复，取不到那些条目）→ 渲染器改为返回样本、日志行写出样本；I1：三处文案仍指向 v0.3.0 已移除的 `/project-context max-memory` → 改 `/memory max-memory` + 61 文件源串扫描；N1–N4 |
| R4 | `0a9dd75` | **CHANGES-REQUESTED** | I1：同进程**第二次** cap 事件仍承诺「样本在日志里」，而该行每项目每进程一次 → 记录 `samplesLogged` 分流；N1–N4、S1–S3（含 docs/configuration.md 机制段与 CHANGELOG 条目） |
| R5 | `2ff6628` | **CHANGES-REQUESTED** | I1（交叉序）：本进程首次 cap 事件若是「仅截断」，日志没有样本，后续 drop 提示仍说「样本来自第一次提示」→ 根治：**样本直接内联进提示与命令回复**，不再依赖日志指针；N1（status 指针悬空 → 措辞改为「诊断落到该文件」）、N2（docs 数字句） |
| R6 | `b5a53b7` | **PASSED / RELEASE-OK: yes** | 交叉序（先截断后丢弃 / 反向）实测提示不再指日志；内联样本在 opaque/仅截断/0 丢/空样本下恒真且有界（3,000 组随机：269 例丢弃，0 空、0 超 72、0 超 3 条）；变异 M1 6 / M2 1 / M2' 9 / M3 1 / M4 1 复现；两套快照数字复算一致；5 条 nit（docs 越权描述、回复未带数字、过期注释、占比基数、拼接标点）已在发布提交收口 |

评审的独立复核（R1）本身很有价值：50,000 组随机输入上分配器语义与自写参考实现一致；两次真实 pass 分别
−4 与 −17 条，其中一次证明 opaque 路径能让分配器整段不执行。

## 机制与证据

- 借用分配器：每段先取 `min(需求, 目标)`，余量入池，超额段按超额比例借用；池覆盖超额时**精确等于**超额 → 0 丢弃。
- 池 = `cap − memoryStructureOverheadChars()`（= 67：header + 每段 `## H\n` + 段间分隔）；`Σtargets` 比它小 11
  （schema 保守多留 9 + floor 余数），这正是 B1 的来源，已在技能 5b 与 attention 里记成教训。
- 提交版记忆（138 条 / 31,993）：canonical 67 + 31,926 = 31,993 ≤ 32,000，`droppedItems=0`；借用 1,071/239/544，
  Project 让 1,850。
- 变异矩阵（复核后）：M0 0 红；M1 借用关掉 6 红；M2 `min(over, pool)` 1 红（上限属性）；字面 `extra = over` 9 红（跨两个测试文件）；M3 池回 `Σtargets` 1 红（边界钉子）；
  M4 每项上限回目标 1 红。四格都红在 `sections-test.mjs`，无崩溃。
- 端到端（真实 flash，现场输入）：渲染器 0 丢弃；既有事实净变化 −1/−3（本次两次）与 −4/−17（评审两次）。
  **归因**：剩余损失**主因是模型自身整篇重写/合并/删除**（一次 39 条 exact-match、净 −17），其次是记忆贴上限
  （余 7 字符）与 opaque 回退路径（提示已补 `- ` 条目形状要求）。

## 记名残留

- **待 owner 定**：抬 `maxMemoryChars`（`/memory max-memory <n>`，每会话多约 1,000 tokens 注入）或人工裁剪一次记忆。
- 模型每轮自行删除/改写属提示层与模型能力边界，若要进一步收紧需独立议题。
- CONTEXT.md 仍按段裁剪（有 truncation marker + 日志），是每轮重写的会话状态，不属同一故障。

## 发布后补记（2026-10-06）

| 项 | 值 |
| --- | --- |
| tag 对象 | `d856f3aa1eac8e2d30ba4a3cefa04bf1f44cfc42` |
| tag 指向（peeled） | `6e8170d05385ade8ae3f07c53ecd428abcc2f17d` |
| 双远端 | `ls-remote --tags 'refs/tags/v0.4.5^{}'` 两端同为 `6e8170d`（`master` 亦同） |
| `~/.pi` pin | `57eccbc`（settings.json + README.md 改 `@v0.4.5`，已推 pi-config `origin`） |
| 安装 | `pi update --extensions`（`tag v0.4.5 -> FETCH_HEAD`，HEAD 落到 `6e8170d`） |
| 副本 HEAD / describe / 脏 | `6e8170d` / `v0.4.5` / 0 |
| 副本自测 | `node tests/run-all.mjs` → hygiene ok + **15/15** |
| 到位抽检 | `memoryStructureOverheadChars`、`allocationFor`、`capSentenceFor`、`Dropped, e.g.`、`dropped entries (first` 均在；`samplesLogged` 0 处、`/project-context max-memory` 0 处 |

**需要重启 pi 才生效**：运行中的会话仍加载旧模块（本次会话进程起于 v0.4.4 安装之前）。

**发布后验收跑（安装版 v0.4.5，真实 flash，现场输入 138 条 / 31,993）**：`errors.log` **没有任何 cap 行**（渲染器 0 丢弃），
渲染复核 `sectionDropped=0 droppedItems=0`；同一次 pass 里回归守卫记 `memory regression: 24 …`（exact-match 口径会把改写/合并
算成删除），净条目 138 → 130（−8）——**这剩余部分是模型自身的整篇重写**，不是渲染器（见下）。

## 结论与待 owner 决定

- **本次修复的承诺已达成并实测**：文档还有余量时渲染器不再丢条目（现场输入、边界 fixture、2,000 组随机属性三处一致）。
- **剩余损失的主因是模型自身重写**（本轮 −8 净、守卫 24 条 exact-match；历次样本 −1…−17），触发条件是记忆贴着上限
  （31,993 / 32,000，余 7 字符）：模型每轮新增都必须靠删/压来腾位，而 flash 级模型压不动。
  **决定**：抬 `maxMemoryChars`（`/memory max-memory <n>`，每会话多约 1,000 tokens 注入）或人工裁剪一次记忆。
  该条已记 `.codestable/attention.md`。
- 提示层（v0.4.4）已把「删」改成「压」，但对 flash 级模型不足；若要进一步收紧需独立议题（例如换辅助模型线路）。

## 发布后发现：cap 裁剪经采纳路径变成永久状态（2026-10-06 现场）

上一会话收尾时（10:48:14Z）一次 pass 把已提交的 138 条 render 换成 126 条，**丢弃经采纳路径变成了状态**，跟踪文件因此少了 12 条curated 事实（本次已恢复 12 条，见提交 `3a7c402`）。

现场证据（都可复核）：

| 来源 | 内容 |
| --- | --- |
| journal 末两条 | `10:48:14.887 replace 31993 字符 / 138 条`（未裁剪的回复）→ `10:48:14.969 replace 29939 / 126 条`（文件内容） |
| errors.log | `10:48:14.289 memory regression: 2 …` 与 `10:48:14.962 adopted an externally edited MEMORY.md into the memory journal` |
| 文件对比 | `git show ae857ab:.agents/memory/MEMORY.md` = 138 条 / 31,993 vs 工作区 126 条 / 29,939 |

机制（由上面三行可算，不是纯推断）：**回复给出约 138 条 → 渲染器按 cap 裁剪掉约 10 条（`droppedItems`）→ 裁剪后的文件被"外部编辑采纳"路径写回 journal → 裁剪成为权威状态**。
`memory regression: 2` 是守卫的**逐字**口径（规范化后精确集合比较），它只统计"原文彻底不在"的条目，**不是**丢失计数：本次 12 条丢失里它只报 2 条，其余是裁剪。cap 行缺失可解释为"每项目每进程写一次"的限流（errors.log 还会轮转），因此**这类丢失在当前实现下是静默的**。

后果与状态：恢复后 render 为 135 条 / 31,935 字符，`sectionDropped=0 droppedItems=0`，距 cap 仅 **65 字符**——与丢失前（7 字符）几乎相同，即**下一次贴顶的 pass 可以再发生同样的事**。未恢复的 3 条（machine-path 扫尾判据、sections-test.mjs 索引细节、审计指针）可从 `ae857ab` 取回。

**待 owner**：抬 `maxMemoryChars`（每条 pass 的净增约 2,000 字符即可避免裁剪）或做一次更深的人工裁剪；在此之前"恢复"只能挡住一次。
