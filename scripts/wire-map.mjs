#!/usr/bin/env node
/**
 * Glimpse Rush living wire map: nothing in the game exists without a purpose, a live check, and a completion record.
 *
 *  1. Inventory: discovers every UI control, screen, mode, API route, telemetry event and feedback tag from the code.
 *     Anything not in scripts/wire-registry.mjs is UNREGISTERED (red); anything registered but gone is DEAD (red).
 *  2. Wires: each promise is checked in a real browser against a running site (default: production), including that
 *     its completion event actually landed in D1 (read back through the admin session endpoint).
 *  3. Writes docs/WIRE_MAP.md, docs/wire-map.json and docs/wire-map.html. Any red exits 1.
 *
 *   node scripts/wire-map.mjs [https://glimpse-rush.pages.dev] [--only world,blitz]
 *   needs GLIMPSE_ADMIN_TOKEN (env, or ~/.glimpse-rush.env). Test sessions use the synthetic prefix and are not counted.
 *
 * New feature? Register it and give it a wire first. A feature without a green wire is not considered wired.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { chromium } from "playwright";
import { REGISTRY } from "./wire-registry.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const BASE = (args.find((a) => /^https?:/.test(a)) ?? "https://glimpse-rush.pages.dev").replace(/\/$/, "");
const ONLY = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;
const TOKEN = process.env.GLIMPSE_ADMIN_TOKEN
  || (existsSync(join(homedir(), ".glimpse-rush.env")) ? readFileSync(join(homedir(), ".glimpse-rush.env"), "utf8").match(/GLIMPSE_ADMIN_TOKEN=(.+)/)?.[1].trim() : "");
const SYN = "5e5e5e5e";
const read = (p) => readFileSync(join(ROOT, p), "utf8");

// ------------------------------------------------------------------ inventory (static, from code)
function inventory() {
  const idsIn = (src) => [...new Set([...src.matchAll(/id="([a-zA-Z][\w-]*)"/g)].map((m) => m[1]))];
  const index = read("prototype/index.html"), pt = read("prototype/playtest.js"), admin = read("prototype/admin/index.html");
  const ingest = read("functions/_lib/ingest.js");
  const apiFiles = [];
  (function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : apiFiles.push(p); } })(join(ROOT, "functions/api"));
  const setFrom = (src, name) => [...(src.match(new RegExp(name + "\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)"))?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  const found = {
    ui: [...idsIn(index), ...idsIn(pt), ...idsIn(admin)],
    screen: [...(index.match(/function render\(\)\{\(\{([^}]*)\}/)?.[1] ?? "").matchAll(/(\w+):render/g)].map((m) => m[1]),
    mode: [...(index.match(/MODE_NAME=\{([^}]*)\}/)?.[1] ?? "").matchAll(/(\w+):"/g)].map((m) => m[1]),
    api: apiFiles.map((p) => relative(join(ROOT, "functions"), p).replace(/\\/g, "/").replace(/\.js$/, "")),
    event: setFrom(ingest, "EVENT_TYPES"),
    tag: setFrom(ingest, "TAGS"),
  };
  const rows = [];
  for (const [kind, names] of Object.entries(found)) {
    const reg = REGISTRY[kind] ?? {};
    for (const n of new Set(names)) {
      const r = reg[n];
      if (!r) rows.push({ kind, name: n, state: "red", why: "UNREGISTERED: in the code but has no purpose/wire in the registry" });
      else if (!r.purpose || r.wire === undefined || !r.done) rows.push({ kind, name: n, state: "red", why: "registry entry missing purpose, wire or completion" });
    }
    for (const n of Object.keys(reg)) if (!names.includes(n)) rows.push({ kind, name: n, state: "red", why: "DEAD: registered but no longer in the code" });
  }
  // the client must only emit event types the server accepts, and must emit every accepted type
  const emitted = [...new Set([...pt.matchAll(/track\("([a-z_]+)"/g)].map((m) => m[1]))];
  for (const e of emitted) if (!found.event.includes(e)) rows.push({ kind: "event", name: e, state: "red", why: "emitted by playtest.js but rejected by the server allow-list (data silently lost)" });
  for (const e of found.event) if (!emitted.includes(e)) rows.push({ kind: "event", name: e, state: "red", why: "accepted by the server but never emitted (dead telemetry)" });
  const uiTags = [...(pt.match(/const TAGS = \[([\s\S]*?)\];/)?.[1] ?? "").matchAll(/\["([a-z_]+)"/g)].map((m) => m[1]);
  for (const t of found.tag) if (!uiTags.includes(t)) rows.push({ kind: "tag", name: t, state: "red", why: "server accepts the tag but the feedback form never offers it" });
  for (const t of uiTags) if (!found.tag.includes(t)) rows.push({ kind: "tag", name: t, state: "red", why: "form offers a tag the server drops" });
  // photos: catalog vs files vs generated list
  const catalog = JSON.parse(read("tools/photo_catalog.json"));
  const pjs = existsSync(join(ROOT, "prototype/photos/photos.js")) ? read("prototype/photos/photos.js") : "";
  const pool = pjs ? JSON.parse(pjs.slice(pjs.indexOf("=") + 1).trim().replace(/;$/, "")) : [];
  const inPool = new Set(pool.map((p) => p.slug));
  const notSourced = catalog.filter((c) => !inPool.has(c.slug)).map((c) => c.slug);
  for (const p of pool) if (!existsSync(join(ROOT, "prototype", p.src.split("?")[0]))) rows.push({ kind: "photo", name: p.slug, state: "red", why: "listed in photos.js but the image file is missing" });
  return { found, rows, emitted, photos: { catalog: catalog.length, pool: pool.length, notSourced }, pool };
}

// ------------------------------------------------------------------ live helpers
let browser;
async function page({ consent = "yes", sid = SYN + "-map-" + Math.random().toString(16).slice(2, 14) + Date.now().toString(16) } = {}) { // sid null = none preset
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await ctx.addInitScript(() => { window.__csp = []; document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + e.blockedURI)); });
  await ctx.addInitScript(([c, s]) => {
    try { if (c) localStorage.setItem("gr.pt.consent", c); if (s) localStorage.setItem("gr.pt.sid", s); } catch {}
  }, [consent, sid]);
  const p = await ctx.newPage();
  p.errs = []; p.api = [];
  p.on("pageerror", (e) => p.errs.push(String(e)));
  p.on("request", (r) => { if (r.url().includes("/api/")) p.api.push(r.url()); });
  p.sid = sid;
  await p.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await p.waitForSelector("#goPractice");
  return p;
}
const close = (p) => p.context().close();
async function sessionRows(sid) {
  const r = await fetch(`${BASE}/api/admin/session?sid=${sid}`, { headers: { authorization: "Bearer " + TOKEN } });
  if (!r.ok) throw new Error("session endpoint " + r.status);
  return r.json();
}
async function landed(sid, pred, what, ms = 15000) {
  const t0 = Date.now();
  let rows;
  while (Date.now() - t0 < ms) {
    rows = await sessionRows(sid);
    if (pred(rows)) return rows;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`completion not recorded: ${what} (events seen: ${rows?.events.map((e) => e.type).join(",") || "none"})`);
}
const ev = (rows, type, f = () => true) => rows.events.some((e) => e.type === type && f(e, e.data ? JSON.parse(e.data) : {}));
const answers = (p) => p.evaluate(() => ({ full: S.R.photo.accepted[0], half: S.R.photo.partial[0] }));
async function freezeAnswer(p, text) {
  await p.waitForSelector("#fz:not([disabled])", { timeout: 60000 });
  await p.waitForTimeout(350);
  await p.click("#fz");
  await p.waitForSelector("#ans");
  if (text !== null) { await p.fill("#ans", text); await p.press("#ans", "Enter"); await p.waitForTimeout(200); }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const noErrors = async (p) => {
  must(p.errs.length === 0, "page errors: " + p.errs.join(" | "));
  const csp = await p.evaluate(() => window.__csp || []).catch(() => []);
  must(csp.length === 0, "Content-Security-Policy blocked: " + csp.join(" | "));
};

// ------------------------------------------------------------------ wires
const WIRES = {
  home: ["Home loads with every mode and no errors", async () => {
    const p = await page();
    for (const id of ["#goWorld", "#goPractice", "#goBlitz", "#goGroup", "#goPack"]) must(await p.locator(id).isVisible(), id + " not visible");
    await noErrors(p); await close(p); return "5 mode controls visible";
  }],
  consent_no: ["Declining consent sends nothing and stores no id", async () => {
    const p = await page({ consent: null, sid: null });
    await p.waitForSelector("#pt-no");
    p.api.length = 0;
    await p.click("#pt-no"); await p.click("#goPractice"); await freezeAnswer(p, "zzqx"); await p.waitForTimeout(5000);
    const data = p.api.filter((u) => /\/api\/(e|feedback)(\?|$)/.test(u)); // the clock read (/api/time) carries no id and no data
    must(data.length === 0, "data sent after declining: " + data.join(", "));
    must(await p.evaluate(() => localStorage.getItem("gr.pt.sid")) === null, "an id was stored");
    await noErrors(p); await close(p); return "no data sent, no id stored";
  }],
  consent_yes: ["Accepting consent records session_start and screens", async () => {
    const p = await page({ consent: null });
    await p.click("#pt-yes");
    await landed(p.sid, (r) => ev(r, "session_start") && ev(r, "screen") && r.session?.device, "session_start + screen + session row with device");
    await noErrors(p); await close(p); return "session_start, screen landed";
  }],
  practice_full: ["Practice: freeze, correct answer, results with credit; events land", async () => {
    const p = await page();
    await p.click("#goPractice"); await p.waitForFunction(() => S.R && S.R.photo);
    const a = await answers(p);
    await p.waitForSelector("#fz:not([disabled])", { timeout: 20000 });
    const img = await p.evaluate(() => { const i = document.querySelector(".board img"); return i ? { ok: i.complete && i.naturalWidth > 0, w: i.naturalWidth } : { ok: true, emoji: true }; });
    must(img.ok, "photo under the tiles did not load");
    await freezeAnswer(p, a.full);
    await p.waitForSelector(".result-h");
    must(/Correct/.test(await p.locator(".result-h").innerText()), "result is not Correct");
    const credit = await p.evaluate(() => !!(S.R.photo.credit) === /Photo:/.test(document.body.innerText));
    must(credit, "photo credit line missing on results");
    await landed(p.sid, (r) => ev(r, "round_start") && ev(r, "freeze") && ev(r, "answer", (e, d) => d.kind === "correct") && ev(r, "round_end", (e, d) => d.outcome === "correct"), "round_start/freeze/answer/round_end");
    await noErrors(p); await close(p); return `photo loaded (${img.w || "emoji"}px), credit shown, 4 events landed`;
  }],
  half_credit: ["Half answer banks and continues; wrong 2nd answer keeps half credit", async () => {
    const p = await page();
    await p.click("#goPractice"); await p.waitForFunction(() => S.R && S.R.photo);
    const a = await answers(p);
    await freezeAnswer(p, a.half);
    must(await p.evaluate(() => S.screen === "play" && S.R.partialOpen), "round ended on a half answer");
    must(/Half credit banked/.test(await p.locator(".overlay").innerText()), "banked message missing");
    await freezeAnswer(p, "zzqx not a thing");
    await p.waitForSelector(".result-h", { timeout: 8000 });
    must(/Close enough/.test(await p.locator(".result-h").innerText()), "banked half credit lost");
    await landed(p.sid, (r) => ev(r, "round_end", (e, d) => d.outcome === "partial"), "round_end partial");
    await noErrors(p); await close(p); return "banked, continued, kept";
  }],
  giveup: ["Give up reveals the photo and records the outcome; Back returns home", async () => {
    const p = await page();
    await p.click("#goPractice");
    await p.waitForSelector("#giveup", { timeout: 20000 }); await p.click("#giveup");
    await p.waitForSelector(".result-h");
    await landed(p.sid, (r) => ev(r, "round_end", (e, d) => d.outcome === "gave_up"), "round_end gave_up");
    await p.click("#home"); await p.waitForSelector("#goPractice");
    await noErrors(p); await close(p); return "gave_up landed, home reached";
  }],
  unfreeze: ["Unfreeze spends a freeze and is recorded", async () => {
    const p = await page();
    await p.click("#goPractice"); await freezeAnswer(p, null);
    await p.click("#unfreeze"); await p.waitForTimeout(300);
    must(await p.evaluate(() => S.R.freezesUsed === 1 && !S.R.frozen), "freeze not spent");
    await landed(p.sid, (r) => ev(r, "freeze_fail"), "freeze_fail");
    await noErrors(p); await close(p); return "freeze spent, freeze_fail landed";
  }],
  options: ["Practice grid, scramble and hint options reach the round", async () => {
    const p = await page();
    await p.click('#grids [data-n="9"]');
    await p.click('#pScr [data-c="1"]');
    await p.check("#hint");
    await p.click("#goPractice"); await p.waitForFunction(() => S.R && S.R.photo);
    const r = await p.evaluate(() => ({ N: S.R.N, scr: S.R.scr, hint: S.R.hint }));
    must(r.N === 9 && r.scr === 1 && r.hint === true, "options not applied: " + JSON.stringify(r));
    await landed(p.sid, (x) => ev(x, "round_start", (e, d) => e.grid === 9 && d.scr === 1 && d.hint === true), "round_start with options");
    await noErrors(p); await close(p); return "9 tiles, scramble 1, hint on";
  }],
  blitz: ["Blitz: answer, skip, end run, run again; run total recorded", async () => {
    const p = await page();
    await p.click("#goBlitz"); await p.waitForFunction(() => S.R && S.R.photo);
    await freezeAnswer(p, (await answers(p)).full);
    await p.waitForFunction(() => S.R && !S.R.flash && S.R.freezesUsed === 0, null, { timeout: 8000 });
    await p.click("#skip");
    await p.waitForFunction(() => S.R && !S.R.flash, null, { timeout: 8000 });
    await p.click("#endRun"); await p.waitForSelector("#again");
    const total = await p.evaluate(() => S.blitz.total);
    must(total > 0, "run total is 0 after a correct answer");
    await landed(p.sid, (r) => ev(r, "blitz_end", (e, d) => d.total === total) && ev(r, "round_end", (e) => e.mode === "blitz"), "blitz_end with total");
    await p.click("#again"); await p.waitForFunction(() => S.screen === "play");
    await noErrors(p); await close(p); return `run total ${total} recorded`;
  }],
  world: ["World Live: join, freeze, answer, results with leaderboard, next round", async () => {
    const p = await page();
    await p.click("#goWorld"); await p.waitForFunction(() => S.R && S.R.photo);
    await freezeAnswer(p, (await answers(p)).full);
    await p.waitForSelector(".result-h", { timeout: 70000 });
    must(/World Live Leaderboard/.test(await p.locator("body").innerText()), "leaderboard missing");
    must(await p.locator("#next").isVisible(), "next round button missing");
    await landed(p.sid, (r) => ev(r, "round_end", (e) => e.mode === "world"), "world round_end");
    await noErrors(p); await close(p); return "leaderboard shown, round_end landed";
  }],
  group_reconnect: ["Group Room survives reloads: guest returns to the live round with their score; host keeps the game; unknown codes explain themselves", async () => {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync(process.execPath, [join(ROOT, "scripts/group-reconnect-e2e.mjs"), BASE], { encoding: "utf8", timeout: 360000 });
    const out = (r.stdout || "") + (r.stderr || "");
    must(/^PASS/m.test(out), (out.match(/^FAIL.*$/m) || ["no result"])[0]);
    return "guest + host reload mid-game, scores kept, game continued";
  }],
  world_live_board: ["World Live is live: players in the same round see each other's real scores within a second", async () => {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync(process.execPath, [join(ROOT, "scripts/world-live-e2e.mjs"), BASE], { encoding: "utf8", timeout: 200000 });
    const out = (r.stdout || "") + (r.stderr || "");
    must(/^PASS/m.test(out), (out.match(/^FAIL.*$/m) || ["no result"])[0]);
    return (out.match(/both boards had both within \d+ ms/) || ["live"])[0];
  }],
  auto_update: ["Open pages pick up a new deploy by themselves, but never in the middle of a round", async () => {
    const ctx = await browser.newContext();
    let build = "wire-a";
    await ctx.route("**/version.json", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ build }) }));
    const p = await ctx.newPage();
    await p.goto(BASE + "/"); await p.waitForSelector("#pt-no"); await p.click("#pt-no");
    await p.waitForFunction(() => BUILD.mine === "wire-a");
    await p.click("#goPractice"); await p.waitForSelector("#fz:not([disabled])", { timeout: 20000 });
    build = "wire-b";
    await p.evaluate(() => checkBuild());
    await p.waitForTimeout(2500);
    must(await p.evaluate(() => S.screen === "play" && BUILD.pending), "page reloaded mid-round or did not notice the new build");
    const reloaded = p.waitForEvent("load", { timeout: 10000 });
    await p.click("#giveup"); await p.waitForSelector(".result-h").catch(() => {});
    await reloaded;
    await p.waitForFunction(() => typeof BUILD !== "undefined" && BUILD.mine === "wire-b", null, { timeout: 10000 });
    await ctx.close();
    return "noticed mid-round, waited, reloaded on the results screen";
  }],
  a11y: ["Accessibility: no WCAG 2 A/AA violations on home, a selected option, or group setup (axe-core)", async () => {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync(process.execPath, [join(ROOT, "scripts/a11y.mjs"), BASE], { encoding: "utf8", timeout: 120000 });
    const out = (r.stdout || "") + (r.stderr || "");
    const ids = [...new Set([...out.matchAll(/"id": "([a-z-]+)"/g)].map((m) => m[1]))];
    must(/^PASS/m.test(out) && ids.length === 0, "violations: " + (ids.join(", ") || out.split("\n").slice(-2).join(" ")));
    return "0 violations";
  }],
  static_files: ["Icons, manifest, robots, share image and a real 404 are served; photos cached for a year", async () => {
    const want = { "/favicon.ico": ["200", "image"], "/manifest.webmanifest": ["200", "manifest"], "/robots.txt": ["200", "text/plain"],
      "/og.png": ["200", "image/png"], "/icon-512.png": ["200", "image/png"], ["/no-such-page-" + Date.now()]: ["404", "text/html"] };
    for (const [u, [code, type]] of Object.entries(want)) {
      const r = await fetch(BASE + u);
      must(String(r.status) === code && (r.headers.get("content-type") || "").includes(type), `${u}: ${r.status} ${r.headers.get("content-type")}`);
    }
    const photo = inv.pool[0];
    const pr = await fetch(BASE + "/" + photo.src);
    must(/immutable/.test(pr.headers.get("cache-control") || ""), "photos are not cached long-term");
    const h = await fetch(BASE + "/");
    for (const k of ["content-security-policy", "strict-transport-security", "x-frame-options", "permissions-policy"]) must(h.headers.get(k), "missing header " + k);
    must(/og:image/.test(await h.text()), "share image tag missing");
    return "all present; CSP, HSTS, frame and permissions headers set";
  }],
  world_same: ["World Live is the same round on every device at the same moment, even with a wrong device clock", async () => {
    const real = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const skew = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await skew.addInitScript(() => { const n = Date.now.bind(Date); Date.now = () => n() + 9000; }); // a phone whose clock is 9 s fast
    try {
      const [a, b] = await Promise.all([real.newPage(), skew.newPage()]);
      await Promise.all([a.goto(BASE + "/"), b.goto(BASE + "/")]);
      for (const p of [a, b]) { await p.waitForSelector("#pt-no"); await p.click("#pt-no"); }
      const out = [];
      for (const btn of ["#goWorld", "#goWorldScr"]) {
        await Promise.all([a.click(btn), b.click(btn)]);
        await Promise.all([a, b].map((p) => p.waitForFunction(() => S.R && S.R.cycle !== undefined, null, { timeout: 10000 })));
        const snap = (p) => p.evaluate(() => ({ k: S.R.cycle, photo: S.R.photo.slug, N: S.R.N, seed: S.R.seed, scr: S.R.scr, wall: Math.round(S.R.revealStart + performance.timeOrigin) }));
        const [x, y] = await Promise.all([snap(a), snap(b)]);
        must(x.k === y.k && x.photo === y.photo && x.N === y.N && x.seed === y.seed && x.scr === y.scr, `different rounds: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`);
        const gap = Math.abs(x.wall - y.wall);
        must(gap < 250, `reveal start ${gap} ms apart (clock sync failed)`);
        out.push(`${btn === "#goWorld" ? "plain" : "scrambled"} ${x.photo} ${gap} ms apart`);
        for (const p of [a, b]) await p.evaluate(() => { S.screen = "home"; render(); });
      }
      return out.join("; ") + " (one device clock 9 s fast)";
    } finally { await real.close(); await skew.close(); }
  }],
  world_scr: ["World Live: Scrambled: every round shuffled + turned, x1.5 score, own board, recorded as its own mode", async () => {
    const p = await page();
    await p.click("#goWorldScr"); await p.waitForFunction(() => S.R && S.R.photo);
    must(await p.evaluate(() => S.R.scr === 2 && !!S.R.scramble), "round is not at scramble level 2");
    await freezeAnswer(p, (await answers(p)).full);
    await p.waitForSelector(".result-h", { timeout: 70000 });
    must(/World Live: Scrambled Leaderboard/.test(await p.locator("body").innerText()), "scrambled leaderboard missing");
    await landed(p.sid, (r) => ev(r, "round_start", (e, d) => e.mode === "world_scr" && d.scr === 2) && ev(r, "round_end", (e) => e.mode === "world_scr"), "world_scr round_start/round_end");
    await noErrors(p); await close(p); return "scrambled round played, recorded as world_scr";
  }],
  abandon: ["Quitting a round before it ends is recorded", async () => {
    const p = await page();
    await p.click("#goWorld"); await p.waitForSelector("#quit", { timeout: 20000 });
    await p.click("#quit"); await p.waitForSelector("#goPractice");
    await landed(p.sid, (r) => ev(r, "round_abandon"), "round_abandon");
    await noErrors(p); await close(p); return "round_abandon landed";
  }],
  visit_data: ["Visit data lands: device details, page speed, answer time, play time, errors", async () => {
    const p = await page();
    await p.click("#goPractice"); await p.waitForFunction(() => S.R && S.R.photo);
    await freezeAnswer(p, (await answers(p)).full);
    await p.waitForSelector(".result-h");
    await p.evaluate(() => setTimeout(() => { throw new Error("wire-map probe"); }, 0));
    await p.waitForTimeout(500);
    const sid = p.sid;
    await p.close({ runBeforeUnload: true }); // pagehide -> final heartbeat by beacon
    await p.context().close();
    const rows = await landed(sid, (r) => ev(r, "session_start", (e, d) => d.os && d.browser && d.visit && d.page && d.page.ttfb >= 0)
      && ev(r, "answer", (e, d) => Number.isFinite(d.rt) && d.rt > 0 && d.rt < 8000)
      && ev(r, "heartbeat", (e, d) => d.active_ms > 0 && d.rounds >= 1)
      && ev(r, "client_error", (e, d) => d.kind === "js" && /wire-map probe/.test(d.msg)), "session_start details + answer rt + heartbeat + client_error");
    const hb = rows.events.filter((e) => e.type === "heartbeat").map((e) => JSON.parse(e.data)).pop();
    const st = JSON.parse(rows.events.find((e) => e.type === "session_start").data);
    return `${st.os}/${st.browser}, first byte ${st.page.ttfb} ms, ${Math.round(hb.active_ms / 1000)} s active, error captured`;
  }],
  owner_device: ["?owner=1 marks a device so its plays are never counted", async () => {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto(BASE + "/?owner=1"); await p.waitForSelector("#pt-yes"); await p.click("#pt-yes");
    await p.goto(BASE + "/"); await p.waitForSelector("#goPractice");
    const sid = await p.evaluate(() => window.__playtest.sid);
    await ctx.close();
    must(sid.startsWith("5e5e5e5e-owner-"), "owner device id is " + sid);
    await landed(sid, (r) => ev(r, "session_start"), "owner session stored");
    return "owner plays stored, excluded from stats";
  }],
  feedback_form: ["Feedback form: rating, tags, text, send; stored with context", async () => {
    const p = await page();
    await p.click(".pt-fab"); await p.click("#pt-cancel");
    await p.click(".pt-fab");
    await p.click('#pt-stars [data-n="3"]'); await p.click('#pt-tags [data-k="other"]');
    const mark = "wire-map " + Date.now();
    await p.fill("#pt-liked", mark); await p.fill("#pt-dis", "x"); await p.fill("#pt-bug", "y"); await p.fill("#pt-contact", "");
    await p.click("#pt-send");
    await p.waitForFunction(() => /Thank you/.test(document.querySelector("#pt-msg")?.textContent || ""), null, { timeout: 8000 });
    const rows = await landed(p.sid, (r) => r.feedback.some((f) => f.liked === mark && f.rating === 3 && f.tags === "other" && JSON.parse(f.context).screen === "home") && ev(r, "feedback_open"), "feedback row + feedback_open");
    await noErrors(p); await close(p); return `feedback stored (${rows.feedback.length} rows for this session)`;
  }],
  round_reaction: ["Round thumbs and 'should count' flag are stored per photo", async () => {
    const p = await page();
    await p.click("#goPractice"); await p.waitForFunction(() => S.R && S.R.photo);
    await freezeAnswer(p, "zzqx one"); await freezeAnswer(p, "zzqx two");
    await p.waitForSelector(".pt-rf", { timeout: 10000 });
    await p.click('.pt-rf [data-r="1"]'); await p.click('.pt-rf [data-d="0"]');
    await p.waitForFunction(() => /Thanks/.test(document.querySelector("#pt-st")?.textContent || ""), null, { timeout: 8000 });
    await landed(p.sid, (r) => r.feedback.some((f) => f.kind === "round" && f.rating === 1) && r.feedback.some((f) => f.kind === "dispute" && f.answer === "zzqx one"), "round + dispute feedback");
    await noErrors(p); await close(p); return "thumbs + dispute stored";
  }],
  admin: ["Admin results are locked without the token, load with it, and exclude test traffic", async () => {
    must((await fetch(BASE + "/api/admin/summary")).status === 401, "summary open without token");
    must((await fetch(BASE + "/api/admin/session?sid=" + SYN + "-x-000000000000")).status === 401, "session open without token");
    const s = await (await fetch(BASE + "/api/admin/summary", { headers: { authorization: "Bearer " + TOKEN } })).json();
    must(!s.recent.some((f) => /^wire-map /.test(f.liked || "")), "wire-map feedback is being counted");
    const p = await browser.newPage();
    await p.goto(BASE + "/admin/"); await p.fill("#tok", TOKEN); await p.click("#login button");
    await p.waitForFunction(() => /Updated/.test(document.querySelector("#status").textContent), null, { timeout: 10000 });
    must(await p.locator("text=Rounds by mode").isVisible(), "dashboard did not render");
    for (const h of ["Audience", "Play time", "Daily", "Speed", "Errors on testers' devices", "Platforms"]) must(await p.locator("h2", { hasText: h }).count(), "dashboard section missing: " + h);
    must(await p.locator("#dl").isVisible(), "download button missing");
    await p.close(); return `locked, renders, ${s.totals.sessions} real testers counted`;
  }],
  api_guard: ["APIs reject garbage, oversize and empty input", async () => {
    const post = (path, body) => fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body });
    must((await post("/api/e", '{"sid":"x"}')).status === 400, "bad event accepted");
    must((await post("/api/e", "x".repeat(33000))).status === 413, "oversize accepted");
    must((await post("/api/feedback", JSON.stringify({ sid: SYN + "-guard-0000000000", kind: "general" }))).status === 400, "empty feedback accepted");
    return "400 / 413 / 400";
  }],
  headers: ["Security and no-index headers are served", async () => {
    const a = await fetch(BASE + "/admin/"), h = await fetch(BASE + "/");
    must(/noindex/.test(a.headers.get("x-robots-tag") || ""), "admin is indexable");
    must(h.headers.get("x-content-type-options") === "nosniff", "nosniff missing");
    return "noindex on /admin, nosniff";
  }],
  photos: ["Every built-in photo loads at 900x900 with an allowed licence, answers and a credit", async () => {
    const pool = inv.pool;
    must(pool.length > 0, "no photos in the pool");
    const bad = [];
    for (const ph of pool) {
      if (!ph.accepted?.length || !ph.partial?.length) bad.push(ph.slug + ": answers");
      if (!/^(public domain|pd\b|pd-|cc0|cc by \d)/i.test(ph.credit?.license || "") || /sa|nc|nd/i.test((ph.credit?.license || "").replace(/^cc by /i, ""))) bad.push(ph.slug + ": licence " + ph.credit?.license);
      if (!ph.credit?.author || !ph.credit?.page) bad.push(ph.slug + ": credit");
    }
    const p = await browser.newPage();
    await p.goto(BASE + "/");
    const dims = await p.evaluate(async (srcs) => Promise.all(srcs.map((s) => new Promise((ok) => { const i = new Image(); i.onload = () => ok([s, i.naturalWidth, i.naturalHeight]); i.onerror = () => ok([s, 0, 0]); i.src = s; }))), pool.map((x) => x.src));
    for (const [s, w, h] of dims) if (w !== 900 || h !== 900) bad.push(s + `: ${w}x${h}`);
    await p.close();
    const credits = await (await fetch(BASE + "/photos/CREDITS.md")).text();
    for (const ph of pool) if (!credits.includes(ph.credit.page)) bad.push(ph.slug + ": not in CREDITS.md");
    must(!bad.length, bad.slice(0, 8).join("; ") + (bad.length > 8 ? ` (+${bad.length - 8} more)` : ""));
    return `${pool.length} photos OK`;
  }],
  selftest: ["Scoring self-test in the page passes every spec vector", async () => {
    const p = await page();
    await p.click("summary:has-text('Scoring self-test')");
    await p.waitForFunction(() => (document.querySelector("#vec")?.textContent || "").length > 20);
    const t = await p.locator("#vec").innerText();
    must(!/FAIL/i.test(t), "a vector failed");
    await noErrors(p); await close(p); return (t.match(/\d+\s*\/\s*\d+[^\n]*/) || ["passed"])[0].slice(0, 60);
  }],
  pack: ["Your own photos: add a photo from the device, name the pack, back out", async () => {
    const p = await page();
    await p.click("#goPack");
    await p.setInputFiles("#files", join(ROOT, "prototype/photos", inv.pool[0]?.slug + ".jpg"));
    await p.waitForFunction(() => /Added 1 photo/.test(document.querySelector("#packMsg")?.textContent || ""), null, { timeout: 10000 });
    await p.fill("#packName", "Wire map pack"); await p.press("#packName", "Tab");
    await p.click("#back"); await p.waitForSelector("#pSrc");
    must(await p.evaluate(() => PACK.photos.length === 1), "photo not in the pack");
    await noErrors(p); await close(p); return "1 photo added";
  }],
  pack_persist: ["Your own photos survive a reload", async () => {
    const p = await page();
    await p.click("#goPack");
    await p.setInputFiles("#files", join(ROOT, "prototype/photos", inv.pool[0]?.slug + ".jpg"));
    await p.waitForFunction(() => /Added 1 photo/.test(document.querySelector("#packMsg")?.textContent || ""), null, { timeout: 10000 });
    await p.reload(); await p.waitForSelector("#goPractice");
    const n = await p.evaluate(() => PACK.photos.length);
    await close(p);
    must(n === 1, `after reload the pack has ${n} photos (saving needs the claude.ai asset store; not available on this site)`);
    return "kept after reload";
  }],
  profile: ["Player name is saved on the device", async () => {
    const p = await page();
    await p.fill("#profName", "WireMap"); await p.press("#profName", "Tab");
    await p.reload(); await p.waitForSelector("#profName");
    must(await p.inputValue("#profName") === "WireMap", "name not kept");
    await noErrors(p); await close(p); return "kept after reload";
  }],
  group: ["Group Room: host shares a link, a friend joins with just a name, both play the same round live", async () => {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync(process.execPath, [join(ROOT, "scripts/group-e2e.mjs"), BASE], { encoding: "utf8", timeout: 180000 });
    const out = (r.stdout || "") + (r.stderr || "");
    must(/^PASS/m.test(out), (out.match(/^FAIL.*$/m) || ["no result"])[0]);
    const joined = out.match(/host saw the guest (\d+) ms/)?.[1], skew = out.match(/round start skew (\d+) ms/)?.[1];
    return `joined via invite in ${joined} ms, round start skew ${skew} ms, boards match`;
  }],
};

