---
doc_type: design
issue: autolearn-progressive-disclosure
status: draft
revision: 2
date: 2026-10-05
partial_implemented_in: 997447a（切片 A1，随 v0.3.2 发布；切片 B1′ 未实现，故本设计仍是 draft）
decides: 生产者侧按需取正文（inspectSkill ＋ 代码层「展示过才可覆盖」）与技能分层（SKILL.md ＋ references/）一并设计；外部调研已把入口上限从 2500 放宽到 6000、新增「引用只一层深」、并把 B 降级为「只对大技能外置长细节」；单位上限、守卫严格度、存量迁移口径见 §0 待答表
supersedes: 不改 v0.3.1 的取代语义，只补它的覆盖率与成本；v0.3.1 的「整篇正文注入」在此被 §3 替换；revision 1 的「入口 ≤2500」「B 面向全部技能」被 §1.5 的外部证据修正
---

# autolearn 渐进披露设计（revision 2，draft）

## 0. owner 已答 / 待答

> **2026-10-05 补记（A1 发布后）**：下表第 1／2／3 项是 A 片（按需取正文）的取值选择，A1 已按推荐值实现并随
> v0.3.2 发布（`997447a`：`inspectSkill` 上限 2 在代码里截断、只有本轮展示过的名字可被覆盖、候选受约束而
> approve 不受但明说盲写）——回归钉子与单侧变异见 §7 A1；第 7 项的发布节奏实践上也已定为「A 单独发 v0.3.2」；
> 第 8 项由 §1.5 采用（B 降级为「只对 ≥8000 字符的技能外置长细节」）。**仍然待答的是 B1′ 的 4／5／6**（合并时
> references 可否增删改、分层上限取值、存量 17 条是否分层），因为 B1′ 尚无实现：技能目录里 `references/` 数量为 0，
> 代码里也没有 `MAX_SKILL_REFERENCE_CHARS` / `MAX_SKILL_REFERENCES` 一类的常量。

| # | 议题 | 结论 |
| --- | --- | --- |
| 0.1 | 做 (a) 还是 (b) | **a + b 一起设计**（owner，2026-10-05） |
| 0.2 | 先给设计文档 | **是**（本文件） |
| 1 | `inspectSkill` 一次允许点名几条 | 待答（§3.2 推荐 2） |
| 2 | 代码层守卫严格度：未展示就不能覆盖（G1）／只记日志（G2） | 待答（§3.3 推荐 G1） |
| 3 | `candidate` 与 `approve` 是否也受「展示过」约束 | 待答（§3.4 推荐：候选受、approve 不受但明确告知盲写） |
| 4 | 合并时 references 可否增删改（B1 只改入口／B2 放开） | 待答（§4.3 推荐 B1；外部证据见 §1.5） |
| 5 | 分层上限：入口 ≤6000（r1 为 2500）、单篇引用 ≤20000、引用 ≤5、只一层 | 待答（§4.4 推荐值，入口已按规范与生态实测上调） |
| 6 | 存量 17 条是否分层 | 待答（§4.6 推荐：**只对 ≥8000 字符的技能**分层一次，其余不动） |
| 7 | 发布节奏：a 发 v0.3.2、b 发 v0.4.0，还是一次发 | 待答（§10 推荐：A 单独发 v0.3.2，B 观察后再定） |
| 8 | B 是否降级（外部证据对递归分层不利） | 待答（§1.5：建议 B 缩为「只外置长细节、关键步骤留入口」） |

### 0.1 命名与词汇决议（owner 已答，2026-10-05）

| # | 项 | 决议 |
| --- | --- | --- |
| N1 | `/autolearn` 命令描述 | 改为 `Learn or update a project skill now; …` |
| N2 | 新的拒绝理由 | `body not shown this pass`（与 `body too short` 同形） |
| N3 | approve 盲写提示 | `Updated project skill: X → path` 后追加 `— approved by hand; this pass never showed its body` |
| N4 | `docs/configuration.md` | 补半句：「且必须先在本轮提示词里展示过它的正文」 |
| N5 | 工具字段名 | **`inspectSkill`**（与 `inspect` 同构，最多 2 条，数量在**代码**里截断） |
| N6 | 提示词小节 | `<learned-skill-bodies>` 保留；「点名未给」不新增小节，规则区一行 `Without a body this pass (do not reuse these names): …` |
| N7 | 三个动词定死 | **show 展示**／**merge 合并**／**supersede 取代**，prompt、CHANGELOG、docs、MEMORY 一律用这三个 |
| N8 | 预算常量 | `AUTOLEARN_LEARNED_BODY_CHARS` → **`AUTOLEARN_SHOWN_BODY_CHARS`**（语义改为「本轮点名展示总量」） |
| N9 | 正文收集函数 | `learnedBodiesText(skills)` → **`learnedBodies(skills, requested?)` 返回 `{ text, names }`** |
| N10 | 展示集合变量 | **`shownNames: Set<string>`** |
| N11 | Decision 字段 | `inspect` ＋ `inspectSkill` |
| N12 | 分层目录名 | 直接用规范词 **`references/`** |
| N13 | B 的拒绝理由 | `reference path must be references/<kebab>.md`／`reference file is missing`／`reference file is not linked from the body`／`too many references`／`reference too long` |
| N14 | `body` 上限语义 | **乙**：`body` 上限改为 6,000（entry），单篇引用另设 `MAX_SKILL_REFERENCE_CHARS = 20000`；存量 >6,000 的四条靠「触发式分层」豁免 |

