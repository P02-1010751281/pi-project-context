# 直接测量：隔离探针下的真 baseline B_true

（2026-10-13，闭合 brief 的「残余 ②」）

## 问题

回归拟合出的 `B_true = 30–39k` 有两处不够独立：字符轴取自会话文件；注入块、工具、技能、system
全算在一个数里。需要一个**由 provider 直接报出**、配置可控的对照值。

## 方法

两个沙箱（`mktemp -d /tmp/pi-baseline-probe-*`），cwd = 沙箱，`.agents/skills/` 与活树一致（`cp -a`），
`git init` 使其被认作项目根（`shared/paths.ts` 用 `git rev-parse --show-toplevel` 认定项目）：

| 沙箱 | `.agents/memory/` 内容 | 目的 |
| --- | --- | --- |
| probe | 活树的 `MEMORY.md`(31,765B) + `CONTEXT.md`(7,539B) + `HANDOFF.md` + `project-context.json` | 真值含注入块 |
| ctl | 只有 `project-context.json` | 真值不含注入块（两者之差即注入块） |

命令（`-ne -np`：只加载被测扩展、保留技能；core 路由 deepseek，避开「`-ne` 会注销 provider」的坑）：

```
pi -p -ne -np -e <repo>/extensions/project-context/index.ts \
   --provider deepseek --model deepseek/deepseek-flash "Reply with exactly OK."
```

记录：`01a1331c-c79e-719e-8607-eaeac5454f95`（probe）、`01a1331d-6d3f-7040-b995-94afee91fb13`（ctl），
两次都 exit=0、回答 `OK`。副作用只落在沙箱（扩展新建 `session-logs/`、重写 memory 副本、写 `.gitignore`），
以及 pi 自己的会话存储（agent dir 的 `sessions/` 下就是上面两条记录）；活树的 `.agents/memory/` 未被触碰
（`MEMORY.md`/`memory.jsonl` mtime 仍是 10:00:12，探针跑在 10:34–10:35）。

## 结果

| 量 | probe | ctl |
| --- | --- | --- |
| 首条请求 prompt tokens | **17,766** | **11,021** |
| 其中 cacheRead | 0 | 9,856 |
| 该请求前分支消息 chars / est(chars/4) | 54 / 13 | 54 / 13 |
| B_ext（= prompt − est） | 17,753 | 11,008 |

- **注入块 = 17,766 − 11,021 = 6,745 tokens**（≈39.3k 字符 ⇒ 5.8 字符/token，比 `chars/4` 省 token）
  ⇒ 扩展对注入块的估计（chars/4 ≈ 9,826）**高估约 3.1k**，这一项让 B_ext 偏低，不制造高估。
- **消息 chars≈0 时 B_ext = B_true（17,753 对 17,753）** ⇒ 估计误差在零点为零、随 chars 增长
  ⇒ 主机制（误差 ∝ 消息字符数）得到独立确认；owner 那条 +115k 的偏移不可能是常数量。
- 活树会话回归截距 30–39k 与本次 17.8k 的差（12–21k）= 本机**其他扩展**的贡献
  （browser/CDP 与 computer-use 工具组等，`-ne` 全被关掉）；这部分是 pi prompt 的真实组成，B 本就该含它。
- ctl 首条请求 `cacheRead=9,856` ⇒ **deepseek 直连按前缀缓存且跨会话命中**：注入块在 system prompt
  尾部，去掉它前面的前缀仍然命中 ⇒ 尾部注入不破坏前缀缓存（对 cache 问题的实测支持）。

## 残余状态

- 「残余 ②（隔离式 provider 探针直接量 B_true）」：**闭合**，数值如上。
- 「残余 ①（精确复原 owner 那条 317k/151k 线）」：不作为事实闭合，转为设计需求 ——
  见 `baseline-attribution-experiment.md` 的「另一条候选机制」与「局限与未定」：状态行必须同时显示
  `B` / `pi.tokens` / `Σest` 三个量，否则任何读数都无法自证。
