// Backend tests for playtest telemetry: real handlers + real SQL on SQLite (D1's engine).
// D1 itself is exercised live after deploy; see playtest/README.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { cleanBatch, cleanFeedback, cleanEvent, LIMITS } from "../functions/_lib/ingest.js";
import { onRequestPost as postEvents } from "../functions/api/e.js";
import { onRequestPost as postFeedback } from "../functions/api/feedback.js";
import { onRequestGet as getSummary } from "../functions/api/admin/summary.js";

const MIGRATION = readFileSync(new URL("./migrations/0001_init.sql", import.meta.url), "utf8");
const SID = "0123456789abcdef-test-sid-0001";
const SID2 = "0123456789abcdef-test-sid-0002";

function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec(MIGRATION);
  return {
    raw: db,
    prepare(sql) {
      const st = db.prepare(sql);
      return {
        bind(...a) {
          return {
            _st: st, _a: a,
            run: async () => { st.run(...a); return {}; },
            first: async () => st.get(...a) ?? null,
            all: async () => ({ results: st.all(...a) }),
          };
        },
      };
    },
    async batch(stmts) {
      db.exec("BEGIN");
      try { for (const s of stmts) s._st.run(...s._a); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
    },
  };
}
const req = (path, body, headers = {}) =>
  new Request("https://x.test" + path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers });
const ev = (type, extra = {}) => ({ type, ts: Date.now(), ...extra });
const rows = (db, sql, ...a) => db.raw.prepare(sql).all(...a);

test("A ingest: rejects bad session ids and unknown event types, clamps wild timestamps", () => {
  const now = Date.now();
  assert.equal(cleanBatch({ sid: "short", events: [] }, now), null);
  assert.equal(cleanBatch({ sid: SID, events: "nope" }, now), null);
  const b = cleanBatch({ sid: SID, events: [ev("round_start"), ev("drop_table"), { type: "freeze", ts: 5 }] }, now);
  assert.deepEqual(b.events.map((e) => e.type), ["round_start", "freeze"]);
  assert.equal(b.events[1].ts, now, "a 1970 timestamp is replaced by server time");
  const big = cleanEvent({ type: "answer", data: { text: "x".repeat(LIMITS.data + 10) } }, now);
  assert.equal(big.data, JSON.stringify({ truncated: true }));
  assert.equal(cleanBatch({ sid: SID, events: Array.from({ length: 500 }, () => ev("screen")) }, now).events.length, LIMITS.batch);
});

test("B ingest: feedback validation (rating ranges, tag vocabulary, empty submissions)", () => {
  assert.equal(cleanFeedback({ sid: SID, kind: "general" }), null, "empty feedback is rejected");
  assert.equal(cleanFeedback({ sid: SID, kind: "bogus", liked: "x" }), null);
  assert.equal(cleanFeedback({ sid: SID, kind: "general", rating: 9, liked: "x" }).rating, null);
  assert.equal(cleanFeedback({ sid: SID, kind: "general", rating: 4 }).rating, 4);
  assert.equal(cleanFeedback({ sid: SID, kind: "round", rating: 0 }).rating, 0);
  assert.equal(cleanFeedback({ sid: SID, kind: "round", rating: 3, liked: "x" }).rating, null);
  assert.equal(cleanFeedback({ sid: SID, kind: "general", rating: 5, tags: ["fun", "<script>", "too_hard"] }).tags, "fun,too_hard");
  assert.equal(cleanFeedback({ sid: SID, kind: "general", liked: "y".repeat(5000) }).liked.length, LIMITS.text);
});

test("C /api/e stores events and a session; a second batch accumulates", async () => {
  const db = d1();
  const meta = { device: "mobile", viewport: "390x844", lang: "en-US", build: "t1" };
  let r = await postEvents({ request: req("/api/e", { sid: SID, meta, events: [ev("session_start"), ev("round_start", { mode: "practice", grid: 36, photo_id: "p1", round_no: 1 })] }, { "cf-ipcountry": "US" }), env: { DB: db } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).saved, 2);
  r = await postEvents({ request: req("/api/e", { sid: SID, events: [ev("freeze", { mode: "practice", grid: 36, photo_id: "p1", data: { shown: 9 } })] }), env: { DB: db } });
  assert.equal(r.status, 200);
  const s = rows(db, "SELECT * FROM sessions")[0];
  assert.equal(s.events_n, 3);
  assert.equal(s.country, "US");
  assert.equal(s.device, "mobile");
  assert.equal(rows(db, "SELECT COUNT(*) n FROM events")[0].n, 3);
  assert.equal(JSON.parse(rows(db, "SELECT data FROM events WHERE type='freeze'")[0].data).shown, 9);
});

