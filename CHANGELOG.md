# Changelog

只记**行为变化**（`feat` / `fix`）。文档、审计与记忆渲染的提交不入此表 —— 它们在 git 历史与 `.codestable/` 里。
版本号语义近似 semver：`fix` 进 patch，`feat` 或破坏性变更进 minor。

## v0.4.13 — 2026-10-19

### 修复

- **被拒绝的 consolidation 回复不再改 `CONTEXT.md`**：当回复因「构建期间存储的 `MEMORY.md` 已变化」被拒时，以前同一回复的
  `context` 段仍会落盘；它和 memory 同出于更旧的快照，会把更新的 `CONTEXT.md` 覆盖回去（现场 2026-10-19T08:27:10Z：
  拒发日志与 `CONTEXT.md` 写回同秒，手工收敛的 open tasks 回到旧清单）。现在拒绝态两者都不发布，下一次 pass 从磁盘上的
  较新 context 重建；`/memory update` 的回执仍按 `contextWritten` 如实说明 context 没有更新。

## v0.4.12 — 2026-10-19

### 修复

- **触发发送失败也进入 failure backoff**：`maybeTrigger` 的 `sendUserMessage` catch 现在会 arm 失败退避；
  以前它只清 in-flight 并提示，pre-compaction guard 会在同一失败上反复取消后续自动 compaction。
- **replay 不再携带 predecessor 的 assistant usage/stopReason**：重放消息只描述旧会话的请求，旧 `usage` 会让 successor
  的第一次 `_prepareRun` 把旧 prompt 大小当成当前上下文，`recent` 大于 pi 的 keep 窗口时可能提前压缩 replays；
  删掉 `usage` 字段又会让 pi 的 footer 统计、compaction 后的 context accounting 和 overflow classifier 读到不存在的
  `usage.input`/`totalTokens`，所以归零成完整记录。判决同样要删：`_prepareRun` 在 successor 首轮前对携带的末条
  assistant 跑 `_checkCompaction(_, false)`，不看 usage 就会对 `error` 判决走 `explicitOverflow`、对 `length` 判决走
  `isRecoverableLength`，把刚交接来的 replay 直接压缩；代价是虚拟模型在 successor 首次响应前把携带的响应计为最近一次成功。
- **toolResult cap 回执不再承诺硬上限，裁剪 marker 跟随交接语言**：极小 cap 下 marker 自身可能大于配置值，
  回执改为“目标”并说明可能只留下 omission marker；中文交接的 replay marker 也改为中文，不再夹英文。

## v0.4.11 — 2026-10-18

### 新增

- **可选的交接 toolResult 文本上限**：`/handoff budget toolresult <tokens|off>`（默认 `0`/off）为每个被携带的
  `toolResult` 增加一个独立的 token 上限。超过上限时只把文本块替换成
  `[tool result trimmed during handoff: N characters; full output in the previous session log]`，保留 `toolCallId`、
  图片和 `nestedCalls`，完整正文仍留在旧会话日志；successor 的 continuation 会说明工具输出被裁剪。
  这是为控制 handoff 首轮 payload 的可选杠杆，不改变默认的原文携带行为；状态行与 `/handoff budget recent` 回执会显示该上限。
  cap 省的是 carried 正文，不保证 successor 总成本下降：successor 需要被裁内容时必须回读文件或 session log，回读可能更贵。

### 修复

- **自动 handoff 先于 pi 的自动 compaction**：pi 在 post-run 循环里先跑 `_checkCompaction`、再发 `agent_settled`，单轮涨幅跨过两条线时
  compaction 会先生效，handoff 只能看到压缩后的分支——正是它要规避的损失。现在 `session_before_compact` 在阈值已到时取消自动
  `threshold` / 无重试的 `overflow` compaction，让 settle 触发器在未压缩的分支上交接；带 `willRetry` 的 overflow recovery
  仍先由 pi 重试，手动 `/compact` 仍由用户决定。失败的 handoff 进入
  failure backoff，下一次自动 compaction 照常进行；被其他扩展取消的 handoff 进入冷却，`nothing older ...` 的 skip 也会冷却。

- **重锚不再把分支文本没有承载的计费内容当成 baseline 增长**：`measureContext` 的 ② 检测
  （`prompt_r − prompt_p > 2 × (chars_r − chars_p)`）在中转站推理路由上逐轮触发 —— provider 把未落盘的隐藏推理计入下一次 prompt，
  而持久化消息里只有空 thinking 块；截图重的会话同理，`chars` 按设计排除图像块。每次重锚都把整段文本的 `chars × (1/r − 1/8)` 高读重新计入，
  baseline 随会话抬升，floor 越过质量拐点或可用窗口后自动交接被静默关闭。现在检测给两类内容一个 allowance：上一条回复的
  `max(0, usage.output − messageTokens)` 与自上次采样以来图像块按 pi 自身预算折算的 token（每张 1,200）。真实的注入块刷新仍会超过
  该界并重锚；预算内的小图不再重锚，其真实成本不进 baseline（floor 低读该成本，fail-open、按图有界），超出预算的图仍重锚。
  状态行的 baseline 说明不变。
- **交接后的首条回复先复述上一轮**：续接提示的收尾从「从上次中断处继续 / Continue the task from where it left off」改为
  「先复述上一轮用户的要求、当前进度，以及仍在生效的技能或模式」，然后继续。successor 不再直接开工而让用户不知道在继续什么；
  旧版收尾仍被 `isHandoffPromptText` 识别，重放时照旧替换为 omission marker。
- **交接保留上一会话加载的技能与模式**：successor 现在收到一份「上一会话加载的技能与模式」清单，来源是用户 `/skill:` 加载的技能块（含 standalone `.md`）、`read` 过 `SKILL.md` 的工具调用（含工具结果上记录的嵌套 `read`）、
  compaction 的 `readFiles`、以及上一份交接提示的 `<read-files>`（去重；`/skill:` 最优先，其次真实 `read`，两者内部按最近出现排序；
  提示/压缩清单最后，按块内倒序只填剩余名额；最多 8 个）；每个条目带技能名与文件路径（目录形式为 `SKILL.md`，单独文件为其 `.md`），
  并被告知若某个设定了持续生效的模式，先重新读取它的技能文件再继续；复述收尾里的 `SKILL.md` 也改成同样的中性措辞，旧版收尾仍在 `HANDOFF_PROMPT_CLOSINGS` 中可识别。此前技能说明被切掉后，successor 只看到 `<read-files>` 里的路径，
  grilling 这类模式不会延续。
