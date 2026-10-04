# v0.3.0 发布证据

日期：2026-10-04
范围：命令面按层收束（破坏性）＋ 配置旧形态一次性迁移 ＋ autolearn 提示词两条规则

## 提交与标签

| 项 | 值 |
| --- | --- |
| 发布内容提交 | `4f1e26b8a14dc3e13d232379a3fd1e67e45d7fb1`（`chore(skills)`，含行为提交 `0399e04`、文档提交 `463ee07`） |
| 行为提交 | `0399e04` `feat(commands,config)!: one command per layer, budget verbs, and a one-time legacy config migration` |
| 文档提交 | `463ee07` `docs(configuration,handoff): write the v0.3.0 surface, the budget verbs and the flat-only read path` |
| 技能提交 | `4f1e26b` `chore(skills): merge the retire/rename procedure into the surface audit and clean the prompt-rule skill` |
| tag 对象 | `1812148c06c602b8cf6ff8d6b573e2e18a5c12f6` |
| tag 指向（peeled） | `4f1e26b8a14dc3e13d232379a3fd1e67e45d7fb1` |
| forgejo | `ssh://forgejo@git.lentech.site/C02-1010751281/pi-project-context.git` master/tag 均在 `4f1e26b`/`1812148` |
| github 镜像 | `ssh://git@ssh.github.com:443/P02-1010751281/pi-project-context.git` master/tag 均在 `4f1e26b`/`1812148` |

## pin 与安装

| 项 | 值 |
| --- | --- |
| `~/.pi` pin 提交 | `292f3b1fcef8`（`agent/settings.json` 与 `README.md` 同步改 `@v0.3.0`，已推送） |
| 安装命令 | `pi update --extensions`（拉到 tag `v0.3.0`） |
| 安装副本 HEAD | `4f1e26b8a14dc3e13d232379a3fd1e67e45d7fb1` |
| 安装副本 `describe --tags` | `v0.3.0` |
| 安装副本脏文件 | 0 |
| 到位抽检 | 副本内 `budget summary` ×3、`takes no target` ×1、`migrateLegacyConfig` ×3、`contextStatusLine` ×1 |

**需要重启 pi 才生效**：运行中的会话仍加载旧模块，`pi update --extensions` 不会热替换已加载的扩展。

## 验收

- `node tests/run-all.mjs`：**15/15 绿**（只加断言，不新增测试文件）。
- 单侧变异矩阵（每组只打红自己的断言，共 5 组）：删/改 `/memory` 的 `Context file:` 标签 → 2 条逐行覆盖断言红；
  给 `maxTokens` 加回旧形态回退项 → 冻结断言红；让裸 `/session-log` 重新写文件 → 只读证明红；删 autolearn 跨仓边界规则 → 边界断言红；
  删形态模式规则 → 形态断言红。
- 迁移实测（本仓 `.codestable/` 存放，不写进 curated 面）：全机 9 个 `project-context.json` 均为扁平 23 键、0 个嵌套形态；
  `autolearn.json` 0 个；`~/.pi/agent/auto-handoff.json` 不存在。扁平化提交 `b5d825d`（2026-09-25）之后新增的 8 个键从来没有回退项。
- 共享 config 面的兄弟实现只读扁平键，不认嵌套形态，所以收旧形态不牵动跨仓契约。

## 行为变化（破坏性，无过渡期）

`/context` 退役；`max-memory` 与特性级 `on|off` 移入本层命令；伞形 `on|off` 不再接受目标；`/handoff` 裸比例与 `auto`/`target`/`keep`/`send`/`draft`
被 `threshold`/`budget summary|recent`/`mode` 取代；`/session-log` 无参改为只读（写走 `write`）。
配置键一个都没改，所以没有键迁移；旧配置**形态**在首次读配置时迁移一次并提示。