test("D /api/e rejects malformed, oversize and rate-flooded requests without writing", async () => {
  const db = d1();
  assert.equal((await postEvents({ request: req("/api/e", "{not json"), env: { DB: db } })).status, 400);
  assert.equal((await postEvents({ request: req("/api/e", { sid: "x", events: [] }), env: { DB: db } })).status, 400);
  assert.equal((await postEvents({ request: req("/api/e", "x".repeat(LIMITS.body + 1)), env: { DB: db } })).status, 413);
  assert.equal(rows(db, "SELECT COUNT(*) n FROM events")[0].n, 0);
  const ins = db.raw.prepare("INSERT INTO events(sid,ts,srv_ts,type) VALUES(?,?,?,?)");
  for (let i = 0; i < LIMITS.perMinute; i++) ins.run(SID, Date.now(), Date.now(), "screen");
  const r = await postEvents({ request: req("/api/e", { sid: SID, events: [ev("screen")] }), env: { DB: db } });
  assert.equal(r.status, 429, "flooding one session id is throttled");
  const other = await postEvents({ request: req("/api/e", { sid: SID2, events: [ev("screen")] }), env: { DB: db } });
  assert.equal(other.status, 200, "other sessions are unaffected");
});

test("E /api/feedback stores each kind and keeps the optional contact separate from events", async () => {
  const db = d1();
  const post = (b) => postFeedback({ request: req("/api/feedback", b), env: { DB: db } });
  assert.equal((await post({ sid: SID, kind: "general", rating: 4, tags: ["fun", "too_hard"], liked: "tiles flip", disliked: "7s is short", bug: "", contact: "a@b.co", context: { screen: "home" } })).status, 200);
  assert.equal((await post({ sid: SID, kind: "round", rating: 0, photo_id: "p1" })).status, 200);
  assert.equal((await post({ sid: SID, kind: "dispute", answer: "bike", photo_id: "p2" })).status, 200);
  assert.equal((await post({ sid: SID, kind: "general" })).status, 400);
  const f = rows(db, "SELECT * FROM feedback ORDER BY id");
  assert.equal(f.length, 3);
  assert.equal(f[0].tags, "fun,too_hard");
  assert.equal(f[0].contact, "a@b.co");
  assert.equal(f[2].answer, "bike");
  assert.equal(rows(db, "SELECT COUNT(*) n FROM events")[0].n, 0, "feedback never lands in the events table");
});

test("F admin summary: 401 without the token, correct aggregates with it", async () => {
  const db = d1();
  const env = { DB: db, ADMIN_TOKEN: "s3cret-token" };
  const send = (sid, events) => postEvents({ request: req("/api/e", { sid, events }), env });
  const end = (photo, outcome, score, shown, grid = 36, mode = "practice") =>
    ev("round_end", { mode, grid, photo_id: photo, data: { outcome, score, shown } });
  await send(SID, [
    ev("round_start", { mode: "practice", grid: 36, photo_id: "p1" }), end("p1", "correct", 2000, 9),
    ev("round_start", { mode: "practice", grid: 36, photo_id: "p2" }), end("p2", "none", 0, 36),
    ev("round_start", { mode: "world", grid: 16, photo_id: "p1" }), ev("round_abandon", { mode: "world", grid: 16, photo_id: "p1" }),
    ev("answer", { photo_id: "p2", data: { kind: "wrong", text: "cat" } }),
    ev("answer", { photo_id: "p2", data: { kind: "wrong", text: "cat" } }),
    ev("answer", { photo_id: "p2", data: { kind: "wrong", text: "dog" } }),
  ]);
  await send(SID2, [end("p1", "partial", 1000, 12), ev("round_start", { mode: "practice", grid: 36, photo_id: "p1" })]);
  await postFeedback({ request: req("/api/feedback", { sid: SID, kind: "general", rating: 5, tags: ["fun"] }), env });
  await postFeedback({ request: req("/api/feedback", { sid: SID2, kind: "general", rating: 3, tags: ["fun", "too_slow"] }), env });
  await postFeedback({ request: req("/api/feedback", { sid: SID, kind: "round", rating: 0, photo_id: "p2" }), env });
  await postFeedback({ request: req("/api/feedback", { sid: SID, kind: "dispute", answer: "kitty", photo_id: "p2" }), env });

  const noTok = await getSummary({ request: new Request("https://x.test/api/admin/summary"), env });
  assert.equal(noTok.status, 401);
  const bad = await getSummary({ request: new Request("https://x.test/api/admin/summary", { headers: { authorization: "Bearer nope" } }), env });
  assert.equal(bad.status, 401);
  const unset = await getSummary({ request: new Request("https://x.test/api/admin/summary", { headers: { authorization: "Bearer " } }), env: { DB: db } });
  assert.equal(unset.status, 401, "no ADMIN_TOKEN configured means locked, not open");

  const ok = await getSummary({ request: new Request("https://x.test/api/admin/summary", { headers: { authorization: "Bearer s3cret-token" } }), env });
  assert.equal(ok.status, 200);
  const s = await ok.json();
  assert.equal(s.totals.sessions, 2);
  assert.equal(s.totals.feedback, 4);
  const pr = s.funnel.find((x) => x.mode === "practice");
  assert.deepEqual([pr.started, pr.ended, pr.abandoned], [3, 3, 0]);
  const wo = s.funnel.find((x) => x.mode === "world");
  assert.deepEqual([wo.started, wo.ended, wo.abandoned], [1, 0, 1]);
  const p1 = s.photos.find((x) => x.photo_id === "p1"), p2 = s.photos.find((x) => x.photo_id === "p2");
  assert.equal(p1.pct_solved, 100);
  assert.equal(p2.pct_solved, 0);
  assert.equal(s.photos[0].photo_id, "p2", "hardest photo is listed first");
  assert.deepEqual(s.wrongAnswers[0], { photo_id: "p2", text: "cat", n: 2 });
  assert.deepEqual(s.disputes[0], { photo_id: "p2", answer: "kitty", n: 1 });
  assert.equal(s.rating.avg, 4);
  assert.deepEqual(Object.fromEntries(s.tags.map((t) => [t.tag, t.n])), { fun: 2, too_slow: 1 });
  assert.equal(s.rounds[0].down, 1);
  const g36 = s.byGrid.find((x) => x.grid === 36);
  assert.equal(g36.rounds, 3);
  assert.equal(g36.pct_correct, 33.3);
});

