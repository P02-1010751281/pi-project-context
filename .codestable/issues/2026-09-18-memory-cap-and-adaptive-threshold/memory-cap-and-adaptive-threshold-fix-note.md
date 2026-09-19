---
doc_type: issue-fix
issue: 2026-09-18-memory-cap-and-adaptive-threshold
status: confirmed
path: quick
fix_date: 2026-09-18
related: [memory-cap-and-adaptive-threshold-report.md, memory-cap-and-adaptive-threshold-review.md]
tags: [memory, truncation, maxMemoryChars, context, handoff, threshold]
---

# 记忆截断 + auto 阈值偏低 修复记录

触发：owner 报告「MEMORY.md 最后一行被截断」与「auto 阈值明显偏低」→ 一句「all」要求全修；排查中定位的 CONTEXT.md 静默停更一并收口。
**本次改动含代码、测试与 artifact，尚未提交/推送**（等 owner 决定）。

## 1. 记忆上限：整行截断 + 明示标记 + 可配置（`project-state.ts` / `config.ts`）

- `normalizeMemoryDocument(value, limit)`：超限时改用 `clipToLineBoundary()` 按**整行**截断，并在末尾追加一行
  `_[memory truncated at <limit> characters: <dropped> dropped]_`。只有「单行本身就超过上限」的极端情况才会切行内。
- 幂等：归一化时先抽出既有的 marker 行、正文单独计量，marker 原样保留 —— 因此 `recordMemoryDocument` → `foldMemoryJournal`
  → 外部编辑比较键 `memoryComparisonKey` 反复归一化不会叠 marker、也不会把 marker 洗掉。写入、fold、比较键、legacy 读取共用同一限制。
- 标记即证据：`isMemoryTruncated()` 导出，三个出口都点名 ——
  - `errors.log`（每项目每进程一条）：`memory exceeded maxMemoryChars (N): the tail was dropped on a line boundary …`；
  - 非静默 pass 的 warning 通知（`agent_settled` 路径）；
  - 显式命令的回复 `consolidateReply`（`memory-learn`/`context-update` 走的是 silent pass，之前只有通知可选，现在回复里带一句）；
  - `/project-context status` 的 `Memory:` 行追加 `— at the maxMemoryChars cap, the tail was dropped (whole lines only); raise maxMemoryChars …`。
- 新配置 `maxMemoryChars`（默认 **32000**，范围 4000–200000）：由调用方**显式透传**到 `normalizeMemoryDocument` /
  `foldMemoryJournal` / `memoryComparisonKey` / `loadMemory` / `recordMemoryDocument`（都是可选参数，默认 `MAX_MEMORY_CHARS`），
  `getConfig` 不写任何进程级状态。初版曾用 `setMemoryCharLimit()` 进程级覆盖，lane A 第 1 轮 I2 指出「配置→限制」的绑定依赖调用顺序、
  同进程多项目会串味，已改为此形式；session_start 的 legacy OMP memory 迁移也显式传入同一 `maxMemoryChars`，不再漏回默认值。旧行为是固定 24000，本仓记忆正好贴在上限上，任何新增内容都在静默挤掉尾部 —— 默认上调是这次「别再丢」的必要条件。
- 探针（`tests/consolidation-test.mjs` 新增两段）：
  - 纯函数段：上限内原样返回；超限必带 marker；marker 报出上限与丢弃量；**保留的每一行都是完整原始行**；保留部分 ≤ 上限；
    重复归一化幂等；显式 `limit=8000` 生效，省略 limit 回落到默认。
  - 端到端段：`project-context.json` 写 `maxMemoryChars: 5000` → 模型回复一份 ~29k 字符的记忆 → 渲染 < 5400 且带 `at 5000 characters`
    → 只有整行；`errors.log` 有 `exceeded maxMemoryChars (5000)`；命令回复与 `status` 都点名。
- 变异：把截断退回 `.slice()` → 9 条断言变红（含端到端三条）；去掉 `getConfig` 的推送 → 3 条变红。

## 2. CONTEXT.md：省略与截断两种「没有 context」都留痕（`consolidate.ts`）

- `ConsolidatedResult` 新增 `recovered?: boolean`：回复对象没闭合、只能从 `memory_markdown` 恢复时置位（等价于「输出上限吃掉了
  context 段」）。纯解析探针：`a reply that was cut off is flagged` / `a complete reply is not flagged as cut off`。