### 0.2 词汇审计遗留（2026-10-05 扫出，owner 已拍；规则成文于 `.codestable/reference/vocabulary-conventions.md`，落地见 `.codestable/issues/2026-10-05-vocabulary-consistency/`；逐条证据见 §13）

| # | 项 | 建议 |
| --- | --- | --- |
| V1 | `/handoff` 通知仍写 `Auto summarize target:`，命令词已是 `budget summary` | 顺手修（v0.3.0 已决未落） |
| V2 | 持久化键 `handoffTargetTokens`／`handoffKeepTokens` 滞后于 `budget summary`／`budget recent` | 单独立项（破坏性 + 迁移 + 10 处测试） |
| V3 | 同特性键拼写不一：`autoLearn` vs `autolearnAt`／`Turns`／`IntervalMs`；`archiveEnabled`/`handoffEnabled` vs `autoConsolidate`/`autoLearn` | 同 V2 一并做 |
| V4 | 四层「立即执行」动词各异：`update`／`write`／`now`／裸调用 | 建议记为「已决：各层动词描述各自动作」 |
| V5 | 通知前缀四种风格（memory 一层内部就有三个） | 单独立项 |
| V6 | 跨层状态渲染器名：`statusText` vs `memoryStatusMessage`/`contextStatusLine` | 纯内部改名，可顺手 |

## 1. 现场事实（本机可复现，探针见 §11）

- `.agents/skills/` 共 **17** 条项目技能，**全部带 v0.3.1 的来源标记**；目录里除 `SKILL.md` **没有任何其它文件**（`find -type f` = 17）。
- 17 条正文字符数合计 **96,975**（均值 5,704；最大 `memory-recovery` 13,207、`independent-review` 12,196。
- 注入预算是**总量**：`AUTOLEARN_LEARNED_BODY_CHARS = MAX_SKILL_BODY_CHARS = 20,000`，且「整篇才收，放不下就整条跳过」（`autolearn/inventory.ts`）。
  实测被注入的只有 **4 条**：`adaptive-handoff-threshold-review`(3,238)、`audit-claim-verification`(9,272)、
  `auxiliary-alert-storm-triage`(3,379)、`gate-probe-mutation-check`(2,754)，合 **18,857**；其余 **13 条永远进不了提示词**，
  其中恰含最胖的两条。
- 提示词总长 **32,057** 字符，其中 `<learned-skill-bodies>` 段 **18,859（59%）**；若不注入正文则为 **13,149** 字符。
  清单段本身只有 **3,594** 字符。
- 判定面现状：**代码 gate 只认标记与 scope**（`autolearn/candidate.ts` 的 `rejectionReason`），写入路径再读目标文件的标记（`autolearn/pass.ts`），
  approve 同（`autolearn/candidate.ts`）。**没有任何一层知道「这条正文是否被展示过」** —— 那 13 条是「可覆盖、却在提示词里不可见」。
- 生产者无法自己去读文件：autolearn 的辅助调用是**一次 completion**，只提供 `record_skill` 一个工具（`autolearn/pass.ts:102`），
  且 `shared/llm.ts` 的 `callAux` 有无工具回退，没有工具循环。所以「按需取」只能由扩展按点名注入。
- 已有的往返机制可复用：`pass.ts:151-153` 在「没提案且 `inspect` 非空」时取原始证据并**重建提示词**跑第二轮。
- pi 原生支持分层技能：技能可带 `references/`，启动只注入 name/description/path，模型用到才读 `SKILL.md`，
  引用按技能目录相对路径解析（pi `docs/skills.md:5,18,34,39,45`）。本仓 CodeStable 侧技能即此形态。

## 1.5 外部调研（2026-10-05；链接见 §12）

### 官方规范怎么定分层与上限

- 三层：**metadata**（`name`/`description`，约 100 tokens，启动即常驻）→ **instructions**（`SKILL.md` 正文，规范建议 **<5,000 tokens**，技能被激活时**整篇**加载）
  → **resources**（`scripts/`、`references/`、`assets/`，只在需要时加载）。
- 结构硬规则：**正文 <500 行**（「超过就拆到单独文件」）、**引用只一层深**（原文："Keep file references one level deep from `SKILL.md`.
  Avoid deeply nested reference chains."）、`name` ≤64、`description` ≤1,024。