test("G synthetic (wire-map) sessions are stored but never counted; the session endpoint is admin-only", async () => {
  const { onRequestGet: getSession } = await import("../functions/api/admin/session.js");
  const db = d1();
  const env = { DB: db, ADMIN_TOKEN: "tok-123" };
  const SYN = "5e5e5e5e-map-0000000000000001";
  await postEvents({ request: req("/api/e", { sid: SYN, events: [ev("round_start", { mode: "practice", grid: 36, photo_id: "p9" }), ev("round_end", { mode: "practice", grid: 36, photo_id: "p9", data: { outcome: "correct", score: 10, shown: 3 } })] }), env });
  await postFeedback({ request: req("/api/feedback", { sid: SYN, kind: "general", rating: 1, tags: ["other"] }), env });
  await postEvents({ request: req("/api/e", { sid: SID, events: [ev("round_start", { mode: "world", grid: 16, photo_id: "p1" })] }), env });
  const s = await (await getSummary({ request: new Request("https://x.test/api/admin/summary", { headers: { authorization: "Bearer tok-123" } }), env })).json();
  assert.equal(s.totals.sessions, 1, "synthetic session not counted");
  assert.equal(s.totals.events, 1);
  assert.equal(s.totals.feedback, 0);
  assert.equal(s.funnel.find((x) => x.mode === "practice"), undefined);
  assert.equal(s.rating.n, 0);
  const url = "https://x.test/api/admin/session?sid=" + SYN;
  assert.equal((await getSession({ request: new Request(url), env })).status, 401);
  assert.equal((await getSession({ request: new Request("https://x.test/api/admin/session?sid=bad", { headers: { authorization: "Bearer tok-123" } }), env })).status, 400);
  const rows = await (await getSession({ request: new Request(url, { headers: { authorization: "Bearer tok-123" } }), env })).json();
  assert.deepEqual(rows.events.map((e) => e.type), ["round_start", "round_end"]);
  assert.equal(rows.feedback[0].rating, 1);
});