- 写入路径新增一条 trace（沿用 `contextShapeWarned`，每项目每进程一次）：
  `the consolidation reply carried no context section (its object never closed, so only memory_markdown could be recovered); the previous CONTEXT.md is kept and stays stale until a pass returns one`。
  「有 context 但形状不可用」的旧分支保留（文案不变，仍区分 previous/placeholder）。marker 行识别同时收紧为完整形状正则（`^_\[memory truncated at \d+ characters: \d+ dropped\]_$`），
  避免把「内容恰好以 `_[memory truncated` 开头」的正常记忆行误当 marker 搬走（第 1 轮 M2）。
- 探针：完整回复但省略 context → CONTEXT.md 原样保留 + errors.log 有 `carried no context section` 且**不含** `cut off`；
  截断回复 → 记忆落地 + errors.log 同时有 `carried no context section` 与 `cut off`。
- 变异：去掉 `recovered` 标记 → 2 条红；去掉新分支 → 2 条红。

## 3. auto 阈值：窗口占比作下限 + 摘要窗口封顶（`handoff.ts`）

- `resolveThreshold(ctx, usage, summaryModel?)`：自适应分支改为
  `olderTarget = max(8000, min(handoffTargetTokens, floor(会话余量/2)))`，再取
  `tokens = max(baseline + keep + olderTarget, round(handoffThresholdRatio × window))`，
  即 **`handoffThresholdRatio`（默认 0.4）在自适应模式下是下限**，绝对目标只在 baseline 很重时把阈值推得更高。
  上限依次是：摘要模型窗口（`摘要模型窗口 − SUMMARY_OUTPUT_RESERVE_TOKENS`，让被摘要的前缀能塞进 aux 路由；aux 模型未配置时退回会话窗口）、
  模型首个计价档位、`usable − TIER_EDGE_MARGIN`。
- 调用点三处都拿到摘要模型：`statusText`（显示用）、`maybeTrigger`（定时触发判断）、`runHandoff`（实际交接）。
  初版写成 `if (prefixRoom > 0) tokens = min(...)`，lane A 第 1 轮 I1 指出：摘要模型窗口 ≤ `SUMMARY_OUTPUT_RESERVE_TOKENS`(32768) 时
  `prefixRoom ≤ 0`，整个封顶被静默跳过、阈值仍可回到 0.4×会话窗口（1M → 400k），与被摘要前缀必须能进 aux 窗口的前提矛盾。
  现改为 `prefixRoom = max(MIN_SUMMARIZE_TOKENS, summarizerWindow − SUMMARY_OUTPUT_RESERVE_TOKENS)`，无分支：装不下连最小前缀时阈值就停在最小前缀。
- 状态行：自适应时追加 `· target 64k · floor 40%`；若摘要窗口、计价档位或 usable window 压低最终值，再追加 `· capped by ...`，避免再出现「阈值 6.4% 但配置写着 40%」而无原因的困惑。
- 新增 `/auto-handoff auto [0.1-0.95]`：保留自适应数学、改下限占比（裸比例 `/auto-handoff 0.5` 仍是固定模式）。
- 探针（`tests/handoff-test.mjs`）：1M 窗口 + 小 baseline → 阈值恰好 400k（40%）、label 为 `auto 400k (40%)`；
  baseline 很重（usage 512k/1M）→ 阈值 > 400k（自适应仍然自适应）；aux 窗口 200k → 阈值被压到 180k–400k 之间；
  40k 窗口放不下 `baseline + keep + 最小摘要` → 无阈值（不发车）。
  触发级探针用「会话占满大头」的 mock（阈值数学里 baseline = usage − 估算会话量，会话太小会让 baseline 虚高、阈值永不可达）：
  300k/1M 不触发、450k/1M 触发。
- 变异：去掉下限 → 4 条红；去掉摘要窗口封顶 → 1 条红。

## 4. 测试与变异矩阵

