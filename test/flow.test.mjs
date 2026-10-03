// Round-flow tests: real browser, real page. Half credit (partial) on freeze 1 must bank and keep the round
// running (Solo Practice, Solo Blitz, Group via the shared submit path); World Live (ranked) stays unchanged.
// GAME_HTML=<path> runs the same tests against another copy of the page (used to prove they fail on the old rules).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const HTML = process.env.GAME_HTML || fileURLToPath(new URL("../prototype/index.html", import.meta.url));
const URL_ = pathToFileURL(path.resolve(HTML)).href;
let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser.close(); });

async function open() {
  const p = await browser.newPage({ viewport: { width: 390, height: 844 } });
  p.errs = [];
  p.on("pageerror", (e) => p.errs.push(String(e)));
  await p.goto(URL_);
  await p.waitForSelector("#goPractice");
  return p;
}
// Start a mode until the photo has a half-credit answer to type.
async function start(mode) {
  const id = { practice: "#goPractice", blitz: "#goBlitz", world: "#goWorld" }[mode];
  for (let i = 0; i < 15; i++) {
    const p = await open();
    await p.click(id);
    await p.waitForFunction(() => S.R && S.R.photo);
    const ans = await p.evaluate(() => ({ full: S.R.photo.accepted[0], half: S.R.photo.partial[0] }));
    if (ans.half) return { p, ...ans };
    await p.close();
  }
  throw new Error("no photo with a half-credit answer in 15 tries");
}
async function freezeAndAnswer(p, text) {
  await p.waitForSelector("#fz:not([disabled])", { timeout: 45000 });
  await p.waitForTimeout(350); // the game rejects a freeze <300 ms after the last one (anti-cheat)
  await p.click("#fz");
  await p.waitForSelector("#ans");
  await p.fill("#ans", text);
  await p.press("#ans", "Enter");
  await p.waitForTimeout(150);
}
const state = (p) => p.evaluate(() => ({
  screen: S.screen, done: S.R.done && { score: S.R.done.score, partial: S.R.done.partial, freezeNo: S.R.done.freezeNo },
  partialOpen: !!S.R.partialOpen, out: !!S.R.out, freezesUsed: S.R.freezesUsed, flash: !!S.R.flash,
  fzDisabled: !!document.querySelector("#fz")?.disabled, fzExists: !!document.querySelector("#fz"),
}));
// What the scoring library says this frozen answer is worth.
const worth = (p, f) => p.evaluate((d) => {
  const R = S.R, o = { freezeNo: d.freezeNo, partial: d.partial, hint: R.hint, scr: R.scr };
  return d.inFinal ? finalWindowScore(R.N, o) : revealScore(R.N, d.el, o);
}, f);

test("A practice: half credit on freeze 1 banks the score and the round keeps running", async () => {
  const { p, half } = await start("practice");
  try {
    await freezeAndAnswer(p, half);
    const s = await state(p);
    assert.equal(s.screen, "play", "round must not end on a half answer");
    assert.equal(s.done.partial, true);
    assert.equal(s.partialOpen, true);
    assert.equal(s.fzExists && !s.fzDisabled, true, "Freeze button is live again");
    const f = await p.evaluate(() => ({ ...S.R.done }));
    assert.equal(s.done.score, await worth(p, f), "banked score = half credit per spec");
    assert.match(await p.locator(".overlay").innerText(), /Half credit banked/);
    assert.deepEqual(p.errs, []);
  } finally { await p.close(); }
});

test("B practice: full answer on freeze 2 replaces the banked half credit when it scores more", async () => {
  const { p, half, full } = await start("practice");
  try {
    await freezeAndAnswer(p, half);
    const banked = (await state(p)).done.score;
    await freezeAndAnswer(p, full);
    const s = await state(p);
    assert.equal(s.screen, "results");
    const fullAt2 = await p.evaluate(() => {
      const f = S.R.done; return f.partial ? null : { freezeNo: f.freezeNo, el: f.el, inFinal: f.inFinal, partial: false };
    });
    if (fullAt2) {
      assert.equal(fullAt2.freezeNo, 2);
      assert.equal(s.done.score, await worth(p, fullAt2));
      assert.ok(s.done.score >= banked);
    } else {
      assert.equal(s.done.score, banked, "if the half credit scored more, it is kept");
    }
    assert.deepEqual(p.errs, []);
  } finally { await p.close(); }
});

test("C practice: wrong answer on freeze 2 keeps the banked half credit (not zero)", async () => {
  const { p, half } = await start("practice");
  try {
    await freezeAndAnswer(p, half);
    const banked = (await state(p)).done.score;
    assert.ok(banked > 0);
    await freezeAndAnswer(p, "zzqx not a thing");
    await p.waitForSelector(".result-h", { timeout: 8000 });
    const s = await state(p);
    assert.equal(s.screen, "results");
    assert.equal(s.done.score, banked);
    assert.match(await p.locator(".result-h").innerText(), /Close enough/);
  } finally { await p.close(); }
});