- **交接文件索引包含扩展工具的嵌套调用**：`<read-files>` / `<modified-files>` 现在也收集 codemode 等扩展工具在 tool result 上记录的嵌套
  `read` / `write` / `edit`，与 pi 的 `extractFileOpsFromMessage` 对齐；此前这些调用只在 active 技能清单里可见，文件索引缺项。

## v0.4.10 — 2026-10-14

### 修复

- **物理下限的 baseline 改成「每条 usage 记录一个密度上界，取最小」**（issue `2026-10-09-handoff-baseline-residual`）：
  `baselineTokens` 一直把「当前这一点的 usage 残差」当非会话基线，而残差 = 真值 + `Σchars × (1/4 − 1/r)`（本仓实测
  `r = 2.2–3.8`），于是 floor 随对话变长自己长高，越过质量拐点后自动交接被**无声**关掉（现场：prompt 317k、floor 179k > knee 157k）。
  现在用取值带给出每条记录上成立的不等式 `chars/8 ≤ T_r ≤ chars`，取 `prompt_r − chars_r/8`（对**设定它的那条记录时刻**真值的上界，
  所以在那之前永不低读；注入块在会话内后来长大时它读低那个增量，除非增长大到可证（门槛见 design §14，② 已修），登记为残余②），再在这些上界里取最小；后出现的记录上界只会更大（`r < 8`），所以取值由**最空的那条记录**定下、
  不再随分支增长。代价是最空记录自身字符数带来的高读（`chars × (1/r − 1/8)`，以该记录为界），方向是 fail-closed ——
  floor 是拒绝门，读低才会过早交接。
- **图像块不进密度基准**（第 3 轮独立审查的 important I-1，fail-open）：pi 的 `estimateTokens` 对每张图固定计 4,800 字符
  （`ESTIMATED_IMAGE_CHARS`），而取值带要求「每张图 ≥600 token」才不低读；小图（截图缩略图、low-detail 约 100 token）远低于此 ⇒
  上界落到真值之下并赢 `min`（审查员夹具：真值 17,766 + 图 100 token，读 **17,264**，低 502）。现在 `chars` 与 `estimated` 都只计**文本**
  （去掉 image block 后再调 `estimateTokens`），图的真实 token 落进 baseline：方向 fail-closed，baseline 高读该图自己的 token 数，
  而 floor（文本 token + 整个 baseline）不变 —— 没有双重计数。
- **区间一致性：文本长得比 prompt 快的记录不算测量**（同一轮的 important I-2，fail-open）：`prompt <= chars/8` 只判记录**自身**合格，
  而一条记录计费后分支里被插入了它没被计费的字符（前任重放插在它之前、分支被编辑）时，它的 `chars` 偏大 ⇒ 上界落到真值之下并赢 `min`
  （审查员夹具：本地记录 prompt 18,766、重放 50,000 字符 ⇒ 读 **12,016**，低 5,750）。现在相邻样本（无 split 边界、且 prompt 未缩小）
  必须满足 `chars_r − chars_p ≤ (prompt_r − prompt_p) × 8`（由 `B_p ≤ B_r`、`T_r ≥ chars_r/8`、`T_p ≤ chars_p` 推出），违反即**丢弃**该记录；
  prompt 缩小的区间不检查，这是**有意**的 fail-open 取舍：交接继承的前任记录是大 prompt 对小 prompt（活树 131k 对本地记录），
  丢掉本地记录会把 baseline 钉死在前任量级上 —— 正是本 issue 要修的静默关闭。代价与残余 ④⑤（偏稀疏锚点；文件级陈旧锚点）
  见 `.codestable/issues/2026-10-09-handoff-baseline-residual/design.md` §9–§13 与 review-report（§11 还枚举了真实可达的低读形状：
  被排除的 `!!` 输出（已修）、保留的 pre-compaction 记录 + 膨胀摘要（⑥，已修）、`SPLIT_TURN_MARKER` 注入）。
- **可判定的重锚：注入块在会话内增长时，最小值从该记录重启**（残余②收尾）：读数原本是「设定它的那条记录时刻」的 `B`，
  注入块刷新后它低读增量（以增量为界）。现在当某条记录的 prompt 增长超过新增文本所能承载的上限
  （`prompt_r − prompt_p > 2 × (chars_r − chars_p)`，即新增文本 ≤2 token/字符）就把最小值从该记录重启。
  它只在「新增文本 ≤2 token/字符」的假设下成立（band 本身只保证 ≤1），所以是**启发式、不是证明**（假阳性只抬高读数，方向 fail-closed）；门槛以下的增长仍以该增量为界。
  第一版门槛取 `chars_r − chars_p / RATE_MAX`：它把 `7/8 · chars_p` 白送给文本，活树要 ~77k 的增长才触发
  （实测注入块 6,745）⇒ **等于没修**，第 9 轮独立审查 I-1 抓到后改成上面这条（现场夹具 22,766 ⇒ 52,767，真值 47,766）。
- **压缩前计费的记录不再作样本**（残余⑥收尾）：pi 自己用 `assistantIsFromBeforeCompaction`（`agent-session.js`：
  `assistantMessage.timestamp <= compactionEntry.timestamp`）把这类记录视为失效，而 `buildContextEntries` 的 `firstKeptEntryId`
  会把其中一条留在分支里 —— 它的 prompt 属压缩前分支、`chars` 属压缩后投影，两边都不是。采样器现在镜像该判据：
  夹具里那条记录自己的上界是 16,000（真值 17,766，**低 1,766**），失效后读数改由压缩后的记录给出 28,265。
  代价是「既有 compaction、又还没有新记录」的窗口退回无样本公式（由契约 `a compaction window with no newer record falls back …` 钉住）。
- **外部替换的可见性加上 ctime 兜底**（记忆读路径已登记的残留）：`readRenderWithMtime` 的 `changed` 只比 mtime+size ⇒ **保留 mtime 的同尺寸替换**
  （`cp -p`、`rsync -t`）看不见，而发布侧正是靠这个标志决定「不写」⇒ 方向 fail-open。现在判定抽成纯函数 `renderChangedAcrossRead` 并加上 **ctime**
  （用户态改不动它）：同尺寸且 mtime 相同但内容被换过也判为 changed，把写回让给下一次 pass。契约
  `read consistency: a same-size mtime-preserving replacement is a change`（变异「去掉 ctime 子句」红 1）。
