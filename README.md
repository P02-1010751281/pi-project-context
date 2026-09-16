# pi-project-context

[pi coding agent](https://github.com/earendil-works/pi) 扩展：项目记忆与会话上下文——会话存档、`MEMORY.md`/`CONTEXT.md` consolidation、跨会话技能学习、上下文窗口交接。

## 安装

```bash
pi install git:github.com/P02-1010751281/pi-project-context
```

> 本包没有 `package.json`：pi 按约定目录 `extensions/` 发现入口，git 安装不需要 npm（无运行时依赖，pi 核心由宿主提供）。不要加回 `package.json`——含 manifest 的 git 包在安装/checkout 对齐时会执行 `npm install`，未装 npm 的机器会让 `pi` 启动失败。

升级：仓库侧打新 tag，再 `pi install <source>@<new-ref>`（`pi update --extensions` 只对齐已 pin 的 ref）。

**不要再往 `~/.pi/agent/extensions` 部署副本**：pi 会同时加载两份实例，各自注册同名命令，pi 把**所有**副本都改名（`auto-handoff:1`/`:2`），原名失效——斜杠命令变成普通聊天发给模型，hook 也双跑。旧版镜像部署已移除（`install.sh` 删除）；残留的 `~/.pi/agent/extensions/project-context` 与旧拆分目录（`session-context`、`memory`、`autolearn`、`auto-handoff`、`_shared`）删掉再 `/reload`。

## 架构与数据流

```
会话（事件流）
   │ ① 存档：无模型调用，逐轮增量 append
   ▼
session.jsonl（唯一权威）──► session.md（全量渲染，人读）──► INDEX.md（每会话一行）
   │
   ├─ ② 整理（1 次调用，节流）  raw 对话 + MEMORY/CONTEXT ─► CONTEXT.md + memory.jsonl ─► MEMORY.md（渲染）─► 每轮注入
   │
   ├─ ③ 沉淀（1 次调用，低频）  MEMORY/CONTEXT + 索引 ─► skills/<name>/SKILL.md
   │                            └ 证据不足（<2 个已存档会话）─► memory/skill-candidates/<name>.md
   │
   └─ ④ 交接（1 次调用）        当前会话 ─► 新会话（旧段摘要 + 最近原文 + 旧存档指针）+ HANDOFF.md
```

| 阶段 | 触发 | 产物 |
|---|---|---|
| ① 存档 | 每轮落 JSONL；settle / shutdown 渲染收尾 | `session.jsonl`、`session.md`、`INDEX.md` |
| ② 整理 | 新增用户轮 ≥ `consolidateTurns`(6) 且距上次 ≥ `consolidateIntervalMs`(5min) | `CONTEXT.md` + `MEMORY.md`（每轮注入） |
| ③ 沉淀 | 材料有更新 且（累计轮 ≥ `autolearnTurns`(20) 或距上次 ≥ `autolearnIntervalMs`(30min)） | `.agents/skills/<name>/SKILL.md`；证据不足写 `skill-candidates/` |
| ④ 交接 | 上下文占用越过阈值 | 新会话 + `HANDOFF.md` |

四项功能刻意放在同一个扩展里：pi 对每个扩展用 `moduleCache: false` 单独建模块注册表，跨扩展共享节流/单飞状态会各拿一份；合并后这些状态天然单实例，`agent_settled` 上 存档 → 整理 → 沉淀 → 交接 的顺序也在一个 handler 链里确定。

## 数据布局

```
<project>/.agents/
├── skills/<name>/SKILL.md          # ③ 沉淀的项目技能（description 常驻，body 按需加载）
└── memory/
    ├── MEMORY.md                   # ② 长期记忆渲染（人读 + 每轮注入，可由 memory.jsonl 重建）
    ├── memory.jsonl                # ② 长期记忆唯一权威：append-only 记录（replace / append）
    ├── CONTEXT.md                  # ② 工作态：摘要 / 关键点 / open tasks（每轮注入）
    ├── HANDOFF.md                  # ④ 最近一次交接摘要（含旧存档指针）
    ├── project-context.json        # 功能开关与参数（dsh 侧在 ~/.dsh/settings.yaml）
    ├── skill-candidates/<name>.md  # ③ 待确认候选（approve 后转正）
    ├── errors.log                  # 各阶段捕获的异常（凭据样串先脱敏）；单条截断 8000 字符，>1MB 轮换保留最新 64k
    ├── MEMORY.md.memory-backup-*   # 覆盖前写的字节级备份（mtime 保留最新 5 份，一小时内不轮换）
    ├── memory-log-*.jsonl          # 轮换前的 journal 归档（保留最新 5 份，一小时内不删）
    ├── .gitignore                  # 首次写出本地产物时生成：忽略 journal/归档/临时文件、备份、errors.log、锁文件
    └── session-logs/
        ├── INDEX.md                # ① 机械索引：每会话一行，按 id 去重、只留最新 200 行
        ├── .gitignore              # 首次写出时生成，忽略整个目录
        └── <session-id>/{session.jsonl,session.md}
```

边界规则：**memory = 长期**（跨会话仍成立的事实/决策/偏好，写入门槛高）；**context = 工作态**（本会话摘要/关键点/open tasks，整体重写，可重建）。不确定先写 context，下轮仍成立再晋升 memory。

### 失败与恢复

- **存量污染（旧版本 bug）**：旧实现可能把模型回复原样写进 `MEMORY.md`。读取端只**内存解码**（`memory_markdown` 为对象的首键或次键、前缀为 JSON/围栏/单行引导语、值确为文档），不写盘、不建备份、不记日志；下一次正常整理覆盖前先写字节级备份再改写。
- **记忆与存档同构**：`memory.jsonl` 是 append-only 唯一权威，`MEMORY.md` 是它的渲染（可重建、人读、注入与外部编辑入口）。读取以 journal 折叠为准；渲染内容（归一后）与折叠不同、且 mtime 晚于 journal 时视为外部编辑（手改/旧版本写入）并优先采信，下一次写入先把该字节收进 journal 再追本次结果（同一 mtime tick 内的外部编辑会被 journal 覆盖）。journal 损坏行跳过并计数到 `errors.log`；整份 journal 无可用记录时 fail closed，不悄悄回退旧渲染。
- **每次覆盖前备份**：`backupMemoryBeforeWrite` 读当前磁盘字节（字节保真）后写 `.memory-backup-<stamp>-<rand>`；目标存在但读不了（非 ENOENT）时 fail closed，pass 报 failed 并留 `errors.log`，绝不覆盖。
- **保留策略**：按 mtime 保留最新 5 份；一小时内新建的备份不轮换，通知里点名的备份在下一次整理后仍在。修剪只删除本扩展生成的完整名字，用户文件/目录/符号链接不受影响。journal 超过 512KB 时在锁内折成一条 `replace`，旧文件改名归档（保留最新 5 份，改名前失败则放弃轮换）。
- **写入串行**：`MEMORY.md.lock`（`wx` 独占）把“追加 journal → 轮换 → 原子改名渲染”串起来，跨进程也不会互相覆盖；超过 30 秒的陈旧锁由 `<lock>.steal` 声明单胜者后夺取，释放时按唯一 token 校验，`谁拿到的锁谁释放`。
- **输出预算自适应**：按每个 artifact 自身的 token 率分配（非 ASCII 记 1 token/字符，含 emoji/西里尔等；`"`/`\` 计 JSON 转义开销），两侧各有下限，被剪时写备份并告警。模型自身上限未知时，自适应上限受 `maxOutputTokens`（默认 32768）封顶。
- **本地产物不外泄**：`memory.jsonl`、归档、备份与 `errors.log` 由 `.agents/memory/.gitignore` 忽略；`errors.log` 落盘前脱敏 `sk-`/`ghp_`/JWT/Bearer 等凭据样串。

已结束的历史会话用 `/session-log import <session.jsonl|目录>…` 回填，与实时路径共用同一渲染器与索引（逐字节保留原文、幂等、无模型调用）。旧数据在 `session_start` 自动迁移：`<project>/.pi/{MEMORY.md,CONTEXT.md,session-logs,skills}`、`.agents/memory/skills`（中间版本布局）、旧索引 `.agents/memory/session-index.md`（链接自动改写）、OMP `~/.omp/agent/memories/<encoded-project>/`（只读导入）；遇到文件/目录类型冲突时两侧都保留并在通知里点名，失败留到下个会话重试。

## 源码结构

```
extensions/project-context/           # 单一扩展（12 个模块，无运行时依赖）
├── index.ts            # hooks、8 个命令、flags、功能开关
├── config.ts           # 项目级配置读写 + 旧布局兼容
├── archive.ts          # ① 存档：触发点、增量落盘、注入 CONTEXT.md
├── session-log.ts      # session.jsonl 追加与 session.md 渲染
├── session-index.ts    # INDEX.md：解析 / 去重 / 200 行上限 / 渲染
├── import-archive.ts   # /session-log import 回填
├── consolidate.ts      # ② 整理 pass（单飞 + 会话级节流 + 失败退避）
├── context-doc.ts      # CONTEXT.md 渲染
├── autolearn.ts        # ③ 沉淀 pass：证据门禁、技能校验
├── handoff.ts          # ④ 交接：阈值判断、摘要、新会话、guard
├── llm.ts              # 模型 JSON 调用与辅助路由解析
└── project-state.ts    # 路径、原子写、errors.log 轮换、旧数据迁移
```

## 配置

配置在 `<project>/.agents/memory/project-context.json`，字段名与 dsh 插件一致（只有存储方式和 pi 独有的 `handoffMode`/`handoffGuard` 不同）：

```json
{
  "archiveEnabled": true,
  "autoConsolidate": true,
  "autoLearn": true,
  "handoffEnabled": true,
  "autolearnAt": 0,
  "autolearnTurns": 20,
  "autolearnIntervalMs": 1800000,
  "consolidateTurns": 6,
  "consolidateIntervalMs": 300000,
  "forceDedupeMs": 15000,
  "maxTokens": 8192,
  "maxOutputTokens": 32768,
  "provider": "",
  "model": "",
  "handoffAdaptive": true,
  "handoffThresholdRatio": 0.4,
  "handoffTargetTokens": 64000,
  "handoffKeepTokens": 20000,
  "handoffSummaryThinking": "off",
  "handoffMode": "send",
  "handoffGuard": "wait"
}
```

- 每个功能独立开关，默认全开；命令动词仍是 pi 侧的 `archive|memory|autolearn|handoff`（`FEATURE_FIELDS` 映射到上表字段）：`/project-context on|off archive|memory|autolearn|handoff|all`。
- autolearn 自动 pass 门禁与 dsh 相同：`MEMORY.md`/`CONTEXT.md` 有新内容（mtime 晚于上次 pass）且（累计用户轮 ≥ `autolearnTurns` 或距上次 ≥ `autolearnIntervalMs`）；`autolearnAt` 持久化，重启不会重复跑已消化的材料。
- consolidation 节奏：`consolidateTurns` / `consolidateIntervalMs` 控制自动整理，`forceDedupeMs` 抑制紧邻的强制重复调用。
- handoff：`handoffAdaptive=true` 用自适应阈值，false 时用 `handoffThresholdRatio`（0.1–0.95）；`handoffTargetTokens`/`handoffKeepTokens` 控制移交量与保留量；`handoffMode`（send/draft）与 `handoffGuard`（wait/draft/send/skip）是 pi 独有——dsh 无编辑器，改用 `handoffPendingQuestion: defer|wait`。
- 辅助调用（整理 / 沉淀 / 交接摘要）默认用会话模型；`provider`/`model` 成对设置后改走指定路由（解析不到或未授权时退回会话模型，各警告一次），`maxTokens`（默认 8192，下限 256）是整理/沉淀调用的输出上限；输入超预算时 `maxTokens` 可按各 artifact 的 token 率自动抬高，但不超过模型自身上限与 `maxOutputTokens`（默认 32768）。用 `/project-context model <provider>/<id>|off`、`/project-context max-tokens <n>|default` 修改，`status` 显示当前路由与上限。
- 平台差异：dsh 的交接摘要同样吃 `maxTokens`；pi 的交接摘要复用宿主 `generateSummaryWithUsage`，上限是 reserve 语义（`min(0.8 × reserve, 模型自身上限)`，重试时 reserve 翻倍），不随 `maxTokens` 变化。
- 开关管**自动行为**（写盘 / LLM 调用 / 换会话；`memory` 开关同时管 MEMORY、CONTEXT 的注入）；显式命令不受开关限制；`--no-project-context` 本轮全关且不改配置。
- 旧配置只读兼容：嵌套布局（`features.*`/`autolearn.*`/`handoff.*`）、`memory/autolearn.json` 的 `enabled`/`at`、全局 `~/.pi/agent/auto-handoff.json`；下次保存时重写为扁平布局。

## 命令与 flags

| 命令 | 作用 |
|---|---|
| `/project-context [status \| on\|off <feature\|all> \| model <provider>/<id>\|off \| max-tokens <n>\|default>]` | 查看 / 切换功能开关，设置辅助调用路由与输出上限 |
| `/memory-learn`（别名 `/context-update`） | 立即跑 consolidation：重写 MEMORY.md + CONTEXT.md |
| `/memory` | 显示项目记忆位置与状态 |
| `/context` | 显示 context / 会话索引 / 日志路径 |
| `/session-log` | 立即写会话存档；`import <session.jsonl\|目录>…` 回填已结束的历史会话 |
| `/autolearn` | 立即跑技能学习；`list` / `approve <name>` / `reject <name>` / `on` / `off` |
| `/auto-handoff` | 阀门状态与参数：`auto`、`0.6`、`target 64k`、`keep 20k`、`thinking off`、`guard wait`、`send`/`draft`、`now` |

Flags：`--no-project-context`、`--handoff-ratio 0.4|auto|off`、`--no-auto-handoff`。

## 测试

```bash
node tests/run-all.mjs
```

用 pi 自带的 jiti loader 加载本仓库的扩展（与运行时同一套 alias，不触碰 `~/.pi`），全部跑在临时项目目录上：loader 完整性、注册项、会话投影、索引渲染、autolearn 取证与门禁（含注入体拒绝）、consolidation 端到端与会话级节流、辅助调用路由与上限、功能开关、日志轮换/迁移冲突/原子写卫生。若 pi 不在全局 npm root，用 `PI_PKG=/path/to/@earendil-works/pi-coding-agent` 指定。

## 许可证

MIT © 2026 呼啸山庄 (P02-1010751281)，见 [LICENSE](./LICENSE)。