| 项 | 结果 |
|---|---|
| `node tests/run-all.mjs` | **9/9 通过**；handoff 148 断言、consolidation 240 断言、sync 29 断言 |
| M1 自适应下限 | 4 红（窗口占比 / label / 摘要封顶 / 不早发车） |
| M2 摘要窗口封顶 | 2 红（含「aux 窗口小于输出预留仍要封顶」） |
| M3 整行截断 + marker | 9 红 |
| M4 marker 形状校验放宽 | 1 红（相似内容行被搬走） |
| M5 `recovered` 标记 | 2 红 |
| M6 省略 context 的 trace | 2 红 |
| M7 写入未传 cap（配置→限制透传） | 1 红 |
| M8 命令回复的 cap 文案 | 1 红 |
| M9 迁移 caller / writer 丢失 limit 透传 | 各 1 条 migration cap 探针变红 |

矩阵逐项「改一处 → 只有目标探针变红」，无旁带；每项跑完即还原，工作树与测试前一致。

## 5. 影响、语义变更与待办

- **语义变更**：`maxMemoryChars` 默认 24000 → **32000**；自适应阈值不再由绝对目标单独决定（窗口占比是下限）。
  两者都写进了 `README.md` 的配置说明。
- **仍未恢复的内容**：本仓记忆被静默截掉的那 3 条 bullet（`Sandbox-review hygiene` / `Long reviewer runs` / `Headless end-to-end validation`）
  仍保存在 `0586d47` 与 `MEMORY.md.memory-backup-2026-09-17T14-40-57-285Z-4aaa556c` 中。**没有现在手改**：
  本次会话的进程跑的是已安装的 v0.1.7（旧 cap 24000），任何手改都会在下次 consolidation 再被裸切一次。
  等新版本安装、新进程起来后把这几条补回 `MEMORY.md`（external-edit 路径）即可。
- 新增配置键 `maxMemoryChars` 是 pi 侧独有（dsh 无此键），README 已注明范围与默认值。
- 未做：`context` 段缺失时写 fallback（保留旧 CONTEXT.md 是既定语义，这次只把它变可见）。

## 6. 发布

已按 owner 授权发布 `v0.1.8`：

- 修复 commit：`27f7043`，annotated tag `v0.1.8`。
- `master` 与 tag 已双推 Forgejo 和 GitHub mirror。
- `~/.pi` 的 package pin 已更新为 `@v0.1.8`，`pi-config` commit `bfd794a` 已推送。
- `pi update --extensions` 后安装副本 `/home/user/.pi/agent/git/git.lentech.site/C02-1010751281/pi-project-context` 为 `27f7043`，工作树干净，包含 bounded retry 修复。
- settings-installed RPC probe：`/tmp/pi-project-context-settings-v0.1.8-mdloNV`；未使用 `-ne/-e`，发现 `memory-learn`/`auto-handoff` 命令，真实 consolidation 写出 `MEMORY.md`、`CONTEXT.md`、`memory.jsonl` 和 backup，无 `errors.log`。
- 发版后新增的安装证据只在本节追加记录，不重写已发布 tag。

## 7. 预算公式再推导（owner 要求）

自适应阈值写成一个「预算恒等式」，各量单位统一为 token、作用域统一为**触发时刻**的实测值：

```
usable   = window − WINDOW_RESERVE_TOKENS(16384)
baseline = usage.tokens − estimateTokens(当前分支)          # system + tools + 注入的 memory/context
keep     = handoffKeepTokens(20000)
floor    = baseline + keep + MIN_SUMMARIZE_TOKENS(8000)      # 低于它交棒没有意义
room     = usable − baseline − keep
target   = max(8000, min(handoffTargetTokens(64000), floor(room/2)))
share    = round(handoffThresholdRatio(0.4) × window)
T0       = max(baseline + keep + target, share)              # 下限：share 一般胜出
T1       = min(T0, baseline + keep + max(8000, 摘要模型窗口 − 32768))   # 摘要入参预算
T2       = min(T1, 首个计价档位 − 4000)                        # 只在该档位 > floor + 4000 时
T3       = min(T2, usable − 4000)                            # 窗口余量
tokens   = T3 ≥ floor ? T3 : undefined
```

推导结论（示例值；1M 行按 `baseline=20k, keep=20k`，小窗口行单独注明 baseline，实际值随当前注入内容变化）：

