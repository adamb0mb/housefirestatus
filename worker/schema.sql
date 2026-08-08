-- D1 schema for address-change email subscriptions.
-- Apply with: wrangler d1 execute housefirestatus-subscriptions --remote --file=worker/schema.sql

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  address TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0,
  confirm_token TEXT,
  unsubscribe_token TEXT NOT NULL,
  -- JSON snapshot of the last status this subscription was checked/notified against,
  -- so the cron job can diff "what changed" instead of re-notifying on every run.
  last_status_json TEXT,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  last_notified_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_confirmed ON subscriptions(confirmed);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_confirm_token ON subscriptions(confirm_token);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_unsubscribe_token ON subscriptions(unsubscribe_token);
