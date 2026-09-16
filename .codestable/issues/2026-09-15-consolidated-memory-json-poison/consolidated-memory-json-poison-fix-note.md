---
doc_type: issue-fix
issue: 2026-09-15-consolidated-memory-json-poison
status: confirmed
path: standard
fix_date: 2026-09-15
related: [consolidated-memory-json-poison-analysis.md]
tags: [memory, consolidation, self-heal, token-budget, diagnostics]
---

# consolidation JSON 污染 MEMORY.md 修复记录

## 1. 根因摘要

- **主根因（missing-guard）**：b9c8618 只堵住"把不可解析回复写入 MEMORY.md"的入口，
  `loadMemory()` 对存量污染没有识别/修复分支；污染被注入每个会话、回流给每次整理，
  形成"整理失败 → 不改文件 → 继续失败"的自锁。
- **次根因（配置/数据格式）**：`maxTokens = 8192` 与 `MAX_MEMORY_CHARS = 24000` 不匹配，
  中文记忆重写必然被输出上限截断。
- **次根因（诊断缺口）**：失败只记录错误消息，不带模型实际回复，无法事后定位。
- **环境条件**：两个 2026-09-12 启动的旧进程持续运行修复前代码，是复发的写入来源。

## 2. 实际采用方案

按 owner 批准的 **A + C** 实施。

### A：读取端自愈 + 失败诊断

- `project-state.ts:354` 新增 `readJsonStringField()`：共享的 JSON 字符串字段读取器，
  容忍「未闭合字符串」（截断回复），用 `complete` 标记是否读到闭合引号；替代了
  `consolidate.ts` 里的私有实现（`consolidate.ts:98` 现在只做 `complete` 判定，行为不变）。
- `project-state.ts:388` 新增 `healPoisonedMemory()`：`loadMemory()` 读到正文以 `{` 开头且
  能取出 `memory_markdown` 时，视为历史遗留污染；先用 `MEMORY.md.poison-backup-<时间戳>`
  保留原始字节，再原子写回修复后的 Markdown。判定严格（必须正文以 `{` 开头 + 字段存在），
  正常记忆里附带提到该字段不会被误伤；读不到可恢复值时保持原样（fail-safe）。
- `project-state.ts:406` `normalizeHealedMemory()`：去围栏/标题、按 `MAX_MEMORY_CHARS` 截断；
  未闭合时回退到最后一个 `\n` 或 `。！？`，丢弃被输出上限切断的半句。
- `project-state.ts:421` `loadMemory()` 主路径接入自愈；旧 `.pi/`、OMP 回退来源不写回
  （不是本扩展管理的文件）。
- `consolidate.ts:394` 解析失败的错误信息追加原始回复头部（`replyHead()`，最多 4000 字符，
  `consolidate.ts:124`），使 `errors.log` 能看到模型实际输出；`consolidate.ts:254` 附近
  的通知只显示首行，避免把回复 dump 弹到 UI。

### C：输出预算与 `<existing-memory>` 规模匹配

- `consolidate.ts:141` `replyTokenRate()`：按文本成分估算最坏输出 token 率
  （CJK ≈ 1 token/字符，ASCII/markdown ≈ 0.4），避免用 pi 的 `estimateTokens`（chars/4，
  对 CJK 严重低估）。
- `consolidate.ts:153` `fitMemoryInput()`：`needed = 文本长度 × rate + 1024`；
  输出上限取 `max(config.maxTokens, needed)`，并以辅助模型自身的 `maxTokens` 为硬顶。
  当模型上限仍装不下时，只发送记忆的头部 60% + 尾部 40%（`clipMemory()`，
  `consolidate.ts:169`），保证回复能完整返回；结果带 `clipped` 标记。
- `consolidate.ts:374` 整理 pass 用匹配后的预算调用模型；`consolidate.ts:254` 在剪裁发生时
  向用户发 warning（会话关闭的静默写入除外）。
