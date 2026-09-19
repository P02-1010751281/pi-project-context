---
doc_type: feature-design-review
feature: 2026-09-15-codex-project-context-port
status: passed
review_state: passed
review_reason: 独立审查确认设计、checklist、数据流不变量和验收矩阵一致
reviewer_id: 01a0a366-b7f6-7883-8f79-e5850f437324
summary: Codex project-context 迁移设计通过独立审查，等待 owner 批准后实现
tags: [codex, desktop, plugin, design-review]
---

# Design Review

## 审查范围

- 设计：`codex-project-context-port-design.md`
- 执行清单：`codex-project-context-port-checklist.yaml`
- 基线：Pi v0.1.2 源码、README、现有 8 组测试和项目 `attention.md`

## 结论

`passed`。未发现 blocking、important 或 nit finding。YAML checklist 已通过 validator；Pi 基线 `node tests/run-all.mjs` 已通过 8/8。

## 已核对的不变量

- Codex 默认从 `hooks/hooks.json` 装载 hook，manifest 不依赖未被脚手架校验接受的 `hooks` 字段。
- Pi→Codex 生命周期映射、七类 hook 的响应/失败/幂等语义和 S1–S8 稳定步骤已写入设计与 checklist。
- `session.jsonl` envelope 使用 canonical JSON + SHA-256 `envelope_id`，包含 `source_identity`；base64 保留任意原始字节。
- 全文件/已消费前缀摘要、POSIX `flock`、`fsync`、不完整尾行恢复和 `O_EXCL` request 共同覆盖并发与崩溃恢复。
- Pi 迁移使用 canonical tree digest、source-leaf manifest、确定性 legacy 旁车名，并明确源目录保留。
- `project-context/2` 对 consolidation/autolearn 定义 required-only schema、字段/大小/slug/证据门槛和候选分支。
- Acceptance Coverage Matrix 覆盖归档、framing、并发/恢复、迁移、注入、Stop、维护、handoff 与 Desktop smoke。

## 实现阶段风险

Codex Desktop 当前版本的实际 hook matcher、stdin 事件字段、插件信任流程和 `$PLUGIN_ROOT` 注入仍需在 S1/S8 的真实 smoke test 中核对；这属于实现验证，不改变本设计审查结论。

## Owner amendment

实现阶段按用户确认调整为独立项目 `/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/codex-project-context/`，不增加 `Projects/plugins/`；迁移只保留普通文件内容 sha256，不计算目录树 digest。该调整不改变 Pi 的运行期文件组织和主数据流。
