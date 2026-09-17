# pi 会话 01a0afb5-d802-7108-a73b-4e65665359b9 的交接文档

- 生成时间：2026-09-17T14:40:32.626Z
- 项目：/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context
- 会话日志：.agents/memory/session-logs/01a0afb5-d802-7108-a73b-4e65665359b9/session.md
- 会话索引：.agents/memory/session-logs/INDEX.md

## 目标
- 修复 `pi-project-context` 扩展记录在案但此前「接受/未修」的 4 条残余项，并查清注入的项目上下文 `CONTEXT.md` 停在 09-16 的根因（owner 回复「all」= 全做）。
- 顺带清理其它项目遗留在 `/tmp` 的陈旧临时产物（owner「all」含此项）。
- 走完整仓库流程：实现 → 测试/变异 → lane A 独立复审（只读沙箱、零写入）→ artifacts → owner 发话后提交/推送/发版。

## 约束与偏好
- owner 风格极短指令（「all」「清理干净，不要留残余等」「根治」），要求不留隐患。
- 提交信息英文（`type(scope): imperative summary` + 详细 body），artifacts/docs 中文。
- lane A 只读复审：`pi -p --no-session --no-extensions --no-skills --no-prompt-templates --tools read,bash --provider deepseek --model deepseek-v4-pro --thinking off`，`/tmp` 沙箱副本（含 `.git`），进入/退出 `git status --porcelain` 与 md5 逐轮比对证明零写入。
- 收尾前先跑 `node tests/run-all.mjs`（9 个测试文件）+ 变异-还原矩阵（每个新探针必须能变红、不旁带）。
- 后台进程会被 harness 回收 → 长任务用 `systemd-run --user --unit=... --collect`（已验证可行）。
- 不引入固定 sleep；不改 owner 的交互式 pi 进程。

## 进展
### 已完成
- [x] 上一轮清理：本项目 `/tmp` 残留 658 项 / 1.6G 已删（`/tmp` 4.8G→3.2G），3 个 `/tmp/settings.json.before-*` 一并删除并把 3 处文档引用改为「见 `pi-config` 仓库 git 历史」→ 提交 `70dbde0`；`MEMORY.md` 当前渲染提交 `cf06a2a`。
- [x] 盘点出 4 条未修残余（1 gitignore header 大小写；2 会话头 >64KB 不扁平化；3 staging-切换间崩溃 marker；4 `/project-context` 输出缺记忆状态）+ 第 5 项调查（CONTEXT.md 停更）。
- [x] 代码修复（工作树未提交）：
  - 残余1 `extensions/project-context/project-state.ts`：header 判定改为大小写折叠 `[...lines].some((line) => line.toLowerCase() === MEMORY_GITIGNORE_HEADER.toLowerCase())`（忽略模式仍大小写敏感）。
  - 残余2 `extensions/project-context/handoff.ts::readSessionHeader`：改为按 `SESSION_HEADER_CHUNK_BYTES=64*1024` 读到换行、`SESSION_HEADER_MAX_BYTES=1024*1024` 病态上限，先合并 Buffer 再解码。
  - 残余3 `handoff.ts::restoreHandoffSessionSettings`：前驱不匹配即 `clearHandoffSessionSettings(projectRoot)`（旧行为：留到 TTL）→ 语义变更，已改写原探针为 `a foreign switch drops the stage instead of keeping it`。
  - 残余4 `extensions/project-context/index.ts`：`/project-context status` 新增 `Memory: <source> (<n> chars)`（带 unreadable/poisoned/damaged 文案）与 `Context: <path> — updated <ISO> (<age> ago)`（无则 `none yet`）；新增 `memoryStatusLine`/`contextStatusLine`/`humanAge` 与 `import { stat } from "node:fs/promises"`。
  - CONTEXT.md 根因 `consolidate.ts`：prompt 明确写出 context 键与类型；`parseConsolidated` 增加 `contextUnusable` 标记（键缺失或 `null` 不算）；新增 `contextShapeWarned` Set 保证每项目每进程只记一次 errors.log；严格化 `parseContext`（`key_points`/`open_tasks` 存在但非数组即判不可用）。
