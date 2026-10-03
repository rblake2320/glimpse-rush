-- Glimpse Rush — Postgres system of record (Spec v1.1 §15, §20, §21)
-- Target: PostgreSQL 15+ (tested on 16.4). Idempotent: safe to run more than once.
-- Live ranks live in Redis; this database is the source of truth and the audit record.

-- No extensions needed: gen_random_uuid() and sha256() are core since PostgreSQL 13 and 11.

-- ---------- Accounts & profiles ----------
CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_uid      text NOT NULL UNIQUE,                      -- Firebase Auth uid
  handle        text NOT NULL CHECK (handle ~ '^[A-Za-z0-9_]{3,20}$'),
  display_name  text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 40),
  avatar_asset  uuid,                                      -- FK added after media_assets
  country       char(2),
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,        -- sound, haptics, default grid, etc.
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz                                -- soft delete; PII scrubbed by job
);
CREATE UNIQUE INDEX IF NOT EXISTS users_handle_ci ON users (lower(handle)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS friendships (
  user_id    uuid NOT NULL REFERENCES users(id),
  friend_id  uuid NOT NULL REFERENCES users(id),
  status     text NOT NULL CHECK (status IN ('pending','accepted','blocked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, friend_id),
  CHECK (user_id <> friend_id)
);

-- ---------- Groups (family, friends, team, company) and persistent teams ----------
CREATE TABLE IF NOT EXISTS groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  kind        text NOT NULL DEFAULT 'friends' CHECK (kind IN ('family','friends','team','company','school','other')),
  owner_id    uuid NOT NULL REFERENCES users(id),
  invite_code text NOT NULL UNIQUE CHECK (invite_code ~ '^[A-HJ-KM-NP-Z2-9]{8}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id  uuid NOT NULL REFERENCES groups(id),
  user_id   uuid NOT NULL REFERENCES users(id),
  role      text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS teams (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    uuid NOT NULL REFERENCES groups(id),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 30),
  color       text NOT NULL CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS teams_name_per_group ON teams (group_id, lower(name)) WHERE archived_at IS NULL;

-- Membership history: a row per stint. One active team per user per group.
CREATE TABLE IF NOT EXISTS team_members (
  team_id   uuid NOT NULL REFERENCES teams(id),
  group_id  uuid NOT NULL REFERENCES groups(id),
  user_id   uuid NOT NULL REFERENCES users(id),
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at   timestamptz,
  CHECK (left_at IS NULL OR left_at >= joined_at),
  FOREIGN KEY (group_id, user_id) REFERENCES group_members(group_id, user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_team_per_group ON team_members (group_id, user_id) WHERE left_at IS NULL;

CREATE OR REPLACE FUNCTION team_member_group_matches() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM teams WHERE id = NEW.team_id AND group_id = NEW.group_id) THEN
    RAISE EXCEPTION 'team % does not belong to group %', NEW.team_id, NEW.group_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS team_member_group_matches ON team_members;
CREATE TRIGGER team_member_group_matches BEFORE INSERT OR UPDATE ON team_members
  FOR EACH ROW EXECUTE FUNCTION team_member_group_matches();

-- ---------- Media, photos, answers, packs ----------
CREATE TABLE IF NOT EXISTS media_assets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     uuid REFERENCES users(id),                  -- NULL = house content
  sha256       bytea NOT NULL CHECK (octet_length(sha256) = 32),
  storage_key  text NOT NULL UNIQUE,                       -- originals/{id}.jpg in object storage
  mime         text NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp','image/heic')),
  bytes        integer NOT NULL CHECK (bytes BETWEEN 1 AND 15728640),
  width        integer NOT NULL CHECK (width > 0),
  height       integer NOT NULL CHECK (height > 0),
  status       text NOT NULL DEFAULT 'pending_scan' CHECK (status IN ('pending_scan','clean','blocked','deleted')),
  scanned_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  CHECK (status <> 'clean' OR scanned_at IS NOT NULL)
);
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_avatar_fk FOREIGN KEY (avatar_asset) REFERENCES media_assets(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS photos (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id       uuid NOT NULL REFERENCES media_assets(id),
  pool           text NOT NULL CHECK (pool IN ('ranked','practice','pack')),
  category       text,
  license        text,                                     -- required for ranked/practice
  source_url     text,
  people_present boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired','removed')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (pool = 'pack' OR license IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS photo_answers (
  photo_id uuid NOT NULL REFERENCES photos(id),
  text     text NOT NULL CHECK (char_length(btrim(text)) BETWEEN 1 AND 60),
  kind     text NOT NULL CHECK (kind IN ('accepted','partial','blocked'))
);
CREATE UNIQUE INDEX IF NOT EXISTS photo_answers_unique_ci ON photo_answers (photo_id, lower(btrim(text)));

CREATE TABLE IF NOT EXISTS packs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES users(id),
  group_id   uuid REFERENCES groups(id),
  name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public_pending','public','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS pack_photos (
  pack_id              uuid NOT NULL REFERENCES packs(id),
  photo_id             uuid NOT NULL REFERENCES photos(id),
  position             integer NOT NULL CHECK (position >= 0),
  strict               boolean NOT NULL DEFAULT false,
  hint                 text CHECK (hint IS NULL OR char_length(hint) <= 60),
  uploader_attested_at timestamptz NOT NULL,              -- "I have permission to share this photo with this group"
  PRIMARY KEY (pack_id, photo_id),
  UNIQUE (pack_id, position)
);

-- A pack containing a photo of people can never leave 'private'.
CREATE OR REPLACE FUNCTION pack_visibility_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.visibility <> 'private' AND EXISTS (
       SELECT 1 FROM pack_photos pp JOIN photos ph ON ph.id = pp.photo_id
       WHERE pp.pack_id = NEW.id AND ph.people_present) THEN
    RAISE EXCEPTION 'pack % contains photos of people and must stay private', NEW.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pack_visibility_guard ON packs;
CREATE TRIGGER pack_visibility_guard BEFORE UPDATE OF visibility ON packs
  FOR EACH ROW EXECUTE FUNCTION pack_visibility_guard();

-- ---------- Rooms, rounds, attempts ----------
CREATE TABLE IF NOT EXISTS rooms (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id   uuid REFERENCES groups(id),
  host_id    uuid NOT NULL REFERENCES users(id),
  code       char(6) NOT NULL CHECK (code ~ '^[A-HJ-KM-NP-Z2-9]{6}$'),
  settings   jsonb NOT NULL,          -- {grid, rounds, hint, scramble, scramble_each, photo_source, teams:{enabled, scoring:'average'}}
  status     text NOT NULL DEFAULT 'lobby' CHECK (status IN ('lobby','playing','finished')),
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at   timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS rooms_code_active ON rooms (code) WHERE status <> 'finished';

CREATE TABLE IF NOT EXISTS room_players (
  room_id   uuid NOT NULL REFERENCES rooms(id),
  user_id   uuid NOT NULL REFERENCES users(id),
  team_id   uuid REFERENCES teams(id),                    -- persistent team, or NULL
  team_slot smallint CHECK (team_slot BETWEEN 0 AND 3),   -- ad-hoc room team when no persistent team
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id),
  CHECK (team_id IS NULL OR team_slot IS NULL)
);

CREATE TABLE IF NOT EXISTS rounds (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode         text NOT NULL CHECK (mode IN ('world','daily','blitz','practice','group')),
  room_id      uuid REFERENCES rooms(id),
  round_no     integer CHECK (round_no >= 1),
  photo_id     uuid NOT NULL REFERENCES photos(id),
  grid_n       smallint NOT NULL CHECK (grid_n IN (4,9,16,25,36,64,100)),
  scramble     smallint NOT NULL DEFAULT 0 CHECK (scramble BETWEEN 0 AND 2),
  hint         boolean NOT NULL DEFAULT false,
  seed_hash    bytea NOT NULL CHECK (octet_length(seed_hash) = 32),   -- sha256(seed); seed revealed after RESULTS for audit
  cycle_start  timestamptz NOT NULL,
  reveal_start timestamptz NOT NULL,
  CHECK (reveal_start >= cycle_start),
  CHECK (mode <> 'group' OR (room_id IS NOT NULL AND round_no IS NOT NULL)),
  CHECK (mode IN ('practice','group') OR (scramble = 0 AND NOT hint)),          -- §4a, §5.3: ranked modes plain
  CHECK (mode NOT IN ('world','daily','blitz') OR grid_n >= 25)
);
CREATE UNIQUE INDEX IF NOT EXISTS rounds_room_no ON rounds (room_id, round_no) WHERE room_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS attempts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id         uuid NOT NULL REFERENCES rounds(id),
  user_id          uuid NOT NULL REFERENCES users(id),
  freeze_no        smallint NOT NULL CHECK (freeze_no IN (1,2)),            -- §6.5: max 2 freezes
  freeze_server_ts timestamptz NOT NULL,
  tiles_shown      smallint NOT NULL CHECK (tiles_shown >= 1),
  time_left_ms     integer NOT NULL CHECK (time_left_ms BETWEEN 0 AND 30000),
  answer_text      text CHECK (answer_text IS NULL OR char_length(answer_text) <= 80),
  result           text NOT NULL CHECK (result IN ('correct','partial','wrong','timeout','unfreeze','backgrounded')),
  score            integer NOT NULL DEFAULT 0 CHECK (score >= 0),
  flags            text[] NOT NULL DEFAULT '{}',
  UNIQUE (round_id, user_id, freeze_no)
);

-- ---------- Scoring bound (§5.6 × §4a) ----------
CREATE OR REPLACE FUNCTION grid_mult_100(n integer) RETURNS integer IMMUTABLE LANGUAGE sql AS $$
  SELECT CASE n WHEN 4 THEN 50 WHEN 9 THEN 75 WHEN 16 THEN 90 WHEN 25 THEN 100
                WHEN 36 THEN 150 WHEN 64 THEN 200 WHEN 100 THEN 300 END $$;
CREATE OR REPLACE FUNCTION max_score(n integer, scramble integer) RETURNS integer IMMUTABLE LANGUAGE sql AS $$
  -- divHalfUp(1000·G100·(N−1)·2·S4, 100·N·4), S4 = 4/5/6
  SELECT ((2 * (1000::bigint * grid_mult_100(n) * (n - 1) * 2 * (4 + scramble)) + (100 * n * 4))
          / (2 * (100 * n * 4)))::integer $$;

-- ---------- Scores (one per user per round) ----------
CREATE TABLE IF NOT EXISTS scores (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id),
  round_id   uuid NOT NULL REFERENCES rounds(id),
  mode       text NOT NULL,
  group_id   uuid REFERENCES groups(id),
  room_id    uuid REFERENCES rooms(id),
  team_id    uuid REFERENCES teams(id),
  team_slot  smallint,
  score      integer NOT NULL CHECK (score >= 0),
  elapsed_ms integer NOT NULL CHECK (elapsed_ms >= 0 AND (mode = 'blitz' OR elapsed_ms <= 39999)),
  pct_shown  smallint NOT NULL CHECK (pct_shown BETWEEN 0 AND 100),
  scored_at  timestamptz NOT NULL DEFAULT now(),
  day_key    date,                                         -- set by trigger, America/Chicago
  week_key   text,                                         -- ISO week-year, e.g. 2026-W40
  UNIQUE (user_id, round_id)
);
CREATE INDEX IF NOT EXISTS scores_week ON scores (mode, week_key, user_id);
CREATE INDEX IF NOT EXISTS scores_room ON scores (room_id) WHERE room_id IS NOT NULL;

CREATE OR REPLACE FUNCTION scores_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r rounds%ROWTYPE; local_ts timestamp;
BEGIN
  SELECT * INTO r FROM rounds WHERE id = NEW.round_id;
  IF NEW.mode <> r.mode THEN
    RAISE EXCEPTION 'score mode % does not match round mode %', NEW.mode, r.mode USING ERRCODE = '23514';
  END IF;
  IF NEW.score > max_score(r.grid_n, r.scramble) THEN
    RAISE EXCEPTION 'score % exceeds max % for N=% scramble=%', NEW.score, max_score(r.grid_n, r.scramble), r.grid_n, r.scramble
      USING ERRCODE = '23514';
  END IF;
  local_ts     := NEW.scored_at AT TIME ZONE 'America/Chicago';
  NEW.day_key  := local_ts::date;
  NEW.week_key := to_char(local_ts, 'IYYY"-W"IW');
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS scores_before_insert ON scores;
CREATE TRIGGER scores_before_insert BEFORE INSERT ON scores FOR EACH ROW EXECUTE FUNCTION scores_before_insert();

-- Scores are written once. Corrections are new ledger entries, never edits.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END $$;
DROP TRIGGER IF EXISTS scores_no_update ON scores;
CREATE TRIGGER scores_no_update BEFORE UPDATE OR DELETE ON scores FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------- Tamper-evident score ledger (hash chain) ----------
CREATE TABLE IF NOT EXISTS score_ledger (
  seq       bigint PRIMARY KEY,
  score_id  bigint NOT NULL UNIQUE REFERENCES scores(id),
  payload   text   NOT NULL,                               -- canonical "score_id|user_id|round_id|score|elapsed_ms|scored_at"
  prev_hash bytea  NOT NULL CHECK (octet_length(prev_hash) = 32),
  hash      bytea  NOT NULL CHECK (octet_length(hash) = 32)
);

CREATE OR REPLACE FUNCTION ledger_append() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prev bytea; next_seq bigint; body text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('score_ledger'));       -- serialize chain writers across sessions
  SELECT hash, seq + 1 INTO prev, next_seq FROM score_ledger ORDER BY seq DESC LIMIT 1;
  IF prev IS NULL THEN prev := decode(repeat('00', 32), 'hex'); next_seq := 1; END IF;
  body := NEW.id || '|' || NEW.user_id || '|' || NEW.round_id || '|' || NEW.score || '|' || NEW.elapsed_ms || '|' ||
          to_char(NEW.scored_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  INSERT INTO score_ledger (seq, score_id, payload, prev_hash, hash)
    VALUES (next_seq, NEW.id, body, prev, sha256(prev || convert_to(body, 'UTF8')));
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS scores_ledger_append ON scores;
CREATE TRIGGER scores_ledger_append AFTER INSERT ON scores FOR EACH ROW EXECUTE FUNCTION ledger_append();
DROP TRIGGER IF EXISTS ledger_no_update ON score_ledger;
CREATE TRIGGER ledger_no_update BEFORE UPDATE OR DELETE ON score_ledger FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Returns the first broken seq, or NULL when the whole chain verifies (prev links, hashes, and payload ↔ scores row).
CREATE OR REPLACE FUNCTION ledger_verify() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE l record; expect_prev bytea := decode(repeat('00', 32), 'hex'); expect_seq bigint := 1; s scores%ROWTYPE; body text;
BEGIN
  FOR l IN SELECT * FROM score_ledger ORDER BY seq LOOP
    IF l.seq <> expect_seq OR l.prev_hash <> expect_prev
       OR l.hash <> sha256(l.prev_hash || convert_to(l.payload, 'UTF8')) THEN RETURN l.seq; END IF;
    SELECT * INTO s FROM scores WHERE id = l.score_id;
    body := s.id || '|' || s.user_id || '|' || s.round_id || '|' || s.score || '|' || s.elapsed_ms || '|' ||
            to_char(s.scored_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
    IF body IS DISTINCT FROM l.payload THEN RETURN l.seq; END IF;
    expect_prev := l.hash; expect_seq := expect_seq + 1;
  END LOOP;
  RETURN NULL;
END $$;

-- ---------- Leaderboards (system-of-record queries; Redis mirrors these live) ----------
-- §9 This Week: sum of each player's best 20 World Live scores in the ISO week.
CREATE OR REPLACE VIEW lb_world_week AS
SELECT week_key, user_id, sum(score)::integer AS total, count(*)::integer AS rounds_counted
FROM (SELECT week_key, user_id, score,
             row_number() OVER (PARTITION BY week_key, user_id ORDER BY score DESC, scored_at) AS rn
      FROM scores WHERE mode = 'world') s
WHERE rn <= 20 GROUP BY week_key, user_id;

-- §9 Today: best 10 World Live scores per Chicago day.
CREATE OR REPLACE VIEW lb_world_day AS
SELECT day_key, user_id, sum(score)::integer AS total
FROM (SELECT day_key, user_id, score,
             row_number() OVER (PARTITION BY day_key, user_id ORDER BY score DESC, scored_at) AS rn
      FROM scores WHERE mode = 'world') s
WHERE rn <= 10 GROUP BY day_key, user_id;

-- §20.2 Team round score = average over the team's players in that room (no score = 0), integer half-up.
CREATE OR REPLACE VIEW lb_team_round AS
WITH team_players AS (
  SELECT rp.room_id, rp.user_id, coalesce(rp.team_id::text, 'slot:' || rp.team_slot) AS team_key
  FROM room_players rp WHERE rp.team_id IS NOT NULL OR rp.team_slot IS NOT NULL
), per_round AS (
  SELECT r.room_id, r.id AS round_id, r.round_no, tp.team_key,
         count(*) AS players, coalesce(sum(sc.score), 0) AS points
  FROM rounds r
  JOIN team_players tp ON tp.room_id = r.room_id
  LEFT JOIN scores sc ON sc.round_id = r.id AND sc.user_id = tp.user_id
  GROUP BY r.room_id, r.id, r.round_no, tp.team_key
)
SELECT room_id, round_id, round_no, team_key, players::integer, points::integer,
       ((2 * points + players) / (2 * players))::integer AS team_score
FROM per_round;

CREATE OR REPLACE VIEW lb_team_room AS
SELECT room_id, team_key, sum(team_score)::integer AS total, count(*)::integer AS rounds
FROM lb_team_round GROUP BY room_id, team_key;

-- Persistent team standings: sum of each persistent team's room totals, by the room's Chicago ISO week.
CREATE OR REPLACE VIEW lb_team_week AS
SELECT rm.group_id, to_char(rm.created_at AT TIME ZONE 'America/Chicago', 'IYYY"-W"IW') AS week_key,
       tr.team_key::uuid AS team_id, sum(tr.total)::integer AS total, count(*)::integer AS rooms_played
FROM lb_team_room tr JOIN rooms rm ON rm.id = tr.room_id
WHERE rm.group_id IS NOT NULL AND tr.team_key NOT LIKE 'slot:%'
GROUP BY rm.group_id, week_key, tr.team_key;

-- Profile stats.
CREATE OR REPLACE VIEW profile_stats AS
SELECT u.id AS user_id, count(s.id)::integer AS rounds_scored,
       coalesce(max(s.score) FILTER (WHERE s.mode = 'world'), 0) AS best_world_round,
       coalesce(min(s.elapsed_ms) FILTER (WHERE s.mode = 'world'), NULL) AS fastest_world_ms,
       coalesce(min(s.pct_shown), NULL) AS lowest_pct_shown
FROM users u LEFT JOIN scores s ON s.user_id = u.id
GROUP BY u.id;