- `SKILL.md` 被定义为「总览/目录页，指向按需加载的细节材料」。

### 生态实测（138,133 条技能的实证研究 ＋ GitSkills 数据集）

- 138,133 条去重技能、20,556 个仓；98.8% 有 frontmatter；**正文中位数 169 行 / 687 词**（≈4.1–4.5 KB）。
- 缺陷普遍：**94.6% 至少命中一个检出缺陷**（另一处口径 91.8%，Tier-1 89.3%）；论文表格里「正文 <500 行」占 **10.4%**、
  「把代码/样例外置到资源」占 **37.0%**（原始行：`| G6. Keep body under 500 lines. | R2.1 | 10.4% |`、
  `| G7. Externalize code (60%) and examples (8 blocks). | R3.1–R3.3 | 37.0% |`）。
- 结构不合规很常见：**46 条把文件放在技能根目录**而不是规范目录、**54 条用非标准目录名**、13 条深嵌套；复制是主要复用机制（重复率约 **50.5%**）。
  → 本设计 §4.2/§4.5 的路径约束与死链/孤儿校验不是洁癖，是这类数据集里最高频的坑。
- 本仓对照：17 条**全部单文件**，入口中位 4,139 字节（≈生态中位）、最大 13,207 —— 体型处在生态中位偏上，不是异常值。

### 分层真的更好吗（受控研究对我方不利的一半）

arXiv 2607.17598 是首个受控研究（raw 文档导航 / flat 技能包 / hierarchical 递归技能包 / hybrid 检索 × Codex、Pi、Claude-Code）：

> "On a single book, flat disclosure helps only to the extent that the agent cannot already navigate the document: it matches or exceeds
> raw-document navigation under Pi and Claude-Code, but adds nothing under Codex... **The hierarchical pack never beats the flat one, and
> sometimes collapses accuracy outright**... At library scale the picture flips: bundling twenty books sinks even Codex under raw navigation...
> while flat disclosure holds it at..."（数字在抓取时被截断，故留空）

- 含义：**「入口 → 引用」这一跳本身就是失败点**（模型可能不去读引用）；单文档场景下递归分层无收益、有时显著变差。
  pi 自己的文档写明同一风险：「A model might fail to load a relevant skill」（`docs/skills.md`）。
- 所以 B 的正当理由**不能**写成「分层提升可用性」，只能写成：① 合并单元变小（模型重写 6k 而不是 13k，丢内容概率更低）；
  ② 生产者注入成本（但那是 A 解决的）；③ 把**长细节**（逐条命令表、边界情况、历史证据）搬出入口，**关键步骤必须留在入口**。

### 生产者侧的外部先例

- SkillRevise（arXiv 2606.01139）把「修订既有技能」建模为独立算子：`Revision Operator` 的输入是**当前技能** ＋ 诊断 ＋ 修复原则，
  产出修订稿与修订轨迹 —— 即「改之前必须把旧文本给模型」，与本设计 A 的核心要求一致（A 只是把它变成**按需**取）。
- **没被文献解决的一环**：没有公开证据能预测「模型会不会主动点名要正文」。规范给的是机制，不是模型的自律；
  所以 §3.3 的代码层守卫是必须的，真实路由下的点名率（E1）仍需实现期用真实调用测。

### 调研直接带来的修改

1. §4.4 入口上限 **2,500 → 6,000**（规范 <500 行 / <5,000 tokens、生态中位 4.1–4.5 KB；6,000 给 procedure 型技能留余量，仍只有最大现状的一半）。
2. 新增硬约束：**引用只一层深**（`references/*.md`，不许再嵌套），直接采用规范措辞。
3. B 降级：默认**只对 ≥8,000 字符的技能**分层，且只外置长细节；其余保持单文件（A 已解决覆盖率）。
4. §4.2 的路径/死链/孤儿校验升级为「有外部数据支撑的必要项」。

## 2. 目标与非目标

**目标**

1. 任意**带标记的技能**都能被合并（覆盖率 4/17 → 17/17），且不再依赖「它的正文刚好塞得进预算」。
2. autolearn 基础提示词不再随标记技能总量增长；合并那一轮只为**点名的那一条**付正文成本。
3. 合并单位变小：入口 ≤6,000 字符，模型重写整篇时更不容易丢掉原有步骤。
4. 消费者侧（真正执行任务的 agent）按需读：触发一条技能时先读入口，只在走到某步时读对应引用文件。

**非目标**

- 不改候选/审批的用户面语义：`/autolearn approve|reject` 仍是人工确认入口。
- 不新增用户面命令、动词或开关（`/autolearn` 的参数集不变）。
- 不由管线自动**删除**任何技能目录下的文件（删除仍要人；见 §4.3）。
- 不做「模型自己去读文件」的工具循环（§1 已述通道不存在）。
- 不为存量 17 条做一次性大重构（§4.6）。

