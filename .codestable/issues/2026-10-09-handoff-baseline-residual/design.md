# 设计：baseline 的取样修正（issue 2026-10-09-handoff-baseline-residual）

状态：**待 operator 定稿**；按本仓惯例，实现前需一轮独立审查（冻结修订 + `/tmp` 只读沙箱）。
上游证据：`brief.md`（机制与证伪条件）、`baseline-attribution-experiment.md`（漂移量级）、
`probe-true-baseline.md`（provider 直报真值）。

## 1 一句话问题

`baselineTokens()` 把**当前这一点的 usage 残差**当成非会话基线，而残差随分支字符数增长
（稳定段内实测漂移 +8.9k…+69.7k，跨段累计 +58k…+128k）⇒ floor 在会话中途自己长高，
越过质量拐点后自动交接被无声关掉（owner 现场：prompt 317k、floor 179k > knee 157k）。

## 2 根因分解（全部已测，不用再猜）

    基线_reported = 基线_true + 前缀估计误差 + 末条回复项

- **前缀估计误差** = `Σchars × (1/4 − 1/r)`，本仓实测 `r = 2.2–3.8` ⇒ 恒为正、随分支增长，是主项。
- **末条回复项** = 回复 output tokens − 回复字符/4：`usage.tokens` 含 output（prompt+output），
  而分支估计又把该回复文本按 chars/4 算了进去 ⇒ 每回合 ±1k 级、符号取决于回复的语言构成。
- **注入块**（实测 6,745 tokens）本就该在基线里；扩展对它的估计（chars/4）反而**高估约 3.1k**
  ⇒ 它不是高估来源，不要动。
- 隔离探针：分支消息 chars≈0 时 `基线_reported = 基线_true = 17,753` ⇒ 误差在零点为零。

⇒ 结论：**误差是"当前取样点在分支上的位置"的函数**，不是配置错误，也不是某个常量偏移。

## 3 方案 M（推荐，最小）：把取样点移到分支最空处

**基线 = min over usage 记录 r of ( prompt_r − Σ estimateTokens( 分支截至 r ) )**，其中
`prompt_r = usage.input + usage.cacheRead + usage.cacheWrite`（读条目自带的 `usage`，**不含**末条回复）。

为什么这样对：

- 残差是消息字符数的增函数（前缀项）⇒ 最小值落在"可用样本里分支最空的那一点"，那里的估计误差最小；
  探针已证明零点误差为 0。
- 用 `prompt_r` 而不是 pi 的 `usage.tokens` 顺带消掉末条回复项（方案 R 自动含在里面）。
- 最小值一次取到后 floor 不再随分支增长 ⇒ 满足 `brief.md` 的第一条证伪条件
  （"同一会话里隔一段再跑，baseline 应当基本不动"）。
- 仍是**上界**，但只对**可信样本**成立：`r < 4` 时 chars/4 估计偏低，所以残差偏高；而一个被全局 rate 过度修正的样本
  （换算估计 ≥ 自身 prompt）残差会读到 0 甚至为负，那是测量失效而非读数 —— 它改用历史 chars/4 残差（只高不低），
  不参与 `min`。第 1 轮独立审查证明原措辞（“每个样本都 ≥ 真值”）在异质分支上不成立，已按此收窄。

可行性（已在 pi 1.1.0 的 .d.ts 上核对）：

- `buildContextEntries(entries, leafId?, byId?)` 接受 **leafId** ⇒ 用某条记录的 id 重建"截至该记录"的分支。
- 分支上的 assistant 消息带 `usage?: Usage`（`input/cacheRead/cacheWrite/output` 可取）⇒ 样本不需要新状态。

退化：会话里没有 usage 记录（首回合、或全是被压缩掉的记录）时，**逐字节退回今天的实现**。

## 4 其余三块（各自独立可裁）

