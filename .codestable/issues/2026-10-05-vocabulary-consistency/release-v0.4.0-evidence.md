# v0.4.0 发布证据

日期：2026-10-05
范围：词汇一致性（V2/V3 配置键改名、V5 通知前缀、V6 跨层渲染器名）

## 提交与标签

| 项 | 值 |
| --- | --- |
| 行为提交 | `2177386`（键名＋迁移＋前缀＋渲染器名，含测试） |
| 文档提交（发布内容） | `f217e7d`（`docs/configuration.md`、`docs/handoff.md`、`README.md`、`CHANGELOG.md`、规范与 issue） |
| tag 对象 | `9e1b39d4acfd2cb5a8676d09df09d3c6c9bcae11` |
| tag 指向（peeled） | `f217e7d335e3` |
| forgejo / github | master 与 tag 均在 `f217e7d335e3` / `9e1b39d4acfd` |

## pin 与安装

| 项 | 值 |
| --- | --- |
| `~/.pi` pin | `8470e5b60cd1`（`@v0.4.0`） |
| 安装副本 | `describe v0.4.0` @ `f217e7d335e3`，脏文件 0；`memoryEnabled` 在新代码里 7 处命中、迁移映射在位 |

**需要重启 pi**（v0.3.0／v0.3.1／v0.3.2／v0.4.0 四次行为变更都欠这一下）。

## 改了什么

### V2/V3 配置键改名（破坏性）

| 旧 | 新 |
| --- | --- |
| `autoConsolidate` | `memoryEnabled` |
| `autoLearn` | `autolearnEnabled` |
| `handoffTargetTokens` | `handoffBudgetSummaryTokens` |
| `handoffKeepTokens` | `handoffBudgetRecentTokens` |
| `handoffSummaryThinking` | `handoffThinking` |
| `handoffAdaptive` | `handoffThresholdAuto` |
| `handoffLanguage` | `handoffLang` |

迁移复用 v0.3.0 的一次性机器（`legacyConfigPatch` 是唯一认识旧名处）：旧名折进新名、整份写回、旧名消失；新旧并存新名优先；
旧值是垃圾则经同一批 reader 回落默认值。

### V5 通知前缀

一层一个前缀、前缀后不重复层名：`Automatic consolidation:`／`Project memory updated:`／`Memory cap:` → `Memory:`；
`Auto handoff*` → `Handoff:`；`Session archiving:`／`Session log written:`／`Session log update failed:` → `Session log:`；
`Skill candidates:`／`No skill candidates.` → `Autolearn:`。两条豁免（写进规范）：`Usage:` 行、以及 `/project-context status` 的多行行标签。

### V6 跨层渲染器名

`statusText` → `handoffStatusLine`；`memoryStatusMessage` → `memoryStatusLine`（`memoryStatusLevel`／`contextStatusLine` 本已合规）。

## 验收

- `node tests/run-all.mjs` **15/15 绿**；`switches-test.mjs` 新增 9 条改名迁移断言（旧名折进、新名优先、垃圾旧值回落、写回后无旧名）。
- 单侧变异：从迁移表删掉 `autoLearn` 一条映射 → 只红该组两条（`old switch names fold into the new ones`、`the new names are written`）。
- 旧名全仓扫（`extensions/`、`tests/`、`docs/`、`README.md`）只剩三处**有意保留**：迁移映射表、测试夹具、文档的迁移对照段。

## 已知影响与残留

- **与 dsh 的关系（口径已订正，见 `1a958ce`／`0f424b9`）**：这 **7 个改名两仓同名** —— dsh 改的是同样七个拼写，两仓配置面**不在拼写上分叉**。
  差别在**回退**：本项目旧名在首次读配置时一次性迁移（`legacyConfigPatch`），而 dsh **不读别名**，所以 dsh profile 里残留的旧拼写必须自行改掉（在宿主重启前）。
  pi 侧与 dsh 真正不同的键是 `handoffMode`／`handoffGuard`／`autolearnAt`（对应 dsh 的 `handoffPendingQuestion`），与本次改名无关。
- `docs/` 与 `README.md` 的示例、`docs/handoff.md` 的预算公式用词已同步；CHANGELOG 记 v0.4.0 为破坏性变更。
- 规范 `.codestable/reference/vocabulary-conventions.md` §5 K/P 已从「待落地」改为「已落地」，审计历史补一条。
- 现场待观察：`/memory` 与 `/project-context status` 的 memory 行是否逐字一致（断言已钉，现场再确认一次即可）。
