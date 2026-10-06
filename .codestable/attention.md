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
  （0.2/0.4/0.25/0.15）逐段裁切：本仓内容需要 14.2/42.6/25.7/16.7%，Project 空余 1,850 而其余三段合计超 1,635，
  总文档 31,774 < 32,000 却每轮丢 10–15 条（四次真实 pass）。口径与渲染器一致：段花费 = Σ(entry+3)，不含 `## H` 行。现在渲染器把用不完的配额汇池、超额段按超额比例借用，
  **只有整个文档到达 `maxMemoryChars` 才丢条目**；`errors.log` 的行也改为 `memory document reached its cap: …`
  （旧的 `memory exceeded a section budget:` 已不存在，别再按它做验收）。实现、变异矩阵、端到端对比与第 1 轮评审
  收口见 `.codestable/issues/2026-10-06-consolidation-keeps-entries/fix-2026-10-06-shares-are-targets.md`。
  **教训（评审 blocking）**：池的口径必须是文档的**真实 body**（`cap − memoryStructureOverheadChars()` = 67），
  不是 `Σtargets`（31,922，比真实小 11：schema 出于保守多留 9 + floor 余数）；用后者会在「文档还有 7 字符」时丢 3 条，
  而且先打在本仓自己提交的记忆上。
  **owner 已定（2026-10-06）：人工裁剪，不抬上限。** 深裁剪把 render 从 31,935 降到 **30,290 字符**（135 → 130 条，
  余量 1,710）：合并语义重叠行 + 把 Index 长句收回定位职责，逐行做过**符号/常量/版本/反引号串存活校验**
  （39 个 token，仅 3 处故意移除：v0.4.5 tag id 与 v0.2.3 版本戳，改由 CHANGELOG/证据文件承载）。提交 `8ffe467`。
  损失机制有**两条**，别只记一条：①**模型自己整篇重写/合并/删除**（评审两次真实 pass 为 −4 与 −17 条，其中一次回复
  不带 `- ` 条目、走 opaque 路径使分段账目整段失效）；②**并发或混版本写入者可能把更大的文档换成更小的**（2026-10-06 复核后改写，旧表述「贴顶时渲染器按 cap 裁剪、
裁剪结果经「外部编辑采纳」写回 journal」**已推翻**）：2026-10-06 10:48:14Z 现场 journal 是 `138 条/31,993`（.887）
→ `126 条/29,939`（.969），而采纳日志落在**两者之间**（.962）⇒ 后一条是采纳**另一个写入者**的文件，不是本构建的
裁剪写回。单构建内 journal 尾与文件由同一裁剪器产出（`pass.ts::memoryTextFor` 把 `renderMemoryDocument` 的产物同时
喂给 journal 与 `MEMORY.md`，而该渲染器按构造保证产物 ≤ cap）⇒ 裁剪本来就是状态，**不需要**采纳这一步；
两个 renderer 在未超限时产物逐字节相同（实测），差异只在需要整条丢弃时出现。守卫缺口仍成立：
`memory regression: 2` 是**逐字**口径（12 条里只报 2），cap 行又被「每项目每进程一次」限流吃掉——**这类丢失在实现里是静默的**）。现场与算术见
  `.codestable/issues/2026-10-06-consolidation-keeps-entries/release-v0.4.5-evidence.md`。
    **现状（2026-10-06）**：人工裁剪已执行两次（`8ffe467`、`778d38c`），当前 109 条 / 29,551 字符，余量 **2,449**；门槛规则＝余量 < ~2,000 时再裁一次（不抬上限）。
- **改词汇先读 `.codestable/reference/vocabulary-conventions.md`。** 改命令、配置键、通知/状态文案、提示词小节或工具字段时，必须同一轮把代码、`docs/`、`CHANGELOG`、MEMORY 与那份规范一起改齐；只改一半算未完成（`Auto summarize target` 就是 v0.3.0 只改命令、没改通知留下的）。