- **R 末条回复项**：由 M 用 `prompt_r` 顺带消除；若最终保留 pi 的 `tokens` 作为被减数，则必须加回 est(回复)。
- **D 可见性**：`/handoff status` 显示 `B <值>`、`pi.tokens`、`Σest` 与取样来源（`min@<何时>` / `current`）。
  动机：owner 那条线之所以无法复盘，就是因为读数不带输入 —— 没有这三个量，任何"baseline 异常"的现场都不可自证。
- **C 诚实降级**：当 floor 是被**单点**读数顶到拐点之上、而样本集里存在更小的残差时，状态行点名
  "测量可疑/样本不足"，而不是暗示"baseline 是杆"（本仓审查反复抓的正是"用户可见句子承诺代码做不到的事"）。

**非目标**：不引入第二套 tokenizer；不做会话内校准因子 `Δprompt/Δchar`（M 已在可用样本上取得同样的紧度，
校准反而要多一份跨回合状态与一个噪声源）；不搭缓存层；不改 pi 的估计器；不顺手改阈值公式。

## 5 语义与边界（实现前需定）

1. **样本取舍**：全局 `min`（推荐）还是"最早一条 usage 记录"？两者偏向不同 ——
   全局 min 在 ASCII 重的会话里可能略低于真值（r > 4 时估计偏高，残差被压到真值之下）⇒ floor 略低、触发略早：
   这是「无声关闭」与「提前发生交接」之间的取舍，不是单向的安全选择，需要 operator 定；
   "最早一条"语义最直白（"在空分支上量的"），但首条消息很大时会偏保守（偏向今天的毛病侧）。两者都不得低于 0。
2. **重放记录**：交接继承的上一会话记录，其 `prompt` 覆盖前任整支分支 ⇒ 残差极大 ⇒ 永远不会赢得 `min`
   （不需要显式排除，但要在测试里钉住这个性质）。
3. **分支非单调**：压缩/`context_edit` 会让分支变短 ⇒ "截至 r"的重建必须用 r 自己当 leafId，
   不能用当前叶子截断（否则样本点算错）。
4. **同一根因的第二个消费者（本轮不修，登记为新发现）**：`run.ts` 的 `olderTokens`/`keptTokens` 也用
   `estimateTokens`（chars/4），所以"drop budget"与实际切下的真实 token 数之间同样有 `1 − r/4` 的口径差
   —— 它是同一个根因的另一处表现，但改它会动到切分逻辑，属于另一轮。
5. **不变量**：`baselineTokens` 的返回语义（非会话 token 数）不变；无样本路径字节等价；不新增盘上状态。

## 6 验收

- **纯函数契约**（`tests/handoff-test.mjs` 或新的 `tests/threshold-test.mjs`，用注入 usage 的合成分支）：
  1. 三条记录、`r≈2.5`、递增 chars ⇒ `B̂` 等于"空分支点"的值；**把 min 改成当前点必须变红**。
  2. 用 `prompt` 而非 `tokens` ⇒ 回复很长时 `B̂` 不随之变大；改回 `tokens` 必须变红。
  3. 无 usage 记录 ⇒ 与旧实现逐字节相同；改掉这条路径必须变红。
  4. 含一条"重放记录"（大 prompt + 小 chars）⇒ 它不参与 `min`；去掉该断言必须变红。
- **真机**：`brief.md` 的第一条证伪条件（同一会话两次 `/handoff status`，baseline 不动）+ 本 issue 的
  隔离探针（`probe-true-baseline.md` 的命令）作为 B_true 的旁证。
- **突变矩阵**：每条断言配一个只改一处的补丁，报告 `^FAIL ` 行数（本仓计数口径）。

## 7 规模与决策点

规模：`handoff/threshold.ts` 采样器 + `handoff/run.ts` 状态行，代码约 40 行、测试约 80–120 行；
按本仓历史（设计估计偏低约 1.7 倍）按 **1.5–2 倍**预算。

