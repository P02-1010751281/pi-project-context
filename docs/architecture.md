# 架构与数据模型

## 数据流

```text
会话事件流
   │ ① 存档：逐轮增量 append，无模型调用
   ▼
session.jsonl ──► session.md ──► INDEX.md
   │
   ├─ ② 整理：raw 对话 + MEMORY/CONTEXT
   │       └─► CONTEXT.md + memory.jsonl ──► MEMORY.md ──► 每轮注入
   │
   ├─ ③ 沉淀：MEMORY/CONTEXT + 索引
   │       └─► skills/<name>/SKILL.md 或 skill-candidates/<name>.md
   │
   └─ ④ 交接：当前会话
           └─► 新会话（最近原文 + 文件清单 + 会话日志指针）+ HANDOFF.md
```

| 阶段 | 自动触发 | 主要产物 |
|---|---|---|
| 存档 | 每轮落 JSONL；settle/shutdown 收尾渲染 | `session.jsonl`、`session.md`、`INDEX.md` |
| 整理 | 用户轮数和时间节流达到条件 | `CONTEXT.md`、`memory.jsonl`、`MEMORY.md` |
| 沉淀 | 材料更新且达到轮数/时间门槛 | 项目 skill 或候选 skill |
| 交接 | 上下文达到阈值，或手动 `/handoff now` | successor session、`HANDOFF.md` |

交接的切点由 pi 的 `findCutPoint` 选定，它同时给出 `turnStartIndex` 与 `isSplitTurn`：本扩展据此在
**前缀不超一窗且老侧仍有内容可丢**时吸附到回合起点（整轮原文保留），否则把该回合的起始 user 消息**锚定进重放**、
其余丢给旧会话日志（裁切 + 既有文件索引），所以「最后问了什么」始终以原文到达 successor。交接不调用模型：
较早的部分以指针而不是摘要进入 successor，被切回合的悬空 tool 结果只留在旧会话日志里。

## 数据布局

```text
<project>/.agents/
├── skills/<name>/SKILL.md
└── memory/
    ├── MEMORY.md                   # journal 的人读渲染
    ├── memory.jsonl                # append-only 唯一权威（replace / append）
    ├── CONTEXT.md                  # 当前工作态
    ├── HANDOFF.md                  # 最近一次交接的头部与文件清单
    ├── project-context.json        # 项目配置
    ├── skill-candidates/<name>.md
    ├── errors.log                  # 脱敏后的阶段错误
    ├── MEMORY.md.memory-backup-*    # 覆盖前的字节级备份
    ├── memory-log-*.jsonl          # journal 轮换归档
    ├── .gitignore
    └── session-logs/
        ├── INDEX.md
        ├── .gitignore
        └── <session-id>/{session.jsonl,session.md}
```

本地产物默认由 `.agents/memory/.gitignore` 忽略；`errors.log` 会脱敏 credential-shaped 字符串。备份和 journal 归档各保留最新 5 份，并受一小时保护窗口约束。

## memory 与 context

- **memory** 是跨会话仍成立的事实、决策和偏好，写入门槛较高；`memory.jsonl` 是唯一权威，`MEMORY.md` 可重建。
- **context** 是当前项目的摘要、关键点和 open tasks，整体重写；不确定的内容先放 context，后续仍成立再晋升 memory。
- `MEMORY.md` 的外部编辑只有在内容不同且 render 比 journal 更新时才被采信，下一次写入会先进入 journal。
- 反向不成立：render 由扩展自身记忆状态 + 模型回复生成，不读文件的当前字节。
  输入是 prompt 时点的有效内容 ⇒ 并回若发生在 prompt 之后、或被模型省略，下一次 render 就不带它。
  超限时 cap 还会再裁一次（现场证据见审计补审三 §7，不在本文展开）。
- journal 损坏行会记录并跳过；整份 journal 没有可用记录时 fail closed，不静默回退旧 render。

## 技能沉淀与来源

- 沉淀每项目一次，从记忆/上下文/会话索引（必要时再取原始片段）产出一个技能：`candidate=false` 直接写
  `.agents/skills/<name>/SKILL.md`，`candidate=true` 先落 `.agents/memory/skill-candidates/<name>.md`，由 `/autolearn approve` 确认。
- `.agents/skills/` 里住着三类技能：手写的、旧布局导入的（`shared/migrate.ts`）、本管线写出的。只有第三类可被后续 pass
  **同名覆盖**，判定依据是文档正文里的来源标记 `<!-- autolearn-generated: … -->`（写在 body 而不是 frontmatter：
  pi 启动只注入 name/description/path，未知 frontmatter 键行为未定义）。
- 标记跟着文件生灭，所以范围是**结构保证**：技能删掉后名字若被手写技能占用，对方不带标记，就不会被当成可覆盖的目标。
- 覆盖前模型的正文要**点名取**：第一轮提示词不带任何技能正文，模型用 `inspectSkill`（最多 2 条）要哪几条，
  第二轮才把它们的正文整篇放进 `<learned-skill-bodies>`（放不下就整篇不放）。于是基础提示词不随技能总量增长，
  而「谁能被合并」不再由预算顺序决定。覆盖是**合并**而不是盲写：规则要求保留仍然成立的步骤，合并不了就什么都不提。
