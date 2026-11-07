-- PostgreSQL-compatible schema for Aurora DSQL. Apply once with db:init.
-- JSON stays as exact text, split into UTF-8-safe chunks below DSQL's column limit.
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  revision BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS battles (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id),
  encounter_id TEXT NOT NULL DEFAULT 'soulless-survivor',
  source_battle_id TEXT REFERENCES battles(id),
  source_sequence INTEGER,
  opening_saved BOOLEAN NOT NULL DEFAULT FALSE,
  last_sequence INTEGER NOT NULL DEFAULT 0,
  outcome TEXT CHECK (outcome IN ('victory','defeat','escaped')),
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS saves (
  player_id TEXT NOT NULL REFERENCES players(id),
  slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 6),
  id TEXT NOT NULL,
  battle_id TEXT NOT NULL REFERENCES battles(id),
  schema_version INTEGER NOT NULL DEFAULT 2,
  state_parts INTEGER NOT NULL,
  summary_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (player_id,slot)
);
CREATE TABLE IF NOT EXISTS inventory (
  player_id TEXT NOT NULL,
  slot INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  PRIMARY KEY (player_id,slot,item_id),
  FOREIGN KEY (player_id,slot) REFERENCES saves(player_id,slot)
);
CREATE TABLE IF NOT EXISTS combat_decisions (
  id TEXT PRIMARY KEY,
  battle_id TEXT NOT NULL REFERENCES battles(id),
  sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
  turn_number INTEGER NOT NULL CHECK (turn_number > 0),
  actor_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  ability_or_item_id TEXT,
  targets_json TEXT NOT NULL,
  result_parts INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (battle_id,sequence_number)
);
CREATE TABLE IF NOT EXISTS payload_chunks (
  payload_id TEXT NOT NULL,
  part INTEGER NOT NULL CHECK (part >= 0),
  data TEXT NOT NULL,
  PRIMARY KEY (payload_id,part)
);
-- Short-lived transport chunks preserve the old 8 MiB request capability through
-- Lambda Function URLs. Part -1 is the upload header/completion receipt.
CREATE TABLE IF NOT EXISTS request_chunks (
  player_id TEXT NOT NULL REFERENCES players(id),
  upload_id TEXT NOT NULL,
  part INTEGER NOT NULL,
  part_count INTEGER NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  data TEXT NOT NULL,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (player_id,upload_id,part)
);
CREATE TABLE IF NOT EXISTS response_chunks (
  player_id TEXT NOT NULL REFERENCES players(id),
  response_id TEXT NOT NULL,
  part INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (player_id,response_id,part)
);

-- Old snapshots are retired atomically, then reclaimed in small later batches.
CREATE TABLE IF NOT EXISTS retired_payloads (
  payload_id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id),
  retired_at TEXT NOT NULL
);
