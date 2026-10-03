// Live-room tests against the real Workers runtime: starts `wrangler dev` (workerd + Durable Objects) and connects
// real WebSocket clients. ROOMS_URL=wss://… runs the same tests against a deployed service instead.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL(".", import.meta.url));
let proc, BASE = process.env.ROOMS_URL;

before(async () => {
  if (BASE) return;
  const port = 8790 + Math.floor(Math.random() * 100);
  proc = spawn("npx", ["wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1"], { cwd: DIR, shell: true, stdio: "pipe" });
  BASE = `ws://127.0.0.1:${port}`;
  const http = BASE.replace("ws", "http");
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(http + "/health")).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev did not start");
});
after(() => {
  if (!proc) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"]); else proc.kill();
  proc.stdout?.destroy(); proc.stderr?.destroy(); proc.unref();
});

function client(room) {
  return new Promise((ok, no) => {
    const ws = new WebSocket(`${BASE}/room/${room}`);
    const c = { ws, msgs: [], waiters: [] };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      c.msgs.push(m);
      c.waiters = c.waiters.filter((w) => (w.pred(m) ? (w.ok(m), false) : true));
      if (m.t === "hello") { c.id = m.id; ok(c); }
    };
    ws.onerror = () => no(new Error("socket error"));
  });
}
const wait = (c, pred, ms = 5000) => new Promise((ok, no) => {
  const hit = c.msgs.find(pred);
  if (hit) return ok(hit);
  const t = setTimeout(() => no(new Error("timeout waiting for message")), ms);
  c.waiters.push({ pred, ok: (m) => { clearTimeout(t); ok(m); } });
});
const send = (c, m) => c.ws.send(JSON.stringify(m));
const code = () => "gr-" + Math.random().toString(36).slice(2, 8).padEnd(6, "x");

test("A join: second player gets the first player's presence in hello; first player is told about the second", async () => {
  const room = code();
  const a = await client(room);
  send(a, { t: "presence", patch: { nick: "Host", role: "host" } });
  await wait(a, (m) => m.t === "peer" && m.id === a.id && m.presence.nick === "Host");
  const b = await client(room);
  const hello = b.msgs.find((m) => m.t === "hello");
  assert.deepEqual(hello.peers.map((p) => p.presence.nick), ["Host"]);
  await wait(a, (m) => m.t === "peer" && m.id === b.id);
  a.ws.close(); b.ws.close();
});

test("B presence patches merge and reach every player, including the sender", async () => {
  const room = code();
  const a = await client(room), b = await client(room);
  send(b, { t: "presence", patch: { nick: "Kid", team: 1 } });
  send(b, { t: "presence", patch: { sc: { g: "x", r: { 1: 900 } } } });
  const seen = await wait(a, (m) => m.t === "peer" && m.id === b.id && m.presence.sc);
  assert.deepEqual(seen.presence, { nick: "Kid", team: 1, sc: { g: "x", r: { 1: 900 } } });
  await wait(b, (m) => m.t === "peer" && m.id === b.id && m.presence.sc);
  a.ws.close(); b.ws.close();
});

test("C leaving is announced; rooms are isolated from each other", async () => {
  const r1 = code(), r2 = code();
  const a = await client(r1), b = await client(r1), other = await client(r2);
  b.ws.close();
  await wait(a, (m) => m.t === "leave" && m.id === b.id);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(other.msgs.filter((m) => m.t !== "hello").length, 0, "another room heard nothing");
  a.ws.close(); other.ws.close();
});

test("D bad names, plain HTTP and oversize presence are refused", async () => {
  const http = BASE.replace(/^ws/, "http");
  assert.equal((await fetch(http + "/room/NOT-VALID")).status, 400);
  assert.equal((await fetch(http + "/room/" + code())).status, 426);
  const room = code();
  const a = await client(room), b = await client(room);
  send(a, { t: "presence", patch: { big: "x".repeat(20000) } });
  send(a, { t: "presence", patch: { nick: "after" } });
  const m = await wait(b, (x) => x.t === "peer" && x.id === a.id && x.presence.nick === "after");
  assert.equal(m.presence.big, undefined, "oversize patch was dropped");
  a.ws.close(); b.ws.close();
});

