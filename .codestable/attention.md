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
- **MEMORY.md 的绑定约束是「段配额」，不是总上限——丢条发生在渲染器，不在模型。** 现场证据（2026-10-06）：
  已提交版 31,774 字符里 Invariants +852 / Pitfalls +239 / Index +544 **超出各自配额**，Project 却只用了 71%，
  于是 `renderMemoryDocument`（`memory/sections.ts`）把放不下的**整条丢掉**（实测 `sectionDropped=3`、`droppedItems=9`，
  9 条丢弃全落在现场文件缺的那批里）。关键量级：Project 空额 1,850 **足以吸收** Invariants/Index/Pitfalls 合计
  1,635 的超额，但固定 share 不允许借用——总文档余 1,798 却仍丢条目。
  `errors.log` 的 `memory exceeded a section budget: …` 是这条路径的日志，`memory regression:` 行则跑在裁切**之前**，
  **不能**当损失的度量或验收。守卫只记不拒发（`memory/pass.ts`）。
  已修的是提示层（主规则＋重试句都改成「压到每段配额内，只删可证过期者」，见
  `.codestable/issues/2026-10-06-consolidation-keeps-entries/`）；**未决的是第二层**：固定 share（0.2/0.4/0.25/0.15）
  与本仓实际分布不符，可选「按分布重配 share」或「段间可借额度」（机制改动，需独立设计）。
  手改 MEMORY.md 补条目**必须同时满足段配额**，否则下一轮必被裁回（2026-10-06 已实测过一次）。
- **改词汇先读 `.codestable/reference/vocabulary-conventions.md`。** 改命令、配置键、通知/状态文案、提示词小节或工具字段时，必须同一轮把代码、`docs/`、`CHANGELOG`、MEMORY 与那份规范一起改齐；只改一半算未完成（`Auto summarize target` 就是 v0.3.0 只改命令、没改通知留下的）。
