const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const fs = require("fs");
const TOK = process.env.GLIMPSE_ADMIN_TOKEN || fs.readFileSync(require("os").homedir() + "/.glimpse-rush.env","utf8").match(/=(.+)/)[1].trim();
const BASE = process.env.BASE || "https://glimpse-rush.pages.dev";
const tag = "e2e" + Date.now().toString(36);
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p = await ctx.newPage();
  const errs = []; p.on("pageerror", e => errs.push(String(e))); p.on("console", m => m.type()==="error" && errs.push(m.text()));
  const reqs = []; p.on("response", r => /\/api\/(e|feedback)/.test(r.url()) && reqs.push(r.status()));
  await p.goto(BASE + "/", { waitUntil: "networkidle" });
  console.log("consent bar:", await p.locator("#pt-yes").count());
  await p.click("#pt-yes");
  await p.click("#goPractice");
  for (let i = 0; i < 3; i++) {
    await p.waitForSelector("#fz:not([disabled])", { timeout: 20000 });
    await p.click("#fz");
    await p.waitForSelector("#ans", { timeout: 5000 });
    await p.fill("#ans", tag + "wrong");
    await p.press("#ans", "Enter");
    await p.waitForTimeout(500);
    if (await p.locator(".pt-rf").count()) break;
  }
  await p.waitForSelector(".pt-rf", { timeout: 15000 });
  console.log("results screen has reaction card: true; head =", (await p.locator(".result-h").innerText()).trim());
  await p.click('.pt-rf [data-r="0"]');
  await p.click('.pt-rf [data-d="0"]');
  await p.waitForTimeout(800);
  await p.click(".pt-fab");
  await p.click('#pt-stars [data-n="4"]');
  await p.click('#pt-tags [data-k="fun"]'); await p.click('#pt-tags [data-k="too_hard"]');
  await p.fill("#pt-liked", tag + " liked tiles"); await p.fill("#pt-dis", tag + " disliked 7s");
  await p.click("#pt-send");
  await p.waitForFunction(() => /Thank you/.test(document.querySelector("#pt-msg")?.textContent||""), null, { timeout: 8000 });
  await p.waitForTimeout(5500); // let the 4s flush fire
  await b.close();
  const r = await fetch(BASE + "/api/admin/summary", { headers: { authorization: "Bearer " + TOK } });
  const s = await r.json();
  const has = (arr, f) => arr.find(f);
  const checks = {
    "no page errors": errs.length === 0,
    "api calls all 200": reqs.length > 0 && reqs.every(c => c === 200),
    "practice round started+ended": !!has(s.funnel, x => x.mode === "practice" && x.started >= 1 && x.ended >= 1),
    "wrong answer text captured": !!has(s.wrongAnswers, x => x.text === tag + "wrong"),
    "dispute captured": !!has(s.disputes, x => x.answer === tag + "wrong"),
    "general feedback w/ tags captured": !!has(s.recent, x => x.liked === tag + " liked tiles" && x.rating === 4 && x.tags === "fun,too_hard"),
    "round thumbs-down captured": s.rounds.some(x => x.down >= 1),
    "context attached": !!has(s.recent, x => x.liked === tag + " liked tiles" && JSON.parse(x.context).screen),
  };
  console.log(JSON.stringify({ errs, reqs }, null, 0));
  for (const [k, v] of Object.entries(checks)) console.log(v ? "PASS" : "FAIL", k);
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
})().catch(e => { console.error("SCRIPT ERROR", e.message); process.exit(2); });
