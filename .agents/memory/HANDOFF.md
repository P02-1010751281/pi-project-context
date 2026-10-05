# pi 会话 01a107b7-62eb-707e-a185-56fc3648a868 的交接文档

- 生成时间：2026-10-04T16:47:50.453Z
- 项目：/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context
- 会话日志：.agents/memory/session-logs/01a107b7-62eb-707e-a185-56fc3648a868/session.md
- 会话索引：.agents/memory/session-logs/INDEX.md

## 目标
- 在 `pi-project-context` 仓实现 autolearn 管线的「更新/合并既有技能」能力，范围**严格限定为 autolearn 自己生成的技能**，不得影响手写/legacy 导入的技能。
- 该能力需**跨机器生效**（来源标记随 git 走）。
- 附带完成本轮已验证的历史工作（v0.3.0 命令面收束 + 配置一次性迁移）的收尾与核对。

## 约束与偏好
- 回复简体中文短句；本仓提交英文 Conventional Commits；零 npm 依赖。
- 测试入口 `node tests/run-all.mjs`（15 个文件，**只加断言不加测试文件**）；变异验证要求**单侧变异**（改共享函数两侧一起变，不会打红等式断言）。
- 双推 forgejo + github，每次 `git ls-remote` 校验；保护分支**禁 force-push**；只加显式路径，禁 `git add -A`。
- `.agents/memory/*` 是震荡文件：**禁用 edit 工具**，用 python + 唯一锚点；其脏状态是预期，渲染间抖动不提交。
- 兄弟仓/消费仓产物只读；**不得把其测量值或易变状态写进 MEMORY.md/CONTEXT.md/docs/CHANGELOG.md 及 tracked 技能**（作为反例也不行）；这类实测只进 `.codestable/`。
- 删用户面命令需设计文档 + 现场事实；设计文档实现后改 `status: design-frozen` 并在 banner 记实现提交。
- 技能 description ≤170 字符；docs 正文行 ≤160 字符（`docs/*.md`，表格行例外）。
- 落盘正文用中文（CodeStable 约定）。

## 进展
### 已完成
- [x] v0.3.0 全部发布与核对完毕：行为提交 `0399e04`（+569/−259，16 文件）、文档+CHANGELOG `463ee07`、技能 `4f1e26b`、tag `v0.3.0` obj `1812148c06c6` peeled `4f1e26b8a14d`（双推一致）。
- [x] 证据与设计冻结：`release-v0.3.0-evidence.md`、设计文档 revision 7 `design-frozen`（`392732f`）、去 draft 标签（`f962cd8`）。
- [x] `~/.pi` pin bump `292f3b1fcef8`（`@v0.3.0`，`agent/settings.json` + `README.md`），`pi update --extensions` 已跑，安装副本 `describe v0.3.0 @ 4f1e26b8a14d`，0 脏。
- [x] `docs(memory)` 刷新（`fb766ed`）；补 `fix-note.md`（`480e145`）；修正 fix-note 里 autolearn 非目标表述（`e118782`）；发布技能补两条规则（`89bdded`）。两支远端 master 曾至 `89bddedc0e5d`。
- [x] 核对到：`.agents/skills/` 有三类技能写入者 —— autolearn（`candidate.ts:93`、`pass.ts:176`）、legacy 导入（`shared/migrate.ts:99-101`）、手写；`SkillInfo` 原本无来源字段。
- [x] 确认 pi 文档 `.../pi-coding-agent/docs/skills.md:43`：启动只注入 name/description/path，**不注入正文**；`skills.md:85`：无 description 的技能不加载、未知 frontmatter 键是未定义行为。
- [x] 代码已改（**未提交**）：
  - `autolearn/skill.ts`：新增 `PROVENANCE_PATTERN = /<!--\s*autolearn-generated[^>]*-->/g`、`PROVENANCE_COMMENT`、`autolearnProvenance(raw)`、`withoutAutolearnProvenance(body)`、`skillBody(raw)`、`promotedDocument(name, description, body)`；`SkillInfo` 加 `autolearn: boolean; body?: string`；`skillDocument(skill, false)` 走 `promotedDocument`。
  - `autolearn/inventory.ts`：`collectSkills` 检测标记、project+learned 时带 `body`；`inventoryText` 输出 `(project, learned)`；新增 `learnedBodiesText(skills)`，预算 `AUTOLEARN_LEARNED_BODY_CHARS = MAX_SKILL_BODY_CHARS`（整篇才收，放不下就跳过）。
  - `autolearn/candidate.ts`：`rejectionReason` 允许重用 learned project 技能名；`approveCandidate` 目标带标记→覆盖并 `Updated project skill:`，否则照旧拒绝；`candidateBody` 改为复用 `skillBody`。
  - `autolearn/pass.ts`：发布路径读 `readOptional(destination)`，无标记→拒绝，有标记→覆盖，通知 `Updated`/`Learned`。
  - `autolearn/prompt.ts`：改写两条规则（learned 例外 + 名字重用），新增「更新要保留仍成立的步骤，做不到就什么都别提」，新增 `<learned-skill-bodies>` 段（非空才加）。
