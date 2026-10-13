const PI = "file:///home/user/.pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const REPO = "/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context";
const { parseSessionEntries, estimateTokens, sessionEntryToContextMessages } = await import(PI);
const { loadNamespace, makeCtx, makeSessionManager } = await import(`${REPO}/tests/harness.mjs`);
const threshold = await loadNamespace(`${REPO}/extensions/project-context/handoff/threshold.ts`);
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

// 已知真值（非 message 开销）：probe 沙箱 17,753 / ctl 沙箱 11,008（probe-true-baseline.md）
const TRUTH = { "01a1331c": 17753, "01a1331d": 11008 };

for (const file of process.argv.slice(2)) {
  const id = file.match(/(01a[0-9a-f]{6})/)?.[1] ?? file;
  const entries = parseSessionEntries(await (await import("node:fs/promises")).readFile(file, "utf8"))
    .filter((e) => e.type !== "session" && e.type !== "header");
  let plain = 0, plainMsgs = 0;
  const S = [];
  for (const entry of entries) {
    const msgs = sessionEntryToContextMessages(entry);
    const before = plain, beforeMsgs = plainMsgs;
    let rec;
    for (const m of msgs) { const t = estimateTokens(m); plain += t; if (m.role !== "system") plainMsgs += t; if (m.usage) rec = m.usage; }
    if (!rec) continue;
    const prompt = (rec.input ?? 0) + (rec.cacheRead ?? 0) + (rec.cacheWrite ?? 0);
    if (prompt > 0) S.push({ prompt, before, beforeMsgs });
  }
  const shipped = threshold.measureContext(makeCtx("/tmp", { sessionManager: makeSessionManager(entries) }),
    { tokens: S.at(-1).prompt, contextWindow: 1_000_000, percent: null });
  const rate = shipped.rate, at = (t) => Math.ceil((t * 4) / rate);
  const ship = S.map((s) => s.prompt - at(s.before));
  const sysEx = S.map((s) => s.prompt - at(s.beforeMsgs));
  // A 方案（锚点 + 精确增量）：读数恒为 prompt_first − (锚点消息字符数/8)，锚点 = 首条 usage 记录之前的内容
  const anchor = Math.ceil((4 * S[0].beforeMsgs) / 8);
  const AC = S[0].prompt - anchor;
  const t = TRUTH[id] ?? null;
  console.log(`\n### ${id}   样本 ${S.length}   rate ${rate.toFixed(4)}   首样本 prompt ${S[0].prompt}  首样本 plainBefore ${S[0].before}（其中非 message ${S[0].beforeMsgs}）`);
  if (t) console.log(`  已知真值 B_true = ${t}`);
  const line = (n, a) => `  ${n.padEnd(16)} min ${Math.min(...a)}  中位 ${med(a)}  max ${Math.max(...a)}  漂移 ${Math.max(...a) - Math.min(...a)}${t ? `   与真值差 ${Math.min(...a) - t}` : ""}`;
  console.log(line("① 线上(含system)", ship));
  console.log(line("② 排除system", sysEx));
  console.log(`  ${"③ A+C(锚点/8)".padEnd(16)} 恒为 ${AC}${t ? `   与真值差 ${AC - t}` : ""}   （锚点估算 ${anchor}）`);
  if (S.length > 1) console.log(`  A+B(不排除system) 会读出 ${S[0].prompt - Math.ceil((4 * S[0].before) / 8)}（锚点含 system ⇒ 低读）`);
}
