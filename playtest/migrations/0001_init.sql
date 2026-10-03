-- Playtest telemetry. Anonymous: random per-browser id, no IP, no account.
CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  country    TEXT,
  device     TEXT,
  viewport   TEXT,
  lang       TEXT,
  build      TEXT,
  events_n   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  sid      TEXT NOT NULL,
  ts       INTEGER NOT NULL,   -- client clock, ms
  srv_ts   INTEGER NOT NULL,   -- server clock, ms
  type     TEXT NOT NULL,
  mode     TEXT,
  round_no INTEGER,
  photo_id TEXT,
  grid     INTEGER,
  data     TEXT                -- JSON, size-capped
);
CREATE INDEX IF NOT EXISTS ev_type ON events(type, srv_ts);
CREATE INDEX IF NOT EXISTS ev_sid  ON events(sid, srv_ts);
CREATE INDEX IF NOT EXISTS ev_photo ON events(photo_id, type);
CREATE TABLE IF NOT EXISTS feedback (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  sid      TEXT NOT NULL,
  srv_ts   INTEGER NOT NULL,
  kind     TEXT NOT NULL,      -- general | round | dispute
  rating   INTEGER,            -- general: 1-5, round: 1 (thumbs up) / 0 (thumbs down)
  tags     TEXT,               -- comma list from a fixed vocabulary
  liked    TEXT,
  disliked TEXT,
  bug      TEXT,
  answer   TEXT,               -- dispute: what the player typed
  photo_id TEXT,
  contact  TEXT,               -- optional, only if the tester typed one
  context  TEXT                -- JSON: screen, mode, round, viewport, recent round log
);
CREATE INDEX IF NOT EXISTS fb_kind ON feedback(kind, srv_ts);