## 3. 设计 A：生产者侧按需取正文

### 3.1 机制

第一轮提示词**不注入任何技能正文**，只给清单（名字 ＋ scope ＋ `learned` 标记 ＋ description）。模型若要更新某条既有技能，
必须先用新字段点名它；扩展把点名者的正文注入**第二轮**（复用已有的 inspect 往返），模型在第二轮才做合并提案。

```
第一轮  → 清单（3.6k）＋ 规则；无 <learned-skill-bodies>
模型答复 {"skill":{空},"inspect":[],"inspectSkill":["pi-project-context-memory-recovery"]}
第二轮  → 同一提示词 ＋ <learned-skill-bodies>（只含点名者）＋（若同时点名了会话）<session-evidence>
模型答复 {"skill":{"name":"pi-project-context-memory-recovery","body":"<整篇合并稿>",...}}
写盘    → 展示集合包含该名字 ⇒ 放行覆盖
```

### 3.2 字段与提示词

- `schema.ts`：`inspectSkill: string[]`（与 `inspect` 并列，可空）；上限 `MAX_INSPECT_SKILLS`（推荐 2）。
- `prompt.ts` 规则改写为：

  ```
  - name must be new, except for a `learned` skill: to update one you must first ask for its body with
    `inspectSkill: ["<name>"]`. A name whose body has not been shown in this run may not be reused.
  - an update rewrites the whole shown body: keep every step of it that still holds, or propose nothing.
  ```

- `<learned-skill-bodies>` 只在第二轮、且只对该轮点名的名字渲染；总量仍受 `AUTOLEARN_LEARNED_BODY_CHARS` 约束，
  超限者整条跳过并在第二轮提示词里点名（否则模型会以为能看到）。
- 点名解析：只接受 `learned` ＋ project scope 的名字；未知/global/手写名字 → 忽略并记一条（§3.5 表）。

### 3.3 展示集合与代码层守卫（G1）

「是否展示过」必须成为**代码可判定**的事实，否则又回到提示词层约束：

- `pass.ts` 在跑完（可能两轮）后，把**本轮实际渲染进 `<learned-skill-bodies>` 的名字集合**（`shownNames`）传给写盘判定。
- `candidate.ts` 的 `rejectionReason` 增加参数 `shownNames`：既有技能重名时，除「带标记 ＋ project」外，还要求「名字 ∈ shownNames」，
  否则拒绝（`body not shown this pass`）。写入路径再独立校验一次（与 v0.3.1 的两道判定同构）。
- 推荐 G1（拦）；G2（只 logError 不拦）等于维持现状，不解决「盲写」这一条。

### 3.4 candidate 与 approve

- **候选路径受同一约束**：候选是为后续 approve 落盘的，若目标技能本轮不可见而落盘，就是绕过守卫的侧门 → 同 `shownNames` 判定。
  （新增名字的候选不受影响：没有既有正文可看。）
- **approve 不受约束**：approve 是人确认的动作，且此刻不跑提示词；但它会**盲写**——文案要说明清楚，例如
  `Updated project skill: X → …（the pass never showed its body; approve overwrites as-is）`。
- 这是 §0 第 3 项的待答点：也可以选择让 approve 一并拒绝，代价是「人想修一条大技能」时无路可走。

### 3.5 边界情况

| 情况 | 处置 |
| --- | --- |
| 点名了不存在/手写/global 的名字 | 忽略该名，第二轮提示词底部列 `requested but not shown: <name> (not a learned project skill)` |
| 点名超过上限 | 取前 N 条（按数组序），其余同上列入 not shown |
| 点名但第二轮仍不提案 | 本轮结束（沿用「一轮跟进封顶」） |
| 第一轮既提案又要正文 | 不触发第二轮 → 该提案若覆盖既有技能，因不在 shownNames 被拒，并提示「先点名要正文」 |
| 有提案且 `inspect` 非空 | 现状即不触发跟进轮；保持（正文点名同理，不叠加额外轮次） |

### 3.6 预算核算

| 轮次 | 现状 | 设计 A |
| --- | --- | --- |
| 第一轮 | 32,057（含 4 条正文 18,857） | **13,149**（0 条正文） |
| 第二轮（点名 1 条） | — | +≤ 该条正文（分层后 ≤6,000；未分层 ≤20,000） |
| 可达技能 | 4/17 | **17/17** |

## 4. 设计 B：技能分层（SKILL.md 入口 ＋ references/）

### 4.1 目录形状与消费者侧

```
.agents/skills/<name>/
├── SKILL.md              ← frontmatter ＋ 标记 ＋ 何时用 ＋ 步骤索引（指向引用文件）
└── references/*.md       ← 单篇一个子过程；按相对路径引用
```

