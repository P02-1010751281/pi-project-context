# 真机跑：handoff 前后的前缀缓存（2026-10-18）

本轮用 `pi --mode rpc -ne -ns -np -nt --thinking off --provider deepseek --model deepseek-v4-pro -e extensions/project-context/index.ts`
在 `/tmp/pc-cache-exp2-*` 沙箱里驱动 6 轮对话，然后 `/handoff now`，再在新会话里发 2 轮。
`handoffBudgetRecentTokens=1000`（除非注明 keep 0）；`autoConsolidate` / `autoLearn` 关闭。
只记录 `message.usage` 的 `input` / `cacheRead`，不把数字写进 MEMORY 或 docs。

## 同一会话：前缀命中随轮次增长

| 轮次 | input | cacheRead |
| --- | ---: | ---: |
| 1 | 417 | 384 |
| 2 | 365 | 768 |
| 3 | 441 | 1024 |
| 4 | 389 | 1408 |
| 5 | 337 | 1792 |
| 6 | 413 | 2048 |

## handoff 后：system 前缀保住，conversation 前缀丢掉

后继会话 JSONL 里前几条是 predecessor 的 replay（带旧 usage），必须跳过；实际新会话的 assistant 调用是：

| 后继实际调用 | input | cacheRead |
| --- | ---: | ---: |
| 第 1 次 | 1060 | **384** |
| 第 2 次 | 48 | 1408 |
| 第 3 次 | 60 | 1408 |

predecessor 最后一次 `cacheRead=2048`，后继第一次 `cacheRead=384`：

- system block（本探针 384）命中；
- 被丢掉的 conversation 前缀按定义不能命中，因此首轮掉 1664；
- 后继第二轮 1408 是新会话自己的 prefix（system + handoff prompt + replay）被缓存，不是 predecessor 的 2048 恢复。

## 对照：keep=0（不 replay）

| 后继实际调用 | input | cacheRead |
| --- | ---: | ---: |
| 第 1 次 | 364 | **384** |
| 第 2 次 | 131 | 640 |
| 第 3 次 | 15 | 768 |

第一轮同样是 384；说明 system block 的命中不依赖 replay。replay 让后继自己的 prefix 更長（第二轮 1408），但没有把 predecessor 的 conversation 前缀带回来。

## 对照：`/new` 新会话

`/new` 后首轮 `input=97, cacheRead=384`，与 handoff 后继第一轮相同。跨会话的 system block 可以命中；handoff 特有的损失来自 conversation 起点变化。

## 对照：手动 compaction（独立 20 轮沙箱）

`handoffEnabled:false`，用 RPC `{type:"compact"}`（不是 `/compact` 文本，后者在 prompt 模式会被模型当成用户消息）压缩 20 轮、predecessor 最后一次 `input=1730, cacheRead=30976`；压缩后同一 session 再发两轮：

| 压缩后实际调用 | input | cacheRead |
| --- | ---: | ---: |
| 第 1 次 | 13415 | **384** |
| 第 2 次 | 115 | 13696 |

手动 compaction 同样只命中 system block，旧 conversation 前缀（30976）一次丢掉；后继首轮 total 13801，第二轮 13813。它保留摘要和尾部，但摘要插入后前缀同样从新位置起算，所以 compaction 不比 handoff 更缓存友好；这次对照中 handoff 的首轮 total 只有 1446。

## 噪声与边界

- 有一轮 handoff 后继首轮出现 `cacheRead=0`；重复同一配置后得到 384。本轮不把 0 当作 replay 顺序 bug，按冷/噪声处理；不据此写机制结论。
- 探针是 deepseek 直连、无工具、无 skills 的系统块（384）；生产 system block 更大，绝对掉量会随 block 大小变化，但机制相同：能命中的是静态块，不能命中被丢掉的 conversation。
- 只在单一 provider/route 上跑；中继是否透传 cache_control 仍未验证。

## 结论

handoff 不能高效复用被丢掉的对话前缀；它只能保住静态 system 前缀。实测一次 successor 首轮从 2048 掉到 384，之后按新会话自己的 prefix 重建；20 轮后的手动 compaction 也从 30976 掉到 384，说明换会话不是损失的唯一来源。要减少损失，目标应是保持 system 块逐字节稳定、不要在 handoff 同刻改 memory render，并接受一次 conversation miss；不是恢复旧对话前缀，也不是换成 compaction。
