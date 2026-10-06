# cap 裁剪的两个形状不同：自我采纳回路的探针证据（2026-10-06）

为「静默丢失」的候选方案做判决前的现场证据。探针脚本用 `tests/harness.mjs` 的 `loadNamespace`（与生产同一条加载路径），
造一份超上限的四段日志再逐段比对。

## 1. 读侧的 fold 会「掐中段」，把段头一起切掉

造 55,050 字符的日志（`cap = 32,000`）：

```
fold（loadMemory 出来的状态）: 31,796 字符 / 78 条
段头残留: [## Project | ## Invariants | ## Index]      ← ## Pitfalls 整个段头消失
sectionsFromMarkdown(fold) = undefined                 ← 于是本 pass 走 opaque 路径
```

后果链：`foldMemoryJournal` 用 `normalizeMemoryDocument(document, limit)`，在上限处**保留两头、切掉中间**；
一旦中段含某个 `## H` 段头，四段结构就散架，`sectionsFromMarkdown` 返回 undefined ⇒ pass 落到 opaque 分支，
**per-section 账目（`droppedItems`/`droppedSamples`）整段失效**。这与仓内 pitfall 记录的「一次回复不带 `- ` 条目，
使分段账目整段失效」是同一个机制，只是入口在读侧。

## 2. 写侧的 render 与读侧 fold 不是同一个裁剪器

`renderMemoryDocument` 按段配额 + 池借用**整条丢**（`droppedItems` 可数），`foldMemoryJournal` 按字节**掐中间**。
同一份超限日志因此产出两个不同的字节串；而 `recordMemoryDocument` 的采纳判据是

```js
renderKey !== foldedView && renderInfo.mtimeMs > journalInfo.mtimeMs   → appendMemoryOp(file, "replace", renderKey)
```

我们的 render 写在 journal 之后（mtime 更新），又与 `foldedView` 不同 ⇒ **扩展自己的裁剪产物被当成「外部编辑」收进 journal**，
裁剪于是变成状态。现场证据：2026-10-06 10:48:14Z，journal 先记 138 条的未裁剪回复、再记 126 条的文件内容，
`errors.log` 记 `memory regression: 2` 与 `adopted an externally edited MEMORY.md`。

## 3. 三个候选方案的判决建议

| 候选 | 作用 | 代价 | 建议 |
| --- | --- | --- | --- |
| ① 裁剪时留一条不受限流的诊断 | 只**看得见**，不阻止丢失；且 opaque 路径根本不走 `reached its cap` 分支（走的是 `exceeded maxMemoryChars`，同样每进程一次） | 小 | 做，但必须同时覆盖 opaque 路径，且把「每项目每进程一次」改成每次裁剪记账，否则「同一进程的后续 pass 不再留痕」这条仍在 |
| ② 只裁注入投影、状态保留未裁剪 | 唯一**从根上不丢**的方案 | 大：要改 `loadMemory` 语义、文件可否超上限、注入与 `basisKey` 的对齐，是设计级改动 | 想要零丢才做，需单独立项 |
| ③ **统一裁剪器**（读侧也走段感知分配，超限时保住四段结构） | 关掉**自我采纳回路**（自己的 render 与 fold 同字节 ⇒ 不再被当外部编辑），并让超限状态仍可解析 ⇒ 账目恢复、① 才有东西可记 | 小（改 fold 的裁剪形状 + 两条钉子：超限状态仍解析成四段；自己的 render 永不被采纳） | **推荐先做这一条**，① 作为它的补丁 |

③ 的两条钉子与单侧变异都可写：把 fold 换回 `normalizeMemoryDocument` ⇒「超限状态仍解析成四段」变红；
把采纳判据里的 `foldedView` 换成 `renderKey` 自身 ⇒「自己的 render 不被采纳」变红。
