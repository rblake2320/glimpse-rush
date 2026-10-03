// Regression for the 2026-10-03 E2E report: a guest who reloads during Group Room round 2 was sent to the lobby with
// their score reset. Two real browsers on the live site; guest reloads, then the host reloads; an unhosted code is checked.
import { chromium } from "playwright";
const BASE = (process.argv[2] || "https://glimpse-rush.pages.dev").replace(/\/$/, "");
const b = await chromium.launch();
const mk = async () => { const c = await b.newContext({ viewport: { width: 390, height: 844 } }); await c.addInitScript(() => localStorage.setItem("gr.pt.consent", "no")); const p = await c.newPage(); p.errs = []; p.on("pageerror", (e) => p.errs.push(String(e))); return p; };
const host = await mk(), guest = await mk();
const total = (p, name) => p.evaluate((n) => (groupTable(0).find((r) => r.name === n) || {}).total ?? null, name);
const step = (m) => console.log("·", m);
try {
  await host.goto(BASE + "/"); await host.click("#goGroup"); await host.fill("#nick", "Host"); await host.click("#host");
  await host.waitForFunction(() => S.screen === "groupLobby" && G.code);
  const invite = await host.evaluate(() => inviteUrl());
  await guest.goto(invite); await guest.waitForSelector("#joinCode"); await guest.fill("#nick", "Guest"); await guest.click("#join");
  await host.waitForFunction(() => groupTable(0).length === 2, null, { timeout: 10000 });
  await host.click("#start");
  // round 1: guest scores
  await guest.waitForFunction(() => S.screen === "play" && S.R && S.R.roundNo === 1, null, { timeout: 15000 });
  const a1 = await guest.evaluate(() => S.R.photo.accepted[0]);
  await guest.waitForSelector("#fz:not([disabled])", { timeout: 20000 }); await guest.click("#fz"); await guest.fill("#ans", a1); await guest.press("#ans", "Enter");
  const s1 = await guest.evaluate(() => S.R.done.score);
  await host.waitForFunction((s) => (groupTable(0).find((r) => r.name === "Guest") || {}).total === s, s1, { timeout: 10000 });
  step(`round 1: guest scored ${s1}`);
  // round 2 begins, guest reloads mid-round
  await Promise.all([host, guest].map((p) => p.waitForFunction(() => S.screen === "play" && S.R && S.R.roundNo === 2 && S.R.phase === "REVEAL", null, { timeout: 75000 })));
  const hostPhoto = await host.evaluate(() => S.R.photo.id);
  await guest.reload();
  await guest.waitForFunction(() => S.screen === "play" && S.R && S.R.mode === "group" && S.R.roundNo === 2, null, { timeout: 15000 });
  const back = await guest.evaluate(() => ({ photo: S.R.photo.id, nick: S.nick, mine: G.scores }));
  if (back.photo !== hostPhoto) throw new Error("guest rejoined a different round");
  if (back.mine[1] !== s1) throw new Error("guest's own round-1 score lost: " + JSON.stringify(back.mine));
  await host.waitForFunction((s) => groupTable(0).filter((r) => r.name === "Guest").length === 1 && (groupTable(0).find((r) => r.name === "Guest") || {}).total === s, s1, { timeout: 10000 });
  step(`guest reloaded mid round 2 → back in round 2, same photo, total still ${s1} on the host's board, no duplicate player`);
  // guest scores again after the reload
  const a2 = await guest.evaluate(() => S.R.photo.accepted[0]);
  await guest.waitForSelector("#fz:not([disabled])", { timeout: 20000 }); await guest.click("#fz"); await guest.fill("#ans", a2); await guest.press("#ans", "Enter");
  const s2 = await guest.evaluate(() => S.R.done.score);
  await host.waitForFunction((s) => (groupTable(0).find((r) => r.name === "Guest") || {}).total === s, s1 + s2, { timeout: 10000 });
  step(`guest scored ${s2} after the reload → total ${s1 + s2} on the host's board`);
  // host reloads; the game must carry on to round 3 for both
  const gameId = await host.evaluate(() => G.game.id);
  await host.reload();
  await host.waitForFunction((id) => G.isHost && G.game && G.game.id === id, gameId, { timeout: 15000 });
  await Promise.all([host, guest].map((p) => p.waitForFunction(() => S.screen === "play" && S.R && S.R.roundNo === 3, null, { timeout: 80000 })));
  const t3 = await total(guest, "Guest");
  if (t3 !== s1 + s2) throw new Error("guest total changed across the host reload: " + t3);
  step(`host reloaded → still host of the same game, round 3 started for both, guest total ${t3}`);
  // a code nobody hosts resolves to a clear message
  const lone = await mk();
  await lone.goto(BASE + "/#ZQ" + Math.random().toString(36).slice(2, 6).toUpperCase());
  await lone.waitForSelector("#joinCode"); await lone.fill("#nick", "Lone"); await lone.click("#join");
  await lone.waitForFunction(() => /Nobody is hosting room/.test(document.body.innerText), null, { timeout: 8000 });
  step("unhosted code → 'Nobody is hosting room … host it yourself'");
  const errs = [...host.errs, ...guest.errs, ...lone.errs];
  if (errs.length) throw new Error("page errors: " + errs.join(" | "));
  console.log("PASS");
} catch (e) { console.log("FAIL", e.message); process.exitCode = 1; }
await b.close();