**operator 的决定（2026-10-13）：全部都修。**于是 A（会话内速率）从非目标转入范围 —— 修 `run.ts` 的第二个消费者
必须对任意片段做 chars→tokens 换算，那不能没有速率；采样语义取全局 `min`（理由见下），D/C/§5.4 都做。

## 8 实现（2026-10-13，已落地）

`handoff/threshold.ts` 新增（不新开模块，该文件本来就是 `baselineTokens` 的家）：

- `measureContext(ctx, usage)`：一个 pass 走完分支，对每条 assistant 记录取 `prompt = input+cacheRead+cacheWrite`
  （**不含**回复的 output）与**该记录之前**的消息估计（记录自己的消息不算进自己的 prompt，实测这一处会低读 baseline），
  取最小残差；rate = 最后 5 个同段 delta 的中位数（`4·Δ估计/Δprompt`），取值带 `[1.0, 8.0]`（下界按纯 CJK 约 1 token/字定），
  无可用 delta 时 rate = 4 且 `calibrated=false`；无 usage 记录时逐字节走旧公式。
- `contextTokensAtRate(messages, rate)`：回执与 mid-turn 快照预算共用这一份换算。
- `baselineSuffix(measure)`：状态行后缀（D+C 合在一处：有样本写 `(<rate> c/t, best of <n>)`，无样本写 `(chars/4, no usage sample)`）。

`handoff/run.ts`：`dropping ~X / carrying ~Y`、mid-turn `prefixTokens`、`keptTokens`、`anchorTokens` 四处改用 rate 换算；
状态行加 baseline 后缀。**切点本身仍是 pi 的 `findCutPoint`**（chars/4）：重写它会重复 pi 的 turn 对齐，本轮不动，
因此“真实载入量与 keep 预算的差距”仍在，已在报告里登记为边界。

验收：15 项测试全绿（多次）；末节契约按实测口径为 15 条 `check(`（`git diff … \| grep -c '^+.*check('`），本轮修复后 17 条。第 1 轮独立审查
（冻结 `466ebcd`，CHANGES-REQUESTED，0 blocking / 2 important）改了三条：过度修正的样本回退到 chars/4 残差（否则 `min` 可读到 0）、
非 message 条目（compaction summary 等）也计入 `plain`（否则“逐字节不变”不成立）、未校准后缀不再谎报 4.0。报告与残余 R1–R7 见
`review-report.md`；**§3 的“每个样本 ≥ 真值”应读作“每个可信样本”，不可信样本（换算估计 ≥ 自身 prompt）退回 chars/4 残差后只高不低**。
修复后的变异矩阵（计法 `node tests/run-all.mjs` 的 `^FAIL ` 行）11 条全部变红：取最后一条 2、`totalTokens` 1、rate 固定 4 7、去取值带 3、
退 fallback 减法 9（含既有端到端用例）、回执忽略 rate 1、自己消息计入自己 2、去状态行后缀 1、去过度修正守卫 1、非 message 条目不进估计 1、
未校准分支谎报 4.0 1。
真机 smoke：同一沙箱配置下新代码首条请求 prompt = 17,769（旧代码 17,766，差值来自期间新增的一个技能描述）⇒ 加载与运行正常；
**能区分新旧的是纯函数契约，不是这次 smoke**（一次性会话只有一条记录，取不到 delta）。
原报告的残余①不可能用文件考古闭合，但状态行现在自证。

（早期的 §7 决策点保留在上面作记录：A 的取舍、切点不动的理由、D/C 都做。）

## 9 C+A 实现（2026-10-13 落地；operator 决定「C+A」）

§3 的 M（最小残差 + 单一 rate + 过度修正守卫）在本轮被 **C+A** 取代，两处都是被实测逼出来的：

