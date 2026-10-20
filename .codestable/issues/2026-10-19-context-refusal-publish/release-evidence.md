---
doc_type: release-evidence
issue: 2026-10-19-context-refusal-publish
release: v0.4.14
tag_object: bb9cf5c9042b2f40c19669a5672423654a30518c
peeled: 7fce63972991ded05dffb005e3b8b51c23d49800
---

# v0.4.14 发布证据

- Annotated tag `v0.4.14`，tag 对象 `bb9cf5c`，peeled commit `7fce639`（拒绝态诊断按分支、无虚假写入/裁剪声明；
  review chain 17 轮后按 stop rule 关闭，无 PASS，残余见 review-report）。
- 双远端：`origin`（forgejo）与 `ssh.github.com:443` 的 `refs/tags/v0.4.14` 都是 `bb9cf5c`（peeled `7fce639`）；
  `refs/heads/master` 都是 `7fce639`（github 首次 push 连接被重置，重试后确认）。
- 发布前 `node tests/run-all.mjs` 15/15、`git diff --check` clean。
- `~/.pi` pin：提交 `40faf74 chore: pin pi-project-context v0.4.14`，`agent/settings.json` 与 `README.md`
  都指向 `pi-project-context.git@v0.4.14`（其余未跟踪文件未动）。
- `pi update --extensions` 后安装树 HEAD `7fce639`、本地 tag `v0.4.14`、`git describe --tags` = `v0.4.14`、
  工作树干净；`rg -c "The prompt also had to be shortened"` = 2；安装树 `node tests/handoff-test.mjs` 全绿。
- 真机探针 `/tmp/pc-v0414-probe-xwyReB`（默认设置、未用 `-ne`/`-e`）：
  `pi -p --model deepseek/deepseek-flash "Reply with exactly OK."` 输出 `OK`，生成 `.agents/memory/.gitignore`；
  无 errors.log。本次 `pi -p` 不建 session-logs（`-p` 隐含 `--no-session`）。
- **运行中的 pi 进程仍加载旧代码**（v0.4.13），需要重启/下一次 handoff 才会用到 v0.4.14。

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
