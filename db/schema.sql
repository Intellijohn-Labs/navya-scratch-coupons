-- Genuine Draw — multi-merchant Postgres schema (Neon).
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

-- ---------------------------------------------------------------- Phase 0: outlets, staff, activity log

-- A merchant's branches / shops.
CREATE TABLE IF NOT EXISTS outlets (
  id          SERIAL PRIMARY KEY,
  tenant_id   INTEGER  NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT     NOT NULL,
  address     TEXT     NOT NULL DEFAULT '',
  phone       TEXT     NOT NULL DEFAULT '',
  maps_url    TEXT     NOT NULL DEFAULT '',
  active      SMALLINT NOT NULL DEFAULT 1,
  created_at  TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);
CREATE INDEX IF NOT EXISTS idx_outlets_tenant ON outlets(tenant_id);

-- Extra logins for a merchant. The merchant itself (tenants row) is the owner.
--   manager: everything except account settings, team and outlets
--   counter: redeem rewards only (tied to an outlet)
CREATE TABLE IF NOT EXISTS staff (
  id               SERIAL PRIMARY KEY,
  tenant_id        INTEGER  NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  outlet_id        INTEGER  REFERENCES outlets(id) ON DELETE SET NULL,
  name             TEXT     NOT NULL,
  username         TEXT     NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9][a-z0-9.-]{1,39}$'),
  role             TEXT     NOT NULL CHECK (role IN ('manager', 'counter')),
  password_hash    TEXT     NOT NULL,
  session_version  INTEGER  NOT NULL DEFAULT 1,
  active           SMALLINT NOT NULL DEFAULT 1,
  last_login_at    TIMESTAMP,
  created_at       TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);
CREATE INDEX IF NOT EXISTS idx_staff_tenant ON staff(tenant_id);

ALTER TABLE batches ADD COLUMN IF NOT EXISTS outlet_id INTEGER REFERENCES outlets(id) ON DELETE SET NULL;      -- where the coupons are handed out
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS redeemed_outlet_id INTEGER REFERENCES outlets(id) ON DELETE SET NULL;
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS redeemed_by TEXT;                                                 -- who handed the gift over

-- Tamper-evident activity log: every row stores the hash of the previous row, so editing or
-- deleting history breaks the chain (see verifyAudit in db.js). Rows are never updated.
-- tenant_id has no foreign key on purpose: history stays even if a merchant is deleted.
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   INTEGER,
  actor_type  TEXT     NOT NULL,          -- super | owner | manager | counter | customer | system
  actor_id    INTEGER,
  actor_name  TEXT     NOT NULL DEFAULT '',
  action      TEXT     NOT NULL,          -- e.g. coupon.claimed, gift.updated, merchant.suspended
  entity      TEXT     NOT NULL DEFAULT '',
  entity_id   TEXT     NOT NULL DEFAULT '',
  details     JSONB    NOT NULL DEFAULT '{}',
  ip          TEXT     NOT NULL DEFAULT '',
  created_at  TIMESTAMP NOT NULL,
  prev_hash   TEXT     NOT NULL,
  hash        TEXT     NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_log(tenant_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);

-- ---------------------------------------------------------------- Phase 1: self sign-up, campaigns

-- Merchants can now sign themselves up and wait for approval.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_status_check2') THEN
    ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_status_check;
    ALTER TABLE tenants ADD CONSTRAINT tenants_status_check2 CHECK (status IN ('active', 'suspended', 'pending', 'rejected'));
  END IF;
END $$;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS owner_name     TEXT NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS email          TEXT NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS gst_number     TEXT NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS business_type  TEXT NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS signup_source  TEXT NOT NULL DEFAULT 'super';    -- super | self
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS decided_at     TIMESTAMP;                         -- approved / rejected
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS reject_reason  TEXT NOT NULL DEFAULT '';

-- A campaign groups coupon batches. Instant Win = scratch and win now; Lucky Draw = collect entries, draw later.
CREATE TABLE IF NOT EXISTS campaigns (
  id           SERIAL PRIMARY KEY,
  tenant_id    INTEGER  NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         TEXT     NOT NULL,
  type         TEXT     NOT NULL DEFAULT 'instant' CHECK (type IN ('instant', 'draw')),
  description  TEXT     NOT NULL DEFAULT '',
  terms        TEXT     NOT NULL DEFAULT '',
  starts_on    DATE,
  ends_on      DATE,
  draw_on      DATE,                                    -- Lucky Draw only
  status       TEXT     NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'drawn')),
  created_at   TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);
CREATE INDEX IF NOT EXISTS idx_campaigns_tenant ON campaigns(tenant_id);
ALTER TABLE batches ADD COLUMN IF NOT EXISTS campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_batches_campaign ON batches(campaign_id);

-- Prizes announced for a Lucky Draw (rank 1 = first prize).
CREATE TABLE IF NOT EXISTS campaign_prizes (
  id           SERIAL PRIMARY KEY,
  campaign_id  INTEGER  NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  rank         INTEGER  NOT NULL DEFAULT 1,
  name         TEXT     NOT NULL,
  description  TEXT     NOT NULL DEFAULT '',
  image        TEXT     NOT NULL DEFAULT '',
  quantity     INTEGER  NOT NULL DEFAULT 1 CHECK (quantity >= 1)
);
CREATE INDEX IF NOT EXISTS idx_prizes_campaign ON campaign_prizes(campaign_id);

-- ---------------------------------------------------------------- Phase 2: customers, complaints

-- One-time WhatsApp codes for the customer portal.
CREATE TABLE IF NOT EXISTS otp_codes (
  id          SERIAL PRIMARY KEY,
  phone       TEXT     NOT NULL,
  code_hash   TEXT     NOT NULL,
  attempts    INTEGER  NOT NULL DEFAULT 0,
  expires_at  TIMESTAMP NOT NULL,
  used        SMALLINT NOT NULL DEFAULT 0,
  created_at  TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);
CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_codes(phone, id DESC);

-- Complaint tickets. A ticket belongs to the merchant of the coupon (or, without a coupon, the chosen merchant).
CREATE TABLE IF NOT EXISTS complaints (
  id             SERIAL PRIMARY KEY,
  ticket_no      TEXT     NOT NULL UNIQUE,
  tenant_id      INTEGER  REFERENCES tenants(id) ON DELETE CASCADE,
  coupon_id      INTEGER  REFERENCES coupons(id) ON DELETE SET NULL,
  coupon_code    TEXT     NOT NULL DEFAULT '',
  outlet_id      INTEGER  REFERENCES outlets(id) ON DELETE SET NULL,
  phone          TEXT     NOT NULL,
  customer_name  TEXT     NOT NULL DEFAULT '',
  category       TEXT     NOT NULL CHECK (category IN ('not_received', 'prize_not_given', 'result_dispute', 'invalid_coupon', 'other')),
  description    TEXT     NOT NULL,
  photo          TEXT     NOT NULL DEFAULT '',
  incident_at    TIMESTAMP,
  status         TEXT     NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'rejected')),
  escalated      SMALLINT NOT NULL DEFAULT 0,
  escalated_at   TIMESTAMP,
  escalation_reason TEXT  NOT NULL DEFAULT '',
  resolved_at    TIMESTAMP,
  created_at     TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
  updated_at     TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);
CREATE INDEX IF NOT EXISTS idx_complaints_tenant ON complaints(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_complaints_phone  ON complaints(phone, created_at DESC);

CREATE TABLE IF NOT EXISTS complaint_messages (
  id            SERIAL PRIMARY KEY,
  complaint_id  INTEGER  NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
  author_type   TEXT     NOT NULL CHECK (author_type IN ('customer', 'merchant', 'super', 'system')),
  author_name   TEXT     NOT NULL DEFAULT '',
  body          TEXT     NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);
CREATE INDEX IF NOT EXISTS idx_cmsg_complaint ON complaint_messages(complaint_id, id);

-- ---------------------------------------------------------------- Phase 3: provably fair Lucky Draw

-- Entries are flagged so they still count as entries after a winner's coupon becomes a prize.
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS draw_entry SMALLINT NOT NULL DEFAULT 0;
UPDATE coupons SET draw_entry = 1 WHERE gift_kind = 'entry' AND draw_entry = 0;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS claim_days INTEGER NOT NULL DEFAULT 30;   -- winners collect within this many days
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS backups INTEGER NOT NULL DEFAULT 3;       -- reserve winners drawn after the prizes

-- One draw per Lucky Draw campaign. "sealed" = entry list frozen and fingerprinted, waiting for the public
-- random number (drand round); "drawn" = winners picked.
CREATE TABLE IF NOT EXISTS draws (
  id                 SERIAL PRIMARY KEY,
  campaign_id        INTEGER  NOT NULL UNIQUE REFERENCES campaigns(id) ON DELETE CASCADE,
  tenant_id          INTEGER  NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  status             TEXT     NOT NULL CHECK (status IN ('sealed', 'drawn')),
  entries_count      INTEGER  NOT NULL,
  entries_hash       TEXT     NOT NULL,
  entries_list       TEXT     NOT NULL,
  beacon_round       BIGINT   NOT NULL,
  beacon_randomness  TEXT,
  beacon_signature   TEXT,
  beacon_url         TEXT,
  seed               TEXT,
  picks              JSONB,
  run_by             TEXT     NOT NULL DEFAULT '',
  sealed_at          TIMESTAMP NOT NULL,
  drawn_at           TIMESTAMP
);
CREATE TABLE IF NOT EXISTS draw_winners (
  id            SERIAL PRIMARY KEY,
  draw_id       INTEGER  NOT NULL REFERENCES draws(id) ON DELETE CASCADE,
  campaign_id   INTEGER  NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  tenant_id     INTEGER  NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pick_no       INTEGER  NOT NULL,                    -- order drawn (1 = first)
  backup        SMALLINT NOT NULL DEFAULT 0,          -- drawn as a reserve
  prize_id      INTEGER,
  prize_rank    INTEGER,
  prize_name    TEXT,
  coupon_id     INTEGER  REFERENCES coupons(id) ON DELETE SET NULL,
  coupon_code   TEXT     NOT NULL,
  status        TEXT     NOT NULL CHECK (status IN ('won', 'forfeited', 'standby')),
  replaces_id   INTEGER,                              -- backup promoted in place of a forfeited winner
  status_at     TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_draw_winners_draw ON draw_winners(draw_id, pick_no);

-- Draws of any size: the sealed list is stored as chunks (Vercel Blob when configured, otherwise here).
ALTER TABLE draws ALTER COLUMN entries_list DROP NOT NULL;
ALTER TABLE draws ADD COLUMN IF NOT EXISTS algo SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE draws ADD COLUMN IF NOT EXISTS chunk_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE draws ADD COLUMN IF NOT EXISTS countdown_seconds INTEGER NOT NULL DEFAULT 90;
CREATE TABLE IF NOT EXISTS draw_chunks (
  draw_id  INTEGER NOT NULL REFERENCES draws(id) ON DELETE CASCADE,
  idx      INTEGER NOT NULL,
  hash     TEXT    NOT NULL,
  lines    INTEGER NOT NULL,
  body     TEXT,            -- the chunk itself when Blob storage isn't set up
  url      TEXT,            -- public Blob URL otherwise
  PRIMARY KEY (draw_id, idx)
);