- **被排除的 `!!` 不再被当作「user 可见」的 replay 首条**（第 7 轮独立审查的 important）：`excludeFromContext` 的 bash 经
  `convertToLlm` 整条消失，但 replay 的 user-facing 判据只按 role ⇒ 当切点落在 `!!` 条目上时 kept slice 以它开头、
  `SPLIT_TURN_MARKER` 不插，successor 发给 provider 的首条变成 assistant ⇒ Anthropic/Gemini 这类要求 user-first 的路由直接拒。
  现在「user 可见」= 「provider 可见」（判据由 `text.ts` 单点导出、采样器与 replay 共用），并按 `convertToLlm` 的**真值**语义
  判定排除（手改 `1` 同样排除）。
- **被 `convertToLlm` 丢弃的 `!!cmd` 输出不再计入**（第 6 轮独立审查的 important，fail-open）：provider 收到的是
  `convertToLlm(buildSessionProjection().messages)`，而 `convertToLlm` 会把 `role: "bashExecution" && excludeFromContext`
  （交互式 `!!cmd`）整条丢掉；采样器此前按 `command + output` 计入 `chars`/`estimated` ⇒ 第一条 `!!` 之后的记录 baseline 低读
  （审查员夹具 13,264 对真值 17,766），输出足够大时该记录还会被自身密度下界判定剔除、fallback 归零。现在 `messageTokens`
  与 `contextTokensAtRate` 都镜像这条丢弃（回执与切分预算同样不把 provider 没收到的东西算进去）。
- **同一目标被多次编辑时按 pi 的 last-wins 语义重算**（第 5 轮独立审查的 important）：pi 的投影对每个目标只留**最后一条** edit
  并把它应用到**原始**消息上（core 每次 overflow recovery 都追加一条 `null` 删除、扩展也可再编辑），所以「先删除再恢复」应当恢复内容；
  把每次编辑链式应用到上一次结果上会让目标永久消失 ⇒ `chars` 少算一段内容、baseline 无界高读（审查员夹具 30,000 对忠实值 28,875），
  方向是把自动交接推向**静默拒绝** —— 正是本 issue 的症状。现在 `seen` 同时保存原始消息，每条 edit 都从原始消息重算。
- **`chars` 按 pi 的投影算，而不是原始条目列表**（第 4 轮独立审查的 important I-2，fail-open）：provider 收到的是
  `buildSessionProjection` 的投影，而 `context_edit` 会改写它目标消息的内容（或整条删掉）；按原始条目累加时，一条被缩短或删除的
  100,000 字符消息仍在 `chars` 里 ⇒ 后续记录的读数落到 **5,268**（真值 17,766）。现在在编辑条目出现的位置**就地改写**目标条目的贡献
  （编辑之前的记录仍按原文计算），并镜像 pi 投影的另两条语义：compaction 只发最新一条的 summary（更靠后的记 0）。
- **区间一致性规则的边界写清并钉住**（第 4 轮独立审查的 important I-1）：prompt 缩小时不检查是**有意**的 fail-open 取舍 ——
  交接继承的前任记录是大 prompt 对小 prompt，丢掉本地记录会把 baseline 钉在前任的 131k 上（正是本 issue 要修的静默关闭）。
  代价是一条记录自身的 prompt 相对它存储的前缀已陈旧、且前面只站着更大的前任 prompt 时仍会读低（残余⑤；测试把该形状钉住）。
- **system 消息不再进入被减的估计量**：pi 的 `estimateTokens` 对 system 消息已经算了 `content + sections + toolsAdded`，
  把它计入被减量等于把工具 schema 与系统提示从 baseline 里减掉：隔离探针实测低读 **9,881**（真值 17,753），活树会话低读 **25,823**。
  这也排除了「直接用 pi 的 system 估算当 baseline」这条路：两个沙箱的 system 估算几乎相同（9,881 / 9,882）而真值差 6,745 ——
  那个差就是本扩展注入的记忆块，pi 的估算看不到它。无 usage 记录的首回合公式同步修正（同样只减消息估计）。
- **交接回执与 mid-turn 切分预算改说本会话的 chars/token**（同一根因的第二个消费者，不受上面改动影响）：`dropping ~X / carrying ~Y` 原先用 pi 的
  `chars/4`，CJK 重的会话会把真实切下的量少报约 `1 − r/4`；现在两处共用会话 delta 校准出的 rate（中位数，取值带 `[1.0, 8.0]`）。
  **切点本身仍是 pi 的 `findCutPoint`**（chars/4），本轮不动（重写切点会重复 pi 的 turn 对齐）。
- **状态行自证 + 诚实降级**：`/handoff status` 写 `· baseline <值> (chars/8 bound over <n> records; receipt at <rate> c/t)`；
  无可用记录时写 `(chars/4, no usable record)`，无可用 delta 时写 `receipt at chars/4, no usable delta`。基线不再由 rate 决定，
  所以后缀改成点名它**是**什么（密度上界）与回执**用了什么**换算，不把兑底的 4.0 印成测得的 rate。
- **本版内被取代的中间形态**（同一未发布版本内的迭代，不是对外行为史）：先按「会话内最小残差 + 单一 rate + 过度修正守卫」实现（R1 轮修复，
  冻结 `466ebcd`），第 2 轮独立审查（冻结 `d2e3e82`）用**异质分支**证伪：单一 rate 只对与校准窗口同率的前缀成立，
  `ASCII 20,000 + CJK 尾` 读 3,736、`25,200` 读 106（真值均为 17,766，后者还低于物理下限 11,021）。
  上面的密度上界把这一类 fail-open 从构造上消掉（同样两夹具现读 20,266 / 20,916，均 ≥ 真值）。报告与残余见
  `.codestable/issues/2026-10-09-handoff-baseline-residual/review-report.md`。
- **另修一条与本改动无关的测试竞态**：`consolidation-test.mjs` 读 `CONTEXT.md` 时不等待写入，负载高时 6 次里红 1–3 次（已在 HEAD 上
  复现，非本改动引入），现在与 `MEMORY.md` 一样走 `waitUntil`。

变异矩阵（计法：`node tests/run-all.mjs` 的 `^FAIL ` 行；**本版新增或改写**的断言每条都有只改一处的补丁把它变红，
其余断言的覆盖情况见 review-report）：system 消息重新计入估计红 3、上界退回 rate 缩放红 14、`min` 改 `max` 红 9、
去掉「记录不及其自身密度下界 ⇒ 不是测量」红 1、后缀**把未校准的 4.0 印成测得 rate**红 1、图像字符重新计入估计红 1、
去掉区间一致性规则红 1、忽略 `context_edit`（用原始前缀）红 1、去掉 rate 带下半红 3、同一目标的编辑链式应用（不回到原始消息）红 1、
计入被排除的 bash 输出红 2、`!!` slice 头退回 role 判定红 2、排除判定退回严格 `=== true` 红 2、去掉 overhead 增长 re-anchor 红 2、
去掉「压缩前计费的记录不作样本」红 2；记忆读路径另有「去掉 ctime 子句」红 1。残余 ①③④⑤⑦⑧⑨ 与两条口径差异按 design §14 收尾（钉住）。
两处 system 计入点在第 4 轮修复里合并成一个 `messageTokens`（两条断言合成一条变异），
`rate > RATE_MAX` 那条过滤在样本路径上不可达（区间规则已推出 `rate ≤ RATE_MAX`）⇒ 删除、只保留下半。末节现有 38 条 `check(`（另 2 条 `!!` 契约在更早的 replay 小节）。

