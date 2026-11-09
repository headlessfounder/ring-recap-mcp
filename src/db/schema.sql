-- Ring Recap ledger. Spec section 7, plus a few columns the pipeline needs
-- (attempts, audio_state, tags_json, camera_name in FTS kept current, kv state).

CREATE TABLE IF NOT EXISTS clips (
  ding_id TEXT PRIMARY KEY,
  camera_id TEXT NOT NULL,
  camera_name TEXT NOT NULL,
  day TEXT NOT NULL,                 -- YYYY-MM-DD local
  created_at INTEGER NOT NULL,       -- epoch ms
  duration_s REAL,
  kind TEXT,                         -- motion | ding | on_demand ...
  person_detected INTEGER,           -- 0/1/null
  status TEXT NOT NULL,              -- queued | downloaded | transcribed | described | faced | done | failed
  error TEXT,
  transcript TEXT,                   -- NULL = not yet run, '' = silent / no audio / no speech
  description TEXT,
  faces_json TEXT,                   -- [{name|"unknown", confidence, frame}]
  bytes INTEGER,
  updated_at INTEGER NOT NULL,
  -- additions
  attempts INTEGER NOT NULL DEFAULT 0,   -- failed processing attempts
  audio_state TEXT,                      -- speech | silent | no_audio | no_speech
  tags_json TEXT                         -- {"people","vehicles","notable","tags"} from the describer
);
CREATE INDEX IF NOT EXISTS clips_day ON clips(day, camera_id);
CREATE INDEX IF NOT EXISTS clips_status ON clips(status);

CREATE VIRTUAL TABLE IF NOT EXISTS clips_fts USING fts5(
  ding_id UNINDEXED, camera_name, transcript, description, faces_json, tags
);

CREATE TABLE IF NOT EXISTS recaps (
  day TEXT NOT NULL,
  camera_id TEXT NOT NULL,           -- 'site' for the whole-location rollup
  markdown TEXT NOT NULL,
  json TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  PRIMARY KEY (day, camera_id)
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  day TEXT, started_at INTEGER, finished_at INTEGER,
  clips_found INTEGER, clips_done INTEGER, clips_failed INTEGER, notes TEXT
);

-- Small key/value store for health state (auth status, last camera list, etc).
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