- **C（system 不进被减量）**：pi 的 `estimateTokens` 对 system 消息已算 `content + sections + toolsAdded`，把它计入 `plain`
  等于把工具 schema 与系统提示从 baseline 减掉。两个沙箱实测低读 9,881 / 9,882（真值 17,753 / 11,008），活树低读 25,823；
  同时两沙箱的 system 估算几乎相同而真值差 6,745（= 本扩展注入的记忆块）⇒ 也排除了「直接用 pi 的 system 估算当 baseline」。
- **A（密度上界 + 精确增量）**：R2 的 I-1 证明单一 rate 只对与校准窗口同率的前缀成立（`ASCII 20,000 + CJK 尾` 读 3,736、
  `25,200` 读 106，真值 17,766）。现在用取值带给出 `chars/8 ≤ T_r ≤ chars`，取 `prompt_r − chars_r/8` 作**上界**（永不低于真值），
  在这些上界里取最小；后出现的记录上界只会更大 ⇒ 取值由最空记录定下、不随分支增长。

代码（`handoff/threshold.ts`）：`ContextSample` 增加 `chars`、去掉 per-sample `estimated`；system 消息在两处累加点都跳过
（message 条目与 `sessionEntryToContextMessages` 产出的非 message 条目，后者覆盖 compaction 的 `systemMessage`）；
baseline 循环改成 `prompt − ceil(chars / RATE_MAX)` 的 min；`prompt <= ceil(chars / RATE_MAX)` 的记录不是测量（不参与 min，
也不把读数拖成负数）；过度修正守卫随之删除（上界不可能过修正）；首回合/无记录公式同步只减消息估计；`baselineSuffix` 改说
「chars/8 bound over N records; receipt at …」。rate 校准保留（回执与 mid-turn 预算要用），仅不再参与 baseline。

残余（本轮不修，登记在报告）：① 最空记录自身字符数带来的高读 `chars × (1/r − 1/8)`（活树约 +12k，窗口 1M 时拐点仍先绑定，
无功能影响；但对「首个大块」极重的会话会把 floor 推到拐点之上 ⇒ 拒绝）；② 读数是「设定它的那条记录时刻」的 baseline，
注入块在会话内刷新时低读其增量（本仓实测漂移 13.8k 已消失，这一项以注入块自身增量为界）；③ 只有 predecessor 重放记录的窗口里读虚高：直到出现更小 bound 的记录之前，
读数停在前任记录的量级上（活树实测 record 0–3 读 131,433、record 4 起 52,151；R2 已登记，A/C 与 R5 都未改变它）。

## 10 R4：图像块与区间一致性（第 3 轮独立审查的两条 important）

第 3 轮（冻结 `3abd207`）判 CHANGES-REQUESTED / 0 blocking / 2 important / 4 nit，两条 important 都是 fail-open（低读侧）：

1. **I-1 图像块**：pi 的 `estimateTokens` 对每张图固定计 `ESTIMATED_IMAGE_CHARS = 4800`
   （`dist/core/compaction/compaction.js:182/193-195`），而取值带要求每张图 ≥600 token 才不低读；小图（截图缩略图、
   low-detail 约 100 token）远低于此 ⇒ 上界落到真值之下并赢 `min`。修法：`chars` 与 `estimated` 都只计**文本**
   （`textEstimate` = 去掉 image block 后的 `estimateTokens`），图的真实 token 落进 baseline。代价：baseline 高读 `T_img`；
   floor（`estimated + baseline`）= 文本 token + 整个 baseline，**不变**，没有双重计数（若只把 `chars` 去图而 `estimated` 仍含图，
   floor 会多计约 1,100/图）。
