---
doc_type: release-evidence
issue: 2026-10-19-context-refusal-publish
release: v0.4.13
tag_object: f71c51ebd3ab222f5adbfceb645de798c6380c13
peeled: cdb32e94870c4ee7a602260b86a356b8647506af
---

# v0.4.13 发布证据

- Annotated tag `v0.4.13`，tag 对象 `f71c51e`，peeled commit `cdb32e9`（`fix(memory): a refused reply no longer
  publishes its context section` + 其后的 session-state chore）。
- 双远端均已推送并核对：`origin`（forgejo）与 `ssh.github.com:443` 的 `refs/tags/v0.4.13` 都是 `f71c51e`；
  `refs/heads/master` 都是 `cdb32e9`。
- `~/.pi` pin：提交 `0a34031 chore: pin pi-project-context v0.4.13`，`agent/settings.json` 与 `README.md`
  都指向 `pi-project-context.git@v0.4.13`（`~/.pi` 里其余未跟踪文件未动）。
- `pi update --extensions` 后安装树 HEAD `cdb32e9`、`git describe --tags` = `v0.4.13`、工作树干净；
  `rg -c "the refused reply's context section was not published"` = 1；安装树自带的
  `node tests/handoff-test.mjs` 全绿。
- 真机探针 `/tmp/pc-v0413-probe-Nb5u`（默认设置、未用 `-ne`/`-e`）：
  `pi -p --model deepseek/deepseek-flash "Reply with exactly OK."` 输出 `OK`，生成
  `.agents/memory/{.gitignore,session-logs/}`（该目录下 `project-context.json` 为首次读取时写入）。
- **运行中的 pi 进程仍加载旧代码**（v0.4.12），需要重启才会用到 v0.4.13；本次会话的会话替换发生在发布前，
  所以本次修复在重启前不会影响当前进程。
- 本次是运行时行为变化（拒绝态的发布面），按发布纪律打 tag；无其他内容变更。