test("D practice: giving up after a half answer keeps the banked half credit", async () => {
  const { p, half } = await start("practice");
  try {
    await freezeAndAnswer(p, half);
    const banked = (await state(p)).done.score;
    await p.click("#giveup");
    await p.waitForSelector(".result-h");
    assert.equal((await state(p)).done.score, banked);
  } finally { await p.close(); }
});

test("E practice: a correct answer on freeze 1 still ends the round at once (unchanged)", async () => {
  const { p, full } = await start("practice");
  try {
    await freezeAndAnswer(p, full);
    await p.waitForSelector(".result-h");
    const s = await state(p);
    assert.equal(s.screen, "results");
    assert.equal(s.done.partial, false);
    assert.equal(s.partialOpen, false);
  } finally { await p.close(); }
});

test("F practice: half credit on the LAST freeze ends the round (no third chance)", async () => {
  const { p, half } = await start("practice");
  try {
    await freezeAndAnswer(p, "zzqx not a thing");
    await freezeAndAnswer(p, half);
    await p.waitForSelector(".result-h", { timeout: 8000 });
    const s = await state(p);
    assert.equal(s.screen, "results");
    assert.equal(s.done.freezeNo, 2);
    assert.equal(s.partialOpen, false);
    assert.equal(s.freezesUsed, 2);
  } finally { await p.close(); }
});

test("G blitz: half answer keeps the same photo; Next photo banks the half credit; run total matches", async () => {
  const { p, half } = await start("blitz");
  try {
    const photoBefore = await p.evaluate(() => S.R.photo.id);
    await freezeAndAnswer(p, half);
    const s = await state(p);
    assert.equal(s.flash, false, "no advance to the next photo yet");
    assert.equal(s.partialOpen, true);
    assert.equal(await p.evaluate(() => S.R.photo.id), photoBefore);
    assert.match(await p.locator("#skip").innerText(), /keep .* pts/);
    assert.equal(await p.evaluate(() => S.blitz.total), 0, "nothing added to the run until the photo is finished");
    await p.click("#skip");
    const banked = s.done.score;
    assert.equal(await p.evaluate(() => S.blitz.total), banked);
    assert.deepEqual(p.errs, []);
  } finally { await p.close(); }
});

test("H blitz: half answer then full answer on freeze 2 adds exactly the better score once", async () => {
  const { p, half, full } = await start("blitz");
  try {
    await freezeAndAnswer(p, half);
    const banked = (await state(p)).done.score;
    await freezeAndAnswer(p, full);
    const total = await p.evaluate(() => S.blitz.total);
    const final = await p.evaluate(() => S.R.done.score);
    assert.equal(total, final);
    assert.ok(final >= banked);
  } finally { await p.close(); }
});

test("I world live (ranked): a half answer still ends the player's round (unchanged)", async () => {
  const { p, half } = await start("world");
  try {
    await freezeAndAnswer(p, half);
    const s = await state(p);
    assert.equal(s.partialOpen, false);
    assert.equal(s.done.partial, true);
    assert.equal(s.fzDisabled, true, "no second chance in World Live");
  } finally { await p.close(); }
});

test("J custom photos: a tall phone photo is kept whole (fitted, not cropped)", async () => {
  const p = await open();
  try {
    const px = await p.evaluate(async () => {
      const c = document.createElement("canvas"); c.width = 600; c.height = 1200; const g = c.getContext("2d");
      g.fillStyle = "#00ff00"; g.fillRect(0, 0, 600, 1200);
      g.fillStyle = "#ff0000"; g.fillRect(0, 0, 600, 150);    // top band
      g.fillStyle = "#0000ff"; g.fillRect(0, 1050, 600, 150); // bottom band
      const blob = await new Promise((ok) => c.toBlob(ok, "image/png"));
      const { dataURL } = await prepImage(new File([blob], "tall.png", { type: "image/png" }));
      const img = await new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = dataURL; });
      const k = document.createElement("canvas"); k.width = img.width; k.height = img.height; const q = k.getContext("2d"); q.drawImage(img, 0, 0);
      const at = (x, y) => Array.from(q.getImageData(x, y, 1, 1).data.slice(0, 3));
      return { size: [img.width, img.height], top: at(img.width / 2, img.height * 0.05), bottom: at(img.width / 2, img.height * 0.95), mid: at(img.width / 2, img.height / 2) };
    });
    assert.deepEqual(px.size, [900, 900]);
    assert.ok(px.top[0] > 200 && px.top[1] < 60, "top band (red) survives: " + px.top);
    assert.ok(px.bottom[2] > 200 && px.bottom[0] < 60, "bottom band (blue) survives: " + px.bottom);
    assert.ok(px.mid[1] > 200, "middle is the photo: " + px.mid);
  } finally { await p.close(); }
});