- pi 启动只注入 name/description/path；模型触发技能时读 `SKILL.md`，走到某步再读对应引用（`skills.md:39,45`）。
- 因此入口必须**自包含**：`## When to use` ＋ 一张「步骤 → 文件」表；不得把「何时用」放进引用文件。
- 标记仍只写在 `SKILL.md`：出处仍是**一处**，`collectSkills` 读标记与入口正文的路径不变。

### 4.2 提案形状与写盘

- 提案增加 `references: [{path, content}]`；`body` 变为**入口**（上限 `MAX_SKILL_ENTRY_CHARS`，推荐 **6,000**，依据见 §1.5）。
- `path` 约束：必须匹配 `references/<kebab>.md`（禁 `..`、绝对路径、点文件、嵌套目录、非 `.md`）；**只允许一层**（规范原文 "one level deep"）；
  条数 ≤ `MAX_SKILL_REFERENCES`（推荐 5）；
  单篇 ≤ `MAX_SKILL_REFERENCE_CHARS`（推荐沿用 20,000）。
- 写盘顺序：**先写 references，最后写 `SKILL.md`**。`SKILL.md` 是发布点：在它更新之前，消费者读到的旧入口只会引到旧集合。
- 初建（无既有目录）：`mkdir -p` 目录与 `references/`，写 references，再写入口。
- 候选（`candidate: true`）同样携带 references：候选文件仍是**单个** `.md`（用 `## References` 分节承载各篇），
  approve 时再拆成目录结构——这样候选的「一个人工确认的文件」形态不变。

### 4.3 合并语义（B1：合并只重写入口）

- 合并一轮：模型拿到既有**入口**正文（经 §3 按需取），整篇重写；`references/` **原样不动**。
- 风险（§1.5）：递归分层在受控研究里**从未胜过单文件**，所以只允许把长细节外置；入口必须自己把步骤走通，不许「详见 references/x.md」这类把关键判断推走的写法。
- 入口必须仍指向所有**存在**的引用文件（§4.5 校验），所以入口重写时要保留索引表——提示词写明这一点。
- 想改引用文件时：把该文件作为点名单位（§0 第 4 项的另一半），例如
  `inspectSkill: ["pi-project-context-memory-recovery/references/triage.md"]`，第二轮注入该文件内容，模型只重写该文件。
  第一版推荐**先不做**（B1），因为「单位到文件」会让投影面与断言数翻倍；等 B1 在场上跑过一轮再决定。
- 不删除：合并永不删 references；多余引用由人在 review 时删（或在后续设计里做）。

### 4.4 上限与常量（推荐值）

| 常量 | 推荐 | 理由 |
| --- | --- | --- |
| `MAX_SKILL_ENTRY_CHARS` | 6,000 | 规范 <500 行 / <5,000 tokens、生态中位 4.1–4.5 KB；6,000 留余量（r1 的 2,500 偏紧） |
| 引用深度 | 只一层（`references/*.md`） | 规范原文 "one level deep"；深嵌套是生态高频缺陷 |
| `MAX_SKILL_REFERENCE_CHARS` | 20,000 | 沿用现 `MAX_SKILL_BODY_CHARS`，不引入新上限 |
| `MAX_SKILL_REFERENCES` | 5 | 与本仓最大技能章节数（`memory-recovery` 6 节）相称 |
| `MAX_INSPECT_SKILLS` | 2 | 一轮往返只跑一次，避免成本叠加 |
| `AUTOLEARN_LEARNED_BODY_CHARS` | 20,000（保留） | 语义从「所有 learned 正文」改为「本轮点名注入的总量」 |
| `MIN_SKILL_BODY_CHARS` | 保持 160 | 入口依然要够具体 |

### 4.5 防漂移的可验证口径

入口与引用会漂移（入口说 A、引用写 B）。第一版用**结构断言**兜住可判定的部分：

1. 每个存在的 `references/*.md` **至少**被入口提到一次（无孤儿文件）；
2. 入口提到的每个 `references/...` 路径**必须存在**（无死链）；
3. 入口长度 ≤ 上限、引用篇数 ≤ 上限；
4. 标记在 `SKILL.md`、不在任何引用文件；
5. 断言同时落在两条路径：approve 时的形状检查（复用 `shapeRejection` 风格，拒绝并点名原因）与本仓测试里的合成样本。

内容一致性（步骤在入口与引用之间不矛盾）**不做**自动校验——那是语义问题，留给 review；此条记入 §9 残留。

### 4.6 存量迁移

- 新生成的技能（含候选晋级）一律按 §4.2 形状；`body` 是入口。
- 存量 17 条**不强拆**：它们没有 references，按 A 工作时单位是整条正文（最大 13,207，仍在 20,000 内，且第二轮的代价只落在点名那一条）。
- 触发式分层：某条技能下次被合并/被点名时，模型可以顺势把它拆成入口＋引用（提示词允许），此后该条进入分层形态。
- 兼容读取：`collectSkills` 无需改（仍只读 `SKILL.md`）；`references` 的存在只影响 §4.5 的校验与写盘。

