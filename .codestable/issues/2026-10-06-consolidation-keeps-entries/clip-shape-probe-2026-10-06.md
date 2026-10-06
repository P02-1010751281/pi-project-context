# cap 裁剪调查（含 2026-10-06 复核实测）：结论是「不成立、不改代码」

> **2026-10-06 复核结论（本文件第二节的旧判断已被推翻，保留在下方以便追溯）**：
> 上轮把「扩展自己的裁剪产物被当外部编辑收进 journal」记成**单构建内的自我采纳回路**，并用它论证「统一裁剪器（③）」。
> 本轮把写路径读到底 + 在真机上量了 8 个仓库，**该机制不成立**，③/①/② 三条都不该做。详见第 3 节。

## 1. 现场量测：裁剪路径今天没有触发

用 `tests/harness.mjs` 的 `loadNamespace` 读各仓 `memory.jsonl` 折叠、并与盘上的 `MEMORY.md` 逐字节比对（脚本 `/tmp/eval-clip-decision.mjs`）：

| 仓库 | cap | 文件字符 | fold 字符 | 文件条 | fold 条 | fold 能否解析成四段 | fold≠文件 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| pi-project-context | 32000 | 30223 | 30223 | 109 | 109 | 是 | 否 |
| Quantum_Matrix | 32000 | 25525 | 25525 | 151 | 151 | 是 | 否 |
| UniField | 36000 | 17985 | 17985 | 168 | 168 | 是 | 否 |
| pi-custom-providers | 32000 | 26727 | 26727 | 68 | 68 | 是 | 否 |
| 形式化证明 | 32000 | 18688 | 18688 | 92 | 92 | **否**（`Project facts|…`） | 否 |
| HWCup-Math-A | 32000 | 14394 | 14394 | 82 | 82 | **否**（中文段名） | 否 |
| VQ-TTS | 32000 | 5546 | 5546 | 49 | 49 | **否**（`目的与性质|…`） | 否 |
| CipherCat | 32000 | 2220 | 2220 | 11 | 11 | **否**（`Project Overview|…`） | 否 |

两个要点：

- **0/8 超限**（最接近的是本仓 30223/32000 = 94%），因此 **fold 与文件逐字节相同**——读侧裁剪在任何现场仓库都没有触发过。
- 四个「不能解析成四段」的仓库不是被裁坏的：它们的文档**本来就用外来段名**（旧工具导入的 schema），opaque 路径对它们是设计意图，不是缺陷。

## 2. 【已推翻】上轮的三段判断（保留原文以便追溯）

> ~~读侧 fold 掐中段 ⇒ 段头消失 ⇒ opaque ⇒ 账目失效~~；
> ~~写侧 render 与读侧 fold 不是同一个裁剪器~~；
> ~~扩展自己的裁剪产物被当外部编辑收进 journal（自我采纳回路）~~；
> ~~于是建议 ③ 统一裁剪器~~。

合成探针（55,050 字符四段日志折叠成 31,796 并丢掉 `## Pitfalls` 段头、`sectionsFromMarkdown` 返回 undefined）本身**可复现**，
但它只证明「**当 journal 里存在一个超限 op 时**」会这样——见第 3 节。

## 3. 复核：为什么「自我采纳回路」不成立

### 3.1 单构建内，journal 与文件由同一个裁剪器产出

`memory/pass.ts`：`memoryTextFor(resolved, render)` = `render ? render.text : resolved.result.memory`，而 `render` 是
`renderMemoryDocument(resolved.sections, cap)`——**同一份 `render.text` 既作为 `recordMemoryDocument(text)` 进 journal，又被写成 `MEMORY.md`**。
`renderMemoryDocument` 按构造保证产物 ≤ cap，所以 `recordMemoryDocument` 内部的 `normalizeMemoryReply`（→ `normalizeMemoryDocument`，只在超限时掐）
对它是**空操作**。于是 journal 尾 == 文件 ⇒ `renderKey === foldedView` ⇒ **采纳分支不进入**。

### 3.2 两个 renderer 的产物只在超限时才可能不同，而现场没有超限