test("K World Live: Scrambled: advanced scramble every round, x1.5 scoring, own leaderboard title, next round stays scrambled", async () => {
  const p = await open();
  try {
    await p.click("#goWorldScr");
    await p.waitForFunction(() => S.R && S.R.photo);
    const r = await p.evaluate(() => ({ mode: S.R.mode, scr: S.R.scr, scramble: !!S.R.scramble, turns: S.R.scramble && S.R.scramble.turn.some((t) => t !== 0), title: document.querySelector(".title").textContent }));
    assert.equal(r.mode, "world"); assert.equal(r.scr, 2); assert.ok(r.scramble, "pieces are scrambled"); assert.ok(r.turns, "pieces are turned");
    assert.match(r.title, /World Live: Scrambled/);
    const full = await p.evaluate(() => S.R.photo.accepted[0]);
    await freezeAndAnswer(p, full);
    const d = await p.evaluate(() => ({ ...S.R.done, N: S.R.N }));
    const expect = await p.evaluate((d) => ({ scr: d.inFinal ? finalWindowScore(d.N, { freezeNo: 1, scr: 2 }) : revealScore(d.N, d.el, { freezeNo: 1, scr: 2 }),
      plain: d.inFinal ? finalWindowScore(d.N, { freezeNo: 1 }) : revealScore(d.N, d.el, { freezeNo: 1 }) }), d);
    assert.equal(d.score, expect.scr, "score uses the x1.5 scramble multiplier");
    assert.ok(d.score > expect.plain);
    await p.waitForSelector(".result-h", { timeout: 70000 });
    assert.match(await p.locator("body").innerText(), /World Live: Scrambled Leaderboard/);
    await p.click("#next");
    await p.waitForFunction(() => S.screen === "play" && S.R && S.R.phase !== "RESULTS");
    assert.equal(await p.evaluate(() => S.R.scr), 2, "next round is scrambled too");
    // regular World Live is untouched
    assert.deepEqual(p.errs, []);
  } finally { await p.close(); }
});

test("L regular World Live stays plain", async () => {
  const p = await open();
  try {
    await p.click("#goWorld"); await p.waitForFunction(() => S.R && S.R.photo);
    assert.deepEqual(await p.evaluate(() => [S.R.scr, !!S.R.scramble]), [0, false]);
  } finally { await p.close(); }
});

test("M World Live is one global round: separate browsers get the same photo, grid, tiles, scramble, bots and start time", async () => {
  const ctxA = await browser.newContext(), ctxB = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const [a, b] = await Promise.all([ctxA.newPage(), ctxB.newPage()]);
    await Promise.all([a.goto(URL_), b.goto(URL_)]);
    for (const [btn, scr] of [["#goWorld", 0], ["#goWorldScr", 2]]) {
      await Promise.all([a.click(btn), b.click(btn)]);
      await Promise.all([a, b].map((p) => p.waitForFunction(() => S.R && S.R.photo && S.R.cycle !== undefined)));
      const snap = (p) => p.evaluate(() => ({ k: S.R.cycle, photo: S.R.photo.slug ?? S.R.photo.id, N: S.R.N, seed: S.R.seed, scr: S.R.scr,
        rank: S.R.rank.join(","), scramble: S.R.scramble ? S.R.scramble.src.join(",") + "|" + S.R.scramble.turn.join(",") : null,
        bots: S.R.bots.map((x) => x.name + ":" + x.score).join(","), wall: Math.round(S.R.revealStart + performance.timeOrigin) }));
      const [sa, sb] = await Promise.all([snap(a), snap(b)]);
      const wallA = sa.wall, wallB = sb.wall; delete sa.wall; delete sb.wall;
      assert.deepEqual(sa, sb, "both browsers must get the identical round");
      assert.equal(sa.scr, scr);
      assert.ok(Math.abs(wallA - wallB) < 150, `reveal start differs by ${Math.abs(wallA - wallB)} ms`);
      assert.equal(wallA % 60000 > 4800 && wallA % 60000 < 5200, true, "reveal starts 5 s after the minute");
      await Promise.all([a, b].map((p) => p.evaluate(() => { S.screen = "home"; render(); })));
    }
    // the photo sequence is a property of the minute, not of the browser, and does not repeat within the pool
    const seqA = await a.evaluate(() => Array.from({ length: 200 }, (_, i) => worldRound(30000000 + i, 0).photo.slug ?? worldRound(30000000 + i, 0).photo.id));
    const seqB = await b.evaluate(() => Array.from({ length: 200 }, (_, i) => worldRound(30000000 + i, 0).photo.slug ?? worldRound(30000000 + i, 0).photo.id));
    assert.deepEqual(seqA, seqB);
    const L = await a.evaluate(() => PHOTOS.length);
    const firstBlock = seqA.slice(0, L - (30000000 % L)); // inside one shuffle block nothing repeats
    assert.equal(new Set(firstBlock).size, firstBlock.length);
    assert.notDeepEqual(await a.evaluate(() => worldRound(30000000, 0).photo.slug), await a.evaluate(() => worldRound(30000000, 2).photo.slug), "scrambled queue is a different round");
  } finally { await ctxA.close(); await ctxB.close(); }
});
