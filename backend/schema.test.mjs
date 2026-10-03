// Glimpse Rush schema — adversarial tests against a real Postgres 16 engine (PGlite, in-process).
// Run:  npm i @electric-sql/pglite@0.2   then   node --test schema.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const SQL = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
let db;
const q = (s, p) => db.query(s, p);
const one = async (s, p) => (await q(s, p)).rows[0];
const rejects = (s, p, re) => assert.rejects(q(s, p), re);
const H32 = "decode(repeat('ab',32),'hex')";

async function user(handle) {
  return (await one(`INSERT INTO users(auth_uid,handle,display_name) VALUES ($1,$1,$1) RETURNING id`, [handle])).id;
}
async function photo() {
  const a = await one(`INSERT INTO media_assets(sha256,storage_key,mime,bytes,width,height,status,scanned_at)
    VALUES (sha256(gen_random_uuid()::text::bytea),'originals/'||gen_random_uuid(),'image/jpeg',1000,900,900,'clean',now()) RETURNING id`);
  return (await one(`INSERT INTO photos(asset_id,pool,license) VALUES ($1,'ranked','own') RETURNING id`, [a.id])).id;
}
async function round(mode, n = 36, extra = {}) {
  const p = await photo();
  return (await one(`INSERT INTO rounds(mode,photo_id,grid_n,scramble,hint,seed_hash,cycle_start,reveal_start,room_id,round_no)
    VALUES ($1,$2,$3,$4,$5,${H32},now(),now(),$6,$7) RETURNING id`,
    [mode, p, n, extra.scramble ?? 0, extra.hint ?? false, extra.room ?? null, extra.no ?? null])).id;
}
const score = (u, r, mode, s, extra = {}) => q(
  `INSERT INTO scores(user_id,round_id,mode,score,elapsed_ms,pct_shown,scored_at,room_id,team_slot,team_id)
   VALUES ($1,$2,$3,$4,$5,25,coalesce($6::timestamptz,now()),$7,$8,$9)`,
  [u, r, mode, s, extra.el ?? 7000, extra.at ?? null, extra.room ?? null, extra.slot ?? null, extra.team ?? null]);

before(async () => {
  db = new PGlite();
  await db.exec(SQL);
});

// Suite A — schema hygiene
test('A1 schema is idempotent (applies twice)', async () => { await db.exec(SQL); });
test('A2 max_score matches Spec §5.6 × §4a', async () => {
  const r = await one(`SELECT max_score(25,0) a, max_score(36,0) b, max_score(64,0) c, max_score(100,0) d, max_score(100,2) e, max_score(36,1) f`);
  assert.deepEqual([r.a, r.b, r.c, r.d, r.e, r.f], [1920, 2917, 3938, 5940, 8910, 3646]);
});

// Suite B — score integrity
test('B1 score above bound for its round is rejected', async () => {
  const u = await user('b1user'), r = await round('world', 25);
  await rejects(`INSERT INTO scores(user_id,round_id,mode,score,elapsed_ms,pct_shown) VALUES ($1,$2,'world',1921,0,4)`, [u, r], /exceeds max/);
  await score(u, r, 'world', 1920);
});
test('B2 scramble raises the bound only for that round', async () => {
  const u = await user('b2user'), plain = await round('group', 100, { room: null, no: null }).catch(() => null);
  assert.equal(plain, null, 'group round without room must be rejected');
  const rs = await round('practice', 100, { scramble: 2 }), rp = await round('practice', 100);
  await score(u, rs, 'practice', 8910);
  await assert.rejects(score(u, rp, 'practice', 8910), /exceeds max/);
});
test('B3 one score per user per round; negative and mode-mismatched scores rejected', async () => {
  const u = await user('b3user'), r = await round('world');
  await score(u, r, 'world', 100);
  await assert.rejects(score(u, r, 'world', 50), /duplicate key/);
  const r2 = await round('world');
  await assert.rejects(score(u, r2, 'world', -1), /check/i);
  await assert.rejects(score(u, r2, 'daily', 10), /does not match/);
});
test('B4 scores are append-only', async () => {
  await rejects(`UPDATE scores SET score = 0`, [], /append-only/);
  await rejects(`DELETE FROM scores`, [], /append-only/);
});
test('B5 ranked modes cannot carry scramble, hint, or small grids', async () => {
  await assert.rejects(round('world', 36, { scramble: 1 }), /check/i);
  await assert.rejects(round('daily', 36, { hint: true }), /check/i);
  await assert.rejects(round('blitz', 16), /check/i);
});
test('B6 third freeze rejected; time_left out of range rejected', async () => {
  const u = await user('b6user'), r = await round('world');
  const ins = (fz, tl) => q(`INSERT INTO attempts(round_id,user_id,freeze_no,freeze_server_ts,tiles_shown,time_left_ms,result)
     VALUES ($1,$2,$3,now(),5,$4,'wrong')`, [r, u, fz, tl]);
  await ins(1, 20000); await ins(2, 15000);
  await assert.rejects(ins(3, 10000), /check/i);
  await assert.rejects(ins(1, 1000), /duplicate key/);
  const r2 = await round('world');
  await assert.rejects(q(`INSERT INTO attempts(round_id,user_id,freeze_no,freeze_server_ts,tiles_shown,time_left_ms,result) VALUES ($1,$2,1,now(),5,30001,'wrong')`, [r2, u]), /check/i);
});