- [x] 测试：`node tests/run-all.mjs` **9/9 通过**；变异矩阵 M1–M7 全部按预期变红（M4 红 3 条、M6 红 4 条为共享闸门的预期）。
- [x] lane A 第 1 轮复审完成（沙箱 `/tmp/residuals-review`，转录 `.codestable/issues/2026-09-17-recorded-residuals/recorded-residuals-review-round1-independent.txt` 10534 bytes）：**无 blocking、无 important**，5 条 minor；结论「可以发版」；沙箱 git status 13→13 行且 3 个源文件 md5 与仓库逐字节一致（零写入 ✓）。
- [x] 其余项目 `/tmp` 陈旧产物清理：删 3303 项 / 2.9G（`/tmp` 3.2G→**334M**），规则「仅删 mtime > 48h 的临时产物」，清单写至 `/tmp/residuals-cleanup-manifest.txt`；保留 `/tmp/uf-ckpt.tgz`（UniField 训练 checkpoint `best.pt`，不可重算）、48h 内条目 1019 项、root 属主/系统条目。

### 进行中
- [ ] 处理第 1 轮复审的 minor（已改代码，未跑测试）：
  - minor#1 已修：`readSessionHeader` 1MB 精确边界加 1 字节 EOF 探测。
  - minor#2 已修：`parseContext` 对存在但非数组的 `key_points`/`open_tasks` 返回 undefined（整个 context 丢弃）。
  - minor#3 已修：errors.log 文案按是否有既有 CONTEXT.md 区分（`the previous CONTEXT.md is kept` / `only a placeholder context was written`）。
  - 待办：minor#4（`MEMORY.md` 陈旧表述，建议随下个 consolidation 更正）、minor#5（`session-logs/.gitignore` 显示为删除是我 rsync 排除 `session-logs` 造成的沙箱假象，非仓库变更，需在 review.md 说明）。
- [ ] 仍需做的事：为新修的两处（1MB 边界探针、非数组列表边界探针）补测试与变异自检 → 复跑 9/9 → 写 `recorded-residuals-review.md` 与 `recorded-residuals-fix-note.md` §1–§8（草稿已写，§独立复审待填）→ 清理沙箱 `/tmp/residuals-review` 与 `/tmp/residuals-review-run.sh`、`/tmp/bgtest*`、`/tmp/stale-list.txt`、`/tmp/residuals-mutations.py` → 可选第 2 轮 closure 复审 → 提交+推送 → 报告 + 问发版。

### 受阻
- (无)

## 关键决策
- CONTEXT.md 停更根因判定：prompt 从未写出 context 键名/类型，`parseContext` 要求对象含字符串 `summary`，辅助模型 = 会话模型（`provider`/`model` 为空），形状漂移即被静默丢弃且无日志（实测 CONTEXT.md mtime 09-16 13:18 vs MEMORY.md 09-17 22:12，errors.log 仅 1 行）。修法三件：prompt 写清键、`contextUnusable` 标记、每进程一次记 errors.log；**保留**「模型没给 context 时不覆盖既有 CONTEXT.md」。
- CONTEXT.md 里的三条「记录在案残余」①②③**均已修复**（`093dbf3` 轮内切分+`SPLIT_TURN_MARKER`；`98aeedf` 的 alias-override stub + `newSession` mock；tests 只剩 `setTimeout 0`），渲染过期是「看起来还有残余」的来源。
- `/tmp` 清理规则：只删 mtime > 48h 的临时产物；CipherCat 的 `/tmp` 快照经核对为**比仓库更旧**（仓库 09-13、快照 09-12）→ 可安全删；不可重算成果（训练 checkpoint）与 48h 内条目保留。
- 残余 3 语义变更已记录：前驱不匹配的 marker 由「留到 TTL」改为「立即清」。
- 复审 minor#2 采用「严格丢弃整个 context + 记录」而非「保留半可用」，与 prompt 的「exactly these keys / discarded」措辞一致。

## 下一步
1. 为新修边界补测试：`tests/handoff-test.mjs` 加「首行恰好 1MB（文件在此结束）仍解析出根」探针；`tests/consolidation-test.mjs` 加 `parseConsolidated` 非数组 `key_points`/`open_tasks` → `contextUnusable === true`，以及缺失列表仍可用。
2. 重跑变异自检（新增/变更闸门）+ `node tests/run-all.mjs` 确认 9/9。
3. 写 `.codestable/issues/2026-09-17-recorded-residuals/recorded-residuals-review.md`（审查方式、第 1 轮表、5 条 minor 处置、零写入结论含 md5）并补 fix-note §8/§5 的处置说明。
4. 视情况跑第 2 轮 closure 复审（`systemd-run --user --unit=...`，沙箱重建）。
5. 清理我的 `/tmp` 沙箱与临时脚本；`git add` 代码+测试+issue artifacts 一次提交并推双远端。
6. 向 owner 汇报（残余逐条处置、变异矩阵、复审结论、`/tmp` 2.9G 释放与保留项）并问是否发 `v0.1.7`（发布序：双远端 push → 注解 tag → 切 pin → `pi update --extensions` → 已装副本真机探针 → 发布记录）。

