# 发布证据 v0.4.10（issue `2026-10-09-handoff-baseline-residual` 的收尾）

- **实现提交（按顺序）**：`e23620d`（② re-anchor 首版 + 残余收口）、`9d0ef59`（② 按 R9 I-1 收紧为 `2 × Δchars`）、
  `44f7104`（⑥ 压缩前记录不作样本 + 措辞）、`1952178`（记忆读路径 ctime —— **R10 冻结的最后一版代码提交**）。
  发布 tag v0.4.10 落在其后的文档提交 `7b38cf4` 上（上一版本文此处把 `44f7104` 的信息挂在了 `1952178` 上，已改正）。
- **独立审查**：lane A 第 10 轮，冻结 `1952178`，`VERDICT: PASSED`（0 blocking / 0 important / 6 nit）；
  抄本 `baseline-residual-review-round10-{independent,prompt}.txt`，6 条 nit 的收口见 `review-report.md`。
- **Post-PASS 说明**：`1952178` 之后的提交只改 CHANGELOG / review-report / design / `docs/handoff.md` / `docs/architecture.md` /
  一个 skill 与 `threshold.ts`、`store.ts` 的**注释**；去注释（`//` 与 `/* */`）后两文件与 `1952178` 逐字节相同 ⇒ 被 PASS 的行为没有变化。
- **发布 tag**：`v0.4.10`（注释 tag 对象 `6ba099c68f48b38e6323938d0df31727e9d0fc51`），peeled commit `7b38cf40774bbebab0446f872c53563eee214417`。
  两个远端都报 tag 对象与 peeled commit（forgejo `C02-1010751281` 与 github 镜像 `P02-1010751281`，`git ls-remote --tags` 验证）。
- **pin**：`~/.pi` 的 `agent/settings.json` 与 `README.md` 从 `@v0.4.9` 提到 `@v0.4.10`（提交 `d5f6de0`，已推 pi-config），
  `pi update --extensions` 输出 `HEAD 现在位于 7b38cf4`。
- **已安装克隆**：`~/.pi/agent/git/git.lentech.site/C02-1010751281/pi-project-context`
  - `git rev-parse HEAD` = `7b38cf4` = peeled tag ✓；未提交 0 项 ✓；
  - `git fetch --tags` 之后 `git describe --tags` = `v0.4.10`（fetch 前是 `v0.4.9-32-g7b38cf4`：本地 tag 未建，符合 release skill 的 gotcha）；
  - 标记串命中：`renderChangedAcrossRead` 2 处（`memory/store.ts`）、`compactionTime` 2 处（`handoff/threshold.ts`）；
  - 该克隆自己的 `node tests/handoff-test.mjs` ⇒ `handoff: all checks passed.`
- **真机探针**（默认设置、一次性会话、`/tmp/probe-release-1791944534`）：`pi -p` 返回 `ok`，模型计费 `input 24,072 + cacheRead 1,024`（无 402/429）；
  扩展侧产物：`.agents/memory/session-logs/INDEX.md` 与 `01a13837-…/session.{md,jsonl}`、两个 `.gitignore` 均生成 ✓
  （新沙箱没有 MEMORY.md，故没有注入块 —— 这一项的端到端差异由本 issue 的 probe/ctl 沙箱读数承载：17,763 / 11,018）。
- **需要重启**：运行中的 pi 进程仍载旧模块，`MEMORY.md`/交接面要等重启后才走 v0.4.10 的代码。
- **重启前的核实（2026-10-14T02:2xZ，发布后复查）**：托管本会话的 pi 进程 `pid 614239`（`args=pi`）启动于 **2026-10-13 09:47:36**，早于本次安装
  （clone HEAD 提交 `7b38cf4` 10:19:42、`pi update` 的 fetch 10:22:14）⇒ 磁盘上是 v0.4.10、内存里仍是旧模块。
  10:25:39 的那个会话边界（上一会话 `01a137f2` 写出 `HANDOFF.md`、新会话接手）**不是重启**：同一进程内 `ctx.newSession` 的会话替换，
  `errors.log` 10:25:47 的 `[autolearn] … stale after session replacement or reload … ctx.newSession(` 即其痕迹（该条是辅助调用失败，非机制错误）。
  该边界发生时上一会话用量约 19%：成功交接不落盘记录，因此「自动阈值还是操作者手动 `/handoff now`」**无法从现有 artifact 判定**，此处不结论。
  复核方式：重启后看 `MEMORY.md`/`CONTEXT.md` 的 mtime 是否晚于 10:22，以及 `errors.log` 是否只有辅助调用类条目。