| 场景 | T0（下限/target） | 生效上界 | 阈值 |
|---|---|---|---|
| 会话 1M，aux 1M（baseline 20k） | 400k（share） | 无 | **400k (40%)** |
| 会话 1M，aux 200k（baseline 20–30k） | 400k（share） | 摘要窗口 → 207.2–217.2k | 约 20.7–21.7% |
| 会话 1M，aux 64k（baseline 20–30k） | 400k（share） | 摘要窗口 → 71.2–81.2k | 约 7.1–8.1% |
| 会话 128k，aux 128k（baseline 20k） | 51.2k（share） | 无 | **51.2k (40%)** |
| 会话 64k，aux 64k（baseline 5k） | 36.3k（target） | 无 | **36.3k (56.7%)** |
| 会话 32k（baseline 20k、keep 20k） | — | `usable ≤ floor` 早退 | undefined（不交棒） |

- **「40% 是下限」只可能在三种上界下被压制**：aux 摘要窗口太小、模型有计价档位、窗口余量不足；压制时用户**看得出原因**（新增 `Threshold.bound` + status 后缀），
  不会再出现「状态写 floor 40%、阈值只有 6%」的自相矛盾。
- **默认 0.4 下 `handoffTargetTokens` 近乎失效**：只有当 `baseline > share − keep − target`（1M 上 ≈ 316k）时它才抬高阈值；小窗口（64k）时才由 `min(target, room/2)` 起作用。真正的旋钮是 `handoffThresholdRatio`。
- `bound` 的语义等价性：`cap()` 只在**严格更小**时改写 token 与名字，与原 `Math.min` 链一致（相等不记名，不影响数值），`tokens < floor` / `usable ≤ floor` 早退路径不变；3 项变异（去掉 share 下限、去掉摘要上界、`bound` 不记录）分别红 5/3/1 条探针。

## 8. 交接后模型设置是否回到 default（owner 提问）

历史排查阶段的结论是「没有现场反例，但尚未证明恢复路径命中过」；最终真实 headless RPC 已在 §10 直接证明恢复路径命中。恢复路径已有直接单测覆盖；本轮又把唯一静默的「staging 时 ctx.model 缺失」改为写入 errors.log。

- 现场证据：全 `~/.pi/agent/sessions/` 共 159 个「有 parentSession 的会话」，逐个比较父会话最后一个 `model_change` 与子会话自己的启动 `model_change`：**0 处不一致**；全库**没有任何会话**在启动时出现第二次 `model_change`（即恢复路径从未真正改写过模型）。
  唯一一处「父非默认模型」（UniField 09-16 `openai-codex/gpt-5.6-luna`）发生在 **v0.1.6 引入该功能之前**，且其子会话首条消息不是交接提示词，本就不是交棒。
- 早期本会话（01a0b729）是交棒继任者（父 01a0b4de），`handoff-session-settings.json` 已被消费删除 → 说明 `restoreHandoffSessionSettings` 走完了「匹配 → 清理」路径；模型无需改动（两边都是 `deepseek/deepseek-flash`）。这是历史现场，最终模型切换/恢复证据见 §10 的 Command Code free-model RPC。
- 静默不恢复的分支（逐条，用户可见后果）：
  | 分支 | 触发条件 | 后果 |
  |---|---|---|
  | `reason !== "new"` 或 `previousSessionFile` 缺失 | 非交棒的会话启动（`/new`、`resume`、`fork`） | 静默；本就不该恢复 |
  | staged 文件缺失/不可解析 | 交棒时 `getProjectRoot`/写盘失败 | 静默；退化为 default（staging 失败时 errors.log 有记录） |
  | `event.previousSessionFile !== staged.previousSessionFile` | 前任文件与暂存的不符 | 静默清理；退化为 default |
  | TTL 10 分钟过期 | 暂存后 >10 分钟才起新会话 | 静默清理；退化为 default（实测交棒是毫秒级，够不到） |
  | `ctx.model` 为空 | staging 时拿不到当前模型 | `model` 字段缺省 → 只恢复 thinking，模型沿用 default；现会写 errors.log |
  | `modelRegistry.find` 找不到 | provider 未注册（自定义 provider） | **有告警**（notify） |
  | `pi.setModel` 抛错 / 返回 false | 无 key、路由不可用 | **有告警**（notify + errors.log；false 只 notify） |
- `ctx.model` 为空仍无法凭空知道应恢复哪个 provider/model；现不改变行为（只恢复 thinking），但 staging 后立即写入 errors.log，明确说明 successor 会沿用 pi default。ExtensionAPI 没有等价的 `pi.getModel()` 兜底，故不伪造模型 ID。