// Suite C — tamper-evident ledger
test('C1 every score lands in the hash chain and the chain verifies', async () => {
  const n = await one(`SELECT (SELECT count(*) FROM scores) s, (SELECT count(*) FROM score_ledger) l, ledger_verify() v`);
  assert.equal(Number(n.s), Number(n.l));
  assert.equal(n.v, null);
});
test('C2 ledger rows cannot be edited or deleted through normal access', async () => {
  await rejects(`UPDATE score_ledger SET payload = 'x'`, [], /append-only/);
  await rejects(`DELETE FROM score_ledger`, [], /append-only/);
});
test('C3 tampering with a score (triggers bypassed by a superuser) is detected at the exact seq', async () => {
  const before = await one(`SELECT max(seq) m FROM score_ledger`);
  await db.exec(`ALTER TABLE scores DISABLE TRIGGER scores_no_update;
                 UPDATE scores SET score = score + 1 WHERE id = (SELECT score_id FROM score_ledger WHERE seq = 2);
                 ALTER TABLE scores ENABLE TRIGGER scores_no_update;`);
  assert.equal(Number((await one(`SELECT ledger_verify() v`)).v), 2);
  await db.exec(`ALTER TABLE scores DISABLE TRIGGER scores_no_update;
                 UPDATE scores SET score = score - 1 WHERE id = (SELECT score_id FROM score_ledger WHERE seq = 2);
                 ALTER TABLE scores ENABLE TRIGGER scores_no_update;`);
  assert.equal((await one(`SELECT ledger_verify() v`)).v, null);
  assert.ok(Number(before.m) >= 2);
});
test('C4 forging a ledger hash is detected', async () => {
  await db.exec(`ALTER TABLE score_ledger DISABLE TRIGGER ledger_no_update;
                 UPDATE score_ledger SET hash = ${H32} WHERE seq = 1;
                 ALTER TABLE score_ledger ENABLE TRIGGER ledger_no_update;`);
  assert.equal(Number((await one(`SELECT ledger_verify() v`)).v), 1);
  await db.exec(`ALTER TABLE score_ledger DISABLE TRIGGER ledger_no_update;
                 UPDATE score_ledger SET hash = sha256(prev_hash || convert_to(payload,'UTF8')) WHERE seq = 1;
                 ALTER TABLE score_ledger ENABLE TRIGGER ledger_no_update;`);
  assert.equal((await one(`SELECT ledger_verify() v`)).v, null);
});

// Suite D — Chicago calendar keys (§9)
test('D1 day/week keys use America/Chicago, Monday 00:00 reset, ISO week-year, DST', async () => {
  const u = await user('d1user');
  const cases = [
    ['2026-10-04T03:30:00Z', '2026-10-03', '2026-W40'],   // Sat 22:30 CDT, not Sunday UTC
    ['2026-10-05T04:59:59Z', '2026-10-04', '2026-W40'],   // Sun 23:59:59 CDT
    ['2026-10-05T05:00:00Z', '2026-10-05', '2026-W41'],   // Mon 00:00 CDT → new week
    ['2026-11-02T05:59:59Z', '2026-11-01', '2026-W44'],   // after DST ends: Sun 23:59:59 CST
    ['2026-11-02T06:00:00Z', '2026-11-02', '2026-W45'],   // Mon 00:00 CST
    ['2027-01-01T18:00:00Z', '2027-01-01', '2026-W53'],   // Fri Jan 1 2027 belongs to ISO 2026-W53
  ];
  for (const [at, day, week] of cases) {
    const r = await round('world');
    await score(u, r, 'world', 10, { at });
    const row = await one(`SELECT day_key::text d, week_key w FROM scores WHERE user_id=$1 AND round_id=$2`, [u, r]);
    assert.deepEqual([row.d, row.w], [day, week], at);
  }
});

