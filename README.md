# pi-project-context

[pi coding agent](https://github.com/earendil-works/pi) 扩展：项目记忆与会话上下文——会话存档、`MEMORY.md`/`CONTEXT.md` consolidation、跨会话技能学习、上下文窗口阀门。

## 安装

作为 pi 包：

```bash
pi install git:github.com/P02-1010751281/pi-project-context@v0.1.0
```

本机自用部署：本仓库是唯一来源，`~/.pi/agent/extensions` 是部署副本（外置盘未挂载也不会让 pi 丢扩展）：

```bash
./install.sh        # 同步 extensions/，并清理由 project-context 取代的旧拆分扩展
```

然后在 pi 里 `/reload`（或重启 pi）。目标目录可用 `PI_EXTENSIONS_DIR=... ./install.sh` 覆盖。

`install.sh` 只管理本仓库 `extensions/` 下的目录，同步时会移除 5 个旧扩展目录（`session-context`、`memory`、`autolearn`、`auto-handoff`、`_shared`），其他文件一律不碰。

## 结构

```
extensions/
├── project-context/
│   ├── index.ts          # hooks、命令、flags、功能开关
│   ├── config.ts         # 项目级配置（开关 / autolearn 节流 / handoff 参数）
│   ├── archive.ts        # 会话存档（无 LLM）：jsonl / md / session-index，注入 CONTEXT.md
│   ├── session-log.ts    # session.jsonl 与 session.md 渲染
│   ├── consolidate.ts    # consolidation pass（一次 LLM）→ MEMORY.md + CONTEXT.md
│   ├── autolearn.ts      # 低频（≥6h）技能 pass
│   ├── handoff.ts        # 上下文窗口阀门
│   ├── context-doc.ts    # 索引与 CONTEXT.md 渲染
│   ├── llm.ts            # 模型 JSON 调用
│   └── project-state.ts  # 路径、原子写、旧数据迁移
```

## 数据流

```
session.jsonl（原始，唯一权威）
 ├─ archive      （无 LLM）每轮落盘 jsonl；settle/shutdown 渲染 md 并维护 session-index.md；
 │                        只读注入 CONTEXT.md
 ├─ memory       （1 次 LLM，6 轮 / 5min 节流）consolidation →
 │                        MEMORY.md（长期）+ CONTEXT.md（工作态），两者每轮注入
 ├─ autolearn    （1 次 LLM，≥6h）读 MEMORY/CONTEXT + 会话索引判断；
 │                        缺证据时按索引回溯存档摘录；≥2 个已存档会话才直接写
 │                        .agents/skills/<name>/SKILL.md，低置信度写 candidate 等确认
 └─ handoff      （1 次 LLM）阈值阀门：旧段摘要 + 最近原文重放 + 指向旧 session id/索引 → 新会话
```

边界规则：**memory = 长期**（跨会话仍成立的事实/决策/偏好，写入门槛高）；**context = 工作态**（本会话摘要/关键点/open tasks/session 索引，整体重写，可重建）。不确定先写 context，下轮仍成立再晋升 memory。

四项功能放在同一个扩展里是刻意的：pi 对每个扩展用 `moduleCache: false` 单独建模块注册表，跨扩展共享节流/单飞状态会各拿一份；合并后这些状态天然单实例，`agent_settled` 的执行顺序（存档 → consolidation → autolearn → handoff）也在一个 handler 链里确定。

## 开关

配置在 `<project>/.agents/memory/project-context.json`，首次使用或旧配置存在时自动生成/兼容：

```json
{
  "features": { "archive": true, "memory": true, "autolearn": true, "handoff": true },
  "autolearn": { "at": 0 },
  "handoff": {
    "threshold": "auto",
    "autoTargetTokens": 64000,
    "keepRecentTokens": 20000,
    "summaryThinking": "off",
    "mode": "send",
    "guard": "wait"
  }
}
```

- 每个功能独立开关，默认全开；`/project-context on|off archive|memory|autolearn|handoff|all`。
- 开关管**自动行为**（写盘 / LLM 调用 / 换会话；`memory` 开关同时管 MEMORY、CONTEXT 的注入）；显式命令不受开关限制。
- `--no-project-context` 本轮全关（不写盘、不注入、不跑 pass、不换会话），不改配置。
- 旧配置兼容：`<project>/.agents/memory/autolearn.json` 的 `enabled`/`at` 与全局 `~/.pi/agent/auto-handoff.json` 仅作为默认值读取，之后统一写 `project-context.json`。

## 命令与 flags

| 命令 | 作用 |
|---|---|
| `/project-context [status \| on\|off <feature\|all>]` | 查看 / 切换功能开关 |
| `/memory-learn`（别名 `/context-update`） | 立即跑 consolidation：重写 MEMORY.md + CONTEXT.md |
| `/memory` | 显示项目记忆位置与状态 |
| `/context` / `/session-log` | 显示 context 位置 / 立即写会话存档 |
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
    ├── CONTEXT.md                      # 工作态 + session 索引，注入 system prompt
    ├── session-index.md                # 存档层索引（无 LLM 维护）
    ├── project-context.json            # 功能开关与参数
    ├── autolearn.json                  # （旧）节流/开关，只读兼容
    ├── skill-candidates/<name>.md      # 待确认候选技能
    ├── errors.log                      # 被吞掉的异常（诊断用，正常为空）
    └── session-logs/<session-id>/{session.jsonl,session.md}
```

旧数据在 `session_start` 时自动迁移：`<project>/.pi/{MEMORY.md,CONTEXT.md,session-logs,skills}`、`.agents/memory/skills`（中间版本布局）、OMP `~/.omp/agent/memories/<encoded-project>/`（只读导入）。

## 测试

```bash
node tests/run-all.mjs
```

测试通过 pi 自带的 jiti loader 加载本仓库的扩展（与运行时同一套 alias，不触碰 `~/.pi`），全部跑在临时项目目录上：loader 完整性、注册项、会话投影、索引渲染、autolearn 取证与门禁、consolidation 端到端、功能开关。若 pi 不在全局 npm root，用 `PI_PKG=/path/to/@earendil-works/pi-coding-agent` 指定。