## 9. lane A 第 1 轮复审与处置

- 结论：**无 blocking**；important ×3、minor ×6（详见 `memory-cap-and-adaptive-threshold-review.md` 与转录）。
- 已修：I1（摘要窗口 ≤ 输出预留时封顶被跳过）、I2（`setMemoryCharLimit` 进程级状态 → 显式参数透传）、
  I3（`truncated`/「被截断」措辞失真 → `recovered`/「object never closed」）、M1（README「硬上限」措辞）、M2（marker 相似行误判）。
- 明确接受（owner 可推翻）：
  - **M4** `floor < usable ≤ floor + TIER_EDGE_MARGIN`（~4000 token 窄带）返回 `undefined`：方向正确（要留计价档位余量），
    且早检 `usable <= floor` 已覆盖绝大多数情况；为它加一条分支只会让数学更难读。
  - **M5** `maybeTrigger` 每轮 settle 调 `resolveAuxModel`：其通知副作用被 `warnedRoutes` 每进程去重，噪音极低；
    拆出「无副作用解析」属于重构，不在本次范围。
  - **M6** 摘要输入余量按整份 `SUMMARY_OUTPUT_RESERVE_TOKENS`(32768) 预留，而实际输出上限是 `0.8×reserve`，
    多扣 ~6.5k 输入余量：偏保守、不丢数据，保留。
- 未做（复审范围提示）：fixed 模式（`handoffAdaptive=false`）不使用摘要窗口封顶 —— 那是用户显式选的窗口占比，保持原语义，仅在此记录。
- 第 2 轮已按「无 blocking 后仍有阈值边界/限制透传逻辑改动」的约定完成，结果见 §10。

## 10. lane A 第 2 轮复审与处置

- 独立复审在 `/tmp/mca-review2` 运行，转录 `memory-cap-and-adaptive-threshold-review-round2-independent.txt`，`EXIT=0`、9491 bytes；复审服务已退出。
- 结论：**无 blocking**；9/9 测试通过。Important：发现 legacy OMP 迁移没有透传 `maxMemoryChars`，已修为 `migrateProjectState(projectRoot, limit)`，由 `consolidate.ts` 的 session_start 读取 config 后传入 `decodePoisonedMemory` 与 `recordMemoryDocument`；新增真实 session_start migration cap 探针。
- Minor 处置：修正 `statusText` 换行、更新 runHandoff 的 aux-window 注释、把无区分度的「clamped」探针改为默认 cap 断言；新增 pricing-tier bound 与 usable-window status suffix 探针。poisoned + capped 同时发生时，通知/命令回复现在同时保留两种诊断。
- 接受：会话模型与摘要模型 tokenizer 不同导致的 prefix budget 是保守近似；不引入第二套 tokenizer/分块摘要。`event.reason !== "new"` 等非 successor 静默 return 属既有保护路径，保持不动。
- 复审快照之后额外落地的硬化：若 handoff staging 时 `ctx.model` 缺失，写 errors.log，避免「只恢复 thinking、模型静默回 default」无人知晓；不改变可恢复信息不足时的行为。
- 复审副本零写入：其 `git status --porcelain` 与开始快照一致；正式树的后续修改均已在本地测试后复核。
- 真实 headless RPC 最初用付费路由时受额度阻断（`deepseek` 402、`scnet` 429、`commandcode` insufficient credits）；随后改用已认证的 Command Code free 模型完成验证，未把前一次失败误报为通过。sandbox：`/tmp/pi-project-context-real-rpc-pgqde64t`。
  初始模型为 `commandcode/poolside/laguna-s-2.1-free`，RPC `set_model` 切到 `commandcode/inclusionai/ling-3.0-flash-sante:free`，再发送 `/auto-handoff now`；successor session 为 `01a0b7ac-f60e-7454-a958-044a89a89712`，最终 `get_state` 与 session JSONL 均确认恢复到 `inclusionai/ling-3.0-flash-sante:free`。
  `HANDOFF.md` 已生成且英文 scaffold 正确；`memory.jsonl` 有两条 `replace` 记录，`MEMORY.md.memory-backup-*` 已生成，`CONTEXT.md` 已更新；`errors.log` 不存在（无错误写入）。
