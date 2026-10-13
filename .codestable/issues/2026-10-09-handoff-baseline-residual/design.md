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