- [x] 测试已改（**未提交**）：`tests/autolearn-test.mjs` 新增「the autolearn prompt allows reusing a learned name only」断言、D 段改为手写技能 `handmade-workflow` 撞名、新增 E3 段（标记存在/不进 frontmatter、就地覆盖、Updated 通知、合并提示词带正文与 `(project, learned)`、手写正文不进提示词、标记只有一份、approve 覆盖 learned / 拒绝手写）。

### 进行中
- [ ] **E3 两条断言失败待修**：`FAIL a learned skill is superseded in place`、`FAIL the update is announced as an update`（其余全 OK，`FAILURES: 2`）。
- [ ] 调试打印仍在测试文件里待删：`console.log("DEBUG notify:" ...)` 与 `console.log("DEBUG doc:" ...)`（插在 `const updatedDoc = await readFile(alphaFile, "utf8");` 之后）。

### 受阻
- 失败根因已定位：DEBUG 输出显示 `["Autolearn: rejected \"alpha-workflow\" (body too short)","warning"]` —— E3 里 `mergedBody` 只有 ~110 字符，低于 `MIN_SKILL_BODY_CHARS = 160`（`autolearn/skill.ts`）。
- 修正方向：把 `mergedBody` 加长到 ≥160 字符（例如追加重复句子），无需改代码。

## 关键决策
- **来源标记用 in-file body HTML 注释，不用侧挂 JSON**：侧挂 JSON 是对账保证，条目漂移时会把「删掉后被手写占用的同名技能」误判成自己的 → 静默覆盖手写文件；标记跟文件同生共死，是结构保证。且 pi 不注入正文，标记不占会话提示词。
- **fail-closed**：读不到标记就当作非 autolearn 生成，退回 add-only。
- **合并语义**：把 learned project 技能的**整篇正文**放进 `<learned-skill-bodies>`（放不下就整条跳过，绝不给截断正文），模型看见最新正文后整篇重写，从而保留人工改动。
- **标记格式**：`<!-- autolearn-generated: this skill may be superseded by a later autolearn pass -->`，放 body 不放 frontmatter（未知键是未定义行为）。
- **autolearn 结构性限制的现场事实存在**（近重复候选被晋级技能取代；晋级技能正文带兄弟仓测量值只能事后手改），阻塞点是来源标记与合并语义两个决策，不是缺证据。

