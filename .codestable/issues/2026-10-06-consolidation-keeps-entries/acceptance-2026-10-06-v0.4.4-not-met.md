# v0.4.4 验收结论：未通过（提示层不够，卡点在段配额）

日期：2026-10-06
方法：用 **v0.4.4 冻结代码**（`git archive v0.4.4`）＋真实辅助调用（`deepseek/deepseek-flash`）＋现场输入，
在沙箱里跑真实的会话关闭合并（`session_shutdown` 的强制 pass）。判定模型按 owner 指定为 flash。

## 沙箱与复现命令

```bash
S=/tmp/pc-v044-accept
mkdir -p "$S/repo" "$S/proj/.agents"
git archive v0.4.4 | tar -x -C "$S/repo"            # 冻结的 v0.4.4 代码
cp -a .agents/memory "$S/proj/.agents/memory"        # 现场 journal / config / errors.log
git show HEAD:.agents/memory/MEMORY.md > "$S/proj/.agents/memory/MEMORY.md"   # 完整 137 条版
# 沙箱 config 关掉 autolearn，避免无关辅助调用；清掉 .lock
cd "$S/proj"
pi -p --mode json -ne -ns -np --thinking off \
   -e "$S/repo/extensions/project-context/index.ts" \
   --model deepseek/deepseek-flash "In one short sentence: what does app.ts export?" > run.json 2>&1
# 断言只看沙箱自己的 .agents/memory/errors.log 与 MEMORY.md
```

诊断跑另加了两个只写日志的探针（`pass.ts`：第一版回复的 `sectionDropped/droppedItems`；重试的
`kind/sectionDropped/droppedItems/adopt`），行为不变。

## 输入（现场完整版，`git show HEAD:.agents/memory/MEMORY.md`）

口径与渲染器一致：段花费 = Σ(entry+3)，不含 `## H` 行（改口径前本表曾多算每段的行头，数字偏大 9–14）。

| 段 | 段花费 | 段配额（cap 32000） | 差 |
| --- | --- | --- | --- |
| Project | 4,534 | 6,384 | 余 **1,850** |
| Invariants | 13,621 | 12,769 | **超 852** |
| Pitfalls | 8,220 | 7,981 | **超 239** |
| Index | 5,332 | 4,788 | **超 544** |
| 合计 | 31,707（文档 31,774 = 结构 67 + 条目 31,707） | Σtargets 31,922 / 真实 body 31,933 | 三段合计超 1,635，Project 空余足以吸收 |

`renderMemoryDocument(该输入, 32000)` → `sectionDropped=3, droppedItems=9`。

## 四次真实 pass 的结果（同一输入、同一模型）

| 跑次 | 第一版回复 | 冷凝重试 | 采纳 | 落盘后条目 | errors.log |
| --- | --- | --- | --- | --- | --- |
| 1（原始 v0.4.4） | 3 段超，丢 12 | 回复不成四段形状 → 按 opaque 判（33,093 > 32,000） | 否 | 129 | `3 section(s) exceeded their budget and 12 whole entry(ies) were dropped` |
| 2（带探针） | 3 段超，丢 15 | 3 段超，丢 13 | 否 | 128 | 同上（15 条） |
| 3（探针＋提示附「每段当前用量/超出量」） | 3 段超，丢 13 | 3 段超，丢 11 | 否 | 129 | 同上（13 条） |
| 4（同上） | 3 段超，丢 12 | 3 段超，丢 10 | 否 | 129 | 同上（12 条） |

- 四次**全部** `adopt=false`：重试的渲染 `sectionDropped` 从不为 0，所以扩展按设计保留第一版，
  写盘时渲染器把放不下的条目整条丢弃 → **每次真实丢失 10–15 条**（净条目数 137 → 128/129）。
- 跑次 3/4 是「把每段当前用量与超出量写进提示」的对照实验：**没有帮助**（模型仍 3 段超）。
- 跑次 1 还暴露一处形状问题：重试走 `call(..., allowTools=false)`，提示要求回 JSON 文本，模型于是给出
  33,093 字符的整篇文档；不成四段时按 opaque 判，用**整档上限** 32,000 裁定，比第一版更严 → 必然被拒。
  即重试用的裁判与第一版不是同一把尺子。

## 结论

1. **v0.4.4 的提示层修复不足以止住丢失**。它把「教模型删」改成「教模型压」，方向对（第四次重试比第一版少丢
   2–5 条），但模型（flash 级）在 137 条 / 31,774 字符的输入上**压不进固定段配额**，重试也从未达标。
2. **真正的绑定约束是「固定段配额 vs 本仓内容分布」**，不是总上限：Project 段空余 1,850，三段合计只超 1,635，
   总文档 31,774 < 32,000。也就是说：**总量够、分配不够**。重试的渲染文本 29,840 字符（低于 32,000）却仍
   有 3 段超配额——这条最能说明问题不是「模型输出太大」，而是「配比不对」。
3. 因此「errors.log 不再出现 section budget 行 + 条目数不缩水」这条验收**在当前配额下不可达**；不是修复
   实现错了，而是策略本身需要决定（见下）。

## 待 owner 决策（三个可选，数据已备）

| 选项 | 改动 | 今天的效果 | 代价 |
| --- | --- | --- | --- |
| **A 接受自然裁剪** | 无 | 每轮继续丢 10–15 条 | 内容持续流失（journal 仍有历史，可人工回捞） |
| **B 重配 share** | `memory/schema.ts` 四个常量 | 需要的 share ≈ Project 14.2% / Invariants 42.6% / Pitfalls 25.7% / Index 16.7%（合计约 99.3%） | 改契约（测试钉了 share 数组）；且总文档已占 99.4% 上限，零余量，任何增长再次触发 |
| **C 段间可借额度** | 渲染器（share 变软目标，硬约束退回整档上限） | 这一版 **0 丢弃**（canonical 31,774 ≤ 32,000，余 226） | 已在 v0.4.5 实现（见 `fix-2026-10-06-shares-are-targets.md`） |
| D 仅调配置 | `.agents/memory/project-context.json` 的 `maxMemoryChars` | 实测 **35,700** 才能让今天的内容装进现有 share（零余量）；**36,000** 余 47 字符 | 每个会话的注入前缀 +约 4,000 字符（约 1,000 tokens）；不治配比，只是把墙往后推 |

推荐顺序：**C**（唯一能同时不丢条目、又保留 share 作为目标的做法，且实测立即可解）→ B（若接受新配比契约）
→ D（临时缓解）→ A（下策）。

## 现场状态

- 跟踪的 `MEMORY.md`（HEAD）仍是完整 137 条版；工作区那份是渲染器裁过的版本，已 checkout 回 HEAD。
- 完整内容在 journal 里（采纳记录），所以这一轮丢失**可回捞**，不是不可逆。
- 当前 pi 进程仍是 v0.4.3 模块（进程启动 10-05 23:51，安装 10-06 14:59），所以 07:06:31Z 那次丢 21 条按旧代码计，
  不算 v0.4.4 的行为。
