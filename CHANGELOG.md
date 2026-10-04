# Changelog

只记**行为变化**（`feat` / `fix`）。文档、审计与记忆渲染的提交不入此表 —— 它们在 git 历史与 `.codestable/` 里。
版本号语义近似 semver：`fix` 进 patch，`feat` 或破坏性变更进 minor。

## Unreleased

### 修复

- 测试：适配 pi 1.0.2 的 managed 安装树（读 `install/current-version`，依赖沿 `node_modules` 向上查找）。
  仅 `tests/`，运行时代码未变。

### 文档

- 锁归属更正扩散到主审计横幅与补审二模块表（19 个 `.lock` 属 Codex 移植，不是 `lock.ts` 的现场依据）。
- `docs/architecture.md`、`docs/configuration.md` 补两条语义：手工并回 `MEMORY.md` 不持久；cap 每次写入都生效。
- 全部文档按句读换行（无 >160 字符的行）；`docs/README.md` 索引不再钉死「当前 issue」。

## v0.2.1 — 2026-10-03

外部编辑采纳：重建回复期间落地的外部编辑不再被覆盖 —— 回复的 basisKey 与当前有效内容不一致时**拒绝发布**，
且拒绝时发布侧无任何副作用（无备份、无 cap/poison 日志、无成功通知），下一次 consolidation 从存活内容重建。
另：超出 cap 的回复在裁剪前先本地留档。

## v0.2.0 — 2026-10-03

分节渲染：consolidation 输出按固定四节（`Project` / `Invariants` / `Pitfalls` / `Index`）逐节预算渲染。
**破坏性改名**（无过渡期）：`/memory-learn` → `/memory update`、`/auto-handoff` → `/handoff`、`/context-update` 删除。

## v0.1.12 — 2026-10-01

`CONTEXT.md` 固定三节 schema（`Summary` / `Key points` / `Open tasks`）+ 逐节预算 + 截断标记；memory schema 与条目指针化。

## v0.1.11 — 2026-09-25

收口 R3 丢失面：autolearn 批准路径重新套用形状规则；handoff 手动 `target` 与触发线解耦；阈值拒绝点名原因而非归咎窗口。

## v0.1.10 — 2026-09-19

`/handoff auto` 阈值锚到保守拐点曲线。

## v0.1.9 — 2026-09-19

预留 reasoning 预算，尊重 finish reason。

## v0.1.8 — 2026-09-19

加强 memory 与 handoff 的恢复路径。

## v0.1.7 — 2026-09-17

关闭四条已登记残留并暴露陈旧 context；追加 `.gitignore` 行不再重复表头。

## v0.1.6 — 2026-09-17

handoff 携带会话设置跨越切换，目录树压平。

## v0.1.5 — 2026-09-16

handoff 切在回合中段，避免单个超长回合阻塞。

## v0.1.4 — 2026-09-16

handoff 跟随对话语言，replay 丢弃过期提示。

## v0.1.3 — 2026-09-16

内存改为「append-only journal + 渲染的 `MEMORY.md`」；写锁抗病理路径、备份有界；不可读的旧内存源会被报告。

## v0.1.2 — 2026-09-14

与 dsh 对齐：辅助调用走同一路由与配置字段；autolearn 共用新材料/轮次门；不可读的 JSON 回复不再写成 `MEMORY.md`。

## v0.1.1 — 2026-09-12

去掉 `package.json`，git 安装无需 npm。

## v0.1.0 — 2026-09-12

首个版本：archive / consolidation / autolearn / handoff 四项能力。
