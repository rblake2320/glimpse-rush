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

const all = async (db, sql, ...b) => (await db.prepare(sql).bind(...b).all()).results ?? [];

export async function summary(db, now) {
  const day = now - 864e5;
  const one = async (sql, ...b) => (await db.prepare(sql).bind(...b).first()) ?? {};
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
    recent: await all(db,
      `SELECT id, srv_ts, kind, rating, tags, liked, disliked, bug, answer, photo_id, contact, context
       FROM feedback ORDER BY id DESC LIMIT 100`),
  };
}
