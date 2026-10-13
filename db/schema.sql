-- Scratch & Win — multi-bakery Postgres schema (Neon).
-- Idempotent: safe to run on every start. Timestamps are stored as UTC (timestamp without time zone).

-- Platform-wide values (session secret, super-admin password hash, …).
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- One row per bakery (tenant). `slug` is also the bakery's login username.
CREATE TABLE IF NOT EXISTS tenants (
  id               SERIAL PRIMARY KEY,
  slug             TEXT     NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  name             TEXT     NOT NULL,
  tagline          TEXT     NOT NULL DEFAULT '',
  logo             TEXT     NOT NULL DEFAULT '',          -- URL or data: URI
  color            TEXT     NOT NULL DEFAULT '#F47216',   -- main brand colour
  color2           TEXT     NOT NULL DEFAULT '#963B1F',   -- dark accent
  address          TEXT     NOT NULL DEFAULT '',
  maps_url         TEXT     NOT NULL DEFAULT '',
  website          TEXT     NOT NULL DEFAULT '',
  whatsapp         TEXT     NOT NULL DEFAULT '',
  footer           TEXT     NOT NULL DEFAULT '',          -- e.g. "Since 1984 · 100% natural flavours"
  areas            TEXT     NOT NULL DEFAULT '',          -- comma list shown as suggestions on the customer form
  terms            TEXT     NOT NULL DEFAULT '',
  public_url       TEXT     NOT NULL DEFAULT '',
  one_per_phone    SMALLINT NOT NULL DEFAULT 0,
  password_hash    TEXT     NOT NULL,
  session_version  INTEGER  NOT NULL DEFAULT 1,           -- bump to log the bakery out everywhere
  status           TEXT     NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  plan_expires_on  DATE,                                  -- NULL = no expiry
  max_coupons      INTEGER  CHECK (max_coupons >= 0),     -- NULL = unlimited
  contact_name     TEXT     NOT NULL DEFAULT '',
  contact_phone    TEXT     NOT NULL DEFAULT '',
  notes            TEXT     NOT NULL DEFAULT '',
  last_login_at    TIMESTAMP,
  created_at       TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);

CREATE TABLE IF NOT EXISTS gifts (
  id           SERIAL PRIMARY KEY,
  tenant_id    INTEGER  REFERENCES tenants(id) ON DELETE CASCADE,
  name         TEXT     NOT NULL,
  description  TEXT     NOT NULL DEFAULT '',
  image        TEXT     NOT NULL DEFAULT '',          -- URL, data: URI, or "emoji:🎂"
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
  tenant_id   INTEGER  REFERENCES tenants(id) ON DELETE CASCADE,
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
  tenant_id       INTEGER  REFERENCES tenants(id) ON DELETE CASCADE,
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

-- Upgrade path for databases created before multi-bakery support (tenant_id is backfilled in db.js).
ALTER TABLE gifts   ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE batches ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_gifts_tenant     ON gifts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_batches_tenant   ON batches(tenant_id);
CREATE INDEX IF NOT EXISTS idx_coupons_batch    ON coupons(batch_id);
CREATE INDEX IF NOT EXISTS idx_coupons_tenant   ON coupons(tenant_id, claimed_at DESC);
CREATE INDEX IF NOT EXISTS idx_coupons_phone    ON coupons(tenant_id, phone);
CREATE INDEX IF NOT EXISTS idx_coupons_claimed  ON coupons(claimed_at DESC) WHERE claimed_at IS NOT NULL;
