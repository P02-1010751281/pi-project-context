# pi-project-context

[pi coding agent](https://github.com/earendil-works/pi) 扩展：项目记忆与会话上下文——会话存档、`MEMORY.md`/`CONTEXT.md` consolidation、跨会话技能学习，以及带摘要和 replay-safe 原文窗口的 handoff。

## 安装

```bash
pi install git:github.com/P02-1010751281/pi-project-context
```

本包没有 `package.json`：pi 按约定发现 `extensions/` 入口，git 安装不需要 npm，也没有运行时依赖。不要加回 `package.json`；含 manifest 的 git 包在安装/checkout 对齐时可能执行 `npm install`，未装 npm 的机器会让 pi 启动失败。

升级：仓库侧打新 tag，再执行 `pi install <source>@<new-ref>`。`pi update --extensions` 只对齐已经 pin 的 ref。

**不要再往 `~/.pi/agent/extensions` 部署副本。** pi 会同时加载两份实例，各自注册同名命令，导致命令改名为 `auto-handoff:1`/`:2`、斜杠命令失效、hooks 双跑。若残留旧的镜像目录（`project-context`、`session-context`、`memory`、`autolearn`、`auto-handoff`、`_shared`），删除后再 `/reload`。

## 功能概览

| 能力 | 主要产物 | 说明 |
|---|---|---|
| 存档 | `session.jsonl`、`session.md`、`INDEX.md` | 逐轮增量写入，可导入历史 session |
| 整理 | `memory.jsonl`、`MEMORY.md`、`CONTEXT.md` | journal-backed 长期 memory 与当前工作态 context |
| 沉淀 | `skills/<name>/SKILL.md` | 证据门禁后的项目技能，或 `skill-candidates/` |
| 交接 | 新 session、`HANDOFF.md` | 旧段摘要 + 最近原文 + replay-safe marker |

项目状态默认位于 `<project>/.agents/memory/`。完整数据布局、恢复规则和源码模块见[架构与数据模型](docs/architecture.md)。

## 文档

- [文档索引、验证与发布前检查](docs/README.md)
- [架构与数据模型](docs/architecture.md)
- [配置与命令](docs/configuration.md)
- [handoff 预算、LaTeX 推导与模型恢复](docs/handoff.md)
- [本次修复（自适应阈值语义）的问题报告、复审与数据报告](.codestable/issues/2026-09-19-handoff-adaptive-threshold-semantics/)
- [上一轮修复（memory 上限与自适应阈值）的问题报告、复审和 RPC 证据](.codestable/issues/2026-09-18-memory-cap-and-adaptive-threshold/)

## 最小配置

配置文件：`<project>/.agents/memory/project-context.json`。

```json
{
  "archiveEnabled": true,
  "autoConsolidate": true,
  "autoLearn": true,
  "handoffEnabled": true,
  "maxMemoryChars": 32000,
  "handoffAdaptive": true,
  "handoffThresholdRatio": 0.4,
  "handoffTargetTokens": 64000,
  "handoffKeepTokens": 20000
}
```

完整字段、命令和 flags 见[配置与命令](docs/configuration.md)。

## 验证

```bash
node tests/run-all.mjs
git diff --check
```

涉及 handoff、memory 写入或 compaction prompt 时，按 `.agents/skills/pi-project-context-headless-rpc-handoff-validation/SKILL.md` 使用 throwaway sandbox 做真实 RPC 验证；provider 的 402/429/credits 错误只能记录为环境阻塞，不能算 handoff 通过。

## 许可证

MIT © 2026 呼啸山庄 (P02-1010751281)，见 [LICENSE](./LICENSE)。