## 5. A + B 合起来

| 方案 | 第一轮 | 合并一轮 | 可合并 | 合并单元 |
| --- | --- | --- | --- | --- |
| 现状（v0.3.1） | 32,057（正文 18,859） | 0 | 4/17 | 整条正文 |
| 仅 A | 13,149 | ≤20,000 | 17/17 | 整条正文 |
| **A + B** | 13,149 | **≤6,000** | 17/17 | 入口（引用按需） |

消费者侧另有一处独立收益：技能被触发时从「整篇 5,704 均值 / 13,207 最大」降到「入口 ≤6,000 ＋ 真正需要的那一节」。

## 6. 改动面

| 文件 | A | B |
| --- | --- | --- |
| `autolearn/schema.ts` | `inspectSkill` | `references` 数组 |
| `autolearn/prompt.ts` | 规则改写；正文段只对点名者渲染；not-shown 汇报 | 分层规则（入口自包含、索引表、引用路径约束） |
| `autolearn/pass.ts` | 展示集合贯穿两轮；写入判定加 `shownNames` | 多文件写盘（先引用后入口）；`mkdir -p` |
| `autolearn/candidate.ts` | gate 加 `shownNames`；候选同约束 | 候选文件的 `## References` 分节；approve 拆分落盘＋形状检查 |
| `autolearn/inventory.ts` | 无（`learnedBodiesText` 改为按点名集合渲染，或由 pass 调用） | 可选：列出引用文件名供 entry 校验 |
| `autolearn/skill.ts` | — | `promotedDocument` 支持引用；路径校验 |
| `shared/limits.ts` | 保留 | 新增 §4.4 常量 |
| `docs/architecture.md` | 「技能沉淀与来源」加按需取正文 | 同节加分层形态与校验口径 |
| `docs/configuration.md` | `/autolearn` 段补一句 | — |
| `tests/autolearn-test.mjs` | 新断言组（见 §7） | 新断言组（见 §7） |

## 7. 回归钉子（含单侧变异点）

### A1（已实测，2026-10-05；代码提交 `997447a`）

| 断言 | 单侧变异 | 实测红了几条 |
| --- | --- | --- |
| 点名后第二轮恰好含点名者的正文 | 第二轮不注入点名正文 | **1**（只有该条） |
| 点名上限 2（代码截断） | `MAX_INSPECT_SKILLS` 2 → 3 | **1** |
| 未展示的既有名字不可覆盖（gate） | 去掉 `shownNames` 条件 | **2**（候选路径两条）——实时路径**不红** |
| 未展示的既有名字不可覆盖（两道判定合计） | 两道同时去掉 | **4**（多出实时路径两条） |
| 点名了却不该给要回告 | `notShown: []` | **1** |
| approve 覆盖时说明是盲写 | 文案回退 | **1** |
| 新字段进 `required`（strict 就绪性） | 从 `required` 删掉 | **1** |

关键发现（与 v0.3.1 同构）：**实时路径有两道独立判定**（gate 读清单、写入读文件），所以单独打掉任何一道，它的断言都不会红 ——
必须一并打掉（M1b）才现形。这不是「钉子无效」，而是「两道判定共用一个可观察结果」；候选路径只有 gate 一道，因此它的两条断言能被单侧变异直接钉住。

### B1′（待实现）

| 断言 | 单侧变异 |
| --- | --- |
| 分层技能写盘＝先引用后入口（记录 mkdir 与写序） | 换序 → 红 |
| 入口提到不存在的引用 → 拒绝并点名 | 去掉死链校验 → 红 |
| 存在未被入口提到的引用文件 → 拒绝并点名 | 去掉孤儿校验 → 红 |
| 路径约束拒绝 `../`、绝对路径、嵌套（只一层）、非 `.md` | 去掉校验 → 红 |

## 8. 验收口径

1. **提示词**：探针测 `buildPrompt`，第一轮 < 14,000 字符且不含 `<learned-skill-bodies>`（现状 32,057）。
2. **覆盖率**：点名 13 条里任意一条都能完成一次合并（测试里合成样本已验证；现场观察项见下）。
3. **现场（发布后，不阻塞）**：下一次 autolearn pass 的提示词长度落在 13k 量级；首个真实「点名 → 合并」事件的
   通知是 `Updated project skill:`。若长期没有真实事件，这仍是**未被现场验证**的能力（与 v0.3.1 的取代能力同一条观察项）。
4. **消费者侧（B）**：headless 会话触发一条分层技能时，能读到 `references/...`（相对路径解析成功）。
5. `node tests/run-all.mjs` 15/15 绿；断言数只增不减。

## 9. 非目标与残留

- 不做入口与引用的**内容**一致性校验（§4.5）；不做引用文件的自动删除；不做 B2（合并改引用）。
- B 的风险已知未消：受控研究（§1.5）显示递归分层不比单文件好、有时更差；本仓若观察到「模型读了入口但不读引用」，
  就应把该技能回退为单文件（这是 B1 之后要盯的现场指标）。