- **偏离说明**：未提高 `DEFAULT_CONFIG.maxTokens`。理由：① 保持与 dsh 插件的默认值一致；
  ② UniField/Quantum_Matrix 的 `project-context.json` 已显式持久化 `maxTokens: 8192`，
  改默认值对存量项目无效；③ 自适应上限覆盖默认值场景且以模型真实上限封顶。

## 3. 改动文件清单

- `extensions/project-context/project-state.ts`：+`readJsonStringField` / `healPoisonedMemory` /
  `normalizeHealedMemory`；`loadMemory` 接入自愈。
- `extensions/project-context/consolidate.ts`：共享解码器、失败诊断（`replyHead` + 首行通知）、
  预算匹配（`replyTokenRate` / `fitMemoryInput` / `clipMemory` / `clipped` 通知）。
- `tests/consolidation-test.mjs`：新增「污染自愈 / 防误判 / 幂等 / 备份」「预算匹配 / 模型上限剪裁」
  两组用例；扩展 `errors.log` 断言包含原始回复头部。
- 未改动：`config.ts`、`llm.ts`、`autolearn.ts`、README。

## 4. 验证结果

- `node tests/run-all.mjs`：**8/8 通过**；新增用例覆盖：
  - 污染文件被解码为 Markdown、截断半句被丢弃、写回磁盘、原始字节备份、二次读取幂等；
  - 正常记忆中反引号提到 `{"memory_markdown": ...}` 不被误判（Quantum_Matrix 第 85 行场景）；
  - 大记忆在模型允许时抬高预算并完整入 prompt；模型上限不足时按 8192 封顶并剪裁中间段
    （头尾标记保留、中间标记消失）；
  - 不可解析回复的 `errors.log` 含 "consolidation reply was not a usable JSON object" 与
    `"memory_markdown": 17` 原始片段。
- **存量数据**：UniField 于 14:46 修复后保持干净；Quantum_Matrix 在 14:55:14 被旧进程的
  shutdown 整理再次写坏（24397 字节原始 JSON），旧进程随后已退出。用新代码路径对真实项目
  执行 `loadMemory()`：14:58:06 自愈为 14385 字符 Markdown，自动备份
  `MEMORY.md.poison-backup-2026-09-15T06-58-06-299Z`（24396 字节），二次读取无写入。
- **回归核对**：对 14:46 的 UniField 备份跑新自愈，结果与人工修复逐字符一致（15055 字符）；
  现有解析保护用例（截断 JSON 不得凭空造记忆、失败不改文件）全部保持通过。

## 5. 遗留事项

- **安装包**：**已解决**——本 issue 的修复随 `v0.1.3`（`e4d48c4`，annotated tag 已 push 到 Forgejo + GitHub 镜像两远端）
  发布；2026-09-16 安装包 pin 切到 `v0.1.4`（`6d8b81b`），此后新会话运行的就是含本修复的代码。
- **备份文件**：UniField 1 个、Quantum_Matrix 2 个 `.poison-backup-*`，已于 2026-09-16 逐份核对后删除（见 §7）。
- **autolearn 固定输出上限**：**已解决**——`autolearn.ts:428` 改用 `adaptiveOutputTokens(...)`（v0.1.3 自适应预算），
  不再使用固定 `config.maxTokens`，超长技能内容不再被同类截断。
- **自愈可见性**：**部分解决**——consolidation 读到污染记忆时会 warn 一次
  （`consolidate.ts:509`，文案说明下次 consolidation 会先备份再重写）；解码本身仍无写副作用（owner 批准的 B 方案）。
  `/project-context` 命令输出目前不含 poison 字段，仅作可选后续增强。
- **已知 nit**：**已解决**——`readJsonStringAt` 已映射 `\b`/`\f` 转义（`project-state.ts`）。
- 旧进程（PID 370858 / 378387）已退出，污染写入来源消失。

## 6. 代码审查与 review-fix 状态（2026-09-15，round 1..5）