## 下一步
1. 删掉 `tests/autolearn-test.mjs` 里两行 DEBUG `console.log`。
2. 把 `mergedBody` 补到 ≥160 字符，重跑 `node tests/autolearn-test.mjs` 直至 `FAILURES: 0`，再跑 `node tests/run-all.mjs`（应 15/15）。
3. 做单侧变异验证（至少三组，每组只打红自己的断言）：① 去掉 `rejectionReason` 的 `autolearn` 条件 → 手写撞名断言红；② `pass.ts` 发布路径改回「已存在一律拒绝」→ 就地覆盖/Updated 断言红；③ 去掉 `learnedBodiesText` 段 → 合并提示词带正文断言红；④ `approveCandidate` 永不覆盖 → approve 覆盖断言红。做完还原。
4. 更新 `docs/configuration.md`（autolearn 段：learned 技能可被覆盖，范围仅限本管线生成的）+ `CHANGELOG.md` 新增 v0.3.1 + `.agents/memory/MEMORY.md` 修正「additive-only」不变式（用 python + 唯一锚点，单独 `docs(memory)` 提交）。
5. 发布：annotated tag `v0.3.1` + 双推 + `git ls-remote` 校验 + `~/.pi` pin bump（`agent/settings.json` + `README.md`，先备份 settings）+ `pi update --extensions` + 校验安装副本（HEAD=peeled、0 脏、grep 新标记串）+ 写 release 证据到新 issue 目录 + 提醒**重启 pi**（v0.2.3、v0.3.0、v0.3.1 都还欠这一次重启）。
6. 可选：为本次能力建新 issue 目录（design + fix note），遵守「一个 issue 一个主题」。

## 关键上下文
- 仓根：`/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context`；pin 仓 `/home/user/.pi`；安装副本 `/home/user/.pi/agent/git/git.lentech.site/C02-1010751281/pi-project-context`。
- 双推 URL：`ssh://forgejo@git.lentech.site/C02-1010751281/pi-project-context.git`、`ssh://git@ssh.github.com:443/P02-1010751281/pi-project-context.git`。
- 关键常量：`MIN_SKILL_BODY_CHARS = 160`、`MAX_SKILL_DESCRIPTION_CHARS = 1024`、`MAX_SKILL_BODY_CHARS = 20000`（`shared/limits.ts:17`，经 `shared/project-state.ts` 再导出）、`AUTOLEARN_INVENTORY_CHARS = 8000`、`AUTOLEARN_MIN_SESSIONS = 2`。
- autolearn 关键位置：gate `candidate.ts:52-53`（`skill "X" already exists` / `candidate "X" already exists`）、approve `candidate.ts:95`（`Skill "X" already exists; remove the candidate manually.`）、发布 `pass.ts:176`、技能收集 `pass.ts:76-77`（project + `globalSkillsDir()`）。
- 测试锚点：`tests/autolearn-test.mjs` 里 `const body = "## When to use\n\nUse this when refactoring the temp project.\n\n## Steps\n\n1. Step one with an exact command: \`node test.mjs\`.2. Step two with a path: \`.agents/memory/MEMORY.md\`."`；A 段用 `node test.mjs` 生成 learned 技能 `alpha-workflow`；`candidateDir = path.join(tmp, ".agents/memory/skill-candidates")` 定义在 E2 段。
- autolearn 跑测时用 `command.handler("", ctx)` 强制跑一遍；`prompts[0]` = 无证据首轮，`prompts[1]` = 带 `<session-evidence>`。
- 未跟踪管线状态：`.agents/memory/skill-candidates/`（现有一条 00:20 生成的 `pi-project-context-legacy-config-one-time-migration.md`，名字全新未撞名）。
- 工作树当前脏：4 个 `.agents/memory/*` 会话态 + 本轮 autolearn 代码/测试改动（未提交）。
- `errors.log` 末行曾出现 `adopted an externally edited MEMORY.md into the memory journal`（手改渲染已被 adoption 入 journal）。
- MEMORY 里相关旧不变式需同步：`The autolearn pipeline is additive-only ... recorded non-goal`（MEMORY.md:37）与 `Autolearn-approved skills ... drops the evidence comment`（:72）。

<modified-files>
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.agents/skills/pi-project-context-release-tag-and-pin-sync/SKILL.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.codestable/issues/2026-10-04-command-surface-convergence/fix-note.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.codestable/issues/2026-10-04-command-surface-convergence/release-v0.3.0-evidence.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/autolearn/candidate.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/autolearn/inventory.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/autolearn/pass.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/autolearn/prompt.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/autolearn/skill.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/tests/autolearn-test.mjs
</modified-files>
