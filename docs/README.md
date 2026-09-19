# 文档索引

`pi-project-context` 的文档按读者和用途拆分：

- [架构与数据模型](architecture.md)：数据流、`.agents/` 布局、memory/context 语义、失败恢复、源码模块。
- [配置与命令](configuration.md)：完整配置示例、字段说明、命令、flags、兼容迁移。
- [handoff 预算与恢复](handoff.md)：自适应阈值公式、LaTeX 推导、cap 诊断、replay、语言与模型恢复。

## 验证入口

```bash
node tests/run-all.mjs
git diff --check
```

涉及 handoff、memory 写入或 compaction prompt 时，还应使用仓库 skill 做真实验证：

```text
.agents/skills/pi-project-context-headless-rpc-handoff-validation/SKILL.md
```

该验证必须使用 throwaway sandbox，检查 `HANDOFF.md`、`MEMORY.md`、`memory.jsonl`、backup、`CONTEXT.md`、`errors.log` 和 session JSONL；provider 的 402/429/credits 错误只能记录为环境阻塞，不能算 handoff 通过。

## 发布前检查

1. `node tests/run-all.mjs`、`git diff --check`。
2. lane A 只读复审，确认复审 sandbox 的 `git status --porcelain` 零变化。
3. 有额度时完成真实 headless RPC，并保留 sandbox 证据。
4. owner 明确批准后再 commit、tag、push、安装新版本并校验安装副本。

问题级的详细证据、变异矩阵和复审转录保存在：

```text
.codestable/issues/2026-09-18-memory-cap-and-adaptive-threshold/
```