- 原方案 A/C 的实现经 **5 轮独立复审**（独立 pi CLI 进程、只读沙箱、前后核验无写入；原始记录：
  `consolidated-memory-json-poison-review-round{1..5}-independent.txt`）：
  - round 1：IMP-1..5（预算不可收敛 / silent 剪裁无痕 / 自愈判定过宽 / 召回缺口 / 缺压缩指令）；
  - round 2：B-1 自愈误判、I-1 headless 无痕、I-2 tiny cap 退化、I-3 召回边界；
  - round 3：B-1 未真正关闭（对象后未校验）、I-2b、T-1；I-1 确认修复；
  - round 4：B-1R（对象前未校验）、I-2bR context 饥饿、I-S2 stale heal 竞态、T-1R；
  - round 5：B-1R5（单行前缀 + 嵌套键 + 二次级联）、I-S2R（CAS 非原子）、T-1R 部分 →
    审查报告 `status: blocked`。
- 代码已超出本记录第 2/3 节的初版描述（+223/−38 → **+427/−52**）：
  - `project-state.ts`：`jsonObjectEnd()`（字符串感知花括号配对）、`isPoisonPrefix()`（对象前缀
    白名单）、字段作用域校验、写前重读比对、备份名随机后缀、自愈留痕；
  - `consolidate.ts`：`clipMemory` → `clipText` + `fitMemoryInput` 两段式预算分配（context 回流）、
    `reserved` 下限、headless 剪裁留痕、`ConsolidateReport = "clipped"`；
  - `tests/consolidation-test.mjs`：结构/前缀反例、cap 参数化、headless 留痕、near-budget 变异守卫。