// ------------------------------------------------------------------ run + report
const inv = inventory();
const prev = existsSync(join(ROOT, "docs/wire-map.json")) ? JSON.parse(read("docs/wire-map.json")) : { wires: {} };
browser = await chromium.launch();
const results = {};
const usedBy = {};
for (const [kind, reg] of Object.entries(REGISTRY)) for (const [name, r] of Object.entries(reg)) if (r.wire) (usedBy[r.wire] ??= []).push({ kind, name, status: r.status });
for (const [id, [promise, fn]] of Object.entries(WIRES)) {
  if (ONLY && !ONLY.includes(id)) continue;
  const elems = usedBy[id] ?? [];
  const planned = elems.length > 0 && elems.every((e) => e.status === "planned" || e.status === "gap");
  const t0 = Date.now();
  let ok, detail;
  if (!TOKEN && /landed|admin/.test(fn.toString())) { ok = false; detail = "GLIMPSE_ADMIN_TOKEN not set"; }
  else try { detail = await fn(); ok = true; } catch (e) { ok = false; detail = String(e.message || e).split("\n")[0]; }
  const state = ok ? "green" : planned ? "amber" : "red";
  const since = state === "green" ? null : prev.wires?.[id]?.failing_since ?? new Date().toISOString();
  results[id] = { promise, state, detail, ms: Date.now() - t0, failing_since: since, elements: elems.length };
  console.log(`${state === "green" ? "GREEN" : state === "amber" ? "AMBER" : "RED  "} ${id.padEnd(15)} ${detail}`);
}
await browser.close();
// registry wires must exist
for (const [kind, reg] of Object.entries(REGISTRY)) for (const [name, r] of Object.entries(reg))
  if (r.wire && !WIRES[r.wire]) inv.rows.push({ kind, name, state: "red", why: `wire "${r.wire}" does not exist` });