## v0.4.9 — 2026-10-08

### 修复

- **上限门改看辅助调用真正用的路由**（第 15 轮独立审查的 important I-A）：v0.4.8 把 reasoning 预留计入「上限是否装得下」，
  但两个调用点都从**会话模型**取 `reasoning`，而真正发起调用的是 `resolveAuxModel` 解析出的辅助路由 —— 把辅助路由指向重推理
  模型时，cap 门会静默漏报，正是这道门要抓的那类现场。新增无告警的 `peekAuxModel`（与 `resolveAuxModel` 共用 `auxRouteFor`
  一个决策点，避免再次漂移），两个调用点改用它；可见句同时改口径：预留是**估算**不是界（现场实测 20489 ≫ 8192），
  `capCeilingWarning` 不再写 `up to`。
- **不透明回复的接受面收窄**（第 15 轮 R-A，第 17 轮复核）：v0.4.8 的判据是「正文里有任意标题 / `- ` 条目 / 围栏」，于是
  `# Project Memory\n\nI'll do the following:\n- review` 这种「散文里带一条 bullet」的回复仍能换掉整篇记忆。现在回复必须是
  **本扩展自己的文档形状**：顶格的 `## <已知小节名>` 标题 + 其下顶格的 `- ` 条目，围栏内的内容不算（与 `sectionsFromMarkdown` 共用同一份小节表和
  `readFenceLine`/`fenceCloses`）。存储侧同时从「必须是规范四节」放宽为「能解析成四节 **或** 剥离标题后 ≥ 40 字符」，
  于是手写的非规范记忆（现场那份六节文档）也受保护。setext / HTML 标题、编号列表、`* `、缩进条目与未知小节名**刻意被拒**
  （记忆保留 + 一条诊断）——第 18–21 轮曾在同一处维护更宽的 markdown 子集，四轮各找到一个 fail-open（围栏半规则、裸分隔线、
  空行与缩进、桥与列表内围栏），因此第 22 轮收缩到 schema 本身，取舍见 `.codestable` 报告。散文形状、被拒形状（含
  `fence-in-list-item`、`fence-hiding-list-fence`、`entry-under-other-heading`、`indented-heading-flush-entry`、`unknown-section`）
  与非规范存储各有用例，形状判定本身另有 `tests/sections-test.mjs` 的 13 条纯函数契约（CRLF 归一化、围栏跳过与
  `{0,3}` 边界在端到端路径上不承重 —— 链路上游已归一化 / 夹具覆盖不到，这几条的变异各红 1 条且只红在 unit 契约上；
  缩进 setext 与 HTML 块起始则端到端承重）。按**最终修订**重测的变异（计法：
  `node tests/run-all.mjs` 里的 `^FAIL ` 行）：仅 ATX 终止作用域红 25 条、有标题即算红 23 条、终止符只保留 setext（`=` 形式）红 17 条、
  围栏从不识别红 15 条、HTML 只认同行闭合标签红 7 条、条目放宽到 `* `/编号/缩进红 6 条、缩进 setext 不终止红 5 条、
  小节名不校验红 3 条，标题缩进 / 围栏内剥列表标记 / 嵌套只剥一层各红 2 条，不归一化换行 / 围栏开启忘掉标题 /
  存储侧丢掉长度下限各红 1 条。早期轮次记的旧数字是各自修订上的历史值（测试文件后来增长，已不可复现）。
- **诊断不再把「形状读不出」说成「没有条目」**（第 18 轮 I-3）：`carried no entries` 对「散文里带一条 bullet」这类回复是假的，
  现在两条路径统一为同一措辞：日志串写全（`the consolidation reply was not a writable memory document…`），toast 用短形式（`the reply was not a writable memory document`）。
- **只读状态路径不再假定 `modelRegistry.find` 存在**（第 17 轮 R-2）：改为可选调用、缺失时回退会话模型，并有用例钉住这条回退。
- **`/autolearn` 的强制 pass 也在等待前提示**（第 15 轮 important I-B）：v0.4.8 只给 `/memory update` 加了提示，而裸
  `/autolearn` 同样是 1–2 次辅助调用、同一条重推理路由，现场那种「十几分钟没有任何输出」的体感原样存在。

## v0.4.8 — 2026-10-08

### 修复

- **不透明回复的拒绝条件真正覆盖现场**（第 14 轮独立审查的 blocking B1，冻结修订 `0450fc4`）：v0.4.7 的判据是「回复整篇
  没有任何 markdown 标题」，但那条现场 —— v0.4.5 沙箱把 118 字节的 `# Project Memory\n\nI'll review the frozen revision …`（磁盘上连同尾换行为 119 字节；journal 的 `memory_markdown` 值按 118 记）
  发布为整篇记忆、替换掉 29.9 KB 的四节文档 —— **带着**规范标题，所以 v0.4.7 放过了它自己引用的那个形状。现在判据先剥掉
  规范标题 `# Project Memory`，再要求正文**自己**带结构（标题 / `- ` 条目 / 围栏）才算文档；「带标题的散文仍走原路」这条
  v0.4.7 行为随之取消。回归用例改为逐字节的现场串，并补上无标题变体、`#.` 伪标题、40/39 字符边界与 fresh 项目。
- **截断重试带上实测的隐藏思考用量**：`fitMemoryInput` 的 reasoning 预留上限是 8192，而 route 实测可能远超 —— 现场
  （Quantum_Matrix）一次请求 32210 输出 token 里 20489 花在隐藏思考，剩下 11721 不够吐出约 33k 的正文，于是重试 +4096
  后照样被截断、fail closed。重试现在取「至少 +4096，且不少于上一次实际花掉的隐藏思考 token」。若**请求上限本身**低于「正文 + 实测隐藏思考」，重试仍被封在该上限内（现场那台 32768 对 20489 隐藏思考就属这一类，需要约 53.5k）：那种配置靠抬高上限或换辅助路由解决 —— 重试仍被封在该上限内，只能以裁短后的正文再试（可能以 `clipped` 的缩短版成功），补不上这个差额。
