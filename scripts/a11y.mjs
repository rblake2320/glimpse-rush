// axe-core WCAG 2 A/AA audit of the home screen and a selected-option state, in a real browser.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const BASE = (process.argv[2] || "https://glimpse-rush.pages.dev").replace(/\/$/, "");
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 390, height: 844 }, bypassCSP: true })).newPage(); // the site CSP rightly blocks injected scripts
await p.goto(BASE + "/"); await p.waitForSelector("#goPractice");
const audit = async (label) => {
  await p.addScriptTag({ content: AXE });
  const r = await p.evaluate(async () => (await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "best-practice"] } })).violations
    .map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, sample: v.nodes[0]?.failureSummary?.split("\n")[1]?.trim().slice(0, 120) })));
  return { label, violations: r };
};
const out = [await audit("home (consent bar showing)")];
await p.click("#pt-no"); out.push(await audit("home"));
await p.click('#grids [data-n="9"]'); out.push(await audit("home, option selected"));
await p.click("#goGroup"); out.push(await audit("group setup"));
console.log(JSON.stringify(out, null, 1));
const serious = out.flatMap((o) => o.violations).filter((v) => v.impact === "serious" || v.impact === "critical");
console.log(serious.length ? `FAIL ${serious.length} serious/critical` : "PASS no serious/critical violations");
await b.close();
process.exitCode = serious.length ? 1 : 0;
