# v0.3.2 发布证据

日期：2026-10-05
范围：autolearn 按需取正文（`inspectSkill`）＋ 覆盖前提「本轮展示过」＋ 命令描述与 approve 文案

## 提交与标签

| 项 | 值 |
| --- | --- |
| 行为提交 | `997447a` `feat(autolearn): make the pass pull a learned skill's body instead of pushing every body it can fit` |
| 文档提交（发布内容） | `8b4550a` `docs(architecture,configuration): describe the ask-first body flow and cut v0.3.2` |
| tag 对象 | `afc8449c15a9e3524b398862004d9e82e4ca628d` |
| tag 指向（peeled） | `8b4550a87277` |
| forgejo / github | master 与 tag 均在 `8b4550a87277` / `afc8449c15a9` |

## pin 与安装

| 项 | 值 |
| --- | --- |
| `~/.pi` pin | `d8b4c6121215`（`agent/settings.json` + `README.md` → `@v0.3.2`） |
| 安装命令 | `pi update --extensions` |
| 安装副本 | `describe v0.3.2` @ `8b4550a87277`，脏文件 0 |
| 到位抽检 | 副本内 `inspectSkill` 在 `autolearn/schema.ts` ×2、`autolearn/pass.ts` ×3 |

**需要重启 pi**（v0.3.0 / v0.3.1 / v0.3.2 三次行为变更都欠这一下）。

## 验收

- `node tests/run-all.mjs`：**15/15 绿**；`tests/autolearn-test.mjs` 断言 **66 → 82**。
- 提示词体积（探针实测）：第一轮 **32057 → 13149** 字符；第二轮代价 ≤ 单条正文（≤20000，分层后 ≤6000）。
- 覆盖率：17 条带标记技能**全部可达**（v0.3.1 时代只有 4 条能进提示词）。
- 单侧变异矩阵（7 组，实测打红条数）：

| 变异 | 红 |
| --- | --- |
| 第二轮不注入点名正文 | 1 |
| `MAX_INSPECT_SKILLS` 2 → 3 | 1 |
| 去掉 gate 的 `shownNames` 条件 | 2（候选路径；实时路径不红） |
| 两道判定同时去掉（双侧） | 4 |
| `notShown: []` | 1 |
| approve 文案回退 | 1 |
| `inspectSkill` 移出 `required` | 1 |

- 范围抽检：写入仍然只发生在 `skillsDir(projectRoot)`；`globalSkillsDir()` 只读；手写/导入技能无标记 → 两道判定都拒绝。

## 已知残留

- **B1′（技能分层）未做**：设计已按外部证据降级（只对 ≥8000 字符的技能、只外置长细节），等 A1 现场表现后再定版。
- 现场待观察（不阻塞）：下一次 autolearn pass 的实际第一轮长度；首个真实的「点名 → 合并」事件（通知 `Updated project skill:`）。
- v0.3.1 的「存量 13 条不可达」已被 A1 解决——不需要 backfill，任何带标记技能都可以被点名取正文。
- 现行候选仍待 owner 决定：`.agents/memory/skill-candidates/pi-project-context-legacy-config-one-time-migration.md`。
