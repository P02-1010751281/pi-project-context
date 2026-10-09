# v0.4.9 发版证据（2026-10-08）

**本文件取代 2026-10-08 早先那份 v0.4.9 证据**：那一版发布在残留台账收完之前就被撤回（tag 双远端删除、
`~/.pi` pin 回退到 `v0.4.8`、提交 `b5083dd`），本次是重发。撤回与重发的差别不是 tag 名，而是**这一轮把残留收完了**：
回复侧接受面按第 22 轮的路线 B 定形、存储侧按实质判断、只读注册表访问可选，并把这一族的边界交给独立审查跑到 PASS。

## 发布内容（相对于 v0.4.8）

- `hasMemoryDocumentShape`：不透明回复的接受面 = **本扩展自己的文档形状**（顶格的 `## <已知小节名>` 标题 + 其下顶格的 `- ` 条目，围栏内不算），
  与 `isHeadingOnlyDocument` 共用 `sections.ts` 的 `readFenceLine` / `fenceCloses`；
  手写的宽 markdown 子集（ATX 任意级别 / setext / HTML / 编号 / 缩进 / 候选段落行）整体删除（回顾见报告第 22 轮节）。
- `endsSectionScope`：另一 ATX 标题、setext 下划线（`=+` / `-+`，允许 0–3 格缩进）、任何以 `<` 开头的行都结束小节作用域；
  换行先按 `LINE_SEPARATOR_RE` 归一化；列表标记剥离只在围栏外、且支持嵌套。
- 存储侧从「必须是规范四节」放宽为「能解析成四节 **或** 剥离标题后 ≥ 40 字符」⇒ 手写的非规范记忆（现场那份六节文档）同样受保护；
  只读路径不再假定 `modelRegistry.find` 存在；SIGKILL 失败路径只留诊断 artifacts。
- 形状判定另有 `tests/sections-test.mjs` 的 13 条纯函数契约（CRLF 归一化、围栏跳过与 `{0,3}` 边界在端到端路径上不承重，
  故钉在 unit 契约上）。

## 发版核对

| 项 | 值 |
| --- | --- |
| 被审修订（PASS 给出时） | `99c9e74`，独立审查第 26 轮 **VERDICT: PASSED**（0 blocking / 0 important / 3 nit） |
| PASS 之后的提交 | `33f27a4`（一处注释 + 两条 unit 用例 + 记录措辞）、`9591216`（CHANGELOG 措辞）；`git diff 99c9e74 9591216 -- extensions/` **只有注释 hunk**（行为承载代码逐字未变） |
| 发布提交 / 分支 | `9591216`，`master` 已推 `origin`（bcc3c8e..9591216） |
| 注释标签 | `v0.4.9` = **tag 对象 `c6b3a12249b0e23e28ce8ad0959ee603f6b9f964`**，peeled **`9591216`** |
| 双远端 | forgejo 与 github 镜像的 `refs/tags/v0.4.9` 都回报同一个 tag 对象 `c6b3a12…` |
| `~/.pi` pin | 提交 `866cce1`（`agent/settings.json` + `README.md` 各 1 处 → `v0.4.9`），已推 `pi-config`；`agent/settings.json` 备份 `/tmp/settings.json.before-v0.4.9-*` |
| 安装树 | `HEAD = 9591216`（peeled 一致）、`describe --tags` = **`v0.4.9`**、工作树干净 |
| 安装树标记 | `hasMemoryDocumentShape` 1 处、`endsSectionScope` 2 处、`stripListMarkers` 2 处 |
| 真实设置探针 | `/tmp/probe-v049-1791516829`：扩展加载、写出 `.agents/memory/session-logs/`（`INDEX.md` + `.gitignore` + 会话目录）、**无 errors.log**；**无** `MEMORY.md` 与 journal —— 与预期一致（自动合并要 ≥6 轮且 ≥5 分钟，`pi -p` 是一次性） |

## 发版时发现并处理的一件事（值得记）

安装树里**残留着上一会话那个已撤回的 `v0.4.9` 本地标签**（tag 对象 `f009fef`，比 HEAD 早 19 个提交）：
远端删除 tag 不会清掉克隆里的本地 tag，`fetch --tags` 也不会覆盖同名的既有 tag，于是 `describe --tags` 报 `v0.4.9-19-g9591216`，
看起来像「安装的比 tag 新」。处理：在克隆里 `git tag -d v0.4.9` 再 `fetch --tags`，`describe --tags` 才回到 `v0.4.9`。
**教训**：撤回一次发版后，消费端（安装树）也要显式清本地 tag，否则 describe 会撒谎。

## 这次探针没有覆盖什么

- 探针只证明「默认设置下扩展会加载、会写归档产物、不写 errors.log」，**没有**覆盖自动合并（6 轮 / 5 分钟门槛）、
  不透明回复的接受面（需要真实辅助模型回复）与 handoff 阈值：这些靠 `tests/run-all.mjs`（15 个测试全绿）与
  独立审查第 26 轮（PASSED）覆盖。
- **本机仍在运行 v0.4.9 之前的模块**：运行中的宿主不会热替换，`errors.log` 里的混合版本噪声要等重启才消失。

## 仍然具名的接受面代价（不是缺陷）

setext / HTML / 编号列表 / `* ` / 缩进条目 / 未知小节名的回复**不被写入**（记忆保留 + 一条 `not a writable memory document` 诊断）——
这是第 22 轮路线 B 的刻意取舍；围栏缩进边界也刻意放宽（多隐内容 ⇒ 多拒，注释已具名）。
首次写入不受影响：存储侧不是文档时，任何形状的回复都照常发布。
