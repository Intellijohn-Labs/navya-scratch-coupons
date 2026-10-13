-- Navya Scratch & Win — Postgres schema (Neon).
-- Idempotent: safe to run on every start. Timestamps are stored as UTC (timestamp without time zone).

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS gifts (
  id           SERIAL PRIMARY KEY,
  name         TEXT     NOT NULL,
  description  TEXT     NOT NULL DEFAULT '',
  image        TEXT     NOT NULL DEFAULT '',          -- URL or data: URI (resized on upload)
  kind         TEXT     NOT NULL DEFAULT 'prize' CHECK (kind IN ('prize', 'lose')),
  weight       INTEGER  NOT NULL DEFAULT 10 CHECK (weight >= 0),   -- relative chance
  stock_total  INTEGER  CHECK (stock_total >= 0),                  -- NULL = unlimited
  stock_used   INTEGER  NOT NULL DEFAULT 0,
  valid_days   INTEGER  NOT NULL DEFAULT 15,
  bumper       SMALLINT NOT NULL DEFAULT 0,
  active       SMALLINT NOT NULL DEFAULT 1,
  created_at   TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);

CREATE TABLE IF NOT EXISTS batches (
  id          SERIAL PRIMARY KEY,
  name        TEXT     NOT NULL,
  headline    TEXT     NOT NULL DEFAULT 'Scratch & Win',
  subline     TEXT     NOT NULL DEFAULT 'A sweet surprise is waiting for you!',
  theme       TEXT     NOT NULL DEFAULT 'orange' CHECK (theme IN ('orange', 'chocolate', 'festive')),
  expires_on  DATE,
  count       INTEGER  NOT NULL DEFAULT 0,
  sample      SMALLINT NOT NULL DEFAULT 0,
  created_at  TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);

CREATE TABLE IF NOT EXISTS coupons (
  id              SERIAL PRIMARY KEY,
  code            TEXT     NOT NULL UNIQUE,
  batch_id        INTEGER  NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  serial          INTEGER  NOT NULL,
  status          TEXT     NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'claimed', 'redeemed', 'void')),
  scans           INTEGER  NOT NULL DEFAULT 0,
  first_scan_at   TIMESTAMP,
  gift_id         INTEGER  REFERENCES gifts(id) ON DELETE SET NULL,
  gift_name       TEXT,
  gift_kind       TEXT,
  reward_code     TEXT UNIQUE,
  reward_expires  DATE,
  claim_token     TEXT,
  customer_name   TEXT,
  phone           TEXT,
  area            TEXT,
  dob             DATE,
  occasion        TEXT,
  consent         SMALLINT DEFAULT 0,
  device          TEXT,
  ip              TEXT,
  claimed_at      TIMESTAMP,
  redeemed_at     TIMESTAMP,
  redeemed_note   TEXT
);

CREATE INDEX IF NOT EXISTS idx_coupons_batch   ON coupons(batch_id);
CREATE INDEX IF NOT EXISTS idx_coupons_phone   ON coupons(phone);
CREATE INDEX IF NOT EXISTS idx_coupons_claimed ON coupons(claimed_at DESC) WHERE claimed_at IS NOT NULL;
