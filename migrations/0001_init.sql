-- AI relay: event store. D1 (SQLite).
CREATE TABLE IF NOT EXISTS events (
  event_id          TEXT PRIMARY KEY,
  correlation_id    TEXT NOT NULL,
  created_at        TEXT NOT NULL,           -- ISO 8601, JST (+09:00)
  created_ms        INTEGER NOT NULL,
  source            TEXT NOT NULL,
  target            TEXT NOT NULL,
  type              TEXT NOT NULL,           -- instruction/result/notification/error/ack
  priority          TEXT NOT NULL,           -- low/normal/high
  payload           TEXT NOT NULL,           -- JSON
  reply_to          TEXT,
  status            TEXT NOT NULL,           -- awaiting_approval/queued/delivering/delivered/acked/dead/expired/rejected
  hop_count         INTEGER NOT NULL DEFAULT 0,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  approved_by       TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_ms   INTEGER NOT NULL DEFAULT 0,
  expires_ms        INTEGER NOT NULL,
  last_error        TEXT,
  delivered_ms      INTEGER,
  acked_ms          INTEGER,
  ack_note          TEXT,
  body_hash         TEXT NOT NULL,           -- idempotency: same event_id must carry the same content
  updated_ms        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_due    ON events (status, next_attempt_ms);
CREATE INDEX IF NOT EXISTS idx_events_target ON events (target, status, created_ms);
CREATE INDEX IF NOT EXISTS idx_events_corr   ON events (correlation_id, created_ms);

-- Replay protection for signed requests.
CREATE TABLE IF NOT EXISTS nonces (
  nonce   TEXT PRIMARY KEY,
  seen_ms INTEGER NOT NULL
);

-- Free-tier guard: accepted events per JST day.
CREATE TABLE IF NOT EXISTS counters (
  day   TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);

-- Rows waiting to be appended to the AI伝言板 sheet (audit log / fallback delivery).
CREATE TABLE IF NOT EXISTS sheet_outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        TEXT NOT NULL,
  reason          TEXT NOT NULL,             -- audit/fallback
  row             TEXT NOT NULL,             -- JSON array, columns A-G
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_ms INTEGER NOT NULL DEFAULT 0,
  done            INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  UNIQUE (event_id, reason)
);
CREATE INDEX IF NOT EXISTS idx_sheet_due ON sheet_outbox (done, next_attempt_ms);