2. **I-2 区间一致性**：`prompt <= chars/8` 只判记录**自身**合格；一条记录计费后分支里被插入它没被计费的字符
   （前任重放插在它之前、分支被编辑）时，它的 `chars` 偏大 ⇒ 上界落真值之下并赢 `min`。修法：相邻样本（无 split 且 prompt 未缩小）
   要求 `chars_r − chars_p ≤ (prompt_r − prompt_p) × RATE_MAX`（由 `B_p ≤ B_r`、`T_r ≥ chars_r/8`、`T_p ≤ chars_p` 推出必要条
   件），违反即**丢弃**该记录（丢弃不可能低读）。prompt 缩小的区间不检查：交接继承的前任记录是大 prompt 对小 prompt，
   那正是 `min` 本就会跳过的情形（把它也丢掉会把 baseline 抬到前任的 131k 量级 ⇒ 自动交接被关掉，方向错）。

**本轮登记残余**：④ **偏稀疏锚点** —— >8 chars/token 的内容（长空白/重复串）出现在**首条**样本里仍会低读
（区间形式已被第 2 条捕获，锚点没有参照物）；⑤ **陈旧锚点** —— 一条记录自身的 prompt 相对它存储的前缀已陈旧时无法从文件判定
（4b 夹具即此形状：`prompt_4 = 60,000` 对前缀 101,001 token 的估计，其文件内部只支持 `B ≤ 9,499`），
只有在它前面还有一条**更小的**可参照样本时才被第 2 条规则捕获；第 4 轮审查员给出了它漏过的形状（更大的前任 prompt +
重放 + 陈旧本地记录 ⇒ 读 12,015 而真值是 17,766），所以「真实交接里前任记录就在前面 ⇒ 会被捕获」这句是**错的**，
已删除：prompt 缩小时不检查是**有意**的 fail-open 取舍（丢掉本地记录会把 baseline 钉死在前任的 131k 上，正是 issue 本身的症状），
代价就是这个形状读低。既有残余 ①②③ 不变。

## 11 R5：按 pi 的投影算 `chars`（第 4 轮的两条 important）

1. **R4-I-2（按原始条目列表累加）**：provider 收到的是 `buildSessionProjection`（`agent-session.js` 用它构造请求）的投影，
   而 `context_edit` 通过 `projectContextEntry` 改写目标消息（`replacement: null` 则整条删掉）。按原始条目累加时，一条被缩短/删除的
   100,000 字符消息仍进 `chars` ⇒ 后续记录读数低约 12,500（审查员夹具 5,267，本仓 5,268，真值 17,766）。
   修法：在**编辑条目出现的位置**（`for (const [index, entry] of entries.entries())`）就地改写目标条目的贡献 ——
   编辑之前的记录仍按原文计算（它们被计费时原文还在），编辑之后的记录按新文本；同时镜像投影的 compaction 语义
   （`index > 0` 的 compaction 贡献 0：旧 compaction 可以因为新 compaction 的 `firstKeptEntryId` 落在它之后而被保留在
index>0，第 5 轮审查员用 `[c_new, m1, c_old, m2, a1]` 的夹具证明了它可达、且我们的镜像正确）。
2. **R4-I-1（区间规则在 prompt 缩小时豁免）**：见 §10 订正 —— 豁免保留（否则交接继承的前任大 prompt 会把 baseline 钉在 131k），
   但边界写清、形状钉住（4d 契约），残余⑤ 即为该形状。第 5 轮审查员进一步指出：该形状在 pi 自己的写者下**不可复现**
   （append 只接 leaf ⇒ 路径祖先必然早于记录），它是**文件级**容错（外部写者 / 手改 JSONL）；真实会话里能造成低读的只有
   本扩展 `SPLIT_TURN_MARKER` 注入这类「同一分支内 token 数被重算」的情形，量级远小于夹具的 50k。4d 注释与 §10 措辞按此口径。

**顺带（第 4 轮 nit）**：`rate > RATE_MAX` 不可达（接受样本已过区间规则 ⇒ `4·added ≤ Δprompt·RATE_MAX`）⇒ 删除，只留 `rate < RATE_MIN`；
`absurd` 夹具改钉 band 下半（prompt 涨 1,000、文本涨 150 ⇒ 0.6 c/t 被拒、4 条样本全在），使 `!calibrated` 不再是同义反复。
