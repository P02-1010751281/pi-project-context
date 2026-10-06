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
- **MEMORY.md 的绑定约束曾是「段配额」，2026-10-06 起改为「文档上限」（v0.4.5）。** 旧规则按四段固定 share
  （0.2/0.4/0.25/0.15）逐段裁切：本仓内容需要 14.2/42.7/25.8/16.7%，Project 空余 1,850 而其余三段合计超 1,635，
  总文档 31,774 < 32,000 却每轮丢 10–15 条（四次真实 pass）。口径与渲染器一致：段花费 = Σ(entry+3)，不含 `## H` 行。现在渲染器把用不完的配额汇池、超额段按超额比例借用，
  **只有整个文档到达 `maxMemoryChars` 才丢条目**；`errors.log` 的行也改为 `memory document reached its cap: …`
  （旧的 `memory exceeded a section budget:` 已不存在，别再按它做验收）。实现、变异矩阵、端到端对比与第 1 轮评审
  收口见 `.codestable/issues/2026-10-06-consolidation-keeps-entries/fix-2026-10-06-shares-are-targets.md`。
  **教训（评审 blocking）**：池的口径必须是文档的**真实 body**（`cap − memoryStructureOverheadChars()` = 67），
  不是 `Σtargets`（31,922，比真实小 11：schema 出于保守多留 9 + floor 余数）；用后者会在「文档还有 7 字符」时丢 3 条，
  而且先打在本仓自己提交的记忆上。
  **待 owner 定（新）**：记忆已占上限 **99.98%**（31,993 / 32,000，余 7 字符），模型每轮新增都会把它推过上限——
  要么抬 `maxMemoryChars`（`/memory max-memory <n>`，每会话多约 1,000 tokens 注入），要么人工裁剪一次。
  另一条已量清的事实：剩余损失**主因是模型自己整篇重写/合并/删除**（评审两次真实 pass 为 −4 与 −17 条，
  其中一次回复不带 `- ` 条目、走 opaque 路径使分段账目整段失效），不是渲染器。
- **改词汇先读 `.codestable/reference/vocabulary-conventions.md`。** 改命令、配置键、通知/状态文案、提示词小节或工具字段时，必须同一轮把代码、`docs/`、`CHANGELOG`、MEMORY 与那份规范一起改齐；只改一半算未完成（`Auto summarize target` 就是 v0.3.0 只改命令、没改通知留下的）。
