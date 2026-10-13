const PI = "file:///home/user/.pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const REPO = "/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context";
const { parseSessionEntries, estimateTokens, sessionEntryToContextMessages } = await import(PI);
const { loadNamespace, makeCtx, makeSessionManager } = await import(`${REPO}/tests/harness.mjs`);
const { readFileSync } = await import("node:fs");
const threshold = await loadNamespace(`${REPO}/extensions/project-context/handoff/threshold.ts`);
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

for (const file of process.argv.slice(2)) {
  const id = file.match(/(01a[0-9a-f]{6})/)?.[1] ?? file;
  const entries = parseSessionEntries(await readFileSync(file, "utf8")).filter((e) => e.type !== "session" && e.type !== "header");
  // 每个 usage 记录：本地非 message 字符数（estimateTokens×4）与该样本的 prompt
  let plain = 0, msgsChars = 0, idx = -1;
  const S = [];
  for (const e of entries) {
    idx++;
    let rec;
    for (const m of sessionEntryToContextMessages(e)) {
      const t = estimateTokens(m);
      plain += t; if (m.role !== "system") msgsChars += 4 * t;
      if (m.usage) rec = m.usage;
    }
    if (!rec) continue;
    const prompt = (rec.input ?? 0) + (rec.cacheRead ?? 0) + (rec.cacheWrite ?? 0);
    if (prompt > 0) S.push({ idx, prompt, msgsChars });
  }
  // 模块在「前缀」上的读数：截到第 k 个样本 = 该时刻的真实运行读数
  const run = (subEntries) => threshold.measureContext(makeCtx("/tmp", { sessionManager: makeSessionManager(subEntries) }),
    { tokens: 0, contextWindow: 1_000_000, percent: null });
  const zero = (arr) => arr.map((e) => e.type === "message" && e.message?.role === "system"
    ? { ...e, message: { ...e.message, content: "", sections: undefined, toolsAdded: undefined } } : e);
  const rows = S.map((s) => {
    const sub = entries.slice(0, s.idx + 1);
    return { ...s, r1: run(sub).baseline, r2: run(zero(sub)).baseline };
  });
  // 区间 rate：相邻样本之间「消息字符 / prompt 增量」= 代码自己的校准量
  const rates = [];
  for (let i = 1; i < S.length; i++) {
    const dP = S[i].prompt - S[i - 1].prompt, dC = S[i].msgsChars - S[i - 1].msgsChars;
    if (dP > 0) rates.push(dC / dP);
  }
  const r2s = rows.map((r) => r.r2);
  console.log(`\n### ${id}   样本 ${S.length}`);
  if (rates.length) {
    console.log(`  区间 rate: 最稀 ${Math.min(...rates).toFixed(2)}  中位 ${med(rates).toFixed(2)}  最密 ${Math.max(...rates).toFixed(2)}   (n=${rates.length})`);
    console.log(`  rate 离散度 max/min = ${(Math.max(...rates) / Math.max(Math.min(...rates), 0.01)).toFixed(2)}`);
  }
  console.log(`  C 后逐样本读数: min ${Math.min(...r2s)}  中位 ${med(r2s)}  max ${Math.max(...r2s)}  漂移 ${Math.max(...r2s) - Math.min(...r2s)}`);
  console.log(`  （同期线上含 system 读数: min ${Math.min(...rows.map((r) => r.r1))}  中位 ${med(rows.map((r) => r.r1))}  max ${Math.max(...rows.map((r) => r.r1))}）`);
  for (const r of rows) console.log(`    k idx${String(r.idx).padStart(3)}  prompt ${String(r.prompt).padStart(7)}  本地消息字符 ${String(r.msgsChars).padStart(7)}   ① ${String(r.r1).padStart(8)}   ②(C) ${String(r.r2).padStart(8)}`);
}