- 判定用**本轮实际展示过的名字集合**（gate 与写入路径各读一次），所以没被展示过的技能既不会被模型看到、也不会被覆盖；
  点名了却不该给（手写、global、超预算）会在第二轮明确回一句「没给正文，这些名字本轮不可复用」。
  新技能通知 `Learned project skill:`，覆盖通知 `Updated project skill:`；`/autolearn approve` 是人工确认，覆盖时明说是盲写。

## 记忆写入与恢复

- 写入顺序在 `MEMORY.md.lock` 内完成：追加 journal、必要时轮换、备份、原子替换 render。
- 跨进程锁有 stale-lock recovery，释放时校验唯一 token，避免误删别的进程的锁。
- `maxMemoryChars` 默认 32000，范围 4000–200000。正文超限时保留头尾、按整行丢弃中段并追加 marker；marker 自身不计入正文预算。
  cap 高到输出上限上界估算装不下时（`memoryReplyTokens` > `max(maxTokens, maxOutputTokens)`）
  在 `status` 和配置时点名。
- 限制由调用方显式传给 normalize、fold、comparison、load、write 和 legacy migration；没有进程级全局 cap，因此多项目不会串味。
- OMP/旧布局在 `session_start` 迁移时使用当前项目的 `maxMemoryChars`，不会退回默认值。
- 旧的 poisoned memory 只在内存中解码；下一次正常覆盖前才备份和修复，不在读取阶段产生副作用。

## 记忆层的写入触发点

只有两个时点会**生成新内容**（都要调辅助模型），其余时点即使写盘也只是搬运已有内容：

| 时点 | 行为 |
| --- | --- |
| `session_start` | 布局迁移与 legacy 记忆导入（经 `recordMemoryDocument` 写 journal 与 render），不调用模型 |
| `before_agent_start` | 注入系统提示，不落盘 |
| `agent_settled` | 自动 consolidation，受 `consolidateTurns`（默认 6 轮）与 `consolidateIntervalMs`（默认 5 分钟）**双重节流** |
| `session_shutdown` | **不调模型的 flush**：采纳外部手改进 journal，或按下面的条件用 fold 重发（写前备份），不生成新内容 |
| `/memory update` | 显式强制 consolidation（`forceDedupeMs` 15 秒内去重重复的强制 pass） |

flush 有三条守卫：journal 不存在时直接返回（裸项目退出后不留记忆状态、不取跨进程锁），文件与 fold 的比较键相同时不写，
要写回或采纳时，判定用的字节与 mtime 必须来自同一版本：自读都走 `readRenderWithMtime`，自带 render key 的调用方，其 mtime 判定取本调用的自读，
并在 append 前校验该 key 仍是文件当前字节（残留窗口只剩最后一次核对到 append 之间）。
最后一条由 `flushActionFor` 这张纯表表达：`recheck`（读取期间文件被替换 ⇒ journal 与文件都不动，留给下一次 pass）、
`none`（文件已是 fold）、`keep`（render 比 journal 新 ⇒ 只采纳进 journal、原字节不动）、`publish`（缺失、render 为空/不可比较，或 journal 不旧于它 ⇒ 写回 fold）。
节流是这笔模型成本的唯一上限：每次 consolidation ≈ 一次辅助模型调用 + 一份全文快照追加进 `memory.jsonl` + 一次 `MEMORY.md` 写入。
退出不生成内容（2026-10-06 决策 1），所以在两次 pass 之间结束的会话，其尾部只留在 `session-logs/` 归档里；缺口长度由节流决定，
不是固定上界（记忆被故障策略 park 时，可以是整段会话）。

## consolidation 的安全语义

consolidation 回复必须提供可用的 memory 对象；`context` 缺失时不会用空内容覆盖旧 `CONTEXT.md`：

- 完整 JSON 但没有 `context`：保留旧文件并写缺失诊断。
- JSON 在 `context` 前截断，但仍恢复出 `memory_markdown`：标记 `recovered` / `object never closed`，保留旧文件并写诊断。
- `context` 存在但形状错误：保留旧文件，记录 shape warning。
- provider 报错（`stopReason: error/aborted`）直接作为失败抛出并记录真实错误信息，不把空回复当 Markdown 记忆、也不做解析重试。
- 输出预算为 reasoning 模型预留隐藏思考：`reasoning: true` 时按正文 token 的 35% 预留（1024–8192），另加 1024 token 的 JSON scaffolding 余量。模型上限不足时按各 artifact 的 token 率裁剪正文，并保留正文地板。
- 回复被输出上限截断（`stopReason: length`）时，先按更大的输出预算重试一次（+4096 token）；若请求上限已被模型/配置封住，则上限不变、重试可能保持或减少正文预算（reserve 增大），由提示词要求压缩；第二次仍截断则 fail closed，错误信息点名输出上限而不是泛化解析失败。
- 其他不可解析回复先做一次有界重试并附加严格格式提醒；第二次仍失败则 fail closed，保留现有文件并把回复头写入 `errors.log`，不会把原始 JSON 当成 memory。