- 因此第 2/3 节的行号与函数名描述的是 review-fix 之前的版本，以当前未提交 diff 为准。
- **owner 决策：`memory-heal-mode = B`（读取端只解码、不写盘）**（2026-09-15）：
  - `project-state.ts`：写入式的 `healPoisonedMemory()` 改为纯函数 `decodePoisonedMemory()`；
    `loadMemory()` 返回 `{ text, source, poisoned }`，读到污染只在内存中返回解码后的 Markdown，
    **不写盘、不备份、不记日志**；新增 `backupMemoryBeforeWrite()`（仅写入方调用，读当前磁盘字节）；前缀白名单收紧
    （空 / `json` / `[` / 围栏），并要求 `memory_markdown` 是对象**首键**（首键正则，非 depth-1）。
  - `consolidate.ts`：每次覆盖 MEMORY.md 前**无条件**调用 `backupMemoryBeforeWrite()`
    （读取当前磁盘字节，消除 round-6 B-2 的陈旧快照）；写入后按**写入时**判定记录/通知污染修复；
    `written` 去重提前到首个 await 之前（消除并发重复写）；`/memory` 对污染文件给出提示。
  - 于是 round 2–5 的 blocking（读路径启发式写回导致的误判）与 TOCTOU 由构造消除：
    读路径不再有任何写副作用。
  - round 6 复审的 blocking 已在同轮处理：截断解码不再裁剪末行（三份真实备份末行完整保留，
    `normalizeHealedMemory` 只做归一化/限长）；写路径改为写时备份；clip 覆盖同样有备份；
    冒号引入行不再参与解码（`Example: {...}` 误判关闭）；并发同版本 pass 只写一次（1 备份/1 日志）。
  - round 7 复审的 important 已在同轮处理：`backupMemoryBeforeWrite()` 改为 fail-closed
    （仅 `ENOENT` 视为「无文件」，其它读错一律抛出 → 写入方不覆盖、记 errors.log、返回 failed）；
    备份修剪改为按 mtime 排序并**排除刚创建的备份名**，时钟回拨也不会删掉新备份；
    新增 mid-call 写者备份、clip 备份、不可读目标 fail-closed、修剪/时钟回拨四类测试。
  - round 8 复审的 important 已在同轮处理：预算剪裁改为**按各 artifact 自己的 token 率**
    分配（不再用全局平均字符率 + 字符均分），并用剪裁后文本重算收敛，混合语种不再越界
    （导出 `fitMemoryInput`/`replyTokenRate` 供单测）；修剪只删**精确匹配生成名 + isFile** 的
    文件，单项 `rm` 失败不中止；备份改为 Buffer 读写（字节副本）；写失败释放 `written` claim
    以便立即重试；`CLIPPED_NOTICE` 区分是否真的写过 MEMORY.md；新增混合语种预算、
    fail-closed 端到端、首次建文件、修剪身份/目录四类测试。
  - round 9 复审的 important 已在同轮处理：`fitMemoryInput` 改为「按 artifact 地板 + 剩余按需分配」，
    剪裁后用实际文本迭代收敛，最后以字符数作 token 上界的保底分配，保证
    `Σ本地率 + reserved ≤ maxTokens` 且两侧非空（20k 随机网格 0 越界 / 0 清零；
    仓库测试为 4 种密度 × 4 档 cap 的矩阵断言）；`written` 只在本次确实 claim 过时释放，
    模型失败不再回放陈旧 outcome；修剪改为**全名锚定正则**（转义字面前缀）而非
    `startsWith` + 尾部后缀；`CLIPPED_NOTICE_NO_WRITE` 改为不宣称备份存在的中性文案；
    新增预算矩阵与「嵌套生成名用户文件不被删」测试。
  - round 10 复审的 important 已在同轮处理：`fitMemoryInput` 的「最后保底」不再把 token 配额当字符数
    （改为按 token 比例缩放 + 字符数绝对上限），并新增**阻尼增长回填**把剪裁后留下的预算用起来；
    `written` 仅在本次未成功写入 MEMORY.md 时释放（部分写失败不再回放陈旧 outcome）；
    skew 测试改用真实 `utimes`；预算矩阵复用导出的 `replyTokenRate`，新增「不浪费预算」断言与
    「ASCII 体 + CJK 尾」「全 ASCII memory × 密集 CJK context」两个 fixture。
    本地 60k 随机网格（4 种密度形状 × 7 档 cap）：0 越界 / 0 清零 / 0 地板破坏 / 0 浪费超标。
  - round 11 复审 **PASSED**（无 blocking / 无 important）。其唯一可执行 nit（严格不变量可有 0.4 token
    浮点残差，测试容差 0.001 与代码 slack 0.5 不一致）已用**精确修剪**收口：收敛判定保留浮点容差，
    之后按超出量对密度更高的一侧做 1–2 字符修剪；60k 随机网格在 0.001 容差下 0 越界。
  - owner 要求「残差都修复掉」后的 **round-12 批次**（待独立复审）：
    - 解码召回：`context` 先行的回复、单行引导语前缀、无 header 的文档值、`.pi`/OMP 来源均可解码；
      同时保持「对象是全文剩余部分 + 首键为回复字段 + 值为文档」三重约束，嵌套示例/短值不解码；
    - 写入串行：`MEMORY.md.lock`（`wx`）串起「备份读取 → 修剪 → 原子改名」，跨进程不再互覆；
      陈旧锁（>30 秒）可安全夺取；`migrateProjectState` 的 OMP 导入同样在锁内 check-then-write；
    - 备份保留：一小时内新建的备份不被轮换，通知点名的备份在下一次整理后仍在；
    - 本地产物：`.agents/memory/.gitignore` 自动忽略 `*.memory-backup-*` 与 `errors.log`；
      `errors.log` 落盘前对 `sk-`/`ghp_`/JWT/Bearer/键值对凭据脱敏；
    - 预算/编码：`replyTokenRate` 对所有非 ASCII 码点记 1 token（含 emoji/西里尔/阿拉伯），
      `"`/`\` 计 JSON 转义开销；`clipText` 不再切开 surrogate pair；
      模型元数据缺失时自适应上限由新配置 `maxOutputTokens`（默认 32768）封顶；
      autolearn 输出上限按 skill body 最大尺寸用同一 helper 自适应；
    - 读错误展示：`loadMemory` 区分 ENOENT 与不可读，`/memory` 对不可读文件给出 warning；
      命令回执指向本次修复的备份；
    - 去重：`cleanMemory`/`normalizeHealedMemory` 合并为导出的 `normalizeMemoryDocument`；
      `readJsonStringField` 补齐 `\b`/`\f` 转义。
    - 仍记录：整文件恰为「JSON 示例」时的误判在无磁盘标记下无法与真实存量污染区分（mode B 只影响读，
      写路径有备份）；Windows/NFS 的 rename/mtime 行为与真实 tokenizer 偏差仍属平台不确定性。
  - round 12/13 复审的 findings 已修：锁内容改为唯一 token，释放前读回比对；陈旧夺取用
    `<lock>.steal` 声明**单胜者**（两个夺取者不再互删新锁），释放也与夺取串行；
    `clipText` 在补偿代理对时同步从 head 扣除，保证 `length ≤ limit`（精确修剪不再空转）；
    `lastWrite` 每轮开始清空；畸形孤立低代理跳过；`.gitignore` 补 `*.lock`/`*.steal`。
  - round 14/15 复审的 findings 已修：`releaseLock` 抢不到 claim 时不再删锁（只有 claim 持有者能删，
    `tryLock` 失败先 close 再 rm）；等待循环 deadline 前置且所有失败路径退避（不再忙等）；
    `<lock>.steal` 若被目录等非普通文件占据则移开自愈；锁 mtime 区分「缺失=0 / 不可读=视为新鲜」；
    仓库新增 3 个子进程的跨进程互斥回归与 `tests/helpers/lock-holder.mjs`；`.gitignore` 补 `*.broken-*`。
    round 15 判 **PASSED**（无 blocking/important）。
  - round 16 复审 **PASSED**；其 nit 已修：`tryLock` 对锁路径上的目录/设备同样移开自愈（对称于 claim）、
    跨进程用例加 spawn timeout / 残留断言 / `fileURLToPath`、`cleanStaleTemps` 回收 `.broken-*`、
    仓库根 `.gitignore` 收窄为 `.agents/**` 前缀规则。
  - round 17 复审 **PASSED**（无 blocking/important）；最后两个 nit 已收口：`cleanStaleTemps` 只删除
    「空目录且超龄」的 `.broken-*`（含内容/非目录一律保留，避免误删用户数据），`tests/run-all.mjs`
    加 60s timeout 且挂起按失败上报；新增 broken 回收回归。60k 随机网格复跑 0 越界/0 清零/0 地板/0 浪费。
  - round 18 复审 **PASSED**：补上 `loadMemory` 对 legacy `.pi`/OMP 来源的不可读区分
    （`readMemorySource`：仅 ENOENT 视为缺失，其余报 `unreadable` 并返回该来源路径），
    `migrateProjectState` 的 OMP 导入对不可读来源改记 `errors.log` 而非静默跳过；新增 legacy 不可读回归。
  - owner 追加「不要残留问题或隐患」后的 **round 19..21 加固批次**：
    锁/claim 的 EEXIST 分类改用 `lstat`（dangling symlink 不再被 `stat` 误判 ENOENT 而永久冻结），
    非普通文件（目录/FIFO/symlink）统一 `rename` 移开自愈；claim 令牌化 + 每次删除前
    `claimStillOurs` 复核；`stealStaleLock` 用 `lstat(ino/dev) → read → lstat 复查 → 字节复查 →
    claim 复查` 钉住删除对象；`tryLock`/`acquireClaim` 写失败清理按「自己创建的 inode」判定；
    备份新增硬上限 20（自守护 `max(KEPT,20)`，一小时内近期备份优先保留、超限后最老优先淘汰，
    同 mtime 按名字 tie-break），修剪前 `stat` 失败的后备跳过不猜删。新增 symlink/FIFO/上限/
    tie-break 回归；round 21 判 **PASSED**（无 blocking/important）。唯一记录的残余是
    「最后复核 → rm」之间无法与内核原子化的悬挂窗（node:fs 不暴露 flock），触发需 >30 秒
    进程暂停 + 并发，影响仅瞬时互斥（写路径原子改名 + 每次覆盖前备份，不产生损坏）。
  - owner 要求「统一一下」后的 **journal 化批次（round 22..24）**：`MEMORY.md` 从唯一副本改为派生渲染，
    新增 `.agents/memory/memory.jsonl` 作为 append-only 唯一权威（`replace`/`append` 记录，单次 `write` 落一行）：
    - 读取 `loadMemory`：journal 存在 ⇒ 按序折叠；不存在 ⇒ 旧路径（含污染解码），老项目零迁移。
    - 外部编辑：归一后内容不同 **且** 渲染 mtime 晚于 journal 才采信（`memoryComparisonKey` 单点收口），
      下一次写入把该字节作为一条 `replace` 收进历史并记 `errors.log`；自家渲染（内容相同）不再被误 adoption。
    - 损坏容忍：坏行/半行跳过并计入 `LoadedMemory.damaged`（整理写 `errors.log`、`/memory` 提示）；
      半行尾部在追加前补换行；整份 journal 无可用记录时 fail closed（`/memory` 给出重建指引）。
    - 轮换：>512KB 锁内折成一条 `replace`，旧文件归档为 `memory-log-<stamp>-<8hex>.jsonl`（保留 5 份，
      一小时内保护）；采用「临时文件 → 归档 → 替换 + 回滚」，任一步失败不让 journal 路径消失。
    - OMP legacy 导入改走同一入口；`.gitignore` 覆盖 journal/归档/轮换临时文件。
    独立性验证：round 22/23 的 findings（mtime 判别器恒真、半行吞并、normalization 口径分叉导致死代码）全部修复，
    round 24 判 **PASSED**（无 blocking/important）。
- 两个项目的存量数据不受影响（已修复的 UniField / Quantum_Matrix `MEMORY.md` 保持原样）。

## 7. 污染备份清理（2026-09-16，owner 授权「检查修复，确认没问题了可以删」）

- 核对方法：把每份 `.poison-backup-*` 字节原样复制进临时项目的 `.agents/memory/MEMORY.md`，
  用真实 `loadMemory()`（含污染解码路径）取出文本，再与两项目现记忆做逐行 + 关键词比对；
  同时核对现记忆自身健康度（`poisoned` / `damaged` / 字符数）。
- 结论：三份备份的实质事实均已在现记忆中，逐行差异只是措辞与结构重排：
  - Quantum_Matrix 备份的 9-15 事实（32×32 +43.64、64×64 Khazad r16=746 vs 366、登记表 61 行）
    见现记忆第 103 行更新记录；`302 passed`、`6f4a108`、`结构化基准` 关键词命中。
  - UniField 备份的「`config` 里不含 `lr`」子句见现记忆第 145 行。
  - 仓库内另有可追溯记录（`git grep`：`302 passed` 命中 3 文件、`6f4a108` 命中 2 文件）。
- 删除清单（size / sha256 前 16 位）：
  - `24027` / `cdd6ee977003adeb` — `UniField/.agents/memory/MEMORY.md.poison-backup-20260915`
  - `24296` / `80b8571e6ef1f245` — `Quantum_Matrix/.agents/memory/MEMORY.md.poison-backup-20260915`
  - `24396` / `66b9c8dfb4627565` — `Quantum_Matrix/.agents/memory/MEMORY.md.poison-backup-2026-09-15T06-58-06-299Z`
- 删除后核对：两项目无残留 `poison-backup` / `backup` 类文件；`loadMemory()` 均 `poisoned=false`、
  `damaged=0`，字符数维持 15055 / 14784 不变。
- 边界说明：备份里存的是模型回复的 JSON 信封原文，删除后不可再取回原始字节；已确认解码事实不丢失，
  且这批数据只影响记忆文本，不影响任何代码路径。