- **上限告警把 reasoning 预留算进去**：`memoryCapUnsatisfiable` 与 `capCeilingWarning` 在会话模型声明 `reasoning` 时，
  把最多 8192 的隐藏思考加进「是否装得下」的估算 —— 只装得下可见正文的 cap 在重推理路由上仍会被截断。
- **`/memory update` 等待前先提示**：一次强制 pass 是 1–2 次辅助调用，重推理路由上可以静默几分钟（现场约 13 分钟），
  命令现在先回一句 `Memory: consolidating…`。

## v0.4.7 — 2026-10-08

### 修复

- **不透明回复不再替换整篇记忆**（issue `2026-10-06-handoff-shutdown-coupling` 收链后的修复）：非工具调用的纯 Markdown
  回复（`fallback-opaque`，四节解析不出时回复正文**原样**成为 `MEMORY.md`）此前只要不是「整篇都是标题」就会被发布 ——
  现场在 v0.4.5 的审查沙箱里，一条会话开场白（118 字节，磁盘上 119）替换了 29.9 KB 的四节记忆 —— 当时记为「无标题」，v0.4.8 才证明它带着规范标题（见上）。现在当**存储的是可解析
  的四节文档**、回复**完全没有任何 markdown 标题**、且长度不低于 `OPAQUE_DOCUMENT_MIN_CHARS`（40，与判断「回复是否算
  变化」同源读取）时，视为无可写内容：跳过写入并写一条诊断（v0.4.8 时的串是 `carried no entries`，v0.4.9 起改为 `not a writable memory document`）。带标题但无条目的回复仍走原路（回归护栏
  记录自己的 skip），更短的回复仍报「too short to be a change」。语义见 `docs/architecture.md` 的「consolidation 的安全语义」。
- **`loadMemory` 改为一次读取**（审查报告的登记残留 R-L1）：纯读站点此前把 render 的字节与另取的 `stat` 配对，理论上可
  读到「旧字节 + 新 mtime」；现在读一律走 `readRenderWithMtime`，读跨越替换（`changed`）时不采纳任何一版、journal 的
  fold 继续当家。写路径的 append 前复核不变。

## v0.4.6 — 2026-10-07

### 变更

- **退出不再合并记忆（issue `2026-10-06-handoff-shutdown-coupling`，选项 ①）**：`session_shutdown` 此前跑一次强制 consolidation，
  它是唯一绕过 `consolidateTurns`（6 轮）/ `consolidateIntervalMs`（5 分钟）节流的 pass，也是 2026-09-22 那条
  「模型调用抛错经 `consolidate` 逸出 handler 进 `ExtensionRunner.emit`」链的唯一来源。现在退出只做**不调模型的 flush**：
  把被外部手改的 `MEMORY.md` 采纳进 journal，文件缺失、render 为空或 journal 不旧于它（含相等 mtime）时用 journal 的 fold 重发（写前备份），比 journal 新的手改只采纳、不改字节，文件已是 fold 时不写；
  不生成任何新内容。代价（已接受）：两次 pass 之间结束的会话，其尾部不再进入 `MEMORY.md`，只留在 `session-logs/` 归档里
  （缺口长度由节流决定，不是固定上界）；自动**生成新内容**只剩被节流的 `agent_settled` 与显式 `/memory update`。`errors.log` 的键随之改为 `shutdown:flush`
  （`shutdown:consolidate` 只出现在 v0.4.1–v0.4.5 的历史记录里）。语义见 `docs/architecture.md` 的「记忆层的写入触发点」。

## v0.4.5 — 2026-10-06

### 修复

- **段配额降为「目标值」，硬上限只剩文档上限**：记忆文档此前按四段固定 share（0.2 / 0.4 / 0.25 / 0.15）逐段裁切，
  某段超出配额就把放不下的条目**整条丢掉**。实测本仓内容需要 14.2 / 42.6 / 25.7 / 16.7%，Project 空余 1,850
  字符而其余三段合计只超 1,635——**总文档 31,774 < 32,000 却每轮丢 10–15 条**（2026-10-06 四次真实 pass；口径：段花费
  = Σ(entry+3)，不含行头；数字对当时的 31,774 版快照，现为 31,993）。
  现在渲染器先把用不完的段配额汇成一个池，超额段按超出比例从池中借用（池够时精确等于各自超额，即一条不丢），
  只有整个文档到达字符上限时才丢条目。`sectionDropped` / `droppedItems` 因此重新变成「文档满了」的信号。
- **每项上限跟随借用后的额度**：借到额度的段，其单条上限也按借后额度算，于是能整条保住更长的条目，而不是按原
  share 截断。
- **提示与日志措辞对齐新策略**：主规则与冷凝重试句都改成「压到文档上限以内」，并明说每段的数字是**目标值**不是
  上限；`errors.log` 的 `memory exceeded a section budget:` 改为 `memory document reached its cap: …`，用户提示
  同步（「达到文档字符上限」）——「某段超预算」在新策略下不再是丢失原因。
- **丢失提示不再承诺做不到的事**：日志行在本进程首个 cap 事件即丢弃时列出被丢条目的**样本**（最多 3 条、每条 ≤ 72 字符）；提示把被丢条目的样本**直接写进句子**（`Dropped, e.g. …`），不依赖那行日志是否写了（日志行每项目每进程一次）；只有单项截断时不再报「到达文档上限」，也不指向不存在的列表；`/memory update` 的回复同样按
  「丢弃 / 仅截断」分流，并在「提示被裁 + 上限同现」时两者都报。三处仍指向 v0.3.0 已移除的
  `/project-context max-memory` 的文案改为 `/memory max-memory`（并加源串扫描钉子，61 个源文件）。

## v0.4.4 — 2026-10-06

### 修复

- **合并通道改为「按段配额压缩」，不再把条目当消耗品丢掉**：记忆文档按四段固定配额写盘，某段超出配额时渲染器
  **整条丢弃**放不下的条目（`memory/sections.ts::renderMemoryDocument`）。主提示原本在超预算规则里以
  `then drop the least durable entries` 收尾，冷凝重试句也写 `remove the least durable entries`——两处都在教模型
  「删」，而现场丢的条目其实一条都不是模型删的。现在两处同向：**保住仍为真的条目 → 段内合并重复 → 跨段去重 →
  压缩措辞直到每段落在自己的配额内**；删除只在「已被取代」或「别处已覆盖」时才允许，且明写不得为腾位置而删。
  `<existing-memory>` 块前另有一行注记，说明这一段内容必须整体存活、装不下时压缩措辞而不是丢条目。
