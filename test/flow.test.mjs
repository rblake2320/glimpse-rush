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
