---
doc_type: design
issue: autolearn-progressive-disclosure
status: draft
revision: 1
date: 2026-10-05
decides: 生产者侧按需取正文（inspectSkill ＋ 代码层「展示过才可覆盖」）与技能分层（SKILL.md ＋ references/）一并设计；单位上限、守卫严格度、存量迁移口径见 §0 待答表
supersedes: 不改 v0.3.1 的取代语义，只补它的覆盖率与成本；v0.3.1 的「整篇正文注入」在此被 §3 替换
---

# autolearn 渐进披露设计（revision 1，draft）

## 0. owner 已答 / 待答

| # | 议题 | 结论 |
| --- | --- | --- |
| 0.1 | 做 (a) 还是 (b) | **a + b 一起设计**（owner，2026-10-05） |
| 0.2 | 先给设计文档 | **是**（本文件） |
| 1 | `inspectSkill` 一次允许点名几条 | 待答（§3.2 推荐 2） |
| 2 | 代码层守卫严格度：未展示就不能覆盖（G1）／只记日志（G2） | 待答（§3.3 推荐 G1） |
| 3 | `candidate` 与 `approve` 是否也受「展示过」约束 | 待答（§3.4 推荐：候选受、approve 不受但明确告知盲写） |
| 4 | 合并时 references 可否增删改（B1 只改入口／B2 放开） | 待答（§4.3 推荐 B1） |
| 5 | 分层上限：入口 ≤2500、单篇引用 ≤20000、引用 ≤5 | 待答（§4.4 推荐值） |
| 6 | 存量 17 条是否强制分层 | 待答（§4.6 推荐：新生成按分层规则，存量按需） |
| 7 | 发布节奏：a 发 v0.3.2、b 发 v0.4.0，还是一次发 | 待答（§10 推荐分两次） |

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

## 2. 目标与非目标

**目标**

1. 任意**带标记的技能**都能被合并（覆盖率 4/17 → 17/17），且不再依赖「它的正文刚好塞得进预算」。
2. autolearn 基础提示词不再随标记技能总量增长；合并那一轮只为**点名的那一条**付正文成本。
3. 合并单位变小：入口 ≤2,500 字符，模型重写整篇时更不容易丢掉原有步骤。
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
| 第二轮（点名 1 条） | — | +≤ 该条正文（分层后 ≤2,500；未分层 ≤20,000） |
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

- 提案增加 `references: [{path, content}]`；`body` 变为**入口**（上限 `MAX_SKILL_ENTRY_CHARS`，推荐 2,500）。
- `path` 约束：必须匹配 `references/<kebab>.md`（禁 `..`、绝对路径、点文件、嵌套目录、非 `.md`）；条数 ≤ `MAX_SKILL_REFERENCES`（推荐 5）；
  单篇 ≤ `MAX_SKILL_REFERENCE_CHARS`（推荐沿用 20,000）。
- 写盘顺序：**先写 references，最后写 `SKILL.md`**。`SKILL.md` 是发布点：在它更新之前，消费者读到的旧入口只会引到旧集合。
- 初建（无既有目录）：`mkdir -p` 目录与 `references/`，写 references，再写入口。
- 候选（`candidate: true`）同样携带 references：候选文件仍是**单个** `.md`（用 `## References` 分节承载各篇），
  approve 时再拆成目录结构——这样候选的「一个人工确认的文件」形态不变。

### 4.3 合并语义（B1：合并只重写入口）

- 合并一轮：模型拿到既有**入口**正文（经 §3 按需取），整篇重写；`references/` **原样不动**。
- 入口必须仍指向所有**存在**的引用文件（§4.5 校验），所以入口重写时要保留索引表——提示词写明这一点。
- 想改引用文件时：把该文件作为点名单位（§0 第 4 项的另一半），例如
  `inspectSkill: ["pi-project-context-memory-recovery/references/triage.md"]`，第二轮注入该文件内容，模型只重写该文件。
  第一版推荐**先不做**（B1），因为「单位到文件」会让投影面与断言数翻倍；等 B1 在场上跑过一轮再决定。