test("E latency: a presence change reaches another player quickly (median of 20)", async () => {
  const room = code();
  const a = await client(room), b = await client(room);
  const times = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    send(a, { t: "presence", patch: { n: i } });
    await wait(b, (m) => m.t === "peer" && m.id === a.id && m.presence.n === i);
    times.push(performance.now() - t0);
  }
  times.sort((x, y) => x - y);
  const med = times[10];
  console.log(`  relay latency median ${med.toFixed(1)} ms, max ${times[19].toFixed(1)} ms`);
  assert.ok(med < (process.env.ROOMS_URL ? 400 : 100), "median relay latency " + med);
  a.ws.close(); b.ws.close();
});

test("F a room of 12 players all converge on everyone's presence", async () => {
  const room = code();
  const cs = [];
  for (let i = 0; i < 12; i++) cs.push(await client(room));
  cs.forEach((c, i) => send(c, { t: "presence", patch: { nick: "P" + i } }));
  for (const c of cs) {
    for (let i = 0; i < 12; i++) await wait(c, (m) => m.t === "peer" && m.presence.nick === "P" + i);
  }
  cs.forEach((c) => c.ws.close());
});

// ---------------------------------------------------------------- World Live board
function worldClient(q, name) {
  return new Promise((ok, no) => {
    const ws = new WebSocket(`${BASE}/world/${q}`);
    const c = { ws, msgs: [], waiters: [] };
    ws.onopen = () => { ws.send(JSON.stringify({ t: "hello", name })); ok(c); };
    ws.onmessage = (e) => { const m = JSON.parse(e.data); c.msgs.push(m); c.waiters = c.waiters.filter((w) => (w.pred(m) ? (w.ok(m), false) : true)); };
    ws.onerror = () => no(new Error("socket error"));
  });
}
const kNow = () => Math.floor(Date.now() / 60000);

test("G world board: every player sees everyone's scores for the round, best first, and the live player count", async () => {
  const q = "0";
  const a = await worldClient(q, "Ann"), b = await worldClient(q, "Bob");
  await new Promise((r) => setTimeout(r, 300));
  const k = kNow();
  send(a, { t: "score", k, score: 1200, s: 9, el: 6000 });
  send(b, { t: "score", k, score: 2400, s: 4, el: 3000 });
  const seenByA = await wait(a, (m) => m.t === "board" && m.k === k && m.rows.length >= 2 && m.rows.some((r) => r.name === "Bob"));
  const mine = seenByA.rows.filter((r) => r.name === "Ann" || r.name === "Bob");
  assert.deepEqual(mine.map((r) => [r.name, r.score]), [["Bob", 2400], ["Ann", 1200]]);
  assert.ok(seenByA.online >= 2, "online count includes both");
  await wait(b, (m) => m.t === "board" && m.k === k && m.rows.some((r) => r.name === "Ann"));
  a.ws.close(); b.ws.close();
});

test("H world board: one score per player per round; out-of-range scores, bad names and stale rounds are dropped; queues are separate", async () => {
  const a = await worldClient("2", "<b>Eve</b>"), watcher = await worldClient("2", "Watch"), plain = await worldClient("0", "Plain");
  await new Promise((r) => setTimeout(r, 300));
  const k = kNow();
  send(a, { t: "score", k, score: 99999, s: 1, el: 100 });       // above the maximum possible score
  send(a, { t: "score", k: k - 5, score: 500, s: 1, el: 100 });   // a round long gone
  send(a, { t: "score", k, score: 700, s: 2, el: 2000 });
  send(a, { t: "score", k, score: 900, s: 2, el: 2000 });         // second score in the same round
  const m = await wait(watcher, (x) => x.t === "board" && x.k === k && x.rows.some((r) => r.name === "bEveb"));
  const eve = m.rows.filter((r) => r.name === "bEveb");
  assert.deepEqual(eve.map((r) => r.score), [700], "only the first valid score counts; markup stripped from the name");
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(!plain.msgs.some((x) => x.t === "board" && x.rows.some((r) => r.name === "bEveb")), "the scrambled queue's scores never reach the plain queue");
  a.ws.close(); watcher.ws.close(); plain.ws.close();
});
