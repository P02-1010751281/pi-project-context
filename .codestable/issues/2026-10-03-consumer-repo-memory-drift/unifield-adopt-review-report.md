# UniField 采纳版：四轮独立审校记录

- 议题：`.codestable/issues/2026-10-03-consumer-repo-memory-drift/`
- 被审工件：`UniField/.agents/memory/MEMORY.md` 的采纳候选（`/tmp/UniField-MEMORY-adopted.md`）
- 协议：`.agents/skills/pi-project-context-sandboxed-independent-review/SKILL.md`（沙箱 + 前后双快照证明零写入）
- 路由：`pi -p --no-session --no-project-context --no-skills --no-prompt-templates --tools read,bash --model "commandcode/deepseek/deepseek-v4.1-flash-fast" "$(cat TASK.md)"`

## 轮次表

| 轮 | 被审候选 | 裁决 | 该轮发现 |
|---|---|---|---|
| R1 | 26848 字符 / 130 行 / md5 `386764528978` | **CHANGES-REQUESTED** | 6 条 important：§37.90 判决规则阈值、α 预登记证伪点、§37.105 D-C 的 ✗ 裁决（且与同文件他处自相矛盾）、`R² 类必须与 dB 合取`、`shared_scale`「每行均值仍未解锁」被删；另加**我改错的数字**「54 条 §37.x」不可复现（34994 版实测 59） |
| R2 | 27133 字符 / 130 行 / md5 `7c23c888bec6` | **PASSED** | 6/6 真修复确认；独立全量重扫（108×109 条模糊匹配 + 93 个数值 token 差分 + 逐 §覆盖）未再发现 important；纠正任务描述里写错的「58 个 §37.x」。顺带提 6 条 nit |
| R3 | 27346 字符 / 130 行 / md5 `180fcff997f4` | **CHANGES-REQUESTED** | **1 条 blocking：我自己引入的回归**——N2 的插入文本落进代码跨内部，把轴串 `` `image_delta_vs_paired_baseline_db` `` 劈成 `` `imag。…留档e_delta_…` ``，违反文件自身「按轴字符串原文查 RECIPES」纪律 |
| R4 | 27354 字符 / 130 行 / md5 `2751247b7cb0` | **PASSED** | 轴串逐字复原、裁决句移出代码跨；全文件反引号奇偶全偶；§37.123 ②(A) 四要素（+3.9719 dB / `--metrics-stat best` / `>= 3.83` 桶 / 哨兵 +0.1019）与活仓 `docs/discussion-log.md` 裁决块一致；6 条 nit 判「可接受为残留」 |

**采纳写入的工件 = R4 被审工件**：`UniField/.agents/memory/MEMORY.md` 与 `/tmp/uf-mem-review-r4/candidate.md` **逐字节相同**（md5 `2751247b7cb0`，27354 字符 / 130 行）。

> 为什么是四轮而不是三轮：R3 抓到的是 **R2 通过之后**由我自己的编辑引入的回归。按协议「一个 PASSED 轮不覆盖其后的改动」，必须补一轮。这也正是该协议条款的价值所在。

## 残留（R4 逐条判定为可接受，不影响任何 裁决 / 桶 / 阈值 / 不变量 的可判性）

| 位置 | 丢失内容 | 判定理由 |
|---|---|---|
| L64 | §37.59「1.12 dB」具体禁令 | 一般禁令「禁 interior SNR 单指标」仍在；被禁数字全文件不出现 |
| L86/L87 | §37.117「外部域仅原始像素」、§37.118「6 图 / 两态 / 仅质心 / 比值依赖 patch-DC 锚点」 | 两段均带「未作判据」标签 ⇒ 不承载裁决，属仪器适用域提示 |
| L68 | 「⇒ 逃逸是配置决定」 | §37.58 逃逸格天花板 ≈15.17 dB 仍在，属解读取向非裁决 |
| L103 | `backbone==patch` 守卫**字面** | 守卫语义仍在（L19 默认 `fixed`≠`patch`；L49 门禁查「默认骨干 ≠ 协议骨干」） |
| L126 | Rule 12「判据落盘晚于探针起动」实例 | Rule 12 纪律与另两实例仍在；实例是教训非判据 |

## 零写入证明

- 方法：每轮运行前后 `md5sum -c` 校验**活仓库** `UniField/.agents/memory/MEMORY.md`；四轮均 `成功`（未被评审进程改动）。
- 已知假阳性：评审进程的**沙箱 cwd** 下会出现 `.agents/memory/{MEMORY.md,CONTEXT.md,memory.jsonl,.gitignore}` —— `--no-project-context` **不能**阻止该落盘，它是扩展自身的启动写入，不是评审侧编辑。故 `find | stat` 快照必须 `-prune` 掉 `.agents/`，否则 diff 永远非空。该条已写入 `SKILL.md`。

## provider 失败记录

- R4 第一次执行产出 **0 字节** + stderr `Request timed out.` ⇒ 按协议判为 **provider 失败、不是评审**，已重跑（第二次成功，2863 字节）。任何「空 transcript + 沙箱 diff 未变」都不算通过轮。

## 仍未修（本议题正题）

「外部编辑采纳后被旧内容覆盖」的写入顺序问题**未修、未立项**：两仓库 journal 都是「一次采纳紧接一次另一版写入，间隔 70–450 ms」，因此 QM 护栏变绿与 UF 采纳是否**守得住**仍未知 —— 下一次 consolidation pass 之后必须复查锚点。