- **冷凝重试句不再失实**：它此前说「超过了 N 字符上限，中间部分会被丢掉」，实际触发条件是**段配额**而非整档上限
  （整档上限只在无分段的回退路径上）。现在写「超出了某段配额（无分段时是整档字符上限），整条条目会被丢掉」，
  并同样要求压缩。采纳条件不变：重试结果必须 `sectionDropped === 0` 才写入。

## v0.4.3 — 2026-10-06

### 修复

- **固定比例模式也走物理下限**：`handoffThresholdRatio` 给出的阈值低于 `baseline + keep + MIN_DROP_TOKENS` 时
  不再触发交接——一次只丢几千 token 的交接只是换会话，省不下上下文。自适应模式一直有这条拒绝门，固定模式此前
  没有，于是 `0.1 × 大窗口` 这类设置会产生「丢弃量很小」的交接。下限仍是拒绝门而非抬升，固定模式的阈值仍完全由
  比例与窗口决定。
- **固定模式的拒绝不再被状态行隐瞒**：`/handoff status` 此前只在自适应模式渲染拒绝原因，固定模式照抄一个永远不会
  触发的比例（例如 `threshold 10%`）。现在两种模式都点名原因：`fixed 10% (the 10.0k-token threshold is below the
  78.0k-token floor a worthwhile handoff needs at this baseline; raise /handoff threshold or lower /handoff budget
  recent)`，或比例取不到正值时的 `fixed 50% (this ratio resolves to no positive threshold …)`。
- **autolearn 清单截断可见**：技能清单超过 8000 字符上限被截断时，注入的清单末尾会多一行
  `- (N more skill(s) not listed: the 8000-character inventory cap was reached)`，而不是静默丢掉尾巴——模型据此
  知道「没看到」不等于「不存在」，读 prompt 的人也能确认上限真的被撞到（本机合并清单 7,892/8,000）。标记本身
  不计入上限，所以文本可能比上限多出标记那一行（不到 100 字符）。

## v0.4.2 — 2026-10-05

### 变更

- **`handoffThinking` 与 `/handoff thinking` 退役**：该键在本仓没有行为读者（只有那个动词写它），回执里
  「stored for the dsh profile」的承诺在本仓找不到证据支撑——v0.4.0 的证据只说两仓共享那七个改名拼写，本机的 dsh 产物里这两个键拼写 0 命中（跨仓不可在本仓复验，见审计 §9.12 R-2）。兼容性上这是一次**硬切**，不是改名：
  v0.4.1 里它仍是已知键（`parseConfig` 读回、`updateConfig` 写回，值会随写持久化），退役后它才成为未知键——
  按本仓规则被忽略，并在下一次写回时随整份重写消失。键、动词、二级补全、旧名迁移项与文档一并移除；没有别名。
  保留同拼写的 `handoffBudgetSummaryTokens` / `/handoff budget summary` 仍有活读者（`threshold.ts` 把它读进
  override 回执；auto 触发公式本身不含它）。同一片把常量 `MIN_SUMMARIZE_TOKENS` 更名为 `MIN_DROP_TOKENS`
  （语义=最小可丢弃前缀，无行为变化）——代码里最后一个 `MIN_SUMMARIZE_*` 标识符随之消失（`summarized`、
  `summarizer` 是别的机制、别的词形）。

### 修复

- **注入的前言与分节改为同一次 fence 感知遍历**（`splitSections` → `scanDocument`）：此前前言用一次不看 fence
  的扫描找第一个标题、分节用另一次看 fence 的扫描，同一份文档因此有两份互相矛盾的视图——一段以 fenced
  代码块开头的文档里，块内的 `## X` 会被前言那次扫描当成标题，前言被截在假标题处、连同围栏内容一起丢掉；
  分节那次扫描（本来就看 fence）从不把那行当小节，所以真正被破坏的只有前言。
- **fence 关闭按 CommonMark 判定**：关闭行必须是同字符、不短于开启行、且除空白外无内容；此前只比较首字符，
  一个三反引号行会提前关掉四反引号块。
- `session_shutdown` 的失败回退把根选择抽成 `shutdownErrorRoot`，存在性检查精确到 `.agents/memory`（与该处
  注释一致）：该分支只在 `getProjectRoot` 拒绝时才可达，而它自身的回退就是会话 cwd，所以这是精度修正——唯一
  可感差异是「cwd 里有 `.agents` 却没有 `.agents/memory`」这个边角：旧代码会在那里落一条日志并顺带建出
  `.agents/memory/`，新代码放弃落日志。该判定无法经由处理器触达（pass 已吞掉能注入的所有失败形态），因此改为对 `shutdownErrorRoot` 的
  直接断言固定：单侧变异（`.agents/memory` → `.agents`）现在精确红一条「只有 `.agents` 的 cwd 不是记忆层」。

## v0.4.1 — 2026-10-05

### 变更

- **memory / CONTEXT 注入改为渐进披露**：每轮固定前缀不再整篇注入这两个文件——决策与踩坑相关的小节
  （`MEMORY.md` 的 `## Invariants`、`## Pitfalls`，`CONTEXT.md` 的 `## Key points`、`## Open tasks`）保持逐字常驻，
  其余小节（`## Project`、`## Index`、`## Summary`）压成一行「文件 + 节名 + 何时读它」的指针，并附一条强指令
  「不确定的具体事实必须先 read 该文件再回答，不得凭印象作答」。指针语言跟随正文语言（同一个 CJK 判定 owner）；
  未知或新增节名默认常驻，没有任何可索引小节时整篇注入。当前渲染下两个文件合计减少约一万字符/轮，
  且服从度可测（真实会话 JSONL 里会出现对应的 `read` 工具执行）。
  设计：`.codestable/issues/2026-10-05-memory-progressive-disclosure/`。
- **交接不再生成摘要**：删除整条摘要链（模型调用、token-cap 重试、九节标题本地化、`summaryFocus`、
  `SUMMARY_OUTPUT_RESERVE_TOKENS` 与摘要模型窗口 cap）。successor 现在只拿到机械载荷：最近回合原文、文件清单，
  以及旧会话日志指针加一条「缺的细节必须先去日志里查」的强指令；较早的部分留在日志里按需取回。
  依据是两条现场事实：把一份真实对话转写折进 prompt 会让 successor 完全跑偏；而「指针 + 真尾 + 强指令」在同样模型
  与一份真实日志上三问全对（实测见 `.codestable/audits/2026-10-05-context-cost-and-progressive-disclosure.md` §9）。
  用户可见文案随之改成事实描述（开始提示 `dropping ~X`、成功提示说明被丢弃部分留在会话日志、状态行 `drop N` /
  `drop budget N`、拒绝句用 handoff 而非 summary）；旋钮名与动词拼写未改（`handoffBudgetSummaryTokens`、
  `/handoff budget summary`），因为它们与 dsh 面共享、改名或删除需要单独决定，因此 `handoffThinking` 在 pi 侧
  目前只剩写路径。

