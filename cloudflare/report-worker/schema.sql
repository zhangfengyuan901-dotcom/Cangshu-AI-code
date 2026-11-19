CREATE TABLE IF NOT EXISTS incidents (
  fingerprint TEXT PRIMARY KEY, created INTEGER NOT NULL, updated INTEGER NOT NULL,
  payload TEXT NOT NULL, notified INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS receipts_group ON receipts(fingerprint);
CREATE INDEX IF NOT EXISTS incidents_pending ON incidents(notified,created);
CREATE TABLE IF NOT EXISTS mail_slots(fingerprint TEXT PRIMARY KEY, hour INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS mail_slots_hour ON mail_slots(hour);
