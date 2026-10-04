import { LIMITS } from "./ingest.js";

export async function rateLimited(db, sid, now) {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE sid=? AND srv_ts>?").bind(sid, now - 60000).first();
  return (r?.n ?? 0) >= LIMITS.perMinute;
}

export async function saveBatch(db, batch, country, now) {
  const { sid, meta, events } = batch;
  const stmts = [
    db.prepare(
      `INSERT INTO sessions(sid,first_seen,last_seen,country,device,viewport,lang,build,events_n)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(sid) DO UPDATE SET last_seen=excluded.last_seen, events_n=events_n+excluded.events_n,
         viewport=COALESCE(excluded.viewport,viewport), build=COALESCE(excluded.build,build)`
    ).bind(sid, now, now, country, meta.device, meta.viewport, meta.lang, meta.build, events.length),
  ];
  for (const e of events) {
    stmts.push(
      db.prepare("INSERT INTO events(sid,ts,srv_ts,type,mode,round_no,photo_id,grid,data) VALUES(?,?,?,?,?,?,?,?,?)")
        .bind(sid, e.ts, now, e.type, e.mode, e.round_no, e.photo_id, e.grid, e.data)
    );
  }
  await db.batch(stmts);
  return events.length;
}

export async function saveFeedback(db, fb, now) {
  await db.prepare(
    `INSERT INTO feedback(sid,srv_ts,kind,rating,tags,liked,disliked,bug,answer,photo_id,contact,context)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(fb.sid, now, fb.kind, fb.rating, fb.tags, fb.liked, fb.disliked, fb.bug, fb.answer, fb.photo_id, fb.contact, fb.context).run();
}

// Wire-map and test traffic uses this session-id prefix; it is stored like any other session but never counted.
export const SYNTHETIC_PREFIX = "5e5e5e5e";
const real = (sql) => sql.replace(/\bFROM (events|feedback|sessions)\b/g, `FROM (SELECT * FROM $1 WHERE sid NOT LIKE '${SYNTHETIC_PREFIX}%') $1`);
const rawAll = async (db, sql, ...b) => (await db.prepare(sql).bind(...b).all()).results ?? [];
const all = (db, sql, ...b) => rawAll(db, real(sql), ...b);

export async function sessionRows(db, sid) {
  return {
    session: await db.prepare("SELECT * FROM sessions WHERE sid=?").bind(sid).first(),
    events: await rawAll(db, "SELECT type, mode, round_no, photo_id, grid, data FROM events WHERE sid=? ORDER BY id", sid),
    feedback: await rawAll(db, "SELECT kind, rating, tags, liked, disliked, bug, answer, photo_id, context FROM feedback WHERE sid=? ORDER BY id", sid),
  };
}

export async function summary(db, now) {
  const day = now - 864e5;
  const one = async (sql, ...b) => (await db.prepare(real(sql)).bind(...b).first()) ?? {};
  const totals = await one(
    `SELECT (SELECT COUNT(*) FROM sessions) AS sessions,
            (SELECT COUNT(*) FROM sessions WHERE last_seen>?) AS sessions_24h,
            (SELECT COUNT(*) FROM events) AS events,
            (SELECT COUNT(*) FROM feedback) AS feedback`, day);
  return {
    generated: now,
    totals,
    funnel: await all(db,
      `SELECT mode,
         SUM(type='round_start') AS started, SUM(type='round_end') AS ended, SUM(type='round_abandon') AS abandoned
       FROM events WHERE type IN ('round_start','round_end','round_abandon') GROUP BY mode ORDER BY started DESC`),
    outcomes: await all(db,
      `SELECT mode, json_extract(data,'$.outcome') AS outcome, COUNT(*) AS n,
              ROUND(AVG(json_extract(data,'$.score'))) AS avg_score
       FROM events WHERE type='round_end' GROUP BY mode, outcome ORDER BY mode, n DESC`),
    byGrid: await all(db,
      `SELECT grid, COUNT(*) AS rounds,
              ROUND(100.0*SUM(json_extract(data,'$.outcome')='correct')/COUNT(*),1) AS pct_correct,
              ROUND(AVG(json_extract(data,'$.shown')),1) AS avg_tiles_at_freeze,
              ROUND(AVG(json_extract(data,'$.score'))) AS avg_score
       FROM events WHERE type='round_end' AND grid IS NOT NULL GROUP BY grid ORDER BY grid`),
    photos: await all(db,
      `SELECT photo_id, COUNT(*) AS rounds,
              ROUND(100.0*SUM(json_extract(data,'$.outcome') IN ('correct','partial'))/COUNT(*),1) AS pct_solved,
              ROUND(AVG(json_extract(data,'$.shown')),1) AS avg_tiles_at_freeze
       FROM events WHERE type='round_end' AND photo_id IS NOT NULL GROUP BY photo_id ORDER BY pct_solved ASC, rounds DESC LIMIT 40`),
    wrongAnswers: await all(db,
      `SELECT photo_id, json_extract(data,'$.text') AS text, COUNT(*) AS n
       FROM events WHERE type='answer' AND json_extract(data,'$.kind')='wrong'
       GROUP BY photo_id, text ORDER BY n DESC LIMIT 60`),
    disputes: await all(db,
      `SELECT photo_id, answer, COUNT(*) AS n FROM feedback WHERE kind='dispute' GROUP BY photo_id, answer ORDER BY n DESC LIMIT 60`),
    rounds: await all(db,
      `SELECT photo_id, SUM(rating=1) AS up, SUM(rating=0) AS down FROM feedback WHERE kind='round' AND photo_id IS NOT NULL
       GROUP BY photo_id ORDER BY down DESC, up DESC LIMIT 40`),
    rating: await one(`SELECT ROUND(AVG(rating),2) AS avg, COUNT(rating) AS n FROM feedback WHERE kind='general'`),
    tags: await all(db,
      `WITH RECURSIVE s(tag, rest) AS (
         SELECT '', tags || ',' FROM feedback WHERE tags IS NOT NULL
         UNION ALL SELECT substr(rest,1,instr(rest,',')-1), substr(rest,instr(rest,',')+1) FROM s WHERE rest<>'')
       SELECT tag, COUNT(*) AS n FROM s WHERE tag<>'' GROUP BY tag ORDER BY n DESC`),
    devices: await all(db, `SELECT device, COUNT(*) AS n FROM sessions GROUP BY device ORDER BY n DESC LIMIT 10`),
    countries: await all(db, `SELECT country, COUNT(*) AS n FROM sessions GROUP BY country ORDER BY n DESC LIMIT 10`),
    ...(await engagement(db, now)),
    recent: await all(db,
      `SELECT id, srv_ts, kind, rating, tags, liked, disliked, bug, answer, photo_id, contact, context
       FROM feedback ORDER BY id DESC LIMIT 100`),
  };
}

// ---------------------------------------------------------------- engagement, errors, platforms, speed
const med = (a) => { const b = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null; };
const avg = (a) => { const b = a.filter((x) => Number.isFinite(x)); return b.length ? Math.round(b.reduce((x, y) => x + y, 0) / b.length) : null; };
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const DAY = 864e5;

export async function engagement(db, now) {
  // one row per visit (page load): active play time and rounds, from heartbeats
  const visits = await all(db, `SELECT sid, json_extract(data,'$.visit') AS visit, MAX(json_extract(data,'$.active_ms')) AS active_ms,
      MAX(json_extract(data,'$.rounds')) AS rounds, MIN(srv_ts) AS t FROM events WHERE type='heartbeat' GROUP BY sid, visit LIMIT 20000`);
  // activity days per player, from any event
  const days = await all(db, `SELECT sid, date(srv_ts/1000,'unixepoch') AS day, COUNT(*) AS n, SUM(type='round_start') AS rounds
      FROM events GROUP BY sid, day LIMIT 50000`);
  const byPlayer = new Map();
  for (const d of days) { if (!byPlayer.has(d.sid)) byPlayer.set(d.sid, []); byPlayer.get(d.sid).push(d.day); }
  const players = byPlayer.size;
  const firstDay = new Map([...byPlayer].map(([sid, ds]) => [sid, ds.sort()[0]]));
  const ret = (k) => {
    const eligible = [...byPlayer].filter(([sid]) => Date.parse(firstDay.get(sid)) <= now - k * DAY);
    // classic Day-N retention: active on exactly day N after their first day (calendar days, UTC)
    const back = eligible.filter(([sid, ds]) => ds.some((d) => Math.round((Date.parse(d) - Date.parse(firstDay.get(sid))) / DAY) === k));
    return { eligible: eligible.length, returned: back.length, pct: eligible.length ? Math.round((100 * back.length) / eligible.length) : null };
  };
  const activeIn = (ms) => new Set(days.filter((d) => Date.parse(d.day) >= Date.parse(dayOf(now - ms))).map((d) => d.sid)).size;
  const mins = visits.map((v) => v.active_ms / 60000);
  const bucket = (lo, hi) => mins.filter((m) => m >= lo && m < hi).length;
  // daily table, last 30 days
  const daily = new Map();
  for (const d of days) {
    const r = daily.get(d.day) ?? { day: d.day, players: 0, new_players: 0, rounds: 0, visits: 0, active_min: 0 };
    r.players++; r.rounds += d.rounds || 0; if (firstDay.get(d.sid) === d.day) r.new_players++;
    daily.set(d.day, r);
  }
  for (const v of visits) { const r = daily.get(dayOf(v.t)); if (r) { r.visits++; r.active_min += v.active_ms / 60000; } }
  const dailyRows = [...daily.values()].sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, 30)
    .map((r) => ({ ...r, active_min: Math.round(r.active_min), avg_visit_min: r.visits ? Math.round((10 * r.active_min) / r.visits) / 10 : null }));

  const starts = await all(db, `SELECT data FROM events WHERE type='session_start' ORDER BY id DESC LIMIT 5000`);
  const plat = starts.map((r) => JSON.parse(r.data || "{}"));
  const count = (key) => Object.entries(plat.reduce((m, p) => ((m[p[key] ?? "unknown"] = (m[p[key] ?? "unknown"] || 0) + 1), m), {}))
    .map(([k, n]) => ({ [key]: k, n })).sort((a, b) => b.n - a.n);
  const answers = await all(db, `SELECT mode, json_extract(data,'$.rt') AS rt, json_extract(data,'$.kind') AS kind FROM events WHERE type='answer' ORDER BY id DESC LIMIT 20000`);
  const hbs = await all(db, `SELECT json_extract(data,'$.api_ms') AS api, json_extract(data,'$.room_rtt') AS rtt, json_extract(data,'$.room_join_ms') AS rjoin FROM events WHERE type='heartbeat' ORDER BY id DESC LIMIT 20000`);
  const imgs = await all(db, `SELECT json_extract(data,'$.img_ms') AS ms FROM events WHERE type='round_start' ORDER BY id DESC LIMIT 20000`);
  const modes = [...new Set(answers.map((a) => a.mode))];

  return {
    audience: {
      players, active_1d: activeIn(DAY), active_7d: activeIn(7 * DAY), active_30d: activeIn(30 * DAY),
      returning_players: [...byPlayer.values()].filter((ds) => new Set(ds).size > 1).length,
      retention_d1: ret(1), retention_d7: ret(7), retention_d30: ret(30),
      visits: visits.length, visits_per_player: players ? Math.round((10 * visits.length) / players) / 10 : null,
    },
    playTime: {
      visits: visits.length, median_min: med(mins) === null ? null : Math.round(med(mins) * 10) / 10, avg_min: visits.length ? Math.round((10 * mins.reduce((a, b) => a + b, 0)) / visits.length) / 10 : null,
      total_hours: Math.round((10 * mins.reduce((a, b) => a + b, 0)) / 60) / 10, rounds_per_visit: avg(visits.map((v) => v.rounds)),
      buckets: [{ range: "under 1 min", n: bucket(0, 1) }, { range: "1-5 min", n: bucket(1, 5) }, { range: "5-15 min", n: bucket(5, 15) }, { range: "15-30 min", n: bucket(15, 30) }, { range: "30+ min", n: bucket(30, 1e9) }],
    },
    daily: dailyRows,
    errors: await all(db, `SELECT json_extract(data,'$.kind') AS kind, json_extract(data,'$.msg') AS msg, json_extract(data,'$.where') AS "where",
        COUNT(*) AS n, COUNT(DISTINCT sid) AS players, MAX(srv_ts) AS last FROM events WHERE type='client_error' GROUP BY kind, msg, "where" ORDER BY n DESC LIMIT 50`),
    platforms: { os: count("os"), browser: count("browser"), net: count("net"), inapp: plat.filter((p) => p.inapp).length, standalone: plat.filter((p) => p.standalone).length },
    speed: {
      answer_ms: modes.map((m) => { const a = answers.filter((x) => x.mode === m); return { mode: m, answers: a.length, median_ms: med(a.map((x) => x.rt)), correct_median_ms: med(a.filter((x) => x.kind === "correct").map((x) => x.rt)) }; }),
      page_ttfb_ms: med(plat.map((p) => p.page?.ttfb)), page_load_ms: med(plat.map((p) => p.page?.load)), page_kb: med(plat.map((p) => p.page?.kb)),
      photo_ms: med(imgs.map((x) => x.ms)), api_ms: med(hbs.map((x) => x.api)), room_rtt_ms: med(hbs.map((x) => x.rtt)), room_join_ms: med(hbs.map((x) => x.rjoin)),
    },
  };
}