### 修复

- **`session_shutdown` 里的整理失败不再逃进 pi**：该事件中的 consolidation 失败此前会冒泡到 pi 的
  `ExtensionRunner`（`errors.log` 2026-09-22 那条链的栈穿过 `emitSessionShutdownEvent`），而交接正在同一个事件里
  `await ctx.newSession`。现在失败被捕获并记到 `errors.log` 的 `shutdown:consolidate` 键下。该守卫在测试面上不可达
  （pass 已吞掉能注入的所有失败形态），因此按「有现场依据的防御」记录，不写成已验证。
- **交接失败提示不再承诺 pi 的自动压缩**：`Handoff: failed — …` 去掉了 `pi auto-compaction still applies`，
  这一层从不控制 pi 的压缩。

- **交接保住「最后一轮」**：pi 的 `findCutPoint` 本来就返回 `turnStartIndex`/`isSplitTurn`，本扩展此前只取
  `firstKeptEntryIndex`，于是被切开的那个回合（连同它的起始 user 消息）会整段丢出重放，
  重放块以 assistant 工具调用/工具结果开头（`[turn prefix summarized during handoff]` 占位；v0.4.1 起该占位改名为
  `[turn prefix dropped during handoff]`）。
  现在：前缀不超一窗且老侧仍有内容可丢时**吸附到回合起点**（整轮原文保留）；否则把该回合的起始 user 消息
  **锚定进重放**，中间体积留在旧会话日志里（裁切 + 既有文件索引）。单回合会话不会因吸附而变成「无可丢内容」而中止。
  现场与设计：`.codestable/issues/2026-10-05-handoff-last-turn-not-replayed/`。

## v0.4.0 — 2026-10-05

### 变更（破坏性：配置键改名）

- 配置键改为**镜像命令路径**（`/handoff budget summary` ⇒ `handoffBudgetSummaryTokens`）：`autoConsolidate`→`memoryEnabled`、
  `autoLearn`→`autolearnEnabled`、`handoffTargetTokens`→`handoffBudgetSummaryTokens`、`handoffKeepTokens`→`handoffBudgetRecentTokens`、
  `handoffSummaryThinking`→`handoffThinking`、`handoffAdaptive`→`handoffThresholdAuto`、`handoffLanguage`→`handoffLang`。
  首次读配置时一次性迁移（与 v0.3.0 的嵌套布局同一条路）：**旧键存在即折进新键、整份写回、旧名消失；新旧并存时新键优先**；
  仍是只有 `legacyConfigPatch()` 认识旧名。根因是 v0.3.0 只收束了命令面，键名/文案没跟上（`Auto summarize target` 到 `b869be3` 才补）。
- 命名与词汇规则成文：`.codestable/reference/vocabulary-conventions.md`（配置键、通知前缀、拒绝理由句式、模型可见词汇、
  代码命名、pi/pi-ai 的 strict-schema 约束、术语表、审计历史）；`.codestable/attention.md` 指向它。
- 通知前缀按层统一：`Automatic consolidation:`／`Project memory updated:`／`Memory cap:` → `Memory:`，`Auto handoff*` → `Handoff:`，
  `Session archiving:`／`Session log written:`／`Session log update failed:` → `Session log:`；前缀后不再重复层名。
  `/memory` 与 `/project-context status` 的 memory 状态行现在是同一句 `Memory: …`。
- 跨层渲染器名统一：handoff 的 `statusText` → `handoffStatusLine`，memory 的 `memoryStatusMessage` → `memoryStatusLine`。
- 七个改名两仓同名：dsh 改的是同样七个拼写，两仓配置面不在拼写上分叉；dsh profile 里残留的旧拼写没有别名可退，须在宿主重启前改掉（映射见 `docs/configuration.md` 的兼容迁移段）。

## v0.3.2 — 2026-10-05

### 变更

- autolearn 改为**按需取正文**：第一轮提示词不再带任何技能正文，模型要用 `inspectSkill`（最多 2 条）点名要哪几条，
  第二轮才注入（整篇，放不下就整篇不放）。此前是「能塞多少塞多少」：17 条带标记的技能里只有 4 条进得了提示词，
  其余 13 条**可覆盖却看不到原文**，且谁进谁出取决于清单顺序。基础提示词从 32057 降到 13149 字符，17 条全部可达。
- 覆盖的前提变成「**本轮展示过它的正文**」：gate 与写入路径各读同一个展示集合，未展示的名字被拒绝
  （`body not shown this pass`），候选路径同受约束；点名了却不该给（手写/global/超预算）会在第二轮明确回执。
  数量上限写在代码里（`maxItems` 不保证被执行）。
- `/autolearn` 命令描述改为 `Learn or update a project skill now`；`/autolearn approve` 覆盖既有技能时明说是**盲写**
  （人工确认路径不经过提示词）。

## v0.3.1 — 2026-10-05

### 变更

- autolearn 可以**取代自己生成的技能**（此前只能新增）。它写出的 `SKILL.md` 带一行来源标记
  （`<!-- autolearn-generated: … -->`）在**正文**而不是 frontmatter：pi 启动只注入 name/description/path，未知 frontmatter 键行为未定义。
- 标记就是范围判据：只有带标记的 **project** 技能允许同名覆盖；手写、旧布局导入（`shared/migrate.ts`）、global 技能一律照旧拒绝。
  标记跟着文件生灭，所以「只动 autolearn 生成的」是结构保证 —— 技能删掉后名字被手写占用，对方不带标记就不会被覆盖。
- 提示词新增 `<learned-skill-bodies>`：被标记技能的正文**整篇**注入（放不下就整篇不放），于是同名覆盖是**合并**而不是盲写；
  规则要求保留仍然成立的步骤，合并不了就不提案。候选路径同样受此约束：不得为手写名字落候选文件。
- 通知区分新增与覆盖：`Learned project skill:` / `Updated project skill:`（`/autolearn approve` 同理）。

## v0.3.0 — 2026-10-04

### 变更（破坏性命令面）