// a non-planned element whose wire is red is itself red
const elementStates = [];
for (const [kind, reg] of Object.entries(REGISTRY)) for (const [name, r] of Object.entries(reg)) {
  const w = r.wire ? results[r.wire] : null;
  const st = r.status ? "amber" : !r.wire ? "red" : !w ? "unrun" : w.state;
  elementStates.push({ kind, name, purpose: r.purpose, wire: r.wire, done: r.done, state: st, status: r.status ?? "live" });
}
const red = inv.rows.filter((r) => r.state === "red").length + Object.values(results).filter((r) => r.state === "red").length
  + elementStates.filter((e) => e.state === "red").length;
const out = { base: BASE, ran: new Date().toISOString(), red, inventory: { counts: Object.fromEntries(Object.entries(inv.found).map(([k, v]) => [k, new Set(v).size])), problems: inv.rows, photos: inv.photos }, wires: results, elements: elementStates };
mkdirSync(join(ROOT, "docs"), { recursive: true });
writeFileSync(join(ROOT, "docs/wire-map.json"), JSON.stringify(out, null, 1));

const lamp = (s) => ({ green: "🟢", amber: "🟡", red: "🔴", unrun: "⚪" }[s] || "⚪");
const md = [
  `# Glimpse Rush wire map`, ``, `Run ${out.ran} against ${BASE}. **${red ? red + " red" : "All wired"}.** Regenerate: \`node scripts/wire-map.mjs\`.`, ``,
  `🟢 works and its completion is recorded · 🟡 promised but not built yet (kept visible) · 🔴 broken, unregistered or dead (fails the build)`, ``,
  `## Inventory`, ``, `Discovered in code: ${Object.entries(out.inventory.counts).map(([k, v]) => `${v} ${k}`).join(", ")}. Photos: ${inv.photos.pool} in the pool of ${inv.photos.catalog} catalogued${inv.photos.notSourced.length ? ` (not sourced yet: ${inv.photos.notSourced.join(", ")})` : ""}.`, ``,
  inv.rows.length ? inv.rows.map((r) => `- 🔴 ${r.kind} \`${r.name}\`: ${r.why}`).join("\n") : "- No unregistered, dead or mismatched elements.", ``,
  `## Wires`, ``, `| | Wire | Promise | Result | Failing since |`, `|---|---|---|---|---|`,
  ...Object.entries(results).map(([id, r]) => `| ${lamp(r.state)} | ${id} | ${r.promise} | ${r.detail.replace(/\|/g, "/")} | ${r.failing_since ?? ""} |`), ``,
  `## Open promises`, ``, ...Object.entries(REGISTRY.promise).map(([k, r]) => `- ${lamp(r.status === "gap" ? "amber" : "amber")} **${k}** (${r.status}): ${r.purpose}${r.wire ? ` — wire \`${r.wire}\`` : " — no wire yet"}`), ``,
  `## Elements`, ``, `| | Kind | Element | Purpose | Wire | Completion |`, `|---|---|---|---|---|---|`,
  ...elementStates.filter((e) => e.kind !== "promise").map((e) => `| ${lamp(e.state)} | ${e.kind} | \`${e.name}\` | ${e.purpose} | ${e.wire ?? "—"} | ${e.done} |`), ``,
];
writeFileSync(join(ROOT, "docs/WIRE_MAP.md"), md.join("\n"));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Glimpse Rush Wire Map</title>
<style>:root{--bg:#060d22;--panel:#0c1a3d;--line:#1f3a7a;--ink:#e8f0ff;--dim:#8fa6d6}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,sans-serif;padding:16px;max-width:1100px;margin-inline:auto}
h1{font-size:1.4rem}h2{font-size:1.05rem;margin-top:24px}.dim{color:var(--dim)}.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--dim)}code{font-size:.85em}</style></head><body>
<h1>Glimpse Rush wire map</h1><p class="dim">Run ${esc(out.ran)} against ${esc(BASE)}. <b>${red ? red + " red" : "All wired"}</b>.</p>
<h2>Wires</h2><div class="wrap"><table><tr><th></th><th>Wire</th><th>Promise</th><th>Result</th><th>Failing since</th></tr>${Object.entries(results).map(([id, r]) => `<tr><td>${lamp(r.state)}</td><td>${esc(id)}</td><td>${esc(r.promise)}</td><td>${esc(r.detail)}</td><td>${esc(r.failing_since ?? "")}</td></tr>`).join("")}</table></div>
<h2>Inventory problems</h2>${inv.rows.length ? `<ul>${inv.rows.map((r) => `<li>🔴 ${esc(r.kind)} <code>${esc(r.name)}</code>: ${esc(r.why)}</li>`).join("")}</ul>` : `<p class="dim">None.</p>`}
<h2>Open promises</h2><ul>${Object.entries(REGISTRY.promise).map(([k, r]) => `<li>🟡 <b>${esc(k)}</b> (${esc(r.status)}): ${esc(r.purpose)}</li>`).join("")}</ul>
<h2>Elements</h2><div class="wrap"><table><tr><th></th><th>Kind</th><th>Element</th><th>Purpose</th><th>Wire</th><th>Completion</th></tr>${elementStates.filter((e) => e.kind !== "promise").map((e) => `<tr><td>${lamp(e.state)}</td><td>${esc(e.kind)}</td><td><code>${esc(e.name)}</code></td><td>${esc(e.purpose)}</td><td>${esc(e.wire ?? "—")}</td><td>${esc(e.done)}</td></tr>`).join("")}</table></div></body></html>`;
writeFileSync(join(ROOT, "docs/wire-map.html"), html);
console.log(`\n${red ? red + " RED" : "ALL WIRED"} — docs/WIRE_MAP.md, docs/wire-map.html`);
process.exit(red ? 1 : 0);
