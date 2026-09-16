---
doc_type: issue-report
issue: 2026-09-16-handoff-language-and-replay
status: confirmed
issue_path: quick
severity: P3
summary: handoff 提示词脚手架硬编码英文，且逐字重放窗口会把上一会话的旧 handoff 提示词原样带进新会话；owner 要求按对话语言渲染并过滤重放
tags: [handoff, i18n, replay, ux]
---

# handoff 语言与重放窗口 Issue Report

## 1. 现象

owner 在 `pi-project-context` 会话中提出两个问题（原话）：

1. 「而且为啥 handoff 是英文的？」——交接提示词脚手架（preamble、`## Handoff Summary`、
   `## Previous session details`、`Continue the task from where it left off.`）是英文，
   而对话是中文。
2. 「当前会话怎么出现了：<一段 16% 的旧 handoff 摘要（rounds 1–21 / HEAD 6818935）>」——
   新会话开头出现了上一代 handoff 提示词，内容早于当前实际状态（journal 批次 `e4d48c4`）。

## 2. 证据（transcript 逐条比对）

- 会话 `01a0a7a9`（journal 批次）entry 81 与当前会话 `01a0a7b1` entry 3 **字节完全一致**：
  `len=7601`、`sha256` 前 12 位 `2fbe4159f558`（同一段 16% 提示词）。
- `01a0a7a9` 的 keep 窗口切点正好落在 entry 81；`01a0a7b1` 的重放块 = `01a0a7a9`
  entries 81–125，随后 entry 47 才是本次交棒注入的 13% 提示词。
- `01a0a7b1` 内 16%/13% 文本的出现位置与 `parentId` 链证实：旧提示词来自重放而非重新注入。

## 3. 影响

- 新会话开局即出现「描述已被取代状态」的旧摘要，模型需先核对才发现过期，浪费上下文并容易误判。
- 中文用户的交接提示词/摘要标题为英文，体验与语言不一致。

## 4. owner 决定（2026-09-16）

回复「1+2+3」，即：

1. 按对话语言渲染 handoff（`handoffLanguage: auto/zh/en`，含摘要标题指令）；
2. 重放窗口过滤旧 handoff 提示词；
3. 处理部署说明（当前安装 ref 为 `@v0.1.2`，新代码需 push + `pi update` 或本地 `-e`）。

## 5. 验收标准

- `auto` 下中文会话产出中文脚手架 + 中文摘要标题（标题由 `localizeSummaryHeadings()` 确定性映射，
  不再依赖模型服从；正文语言仍由 focus 指令驱动）；`zh`/`en` 可显式锁定。
- 重放切片不再携带旧 handoff 提示词；真实旧文本（`2fbe4159f558`）可被识别并过滤。
- 全部测试通过；独立审查无 blocking；已装版本说明清楚。

### 补充验收（C3 + C2，2026-09-16）

- 无操作交棒不再静默：空会话 / 全在 keep 窗口内 → warn notify；auto 路径 30s 冷却不重复告警。
- 真 TUI 自动阈值触发路径实跑成功（非 force），子会话注入提示词与 `HANDOFF.md` 标题全中文。