- 未分层技能的第二轮成本仍可达 20,000（单条上限内）；若某条超过 `MAX_SKILL_REFERENCE_CHARS`，点名它时整条注入会被跳过，
  该条无法被合并（回到「不可见」）——`memory-recovery` 13,207 仍在限内，尚不触发。
- 展示集合以「本轮渲染」为准：若模型点名后改主意，该名字本轮仍算已见（不撤回），这与「看到过就能改」的语义一致。
- 提示词层仍有约束（模型可能不提名就直接用旧名提案），代码层守卫是兜底；被拒时只记 `logError` 不打扰用户（自动 pass 静默）。

## 10. 实施切片与发布

1. **切片 A1（已实现 `997447a`，tag v0.3.2）**：schema ＋ prompt ＋ 展示集合 ＋ gate/写盘/候选守卫 ＋ 测试（`tests/autolearn-test.mjs` 66 → 82 条断言）。**现场待观察**：下一次 autolearn pass 的第一轮提示词长度回落到 13k 量级，以及首个真实的「点名 → 合并」事件（通知为 `Updated project skill:`）。
2. 切片 B1′（已按 §1.5 降级）：分层提案形状 ＋ 路径/深度/上限/死链与孤儿校验 ＋ 多文件写盘 ＋ 候选分节与 approve 拆分 ＋ 测试；
   适用范围限「≥8,000 字符的技能」与「新生成的长技能」。
3. 发布建议：A1 → v0.3.2（feat）；B1′ 观察 A 的现场表现后再定版（预计 v0.4.0，技能形态变化）。两者都需 **重启 pi**（行为在 `extensions/`）。
4. 每片独立提交（行为／文档／技能各一片），保持「一次提交可自证」。

## 12. 外部资料（2026-10-05 抓取）

