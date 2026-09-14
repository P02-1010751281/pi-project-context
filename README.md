# pi-project-context

[pi coding agent](https://github.com/earendil-works/pi) 扩展：项目记忆与会话上下文——会话存档、`MEMORY.md`/`CONTEXT.md` consolidation、跨会话技能学习、上下文窗口阀门。

## 安装

作为 pi 包：

```bash
pi install git:github.com/P02-1010751281/pi-project-context@v0.1.1
```

> 本包没有 `package.json`：pi 按约定目录 `extensions/` 自动发现入口，git 安装因此不需要 npm（本扩展无运行时依赖，pi 核心包由宿主提供）。不要再加回 `package.json`——含 manifest 的 git 包在安装/对齐 checkout 时会执行 `npm install`，在未装 npm 的机器上会让 `pi` 启动失败。

本机自用部署：本仓库是唯一来源，`~/.pi/agent/extensions` 是部署副本（外置盘未挂载也不会让 pi 丢扩展）：

```bash
./install.sh        # 同步 extensions/，并清理由 project-context 取代的旧拆分扩展
```

然后在 pi 里 `/reload`（或重启 pi）。目标目录可用 `PI_EXTENSIONS_DIR=... ./install.sh` 覆盖。

`install.sh` 只管理本仓库 `extensions/` 下的目录，同步时会移除 5 个旧扩展目录（`session-context`、`memory`、`autolearn`、`auto-handoff`、`_shared`），其他文件一律不碰；若 `~/.pi/agent/settings.json`（或项目 `.pi/settings.json`）里同时装了本仓库的 pi package，会打印警告——两份实例会让所有同名命令被 pi 改名为 `auto-handoff:1`/`:2`（原名失效），hook 也会双跑；此时执行 `pi remove <该 package>` 后 `/reload`。

## 结构

```
extensions/
├── project-context/
│   ├── index.ts          # hooks、命令、flags、功能开关
│   ├── config.ts         # 项目级配置（开关 / autolearn 节流 / handoff 参数）
│   ├── archive.ts        # 会话存档（无 LLM）：jsonl / md / INDEX.md，注入 CONTEXT.md
│   ├── session-log.ts    # session.jsonl 与 session.md 渲染
│   ├── consolidate.ts    # consolidation pass（一次 LLM）→ MEMORY.md + CONTEXT.md
│   ├── autolearn.ts      # 低频（新材料 + 20 轮 / 30min）技能 pass
│   ├── handoff.ts        # 上下文窗口阀门
│   ├── session-index.ts  # 机械会话索引渲染（与 dsh 同模块划分）
│   ├── context-doc.ts    # CONTEXT.md 渲染
│   ├── llm.ts            # 模型 JSON 调用
│   └── project-state.ts  # 路径、原子写、旧数据迁移
```

## 数据流

```
session.jsonl（原始，唯一权威）
 ├─ archive      （无 LLM）每轮落盘 jsonl（进程内按游标增量 append，不重写整份）；
 │                        settle/shutdown 渲染 md 并维护 session-logs/INDEX.md；只读注入 CONTEXT.md
 ├─ memory       （1 次 LLM，6 轮 / 5min 节流）consolidation →
 │                        MEMORY.md（长期）+ CONTEXT.md（工作态），两者每轮注入
 ├─ autolearn    （1 次 LLM，新材料 + 20 轮 / 30min）读 MEMORY/CONTEXT + 会话索引判断；
 │                        缺证据时按索引回溯存档摘录；≥2 个已存档会话才直接写
 │                        .agents/skills/<name>/SKILL.md，低置信度写 candidate 等确认；
 │                        拒绝含提示注入话术的 body
 └─ handoff      （1 次 LLM）阈值阀门：旧段摘要 + 最近原文重放 + 指向旧 session id/索引 → 新会话，摘要存档为 HANDOFF.md
```

边界规则：**memory = 长期**（跨会话仍成立的事实/决策/偏好，写入门槛高）；**context = 工作态**（本会话摘要/关键点/open tasks，整体重写，可重建）。不确定先写 context，下轮仍成立再晋升 memory。

四项功能放在同一个扩展里是刻意的：pi 对每个扩展用 `moduleCache: false` 单独建模块注册表，跨扩展共享节流/单飞状态会各拿一份；合并后这些状态天然单实例，`agent_settled` 的执行顺序（存档 → consolidation → autolearn → handoff）也在一个 handler 链里确定。

## 开关

配置在 `<project>/.agents/memory/project-context.json`，字段名与 dsh 插件的 settings 键一致（只有存储方式和 pi 独有的 `handoffMode`/`handoffGuard` 不同）：

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
- autolearn 自动 pass 与 dsh 同门禁：`MEMORY.md`/`CONTEXT.md` 有新内容（mtime 晚于上次 pass）且（累计用户轮数 ≥ `autolearnTurns` 或距上次 pass ≥ `autolearnIntervalMs`）；`autolearnAt` 持久化，重启不会重复跑已消化的材料。
- consolidation 自动节奏与 dsh 同名：`consolidateTurns`（默认 6 轮）/`consolidateIntervalMs`（默认 5min）控制自动整理，`forceDedupeMs`（默认 15s）抑制紧邻的强制重复调用。
- `handoffAdaptive=true` 用自适应阈值；置 false 时用 `handoffThresholdRatio`（窗口占比 0.1–0.95）；`handoffMode`（send/draft）与 `handoffGuard`（wait/draft/send/skip）是 pi 独有（dsh 无编辑器，改用 `handoffPendingQuestion: defer|wait`）。
- dsh 还有 `maxTokens`/`provider`/`model` 三个辅助调用旋钮；pi 的辅助调用固定用会话模型（8192 输出上限），尚未对齐。
- 开关管**自动行为**（写盘 / LLM 调用 / 换会话；`memory` 开关同时管 MEMORY、CONTEXT 的注入）；显式命令不受开关限制。
- `--no-project-context` 本轮全关（不写盘、不注入、不跑 pass、不换会话），不改配置。
- 旧配置兼容（只读）：嵌套布局（`features.*`/`autolearn.*`/`handoff.*`）、`<project>/.agents/memory/autolearn.json` 的 `enabled`/`at` 与全局 `~/.pi/agent/auto-handoff.json` 均作为默认值读取；下次保存时同一文件重写为扁平布局。

## 命令与 flags

| 命令 | 作用 |
|---|---|
| `/project-context [status \| on\|off <feature\|all>]` | 查看 / 切换功能开关 |
| `/memory-learn`（别名 `/context-update`） | 立即跑 consolidation：重写 MEMORY.md + CONTEXT.md |
| `/memory` | 显示项目记忆位置与状态 |
| `/context` | 显示 context / 会话索引 / 日志路径 |
| `/session-log` | 立即写会话存档；`import <session.jsonl\|目录>…` 回填已结束的历史会话 |
| `/autolearn` | 立即跑技能学习；`list` / `approve <name>` / `reject <name>` / `on` / `off` |
| `/auto-handoff` | 阀门状态与参数：`auto`、`0.6`、`target 64k`、`keep 20k`、`thinking off`、`guard wait`、`send`/`draft`、`now` |

Flags：`--no-project-context`、`--handoff-ratio 0.4|auto|off`、`--no-auto-handoff`。

## 数据存放

插件不往 `~/.pi` 写项目数据，全部在项目内：

```
<project>/.agents/
├── skills/<name>/SKILL.md              # autolearn 产出的项目技能（pi 原生发现）
└── memory/
    ├── MEMORY.md                       # 长期记忆，注入 system prompt
    ├── CONTEXT.md                      # 工作态（摘要/关键点/open tasks），注入 system prompt
    ├── HANDOFF.md                      # 最近一次交接的摘要（含旧存档指针）
    ├── project-context.json            # 功能开关与参数
    ├── autolearn.json                  # （旧）节流/开关，只读兼容
    ├── skill-candidates/<name>.md      # 待确认候选技能
    ├── errors.log                      # 被吞掉的异常（诊断用；单条截断到 8000 字符，超 1MB 轮换保留最新）
    └── session-logs/
        ├── INDEX.md                    # 机械会话索引（无 LLM 维护，按 id 去重、只留最新 200 行，链接相对本目录）
        ├── .gitignore                  # 首次写出时自动生成，忽略整个目录
        └── <session-id>/{session.jsonl,session.md}
```

已结束的历史会话可用 `/session-log import <session.jsonl|目录>…` 回填进同一套布局（逐字节保留原文、同一渲染器、同一索引；已归档的默认跳过，无模型调用）。

旧数据在 `session_start` 时自动迁移：`<project>/.pi/{MEMORY.md,CONTEXT.md,session-logs,skills}`、`.agents/memory/skills`（中间版本布局）、`.agents/memory/session-index.md`（旧索引位置，链接自动改写）、OMP `~/.omp/agent/memories/<encoded-project>/`（只读导入）。迁移遇到**文件/目录类型冲突**（例如旧 `MEMORY.md` 是目录、新位置已是文件）时两侧都保留并在通知里点名，不做删除；迁移失败会在下个会话启动时重试。

## 测试

```bash
node tests/run-all.mjs
```

测试通过 pi 自带的 jiti loader 加载本仓库的扩展（与运行时同一套 alias，不触碰 `~/.pi`），全部跑在临时项目目录上：loader 完整性、注册项、会话投影、索引渲染、autolearn 取证与门禁（含注入体拒绝）、consolidation 端到端与会话级节流、功能开关、日志轮换/迁移冲突/原子写卫生。若 pi 不在全局 npm root，用 `PI_PKG=/path/to/@earendil-works/pi-coding-agent` 指定。