因此 `CONTEXT.md` 的更新时间只在某次 pass 真正返回 context 时移动；它可以作为有效的新鲜度信号。

## 旧数据迁移

支持 `<project>/.pi/` 旧布局、`.agents/memory/skills` 中间布局、旧 session index、OMP encoded-project memory，以及 `/session-log import` 的历史 session。
文件/目录类型冲突时两侧保留并通知；失败的迁移留待后续 session 重试。

## 源码模块

```text
extensions/project-context/
├── index.ts                # 入口：hooks、命令、flags、开关（pi 从这里加载）
├── archive/                # ① 存档（无 LLM）
│   ├── archive.ts          #    增量存档与 context 注入
│   ├── session-log.ts      #    session.jsonl / session.md
│   ├── session-index.ts    #    INDEX.md
│   └── import-archive.ts   #    历史 session 导入
├── memory/                 # ② 整理（1 次 LLM）
│   ├── pass.ts             #    整理 pass：节流 + 单飞 + 状态
│   ├── report.ts           #    截断提示、上次写入记录、hook 注册
│   ├── prompt.ts           #    提示词：固定规则 + 装配后的文档
│   ├── input.ts            #    记忆 + 上下文适配进输入预算
│   ├── parse.ts            #    回复解析（容错 JSON + 逐字段裁决）
│   ├── sections.ts         #    分节表示：抽取、渲染与段配额（配额是目标，硬上限只有文档上限）
│   ├── document.ts         #    MEMORY.md 规范化与截断标记
│   ├── schema.ts           #    固定小节 schema 与每节字符预算
│   ├── context-schema.ts   #    CONTEXT.md 固定小节 schema 与每节预算
│   ├── journal.ts          #    memory.jsonl 追加日志（折叠 / 轮转 / 归档）
│   ├── store.ts            #    读路径与一次写入事务
│   ├── backup.ts           #    写入前字节级备份与清理
│   ├── poison.ts           #    存储回复解码与归一化比较键
│   └── context-doc.ts      #    CONTEXT.md 渲染
├── autolearn/              # ③ 沉淀（1 次 LLM，≥6h）
│   ├── pass.ts             #    pass 与注册：节流蒸馏
│   ├── prompt.ts           #    清单 + 索引 + 取证，固定规则
│   ├── inventory.ts        #    技能清单、已学技能正文（仅带标记的项目技能）
│   ├── evidence.ts         #    会话索引、历史会话与取证文本预算
│   ├── candidate.ts        #    候选文件、准入规则、approve/reject
│   ├── parse.ts            #    回复 → 提案
│   ├── schema.ts           #    `record_skill` 工具 schema（always-object 决策形状）
│   └── skill.ts            #    技能形状、SKILL.md 渲染（含来源标记）、安全校验
├── handoff/                # ④ 交接（无 LLM）
│   ├── run.ts              #    交接事务、自动触发、命令注册
│   ├── threshold.ts        #    阈值：膝曲线与窗口末点两项、计价档位 cap、拒绝原因与护栏覆盖回执
│   ├── prompt.ts           #    续接提示与交接文档
│   ├── language.ts         #    语言判定与提示词识别
│   ├── text.ts             #    消息渲染与 replay 标记
│   ├── format.ts           #    数字 / 百分比 / token 格式化
│   ├── file-ops.ts         #    对话中出现过的文件操作
│   ├── question.ts         #    未答问题守卫
│   ├── settings.ts         #    持久开关的进程内镜像
│   ├── state.ts            #    in-flight 与两个冷却时钟
│   ├── handoff.ts          #    交接子包对外门面（再导出）
│   ├── session-settings.ts #    交接的设置暂存与恢复（模型 / 思考级别）
│   └── session-lineage.ts  #    新会话挂在哪个祖先（父链压平、会话头读取）
└── shared/                 # 四个能力共用
    ├── config.ts           #    配置与旧布局兼容
    ├── llm.ts              #    JSON LLM 调用与辅助路由；`callAux` / `pickToolCall` / `tools` 回退
    ├── call-policy.ts      #    辅助调用失败分类、冷却与会话停用
    ├── complete.ts         #    命令参数补全（verbs-as-args 的 Tab 菜单）
    ├── project-state.ts    #    项目状态**门面**（再导出原有公共 API）
    ├── paths.ts            #    项目根与路径助手
    ├── limits.ts           #    字符预算
    ├── files.ts            #    原子写、可选读、探测、移动/合并、临时清理
    ├── notify.ts           #    用户通知与错误文本
    ├── redact.ts           #    日志脱敏
    ├── lock.ts             #    跨进程写锁（journal / 索引 / 迁移共用）
    ├── gitignore.ts        #    `.agents/.gitignore` 托管块
    ├── error-log.ts        #    errors.log 轮转与脱敏写入
    ├── migrate.ts          #    旧布局一次性迁移
    ├── text.ts             #    文本计量、裁剪、回复头
    ├── output-budget.ts    #    辅助调用输出预算
    └── conversation.ts     #    会话渲染与用户轮次统计
```
