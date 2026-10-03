// Two real browsers in the same World Live round on the live site: each must see the other's real score on the board.
import { chromium } from "playwright";
const BASE = (process.argv[2] || "https://glimpse-rush.pages.dev").replace(/\/$/, "");
const QUEUE = process.argv.includes("--scrambled") ? "#goWorldScr" : "#goWorld";
const b = await chromium.launch();
const mk = async (name, mobile) => {
  const c = await b.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 800 } });
  await c.addInitScript((n) => { localStorage.setItem("gr.pt.consent", "no"); localStorage.setItem("gr.nick", JSON.stringify(n)); }, name);
  const p = await c.newPage(); p.errs = []; p.on("pageerror", (e) => p.errs.push(String(e))); p.who = name; return p;
};
const ann = await mk("Ann" + Math.floor(Math.random() * 900 + 100), false), bob = await mk("Bob" + Math.floor(Math.random() * 900 + 100), true);
try {
  await Promise.all([ann, bob].map((p) => p.goto(BASE + "/")));
  await Promise.all([ann, bob].map((p) => p.click(QUEUE)));
  await Promise.all([ann, bob].map((p) => p.waitForFunction(() => S.R && S.R.cycle !== undefined && WL.board, null, { timeout: 15000 })));
  const k = await ann.evaluate(() => S.R.cycle);
  if (k !== await bob.evaluate(() => S.R.cycle)) throw new Error("different rounds");
  const online = await ann.evaluate(() => WL.board.online);
  console.log(`round ${k}, live count ${online}`);
  for (const p of [ann, bob]) {
    const a = await p.evaluate(() => S.R.photo.accepted[0]);
    await p.waitForSelector("#fz:not([disabled])", { timeout: 70000 }); await p.click("#fz"); await p.fill("#ans", a); await p.press("#ans", "Enter");
  }
  const scores = await Promise.all([ann, bob].map((p) => p.evaluate(() => S.R.done.score)));
  // each sees the other's real row while the round is still running
  const t0 = Date.now();
  await ann.waitForFunction(([n, s]) => (WL.forRound(S.R.cycle)?.rows || []).some((r) => r.name === n && r.score === s), [bob.who, scores[1]], { timeout: 10000 });
  await bob.waitForFunction(([n, s]) => (WL.forRound(S.R.cycle)?.rows || []).some((r) => r.name === n && r.score === s), [ann.who, scores[0]], { timeout: 10000 });
  console.log(`scores ${ann.who}=${scores[0]} ${bob.who}=${scores[1]}; both boards had both within ${Date.now() - t0} ms`);
  await Promise.all([ann, bob].map((p) => p.waitForSelector(".result-h", { timeout: 70000 })));
  for (const [p, other] of [[ann, bob], [bob, ann]]) {
    const txt = await p.locator(".card", { hasText: "Leaderboard" }).first().innerText();
    if (!txt.includes(other.who)) throw new Error(`${p.who}'s results board does not list ${other.who}`);
    if (new RegExp(other.who + "\\s*bot").test(txt)) throw new Error("real player marked as bot");
  }
  console.log("results boards list the other real player (not as a bot)");
  if (ann.errs.length || bob.errs.length) throw new Error("page errors " + [...ann.errs, ...bob.errs].join(" | "));
  console.log("PASS");
} catch (e) { console.log("FAIL", e.message); process.exitCode = 1; }
await b.close();