| 来源 | 要点 |
| --- | --- |
| [Agent Skills Specification](https://agentskills.io/specification) | 三层加载；正文 <5,000 tokens 建议；**<500 行**；引用**只一层深** |
| [Claude 平台 best-practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) | 检查表：`SKILL.md` 正文 <500 行、细节放单独文件；description 讲清做什么与何时用 |
| [Anthropic 工程博客：Equipping agents with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) | 渐进披露是核心设计原则；`SKILL.md` 当作目录页 |
| [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | 运行时检索优于预载（JIT context） |
| [What Keeps Agent Skills from Being Reusable?（138K 技能实证）](https://arxiv.org/html/2608.08453v1) | 中位正文 169 行/687 词；94.6% 至少一个缺陷；复制式复用 ~50.5% |
| [GitSkills 数据集](https://www.alphaxiv.org/abs/2608.10906) | 7.26M 附带文件；结构不合规的具体形态（根目录放文件、非标准目录名、深嵌套） |
| [Is Progressive Disclosure All You Need for Long-Context Agents?](https://arxiv.org/html/2607.17598v1) | 受控研究：**hierarchical 从未胜过 flat**，有时准确率崩；库规模下 flat 更稳 |
| [SkillRevise: Trace-Conditioned Skill Revision](https://arxiv.org/html/2606.01139v2) | 修订算子以**当前技能**为输入 —— 改之前必须给旧文本 |

抓取方式：`tvly search/extract`（Tavily CLI），只把过滤后的片段带入上下文；受控研究那段数字被截断，文中已留空而**未臆补**。

## 13. 词汇审计（2026-10-05，扫全仓）

问题：v0.3.0 的「一个事实一个名字」到底收束到哪一层？结论：它收束的是**命令面**（动词/参数/二级词/状态行）与**配置布局**（扁平键 + 一次性迁移），
下面三类没做，且能举出实例。

| # | 面 | 现场证据 | 判断 |
| --- | --- | --- | --- |
| V1 | 用户可见文案 | `handoff/run.ts:405` 通知 `Auto summarize target: ~${fmtTokens(...)} per handoff before caps`；同一文件的 status 行（`run.ts:51`）已写 `summary budget` | **v0.3.0 已决未落**：命令词改了，通知没改 |
| V2 | 持久化键 vs 命令词 | 命令是 `budget summary`／`budget recent`，键仍为 `handoffTargetTokens`／`handoffKeepTokens`（`shared/config.ts:41,43`）；`tests/handoff-test.mjs` 与 `switches-test.mjs` 共 10 处钉住；`config.ts:100` 注释也写 "keep budget" | 实际错位；改名 = 破坏性 + 迁移 + 测试改动 |
| V3 | 同特性键拼写 | `autoLearn`（大写 L）vs `autolearnAt`／`autolearnTurns`／`autolearnIntervalMs`（小写 l）；开关四种拼法：`archiveEnabled`／`handoffEnabled` vs `autoConsolidate`／`autoLearn`（`config.ts:55-64`） | 同一事实两种拼法 |
| V4 | 四层「立即执行」动词 | `/memory update`、`/session-log write`、`/handoff now`、`/autolearn`（裸）：`memory/report.ts:376`、`archive/archive.ts:176`、`handoff/run.ts:375`、`autolearn/pass.ts` 命令体 | 未统一；也可辩护（动词描述各层自己的动作）—— v0.3.0 没讨论过 |
| V5 | 通知前缀 | 实测前缀：`Autolearn:`、`Auto handoff:`、`Automatic consolidation:`、`Project memory updated:`、`Memory cap:`、`Session log written:`／`Session archiving:`、`Auxiliary calls:`、`Features:` —— memory 一层内部就有三个 | 未统一 |
| V6 | 跨层状态渲染器名 | handoff = `statusText(ctx)`（`handoff/run.ts:27`）；memory = `memoryStatusMessage`／`memoryStatusLevel`／`contextStatusLine`（`memory/status.ts`） | 内部名，未统一 |
| V7 | 函数/变量名抽检 | 全仓导出函数基本为 verb+noun（`collectSkills`／`buildPrompt`／`parseDecision`／`resolveAuxModel`…）；`clip*` 家族 5 个成员（`clipTo`／`clipText`／`clipTailToLineBoundary`／`clipToLineBoundary`／`clipToLineBoundaryBothEnds`）各自锁不同边 | 不算残留 |

处置（owner 2026-10-05 已拍）：

1. A1 内联做：§0.1 的 N1–N14（本主题自己的词）＋ **V1**（已完成，`b869be3`：6 处旧词全清，`tests/handoff-test.mjs` 绿）。
2. 单独立项「词汇一致性」（v0.4.0 级别）：**V2+V3**（配置键改名，带迁移与文档）、**V5**（通知前缀）、**V6**（跨层渲染器名）。
   设计、影响面引用计数与待定项见 `.codestable/issues/2026-10-05-vocabulary-consistency/vocabulary-consistency-design.md`。
3. **V4 已决**：四层「立即执行」动词各自描述本层动作，不统一；已写入规范文档 §5 D1，不再当残留看。

不把 V2/V3 的破坏性改名夹进 A1：A1 是 feat（autolearn 要发 v0.3.2），配置键改名是另一件事，混在一起会让「一次提交可自证」失效，也难回退。

## 11. 附录：本设计的现场数字怎么复现

数字不是估的，探针跑在 `tests/harness.mjs` 的 `loadNamespace` 上（临时脚本，未入库）：

```js
// /tmp/probe.mjs —— 用法: node /tmp/probe.mjs（仓根不变时路径写死即可）
const ROOT = "/…/Projects/pi-project-context";
const { loadNamespace, PC } = await import(`${ROOT}/tests/harness.mjs`);
const { buildPrompt } = await loadNamespace(`${PC}/autolearn/prompt.ts`);
const inv = await loadNamespace(`${PC}/autolearn/inventory.ts`);
const skills = await inv.collectSkills(`${ROOT}/.agents/skills`, "project");

// 正文总量与单条大小
console.log(skills.map((s) => [s.name, s.body?.length ?? 0]).sort((a, b) => b[1] - a[1]));

// 提示词长度：含正文 / 不含正文（后者即设计 A 的第一轮）
const sessions = { ids: [], index: "", evidence: "" };
const memory = "M".repeat(4000), context = "C".repeat(2000);
console.log(buildPrompt(ROOT, memory, context, skills, sessions, {}).length);
console.log(buildPrompt(ROOT, memory, context, skills.map((s) => ({ ...s, body: undefined })), sessions, {}).length);

// 实际被注入的集合与总长
console.log(inv.learnedBodiesText(skills).length);
```

复现结果（2026-10-05，本仓 master）：正文合计 96,975；注入 4 条合 18,857；提示词 32,057 / 13,149；清单 3,594。
若这些数字随技能增长而变，设计结论不变（覆盖率与量级），但 §1 的数字要重新跑一遍再引用。

## 决定（2026-10-06，owner 定：暂时保留）

**B1′ 分层暂不实现，直到出现实验结果或证据。** 现有一侧事实是**形状**：`.agents/skills/` 的 18 个技能里 6 个 ≥ 8,000 字符
（最大 13,584），而正文是按需拉取（v0.3.2），清单注入上限 8,000、本仓清单 3,810 **未触顶**。
缺的是**成本事实**——没有任何一次「拉取大技能正文造成实际损失」的记录；按仓规，缺成本事实就不实现。

**重开条件**：任何一次会话或审计记录到「拉大正文造成实际损失」（被迫放弃任务、上下文被打爆等）⇒ 按 fork 4/5/6 的既定答案实现
（单一 present 文件入口 ≤6,000 字符、只允许一层 `references/*.md`、单篇 ≤20,000、一次 ≤5 篇、`inspectSkill` ≤2、触发式）。
