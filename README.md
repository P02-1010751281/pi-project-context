# pi-project-context

[pi coding agent](https://github.com/earendil-works/pi) 扩展：项目记忆与会话上下文——会话存档、`MEMORY.md`/`CONTEXT.md` consolidation、跨会话技能学习、上下文窗口交接。

## 安装

两种方式**二选一**：同时装会加载两份实例（见末尾）。

**A. pi 包**（新机器）：

```bash
pi install git:github.com/P02-1010751281/pi-project-context
```

> 本包没有 `package.json`：pi 按约定目录 `extensions/` 发现入口，git 安装不需要 npm（无运行时依赖，pi 核心由宿主提供）。不要加回 `package.json`——含 manifest 的 git 包在安装/checkout 对齐时会执行 `npm install`，未装 npm 的机器会让 `pi` 启动失败。

**B. 本机镜像部署**（本仓库是唯一来源，`~/.pi/agent/extensions` 只是副本，外置盘未挂载也不丢扩展）：

```bash
./install.sh        # 目标目录可用 PI_EXTENSIONS_DIR=... 覆盖
```

同步 `extensions/` 下的扩展目录，并移除 5 个被取代的旧拆分扩展（`session-context`、`memory`、`autolearn`、`auto-handoff`、`_shared`），其余文件不碰；装完在 pi 里 `/reload`（或重启 pi）。

**不要同时用 A 和 B**：两份实例各自注册同名命令，pi 会把**所有**副本都改名（`auto-handoff:1`/`:2`），原名失效——斜杠命令变成普通聊天发给模型，hook 也双跑。`install.sh` 发现全局或项目设置里仍有本仓库的 pi package 时会警告；此时 `pi remove <该 package>` 再 `/reload`。

## 架构与数据流

```
会话（事件流）
   │ ① 存档：无模型调用，逐轮增量 append
   ▼
session.jsonl（唯一权威）──► session.md（全量渲染，人读）──► INDEX.md（每会话一行）
   │
   ├─ ② 整理（1 次调用，节流）  raw 对话 + MEMORY/CONTEXT ─► CONTEXT.md + MEMORY.md ─► 每轮注入
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
    ├── MEMORY.md                   # ② 长期记忆（每轮注入）
    ├── CONTEXT.md                  # ② 工作态：摘要 / 关键点 / open tasks（每轮注入）
    ├── HANDOFF.md                  # ④ 最近一次交接摘要（含旧存档指针）
    ├── project-context.json        # 功能开关与参数（dsh 侧在 ~/.dsh/settings.yaml）
    ├── skill-candidates/<name>.md  # ③ 待确认候选（approve 后转正）
    ├── errors.log                  # 各阶段捕获的异常（不打断会话）；单条截断 8000 字符，>1MB 轮换保留最新 64k
    └── session-logs/
        ├── INDEX.md                # ① 机械索引：每会话一行，按 id 去重、只留最新 200 行
        ├── .gitignore              # 首次写出时生成，忽略整个目录
        └── <session-id>/{session.jsonl,session.md}
```

边界规则：**memory = 长期**（跨会话仍成立的事实/决策/偏好，写入门槛高）；**context = 工作态**（本会话摘要/关键点/open tasks，整体重写，可重建）。不确定先写 context，下轮仍成立再晋升 memory。

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
- 辅助调用（整理 / 沉淀 / 交接摘要）默认用会话模型；`provider`/`model` 成对设置后改走指定路由（解析不到或未授权时退回会话模型，各警告一次），`maxTokens`（默认 8192，下限 256）是整理/沉淀调用的输出上限。用 `/project-context model <provider>/<id>|off`、`/project-context max-tokens <n>|default` 修改，`status` 显示当前路由与上限。
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