// Suite E — leaderboards
test('E1 weekly board sums only the best 20 of 25 rounds; other weeks untouched', async () => {
  const u = await user('e1user');
  for (let i = 1; i <= 25; i++) await score(u, await round('world'), 'world', i * 10, { at: '2026-10-07T15:00:00Z' });
  await score(u, await round('world'), 'world', 999, { at: '2026-10-14T15:00:00Z' });
  const w40 = await one(`SELECT total, rounds_counted FROM lb_world_week WHERE user_id=$1 AND week_key='2026-W41'`, [u]);
  assert.deepEqual([w40.total, w40.rounds_counted], [(6 + 25) * 20 / 2 * 10, 20]); // 60..250 → 3100
  const w42 = await one(`SELECT total FROM lb_world_week WHERE user_id=$1 AND week_key='2026-W42'`, [u]);
  assert.equal(w42.total, 999);
});
test('E2 team round score = average incl. players with no score, half-up; room total sums rounds', async () => {
  const host = await user('e2host'), a = await user('e2a'), b = await user('e2b'), c = await user('e2c');
  const room = (await one(`INSERT INTO rooms(host_id,code,settings,status) VALUES ($1,'ABC234','{}','playing') RETURNING id`, [host])).id;
  for (const [u, slot] of [[a, 0], [b, 0], [c, 1]]) await q(`INSERT INTO room_players(room_id,user_id,team_slot) VALUES ($1,$2,$3)`, [room, u, slot]);
  const r1 = await round('group', 36, { room, no: 1 }), r2 = await round('group', 36, { room, no: 2 });
  await score(a, r1, 'group', 1001, { room, slot: 0 });            // b missed round 1 → (1001+0)/2 = 500.5 → 501
  await score(c, r1, 'group', 400, { room, slot: 1 });
  await score(a, r2, 'group', 100, { room, slot: 0 });
  await score(b, r2, 'group', 301, { room, slot: 0 });             // (100+301)/2 = 200.5 → 201
  const rows = (await q(`SELECT round_no, team_key, team_score FROM lb_team_round WHERE room_id=$1 ORDER BY round_no, team_key`, [room])).rows;
  assert.deepEqual(rows.map(r => [r.round_no, r.team_key, r.team_score]),
    [[1, 'slot:0', 501], [1, 'slot:1', 400], [2, 'slot:0', 201], [2, 'slot:1', 0]]);
  const tot = (await q(`SELECT team_key, total FROM lb_team_room WHERE room_id=$1 ORDER BY team_key`, [room])).rows;
  assert.deepEqual(tot.map(r => [r.team_key, r.total]), [['slot:0', 702], ['slot:1', 400]]);
});