把 v0.4.3 的 `sections.ts` 取出（`/tmp/rev043/sections.ts`，相对 import 改写为绝对路径）与 HEAD 版对同一份 sections 各渲一次：

```
输入：现场 MEMORY.md 30223 字符，四段=yes
HEAD renderer   : 30223 字符, sectionDropped=0
v0.4.3 renderer : 30223 字符, sectionDropped=0
两个 renderer 的产物相同? **相同**
```

（`sections.ts` 在 v0.4.3 之后确有 4 次提交，含 v0.4.5 的 `e2184af`「shares 改目标值」与 `59a53a4`「池按文档真实 body 计」——
差异只在**超限丢弃**时显现。）

### 3.3 那两条现场 `adopted` 日志是什么

`errors.log` 里确有两条：`2026-10-06T10:48:14.962Z`、`2026-10-06T11:06:53.953Z`（后者带「1 identical failure」去重标记），
journal 侧对应 `10:48:14.887` 与 `.969` 两次 `replace`（31,993 字符/138 条，29,939 字符/126 条，相隔 82ms）。
它们与 `store.ts:75-86` 的注释一致：**「Adopt an external edit (hand edit or an older build)」**——该分支按设计就承担
「盘上的文件来自别的写入者」这一情况，不是被自己的输出触发：

- 现场 pi 会话加载的是 installed clone 的模块（同一天早先的验收记录写明当时进程仍加载 v0.4.3），而 HEAD 的 renderer 已到 v0.4.5；
- **更正（2026-10-06 复核）**：本条曾写「该仓布局同时被 Codex 移植使用，本仓那 1 个 0 字节 `.lock` 即其产物」——**不成立**：
  本仓 `.agents` 下全深度 `find` 得 **0 个 `.lock`**，审计里那 19 个陈旧锁都在消费仓且已于 2026-10-04 清扫；
  Codex 侧只查到本仓的会话记录（`~/.codex` 的 sqlite 与 rollout），**没有**它写本仓记忆层的证据。

因此归因收紧为**一条**：现场进程加载的是旧模块（installed clone 的 v0.4.3，与 HEAD 的 v0.4.5 renderer 不同）⇒ 写出不同字节，
触发的是**设计内的外部编辑采纳**。

### 3.4 读侧「掐中段」还剩多少可达性

只在 journal 里存在**超限 op** 时可达（旧构建写的 op、或手写/导入的超长条目）。同一构建的稳态下
文件 == fold 且 ≤ cap，所以这一形态在本构建里不可达。它是一个**潜在形状问题**，不是现场缺陷。

## 4. 判决（按实测）

| 候选 | 判决 | 依据 |
| --- | --- | --- |
| ① 裁剪加诊断（含 opaque 路径、每次记账） | **不做** | 字节裁剪路径已有 `memoryTruncationMarker` 说明被裁；分段路径已有 `sectionDropped` / `droppedItems`；opaque 路径的「账目」在语义上不存在（外来 schema 没有四段条目概念） |
| ② 状态不裁、只裁注入 | **不做** | 触发条件是超限，现场 0/8；改动面是设计级（`loadMemory` 语义、文件可超上限、`basisKey` 对齐） |
| ③ 统一裁剪器 | **不做** | 其唯一依据（单构建自我采纳）已在 3.1–3.3 被推翻；剩余价值是 3.4 的潜在形态，无现场实例 |

## 5. 仍然值得看的一件事（不是缺陷）

v0.4.4 时代现场确实丢过条目（验收报告 `acceptance-2026-10-06-v0.4.4-not-met.md`：四次真实合并全部 `adopt=false`，每次丢 10–15 条），
那是**份额当上限**导致的，v0.4.5 的 `e2184af`（份额改目标 + 池借用）已修：现在只有**整份文档**超过 `maxMemoryChars` 才会整条丢。

所以真正的护栏是**余量**：本仓 30223/32000（94%）。若继续增长到触顶，丢的就只会是「整份文档塞不进」的那部分——
那是配额事实，不是 bug。要留更大余量，可调本仓 `project-context.json` 的 `maxMemoryChars`（dsh 侧该键为 40000，UniField 为 36000，本机其余 8 个仓为默认 32000）。