test("H engagement: play time per visit, daily players, retention, errors, platforms and speed medians", async () => {
  const db = d1();
  const env = { DB: db, ADMIN_TOKEN: "t" };
  const DAY = 864e5, now = Date.now(), d0 = now - 10 * DAY; // first day 10 days ago
  const ins = db.raw.prepare("INSERT INTO events(sid,ts,srv_ts,type,mode,photo_id,grid,data) VALUES(?,?,?,?,?,?,?,?)");
  const put = (sid, t, type, data, mode = null) => ins.run(sid, t, t, type, mode, null, null, JSON.stringify(data));
  const A = "aaaaaaaaaaaaaaaa-1", B = "bbbbbbbbbbbbbbbb-2", SYNX = "5e5e5e5e-map-zzzzzzzzzz";
  // A: day 0 visit 4 min (2 rounds), comes back day 1 for 20 min, and day 8 for 0.5 min
  put(A, d0, "session_start", { visit: "a1", os: "ios", browser: "safari", net: "4g", page: { ttfb: 100, load: 900, kb: 300 } });
  put(A, d0 + 1000, "round_start", { img_ms: 120 }, "practice"); put(A, d0 + 2000, "round_start", { img_ms: 80 }, "practice");
  put(A, d0 + 3000, "answer", { kind: "correct", rt: 2000 }, "practice"); put(A, d0 + 4000, "answer", { kind: "wrong", rt: 4000 }, "practice");
  put(A, d0 + 5000, "heartbeat", { visit: "a1", active_ms: 120000, rounds: 1, api_ms: 50 });
  put(A, d0 + 6000, "heartbeat", { visit: "a1", active_ms: 240000, rounds: 2, api_ms: 70, room_rtt: 40 });
  put(A, d0 + DAY, "session_start", { visit: "a2", os: "ios", browser: "safari", page: { ttfb: 300, load: 1100 } });
  put(A, d0 + DAY + 1, "heartbeat", { visit: "a2", active_ms: 1200000, rounds: 9 });
  put(A, d0 + 8 * DAY, "heartbeat", { visit: "a3", active_ms: 30000, rounds: 0 });
  // B: one visit on day 0, never returns; one JS error seen twice, one failed image
  put(B, d0 + 500, "session_start", { visit: "b1", os: "android", browser: "chrome", net: "3g", page: { ttfb: 200, load: 2000 } });
  put(B, d0 + 600, "heartbeat", { visit: "b1", active_ms: 600000, rounds: 5, api_ms: 90 });
  put(B, d0 + 700, "client_error", { kind: "js", msg: "x is undefined", where: "/index.html:10:5" });
  put(B, d0 + 800, "client_error", { kind: "js", msg: "x is undefined", where: "/index.html:10:5" });
  put(B, d0 + 900, "client_error", { kind: "resource", msg: "img failed to load", where: "/photos/owl.jpg" });
  put(B, d0 + 950, "answer", { kind: "correct", rt: 1000 }, "blitz");
  // synthetic traffic must not move any number
  put(SYNX, d0, "heartbeat", { visit: "s1", active_ms: 9e6, rounds: 99 });
  put(SYNX, d0, "client_error", { kind: "js", msg: "probe", where: "" });

  const s = await (await getSummary({ request: new Request("https://x.test/api/admin/summary", { headers: { authorization: "Bearer t" } }), env })).json();
  assert.equal(s.audience.players, 2);
  assert.equal(s.audience.returning_players, 1);
  assert.deepEqual(s.audience.retention_d1, { eligible: 2, returned: 1, pct: 50 });
  assert.deepEqual(s.audience.retention_d7, { eligible: 2, returned: 0, pct: 0 }, "A came back on day 8, not day 7");
  assert.equal(s.audience.retention_d30.eligible, 0, "nobody started 30+ days ago");
  assert.equal(s.audience.visits, 4);
  assert.equal(s.playTime.visits, 4);
  assert.equal(s.playTime.median_min, 10, "visits 0.5, 4, 10, 20 min -> median (upper) 10");
  assert.equal(s.playTime.total_hours, 0.6, "34.5 min");
  assert.deepEqual(s.playTime.buckets.map((b) => b.n), [1, 1, 1, 1, 0]);
  assert.equal(s.playTime.rounds_per_visit, 4, "(2+9+0+5)/4");
  const day0 = s.daily.find((r) => r.day === new Date(d0).toISOString().slice(0, 10));
  assert.equal(day0.players, 2); assert.equal(day0.new_players, 2); assert.equal(day0.rounds, 2); assert.equal(day0.visits, 2);
  const day1 = s.daily.find((r) => r.day === new Date(d0 + DAY).toISOString().slice(0, 10));
  assert.equal(day1.new_players, 0); assert.equal(day1.active_min, 20);
  assert.deepEqual(s.errors.map((e) => [e.kind, e.n, e.players]), [["js", 2, 1], ["resource", 1, 1]]);
  assert.deepEqual(Object.fromEntries(s.platforms.os.map((o) => [o.os, o.n])), { ios: 2, android: 1 });
  assert.equal(s.speed.page_ttfb_ms, 200);
  assert.equal(s.speed.photo_ms, 120, "median of 80,120 (upper)");
  assert.equal(s.speed.api_ms, 70);
  assert.equal(s.speed.room_rtt_ms, 40);
  const pr = s.speed.answer_ms.find((x) => x.mode === "practice");
  assert.deepEqual([pr.answers, pr.median_ms, pr.correct_median_ms], [2, 4000, 2000]);
});