// Suite F — groups, teams, rooms, packs
test('F1 a player cannot be on two active teams in one group; history is kept', async () => {
  const o = await user('f1owner'), p = await user('f1p');
  const g = (await one(`INSERT INTO groups(name,kind,owner_id,invite_code) VALUES ('Blake Family','family',$1,'FAMXY234') RETURNING id`, [o])).id;
  await q(`INSERT INTO group_members(group_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'member')`, [g, o, p]);
  const t1 = (await one(`INSERT INTO teams(group_id,name,color,created_by) VALUES ($1,'Red','#ff5a6a',$2) RETURNING id`, [g, o])).id;
  const t2 = (await one(`INSERT INTO teams(group_id,name,color,created_by) VALUES ($1,'Blue','#2f8bff',$2) RETURNING id`, [g, o])).id;
  await assert.rejects(q(`INSERT INTO teams(group_id,name,color,created_by) VALUES ($1,'RED','#000000',$2)`, [g, o]), /duplicate key/);
  await q(`INSERT INTO team_members(team_id,group_id,user_id) VALUES ($1,$2,$3)`, [t1, g, p]);
  await assert.rejects(q(`INSERT INTO team_members(team_id,group_id,user_id) VALUES ($1,$2,$3)`, [t2, g, p]), /duplicate key/);
  await q(`UPDATE team_members SET left_at = now() WHERE team_id=$1 AND user_id=$2`, [t1, p]);
  await q(`INSERT INTO team_members(team_id,group_id,user_id) VALUES ($1,$2,$3)`, [t2, g, p]);
  assert.equal(Number((await one(`SELECT count(*) c FROM team_members WHERE user_id=$1`, [p])).c), 2);
});
test('F2 team must belong to the stated group; non-members cannot join a team', async () => {
  const o = await user('f2owner'), x = await user('f2outsider');
  const g1 = (await one(`INSERT INTO groups(name,owner_id,invite_code) VALUES ('Dealer Staff',$1,'DEAXR234') RETURNING id`, [o])).id;
  const g2 = (await one(`INSERT INTO groups(name,owner_id,invite_code) VALUES ('Other',$1,'QTHER234') RETURNING id`, [o])).id;
  await q(`INSERT INTO group_members(group_id,user_id) VALUES ($1,$2),($3,$2)`, [g1, o, g2]);
  const t = (await one(`INSERT INTO teams(group_id,name,color,created_by) VALUES ($1,'Sales','#3ddc84',$2) RETURNING id`, [g1, o])).id;
  await assert.rejects(q(`INSERT INTO team_members(team_id,group_id,user_id) VALUES ($1,$2,$3)`, [t, g2, o]), /does not belong/);
  await assert.rejects(q(`INSERT INTO team_members(team_id,group_id,user_id) VALUES ($1,$2,$3)`, [t, g1, x]), /foreign key/);
});
test('F3 room codes are unique only among unfinished rooms; bad codes rejected', async () => {
  const h = await user('f3host');
  await q(`INSERT INTO rooms(host_id,code,settings,status) VALUES ($1,'QQQ234','{}','finished')`, [h]);
  await q(`INSERT INTO rooms(host_id,code,settings) VALUES ($1,'QQQ234','{}')`, [h]);
  await assert.rejects(q(`INSERT INTO rooms(host_id,code,settings) VALUES ($1,'QQQ234','{}')`, [h]), /duplicate key/);
  await assert.rejects(q(`INSERT INTO rooms(host_id,code,settings) VALUES ($1,'QQI234','{}')`, [h]), /check/i); // I is excluded
});
test('F4 pack rules: attestation required, answers unique case-insensitively, people photos stay private', async () => {
  const o = await user('f4owner'), p = await photo();
  await q(`UPDATE photos SET pool='pack', people_present=true WHERE id=$1`, [p]);
  const pack = (await one(`INSERT INTO packs(owner_id,name) VALUES ($1,'Reunion 2026') RETURNING id`, [o])).id;
  await assert.rejects(q(`INSERT INTO pack_photos(pack_id,photo_id,position) VALUES ($1,$2,0)`, [pack, p]), /null value/);
  await q(`INSERT INTO pack_photos(pack_id,photo_id,position,strict,uploader_attested_at) VALUES ($1,$2,0,true,now())`, [pack, p]);
  await q(`INSERT INTO photo_answers(photo_id,text,kind) VALUES ($1,'Uncle Jim Bob','accepted'),($1,'car','blocked')`, [p]);
  await assert.rejects(q(`INSERT INTO photo_answers(photo_id,text,kind) VALUES ($1,' uncle jim bob ','partial')`, [p]), /duplicate key/);
  await assert.rejects(q(`UPDATE packs SET visibility='public_pending' WHERE id=$1`, [pack]), /must stay private/);
});
test('F5 media: unscanned assets cannot be marked clean; oversize and wrong types rejected', async () => {
  const ins = (status, scanned, bytes, mime) => q(`INSERT INTO media_assets(sha256,storage_key,mime,bytes,width,height,status,scanned_at)
    VALUES (sha256(gen_random_uuid()::text::bytea),'k/'||gen_random_uuid(),$1,$2,10,10,$3,$4)`, [mime, bytes, status, scanned]);
  await assert.rejects(ins('clean', null, 100, 'image/jpeg'), /check/i);
  await assert.rejects(ins('pending_scan', null, 15728641, 'image/jpeg'), /check/i);
  await assert.rejects(ins('pending_scan', null, 100, 'image/svg+xml'), /check/i);
  await ins('pending_scan', null, 100, 'image/heic');
});
test('F6 handles: format enforced, unique case-insensitively among live accounts', async () => {
  await user('RonB_1');
  await assert.rejects(user('ronb_1'), /duplicate key/);
  await assert.rejects(q(`INSERT INTO users(auth_uid,handle,display_name) VALUES ('x','no spaces','x')`), /check/i);
  await assert.rejects(q(`INSERT INTO users(auth_uid,handle,display_name) VALUES ('y','<script>','x')`), /check/i);
});
