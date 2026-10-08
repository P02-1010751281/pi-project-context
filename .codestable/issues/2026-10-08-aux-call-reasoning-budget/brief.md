# issue：辅助调用在重推理路由上的输出预算（2026-10-08）

## 现场事实（全部可复算）

项目：`/run/media/.../Projects/Quantum_Matrix`（消费方仓库；其记忆与配置是**只读证据**，本 issue 只改本仓代码）。

| 事实 | 证据 |
| --- | --- |
| `/memory update` 静默约 13 分钟 | 进程 19:49:54 启动，20:03 才回到会话；13 分钟里 CPU 只涨 31 s，全程 `do_epoll_wait` + 一条 ESTABLISHED 到代理 `198.18.1.181:https` |
| 第一次尝试被输出上限截断 | `errors.log` `2026-10-08T11:56:31.944Z [memory] Error: consolidation reply was cut off by the model output limit (32210 tokens requested, 20489 spent on hidden reasoning); raise maxOutputTokens or trim MEMORY.md`（+ 原始回复 21210 字符被截断） |
| 隐藏思考远超预留 | 代码的 reasoning 预留 = `clamp(0.35×正文, 1024, 8192)` = **8192**，实测花掉 **20489** |
| 上限本身也贴边 | 该仓 `maxMemoryChars=32000`（磁盘当时 52057 字节，为上限调低前所写），`maxTokens=8192`、`maxOutputTokens=32768` ⇒ `memoryReplyTokens(32000)+8192 = 41216 > max(8192,32768)` ⇒ 静态门已判「装不下」 |
| 路由 | 会话模型 `deepseek/deepseek-flash`（`reasoning`）；`provider`/`model` 为空 ⇒ 辅助调用用它 |

结论：不是死锁，而是「一次或两次每次数分钟的辅助调用 + 全程无输出」；而且这条 route 上**必然**失败，因为重试只加固定 +4096，
预留上限 8192 对实际 20489 太小。现场那次 `trim MEMORY.md` 与 `raise maxOutputTokens` 是错误信息给出的两条人工杠杆。

## 三处修复（v0.4.8）

| 修复 | 位置 | 行为变化 | 钉它的断言与变异 |
| --- | --- | --- | --- |
| 重试带上实测隐藏思考 | `memory/pass.ts` 的截断重试 | 重试 headroom = `max(4096, 上一次 usage 的隐藏思考 token)` | `tests/consolidation-test.mjs` 的 cap-retry 夹具（第一次回复 `usage.reasoning = 20000`，config ceiling 抬到 131072）断言 `budgets[1]-budgets[0] ≥ 20000-4096`；变异（改回固定 4096）恰红 1 条 |
| 上限告警计入预留 | `shared/output-budget.ts` 的 `memoryCapUnsatisfiable` / `capCeilingWarning`；调用点 `index.ts`、`memory/report.ts` | 会话模型声明 `reasoning` 时，把最多 8192 的隐藏思考算进「是否装得下」，措辞里点名。（**v0.4.8 当时取的是会话模型；v0.4.9 改为「辅助调用路由」，见 `round15-fix-note.md`**） | `tests/memory-ops-test.mjs`：`(28000,8192,32768,true)=true` / `(…,false)=false` / 措辞含 `hidden reasoning`；两条变异各恰红 1 条 |
| 等待前先提示 | `memory/report.ts` 的 `/memory update` 动词 | 先回 `Memory: consolidating… (a reasoning route can take minutes)` 再跑 pass | `consolidation-test.mjs` 断言通知里含该句；删掉那句后恰红 1 条 |

全套件（15 项）与 `git diff --check` 在改动后全绿；四条变异各只让自己那条断言变红（副本里做，未触活树）。

## 非目标（登记，不做）

- 不给辅助调用加显式超时：pi 的 provider 层已有 `Request timed out.`，本轮加的是**可观察性**（等待提示）与**可成功性**（重试预算），不是新的超时机制。
- 不把「实测隐藏思考」持久化到跨 pass：首次尝试仍按 8192 估算；跨 pass 学习需要新的状态面，无现场事实支撑。
- 不动消费方仓库的记忆内容与配置（除 owner 明确要求的那次）。
