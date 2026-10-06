# Attention

本文件是 CodeStable 技能启动必读的项目注意事项入口。所有 CodeStable 子技能开始工作前必须读取它。

## 报告语言

CodeStable 所有落盘产出的正文用**中文**：plan / design、plan review / design-review、code review、QA、验收、issue（report / analysis / fix-note）、refactor、roadmap、goal、沉淀（compound）等所有人读报告都用中文表达。机器状态（YAML / JSON / `state.yaml` / frontmatter 字段）保持机读格式不翻译。如需改默认语言，改这一节。

## 项目碎片知识

<!-- cs-note managed: 用 cs-note 维护，新条目按下面分节追加 -->

### 编译与构建

### 运行与本地起服务

### 测试

### 命令与脚本陷阱

### 路径与目录约定

### 环境变量与凭证

- **评审/助手路由是变量，不是常量。** 某条路由回 `429`/`402`/`403` 不等于"本机没有可用路由"：先枚举再宣布受阻。`pi --list-models | awk 'NR>1{print $1}' | sort | uniq -c` 列出所有 provider，再逐条用 `pi -p --no-project-context --model "<provider>/<model>" "Reply with exactly OK."` 廉价探针。陷阱：`pi auth check --provider <id>` 对**由扩展注册**的 provider（`commandcode`、`scnet`）一律答 `provider_not_found`，即使路由本身是好的；它只对 pi 核心 provider 有意义（`deepseek` → `ready`）。2026-10-03 实测：`commandcode` 周限 `429`、`scnet/*` 全被 `403 Token Plan` 挡、而 `deepseek/deepseek-flash` 与 `deepseek/deepseek-v4-pro` 都可用；详情见 `.agents/skills/pi-project-context-headless-runs/SKILL.md`。

### 其他

- **每个机制必须在设计里标出对应的现场事实编号**（issue §1 的现场证据 F1–F4 一类）；标不出就进"非目标/残留"，不进方案。
- **评审发现若要求"新增机制"**（而不是修正已有机制），评审与作者都要先问"对应哪条现场事实"；无则只记残留，不改设计。
- **一个 issue 只做一个主题**：不把跨主题硬化并进来（`poison × 锁` 是反例）。设计行数 > 代码改动 ×3 时，先写一段"最小修复面"再开评审轮。轮次预算、停止规则与其余防复发纪律见 `.agents/skills/pi-project-context-independent-review/SKILL.md` 与 `.agents/skills/pi-project-context-curated-surface-hygiene/SKILL.md`。
- **MEMORY.md 已贴 `maxMemoryChars` 上限，合并通道会丢策展条目，且只有一个只记不拒发的守卫。**
  现场证据：`.agents/memory/errors.log` 三条回归行（`2026-10-05T14:09:16` 记 14 条、`2026-10-05T16:46:30` 分段预算丢 20 条、`2026-10-06T04:30:56` 记 3 条）
  加上 2026-10-06 那次渲染实测丢 11 条策展条目（5 Invariants / 4 Pitfalls / 3 Index；另 2 条是改写合并，不是丢失）。守卫在 `extensions/project-context/memory/pass.ts:318`
  记 `memory regression: …` 之后照常发布，所以「文件里少了什么」不会有第二次提示；跟踪文件被手工补回也会在下一轮再丢，**不是持久修法**（采纳路径只保证外部编辑进 journal）。
  现状：137 条 / 31,774 字符 / 上限 32,000（余量 226，一条条目的量级）。三条出路待 owner 定：
  (a) 接受由每轮合并自然裁减（现状）；(b) 收紧合并规则为「压缩合并而非删除，只删可证过期者」，prompt 级改动，按 `.agents/skills/pi-project-context-consolidation-prompt-rule/SKILL.md` 走并需渲染面验收；
  (c) 抬高 `maxMemoryChars`——注入成本随每会话上升，与 `.codestable/audits/2026-10-05-context-cost-and-progressive-disclosure.md` 的成本结论相抵。2026-10-06 已按 (a) 的临时手段把丢掉的 10 条补回并提交（`8baab6f`）。
- **改词汇先读 `.codestable/reference/vocabulary-conventions.md`。** 改命令、配置键、通知/状态文案、提示词小节或工具字段时，必须同一轮把代码、`docs/`、`CHANGELOG`、MEMORY 与那份规范一起改齐；只改一半算未完成（`Auto summarize target` 就是 v0.3.0 只改命令、没改通知留下的）。