- 命令面按数据流层重排：一个参数住进**改变它的那一层**。`/memory` 新增 `on|off` 与 `max-memory <n>|default`，`/session-log` 新增 `on|off`、
  `write`，两者的无参调用各自打本层的状态行（`max-memory` 从伞形搬来，四个特性的 `on|off` 现在都有本层入口）。
- 伞形的 `on|off` 只剩**四特性批量**，且不接受目标：`/project-context off all` 这类旧写法会被拒绝并提示用裸 `on|off`。
  命令面**没有**扩展开关——整扩展禁用仍然只有 run 级 `--no-project-context` flag，文档与注册描述都写明这一点。
- `/context` 退役：context 文件行归 `/memory`（与 `status` 共用同一 `contextStatusLine()`，两处逐行一致），session index 与 session logs 两行归 `/session-log`（无参**只读**：
  pi 自己已在 `turn_end`/`agent_settled`/`session_shutdown` 写存档，读路径不再带写副作用，要立刻写用 `write`）。
- `/handoff` 动词 13 → 9：`threshold <auto|比例>` 合并 `auto` 与裸比例（`40`、`0.4`、`40%` 等价），
  `budget summary <n>`/`budget recent <n|off>` 取代 `target`/`keep`（两个数一个量摘要、一个量近期窗口，各自说出量的是什么），
  `mode <send|draft>` 取代两个裸词。裸比例**硬切**；`force-auto` 与 `language`/`run`/`force` 同义保持原样。
- 配置兼容不再常驻读路径：嵌套 `features.*`/`autolearn.*`/`handoff.*`、`memory/autolearn.json` 与全局 `~/.pi/agent/auto-handoff.json`
  改为某项目首次读配置时**迁移一次**（折进扁平键、整份写回、提示 moved from …）；此后读路径只看扁平键，新键不再获得回退项。
- autolearn 提示词补两条规则：技能只写本项目自己的持久事实（绝不搬他仓测量值），检查写成形态（如
  `[0-9]{2,3},[0-9]{3} chars`）而不是某一次跑出来的数字；并要求描述保持一行短句、已有技能覆盖时宁可不提案而非生成近似重复。

## v0.2.3 — 2026-10-04

### 修复

- 渲染边界：consolidation 提示词加一条规则——只写本项目自身的持久事实，绝不把其他仓的状态或测量值（提交距离、文件大小、研究数值、键数）搬进
  memory 或 context；点名他仓仅限于记录「谁拥有哪个未决项」。同时在 `<recent-conversation>` 块内首行加一句同义说明，
  因为异仓文本正是从那个块进入提示词的（三轮渲染把兄弟仓数值写回来的现场事实）。
- 命令措辞「一个事实一个名字」：伞形首行 `Project context:` → `Features:`；context 文件那一行在 `/project-context status` 与 `/context`
  里统一叫 `Context file:`。旧版同一个 `CONTEXT.md` 在两处分别叫 `Context:` 和 `Project context:`，而 `Project context:` 在伞形里指的是另一回事。

## v0.2.2 — 2026-10-04

### 修复

- memory 状态行单一化：`/project-context status` 与 `/memory` 改由同一个 `memoryStatusMessage()` 渲染，两套措辞合一。
  伞形状态行因此补齐了「journal 存在但无可用记录」的恢复提示（原先只有 `/memory` 有），`/memory` 的无参输出随共享文案统一。
- 测试：适配 pi 1.0.2 的 managed 安装树（读 `install/current-version`，依赖沿 `node_modules` 向上查找）。
  仅 `tests/`，运行时代码未变。

### 文档

- 锁归属更正扩散到主审计横幅与补审二模块表（19 个 `.lock` 属 Codex 移植，不是 `lock.ts` 的现场依据）。
- `docs/architecture.md`、`docs/configuration.md` 补两条语义：手工并回 `MEMORY.md` 不持久；cap 每次写入都生效。
- 全部文档按句读换行（无 >160 字符的行）；`docs/README.md` 索引不再钉死「当前 issue」。
- `docs/configuration.md` 补「入口关系」一段：伞形是权威开关入口，`/context` 不是 status 的子集，命令面有意不收束（无使用证据）。

## v0.2.1 — 2026-10-03

外部编辑采纳：重建回复期间落地的外部编辑不再被覆盖 —— 回复的 basisKey 与当前有效内容不一致时**拒绝发布**，
且拒绝时发布侧无任何副作用（无备份、无 cap/poison 日志、无成功通知），下一次 consolidation 从存活内容重建。
另：超出 cap 的回复在裁剪前先本地留档。

## v0.2.0 — 2026-10-03

分节渲染：consolidation 输出按固定四节（`Project` / `Invariants` / `Pitfalls` / `Index`）逐节预算渲染。
**破坏性改名**（无过渡期）：`/memory-learn` → `/memory update`、`/auto-handoff` → `/handoff`、`/context-update` 删除。

## v0.1.12 — 2026-10-01

`CONTEXT.md` 固定三节 schema（`Summary` / `Key points` / `Open tasks`）+ 逐节预算 + 截断标记；memory schema 与条目指针化。

## v0.1.11 — 2026-09-25

收口 R3 丢失面：autolearn 批准路径重新套用形状规则；handoff 手动 `target` 与触发线解耦；阈值拒绝点名原因而非归咎窗口。

## v0.1.10 — 2026-09-19

`/handoff auto` 阈值锚到保守拐点曲线。

## v0.1.9 — 2026-09-19

预留 reasoning 预算，尊重 finish reason。

## v0.1.8 — 2026-09-19

加强 memory 与 handoff 的恢复路径。

## v0.1.7 — 2026-09-17

关闭四条已登记残留并暴露陈旧 context；追加 `.gitignore` 行不再重复表头。

## v0.1.6 — 2026-09-17

handoff 携带会话设置跨越切换，目录树压平。

## v0.1.5 — 2026-09-16

handoff 切在回合中段，避免单个超长回合阻塞。

## v0.1.4 — 2026-09-16

handoff 跟随对话语言，replay 丢弃过期提示。

## v0.1.3 — 2026-09-16

内存改为「append-only journal + 渲染的 `MEMORY.md`」；写锁抗病理路径、备份有界；不可读的旧内存源会被报告。

## v0.1.2 — 2026-09-14

与 dsh 对齐：辅助调用走同一路由与配置字段；autolearn 共用新材料/轮次门；不可读的 JSON 回复不再写成 `MEMORY.md`。

## v0.1.1 — 2026-09-12

去掉 `package.json`，git 安装无需 npm。

## v0.1.0 — 2026-09-12

首个版本：archive / consolidation / autolearn / handoff 四项能力。