## 关键上下文
- 仓库：`/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context`；当前 HEAD = `cf06a2a`（远端一致），工作树有未提交代码/测试改动 + 新 issue 目录 `.codestable/issues/2026-09-17-recorded-residuals/`（report/analysis/fix-note 已写 + 复审转录 + prompt）。
- 双远端：`origin` fetch = `ssh://forgejo@git.lentech.site/C02-1010751281/pi-project-context.git`，第二 pushurl = `ssh://git@ssh.github.com:443/P02-1010751281/pi-project-context.git`（`git push origin master` 一次推两处）。
- 已装副本：`/home/user/.pi/agent/git/git.lentech.site/C02-1010751281/pi-project-context`，HEAD = `8a2e6e4`（v0.1.6）；`~/.pi` 仓库 master = `6ae3ec3`。
- 提交链（本仓）：`7976ebb` → `8a2e6e4`（tag `v0.1.6` = 对象 `3a0a372`）→ `730edd3` → `af93fab` → `09ea0c7` → `70dbde0` → `cf06a2a`。
- 受影响文件：`extensions/project-context/{project-state.ts,handoff.ts,consolidate.ts,index.ts}`、`tests/{consolidation-test.mjs,handoff-test.mjs,switches-test.mjs}`；关键符号：`ensureMemoryGitignore`、`MEMORY_GITIGNORE_HEADER`、`readSessionHeader`、`SESSION_HEADER_CHUNK_BYTES`、`SESSION_HEADER_MAX_BYTES`、`restoreHandoffSessionSettings`、`parseConsolidated`、`parseContext`、`contextUnusable`、`contextShapeWarned`、`memoryStatusLine`、`contextStatusLine`。
- 修复后源文件 md5（复审核对基准）：`handoff.ts` d1fab706f3e8…、`consolidate.ts` e4f21ac38c2e…、`project-state.ts` 3ee5be244ee3…（已因 minor 修复再次变更，需重算）。
- 复审 minor 清单：①1MB 精确边界；②非数组列表未被抓；③无既有 CONTEXT.md 时日志文案不准；④`MEMORY.md` 陈旧表述；⑤`session-logs/.gitignore` 删除是沙箱排除造成的假象。
- 运行/工具备注：后台作业用 `systemd-run --user --unit=pc-xxx --collect`（`nohup ... &` 会被回收）；`pi` 路径 `/home/user/.local/bin/pi`；`deepseek-v4-pro` 在 `~/.pi/agent/models.json` 的 provider 为 `codecommand`（`--provider deepseek` 为可用别名，历轮沿用）。
- 上一会话原始记录：`/home/user/.pi/agent/sessions/--run-media-user-6b058d20-a617-484d-b7c6-cd7146baf77c-Projects-pi-project-context--/2026-09-17T11-33-37-234Z_01a0af24-c352-7397-8e33-77b2f8de7e6e.jsonl`（细节用 grep，勿整读）。

<read-files>
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.codestable/issues/2026-09-17-recorded-residuals/recorded-residuals-review-round1-independent.txt
</read-files>

<modified-files>
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.codestable/issues/2026-09-16-handoff-language-and-replay/handoff-language-and-replay-fix-note.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.codestable/issues/2026-09-16-handoff-residuals/handoff-residuals-fix-note.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.codestable/issues/2026-09-17-handoff-session-continuity/handoff-session-continuity-fix-note.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.codestable/issues/2026-09-17-recorded-residuals/recorded-residuals-analysis.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.codestable/issues/2026-09-17-recorded-residuals/recorded-residuals-fix-note.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/.codestable/issues/2026-09-17-recorded-residuals/recorded-residuals-report.md
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/consolidate.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/handoff.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/index.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/extensions/project-context/project-state.ts
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/tests/consolidation-test.mjs
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/tests/handoff-test.mjs
/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context/tests/switches-test.mjs
</modified-files>
