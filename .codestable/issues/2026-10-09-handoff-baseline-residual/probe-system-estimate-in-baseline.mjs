const PI = "file:///home/user/.pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const REPO = "/run/media/user/6b058d20-a617-484d-b7c6-cd7146baf77c/Projects/pi-project-context";
const { parseSessionEntries, estimateTokens, sessionEntryToContextMessages } = await import(PI);
const { loadNamespace, makeCtx, makeSessionManager } = await import(`${REPO}/tests/harness.mjs`);
const { readFileSync } = await import("node:fs");
const threshold = await loadNamespace(`${REPO}/extensions/project-context/handoff/threshold.ts`);
const path = await import("node:path");

for (const file of process.argv.slice(2)) {
  const entries = parseSessionEntries(readFileSync(file, "utf8")).filter((e) => e.type !== "session" && e.type !== "header");
  let plain = 0, sysEst = 0, lastPrompt = 0, lastPlain = 0;
  for (const entry of entries) {
    const msgs = sessionEntryToContextMessages(entry);
    const before = plain;
    for (const m of msgs) { const t = estimateTokens(m); plain += t; if (m.role === "system") sysEst += t; }
    const rec = msgs.find((m) => m.usage)?.usage;
    if (rec) { const p = (rec.input ?? 0) + (rec.cacheRead ?? 0) + (rec.cacheWrite ?? 0); if (p > 0) { lastPrompt = p; lastPlain = before; } }
  }
  const usage = { tokens: lastPrompt, contextWindow: 1_000_000, percent: null };
  const shipped = threshold.measureContext(makeCtx("/tmp", { sessionManager: makeSessionManager(entries) }), usage);
  // 干净对照：保留条目 id/parentId，只把 system 消息内容清零（等价于把 system 从 plain 里排除）
  const zeroed = entries.map((e) => e.type === "message" && e.message?.role === "system"
    ? { ...e, message: { ...e.message, content: "", sections: undefined, toolsAdded: undefined } } : e);
  const excl = threshold.measureContext(makeCtx("/tmp", { sessionManager: makeSessionManager(zeroed) }), usage);
  const atRateSys = Math.ceil((sysEst * 4) / shipped.rate);
  console.log(`\n### ${path.basename(file).slice(0, 40)}`);
  console.log(`  system估算 ${sysEst}   rate ${shipped.rate.toFixed(4)}   atRate(system) ${atRateSys}`);
  console.log(`  ① 线上        : baseline ${shipped.baseline}  samples ${shipped.samples}  idx ${shipped.sampleIndex}  estimated ${shipped.estimated}`);
  console.log(`  ② system=0 对照: baseline ${excl.baseline}  samples ${excl.samples}  idx ${excl.sampleIndex}  estimated ${excl.estimated}`);
  console.log(`  ② − ① = ${excl.baseline - shipped.baseline}   （应 = atRate(system) = ${atRateSys}）  samples 相同? ${shipped.samples === excl.samples}`);
  console.log(`  probe 口径 prompt−Σest(消息) = ${lastPrompt - (lastPlain - sysEst)}`);
}
