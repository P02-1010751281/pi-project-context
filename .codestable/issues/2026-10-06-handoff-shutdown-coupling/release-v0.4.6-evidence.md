# v0.4.6 发布证据（2026-10-08）

## 版本与 tag

| 项 | 值 |
| --- | --- |
| 变更集 | `session_shutdown` 不再合并记忆：退出只做**不调模型的 flush**（采纳外部手改 / 按条件重发 fold），`errors.log` 键改为 `shutdown:flush` |
| 代码修订 | `c442b34..dbddb52`（`b37cb55` 代码收敛、`d87261a`+`7285eb2` 夹具与守卫、`6f66b4e` 标点门及其自检；其余为记录与记忆） |
| tag | `v0.4.6` → tag 对象 `dbf381f38f153a33752f7aa203db5652fd064302`，peeled `dbddb5201eb6966158c6c03b7ac1aeee65f56e23`（`dbddb52`） |
| 双远端 | forgejo 与 github 的 `refs/tags/v0.4.6` 均为 `dbf381f…`（`git ls-remote --tags` 实测） |
| pin | `~/.pi` 仓库 `d82656e`：`agent/settings.json` + `README.md` 的 `pi-project-context@v0.4.6`（备份 `/tmp/settings.json.before-v0.4.6-1791385774`） |
| 安装副本 | `~/.pi/agent/git/git.lentech.site/C02-1010751281/pi-project-context`：`describe=v0.4.6`，`HEAD=dbddb52`（= peeled tag），工作区干净 |
| `pi update --extensions` | `* tag v0.4.6 -> FETCH_HEAD` → `HEAD 现在位于 dbddb52` → `Updated packages` |

## 装内验证（不看版本标签，看树）

| 检查 | 结果 |
| --- | --- |
| 本版新增的守卫标记 | `store.ts:122` 命中「journal append is guarded by the append-time recheck in adoptExternalEdit」 |
| 本版新增的夹具看门狗 | `tests/consolidation-test.mjs` 命中 `process.kill(process.pid, "SIGKILL")` |
| 本版新增的标点门 | `tests/run-all.mjs` 命中 `STOP_CHARS`（3 处） |
| 装内测试 | `node tests/handoff-test.mjs` → `handoff: all checks passed.` |

## 真机 settings 探针（默认设置，临时项目）

项目 `/tmp/probe-v046-1791448188`（`git init`），未用 `-ne`/`-np`：

| 运行 | 结果 |
| --- | --- |
| `pi -p "Reply with exactly: probe-ok"` | 回 `probe-ok`；扩展已加载（写下 `.agents/memory/` 与 `session-logs/` 归档） |
| `pi -p "/memory update"` | 写下 `.agents/memory/CONTEXT.md`（317 B） |
| `pi -p "…uses tabs…确认一句"` | 正常回答 |
| 三次运行后 | 无 `MEMORY.md`、无 `memory.jsonl`、**无 `errors.log`** |

**这符合 v0.4.6 的语义，而不是缺陷**：自动 consolidation 需同时满足 ≥6 轮与 ≥5 分钟两个节流，一次性 `-p` 会话两者都不满足；
退出只做不调模型的 flush，而在一个尚无记忆文件的项目里它无事可做（不建目录、不取锁、不写）。即探针正面验证了本次发布的核心行为：
短会话不再在退出时生成记忆，也不留下错误。记忆写路径（journal 采纳/重发）由单元与 e2e 夹具覆盖，不由本探针覆盖。

## 与审查链的关系

代码层在第 6 轮 `c212fcf` 拿到过 PASS；第 7–13 轮（夹具屏障、策展、记录）全部 CHANGES-REQUESTED 且每条已修，
最后一轮未取得 PASS —— 停链理由与未闭合项见 `shutdown-flush-review-report.md` 的「收链说明」。
