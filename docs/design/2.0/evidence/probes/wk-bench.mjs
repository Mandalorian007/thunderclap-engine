// D2: TC's bench ladder in Playwright WebKit with the iPad Pro 11 profile (1180x820, DPR 2), or Chromium at the same size.
const pw = await import("/Users/matthewfontana/repos/thunderclap-engine/node_modules/.pnpm/playwright-core@1.64.1/node_modules/playwright-core/index.mjs");
const [bn = "webkit", rung = "all"] = process.argv.slice(2);
const L = pw[bn] ?? pw.default[bn]; const devices = pw.devices ?? pw.default.devices;
const browser = bn === "chromium" ? await L.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--enable-features=WebGPUTimestampQuery", "--use-angle=metal"] }) : await L.launch({ headless: true });
const ctx = await browser.newContext(bn === "webkit" ? { ...devices["iPad Pro 11 landscape"], viewport: { width: 1180, height: 820 } } : { viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 });
const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(e.message)); page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
await page.goto(`http://127.0.0.1:11550/bench.html?rung=${rung}`);
let s = null; const until = Date.now() + 8 * 60_000;
while (Date.now() < until) { s = await page.evaluate(() => { const x = window.__harnessBench?.state; return x ? JSON.parse(JSON.stringify(x)) : null; }); if (s?.done || (s?.ready && s.gpu !== "ok")) break; await new Promise((r) => setTimeout(r, 500)); }
console.log(JSON.stringify({ browser: bn, gpu: s?.gpu, timestamps: s?.timestamps, adapter: s?.adapter, error: s?.error, gpuErrors: s?.gpuErrors, errs: errs.slice(0, 5) }));
for (const r of s?.results ?? []) console.log(JSON.stringify(r));
await browser.close();