- 不删除：合并永不删 references；多余引用由人在 review 时删（或在后续设计里做）。

### 4.4 上限与常量（推荐值）

| 常量 | 推荐 | 理由 |
| --- | --- | --- |
| `MAX_SKILL_ENTRY_CHARS` | 2,500 | 入口是每次触发都要吃的上下文；一屏之内 |
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
| **A + B** | 13,149 | **≤2,500** | 17/17 | 入口（引用按需） |

消费者侧另有一处独立收益：技能被触发时从「整篇 5,704 均值 / 13,207 最大」降到「入口 ≤2,500 ＋ 真正需要的那一节」。

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

| 断言 | 单侧变异（应只打红它） |
| --- | --- |
| 第一轮提示词不含任何 `<learned-skill-bodies>` | 让 prompt 照旧渲染全部 → 该断言红 |
| 点名后第二轮恰好含点名者的正文 | 第二轮不渲染点名者 → 红 |
| 未点名的既有技能不可覆盖（gate） | 去掉 `shownNames` 条件 → 红 |
| 未点名的既有技能不可覆盖（写入路径，独立于 gate） | 只改 gate → 写盘断言红（两道判定各自可钉） |
| 候选不得为「未展示」的既有名字落盘 | 同上 |
| approve 覆盖时文案说明是盲写 | 文案改回旧串 → 红 |
| 分层技能写盘＝先引用后入口（记录 mkdir/写序） | 换序 → 红 |
| 入口提到不存在的引用 → 拒绝并点名 | 去掉死链校验 → 红 |
| 存在未被入口提到的引用文件 → 拒绝并点名 | 去掉孤儿校验 → 红 |
| 路径约束拒绝 `../`、绝对路径、嵌套、非 `.md` | 去掉校验 → 红 |

## 8. 验收口径

1. **提示词**：探针测 `buildPrompt`，第一轮 < 14,000 字符且不含 `<learned-skill-bodies>`（现状 32,057）。
2. **覆盖率**：点名 13 条里任意一条都能完成一次合并（测试里合成样本已验证；现场观察项见下）。
3. **现场（发布后，不阻塞）**：下一次 autolearn pass 的提示词长度落在 13k 量级；首个真实「点名 → 合并」事件的
   通知是 `Updated project skill:`。若长期没有真实事件，这仍是**未被现场验证**的能力（与 v0.3.1 的取代能力同一条观察项）。
4. **消费者侧（B）**：headless 会话触发一条分层技能时，能读到 `references/...`（相对路径解析成功）。
5. `node tests/run-all.mjs` 15/15 绿；断言数只增不减。

## 9. 非目标与残留

- 不做入口与引用的**内容**一致性校验（§4.5）；不做引用文件的自动删除；不做 B2（合并改引用）。
- 未分层技能的第二轮成本仍可达 20,000（单条上限内）；若某条超过 `MAX_SKILL_REFERENCE_CHARS`，点名它时整条注入会被跳过，
  该条无法被合并（回到「不可见」）——`memory-recovery` 13,207 仍在限内，尚不触发。
- 展示集合以「本轮渲染」为准：若模型点名后改主意，该名字本轮仍算已见（不撤回），这与「看到过就能改」的语义一致。
- 提示词层仍有约束（模型可能不提名就直接用旧名提案），代码层守卫是兜底；被拒时只记 `logError` 不打扰用户（自动 pass 静默）。

## 10. 实施切片与发布

1. 切片 A1：schema ＋ prompt ＋ 展示集合 ＋ gate/写盘/候选守卫 ＋ 测试（可独立发布，解决覆盖率与 59% 成本）。
2. 切片 B1：分层提案形状 ＋ 路径/上限/死链与孤儿校验 ＋ 多文件写盘 ＋ 候选分节与 approve 拆分 ＋ 测试。
3. 发布建议：A1 → v0.3.2（feat），B1 → v0.4.0（技能形态变化，minor）。两者都需 **重启 pi**（行为在 `extensions/`）。
4. 每片独立提交（行为／文档／技能各一片），保持「一次提交可自证」。

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
