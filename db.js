// SQLite storage (built into Node 22.13+). One file: data/navya.db
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

// Vercel's filesystem is read-only except /tmp (and /tmp is per-instance, not permanent).
const DATA_DIR = process.env.DATA_DIR || (process.env.VERCEL ? '/tmp/navya-data' : path.join(__dirname, 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'navya.db'));

db.exec(`
PRAGMA busy_timeout = 5000;
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS gifts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  description  TEXT DEFAULT '',
  image        TEXT DEFAULT '',
  kind         TEXT NOT NULL DEFAULT 'prize',   -- prize | lose
  weight       INTEGER NOT NULL DEFAULT 10,     -- relative chance
  stock_total  INTEGER,                         -- NULL = unlimited
  stock_used   INTEGER NOT NULL DEFAULT 0,
  valid_days   INTEGER NOT NULL DEFAULT 15,
  bumper       INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS batches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  headline    TEXT NOT NULL DEFAULT 'Scratch & Win',
  subline     TEXT NOT NULL DEFAULT 'A sweet surprise is waiting for you!',
  theme       TEXT NOT NULL DEFAULT 'orange',  -- orange | chocolate | festive
  expires_on  TEXT,                            -- YYYY-MM-DD
  count       INTEGER NOT NULL DEFAULT 0,
  sample      INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS coupons (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  code            TEXT NOT NULL UNIQUE,
  batch_id        INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  serial          INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'new',  -- new | claimed | redeemed | void
  scans           INTEGER NOT NULL DEFAULT 0,
  first_scan_at   TEXT,
  gift_id         INTEGER REFERENCES gifts(id) ON DELETE SET NULL,
  gift_name       TEXT,
  gift_kind       TEXT,
  reward_code     TEXT UNIQUE,
  reward_expires  TEXT,
  claim_token     TEXT,
  customer_name   TEXT,
  phone           TEXT,
  area            TEXT,
  dob             TEXT,
  occasion        TEXT,
  consent         INTEGER DEFAULT 0,
  device          TEXT,
  ip              TEXT,
  claimed_at      TEXT,
  redeemed_at     TEXT,
  redeemed_note   TEXT
);
CREATE INDEX IF NOT EXISTS idx_coupons_batch ON coupons(batch_id);
CREATE INDEX IF NOT EXISTS idx_coupons_phone ON coupons(phone);
`);

const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
function randomCode(len) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += CHARS[bytes[i] % CHARS.length];
  return s;
}

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

function createBatch({ name, headline, subline, theme, expires_on, count, sample = 0, codeFn = () => randomCode(8) }) {
  return tx(() => {
    const info = db.prepare(`INSERT INTO batches(name, headline, subline, theme, expires_on, count, sample)
      VALUES(?,?,?,?,?,?,?)`).run(name, headline, subline, theme, expires_on || null, count, sample);
    const batchId = Number(info.lastInsertRowid);
    const ins = db.prepare('INSERT INTO coupons(code, batch_id, serial) VALUES(?,?,?)');
    const exists = db.prepare('SELECT 1 FROM coupons WHERE code = ?');
    for (let i = 1; i <= count; i++) {
      let code;
      do { code = codeFn(); } while (exists.get(code));
      ins.run(code, batchId, i);
    }
    return batchId;
  });
}

function daysFromNow(n) {
  const d = new Date(Date.now() + n * 86400000);
  return d.toISOString().slice(0, 10);
}

// ---------- First-run seed: brand settings, gifts, a demo batch, sample claims ----------
function seed() {
  if (getSetting('seeded')) return;
  setSetting('session_secret', crypto.randomBytes(32).toString('hex'));
  // Never ship a known default password: use ADMIN_PASSWORD, or generate one and show it once.
  const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
  setSetting('admin_password', pw);
  if (!process.env.ADMIN_PASSWORD) console.log(`\n  First run — admin password: ${pw}\n  (change it in Settings, or set ADMIN_PASSWORD before the first start)\n`);
  setSetting('shop_name', 'Navya Bakers');
  setSetting('tagline', 'The Tempting Taste');
  setSetting('public_url', '');
  setSetting('whatsapp', '919400197802');
  setSetting('one_per_phone', '0');
  setSetting('terms', 'One coupon per customer visit. Reward valid at Navya Bake Shop outlets till the date shown. Not exchangeable for cash.');

  const g = db.prepare(`INSERT INTO gifts(name, description, image, kind, weight, stock_total, valid_days, bumper)
    VALUES(?,?,?,?,?,?,?,?)`);
  g.run('Celebration Cake (1 kg)', 'Our signature red velvet celebration cake — on the house!', '/img/cake.webp', 'prize', 1, 3, 30, 1);
  g.run('Choco-Chip Cookie Box', 'A box of freshly baked choco-chip cookies.', '/img/cookies.webp', 'prize', 14, 60, 15, 0);
  g.run('Caramel Pudding', 'Silky caramel pudding, made with 100% natural flavours.', '/img/desserts.webp', 'prize', 12, 50, 15, 0);
  g.run('Free Savoury Combo', 'Crunchy savouries combo pack — perfect for tea time.', '/img/savouries.webp', 'prize', 14, 80, 15, 0);
  g.run('Fresh Bread Loaf', 'A fresh wholewheat bread loaf from our ovens.', '/img/bread.webp', 'prize', 16, 100, 7, 0);
  g.run('15% Off Your Next Bill', 'Flat 15% off on your next purchase above ₹300.', '/img/snacks.webp', 'prize', 18, null, 30, 0);
  g.run('Better luck next time', 'Thank you for choosing Navya! Keep scanning — more sweet surprises are coming.', '', 'lose', 25, null, 0, 0);

  // Demo campaign: fresh coupons to print + a few already-claimed ones so the dashboard has life.
  // On Vercel every cold instance seeds its own copy, so make the demo codes identical everywhere.
  let n = 0;
  const fixedCode = () => crypto.createHash('sha256').update('navya-demo-' + n++).digest()
    .subarray(0, 8).reduce((s, b) => s + CHARS[b % CHARS.length], '');
  const batchId = createBatch({
    codeFn: process.env.VERCEL ? fixedCode : undefined,
    name: 'Festive Sweet Scratch', headline: 'Scratch & Win', subline: 'A sweet surprise is waiting for you!',
    theme: 'orange', expires_on: daysFromNow(60), count: 24, sample: 1,
  });
  const sample = [
    ['Anjali Menon', '9847012345', 'Angamaly', 1], ['Rahul Varghese', '9895123456', 'Kalady', 2],
    ['Fathima Rasheed', '9446234567', 'Aluva', 0], ['Joseph Thomas', '9744345678', 'Angamaly', 3],
    ['Sneha Nair', '9961456789', 'Perumbavoor', 4], ['Arjun Das', '9037567890', 'Chalakudy', 6],
    ['Meera Joseph', '9567678901', 'Angamaly', 5], ['Nikhil Paul', '8089789012', 'Kalady', 1],
    ['Divya Krishnan', '9633890123', 'Aluva', 2],
  ];
  const coupons = db.prepare('SELECT id FROM coupons WHERE batch_id = ? ORDER BY serial LIMIT ?').all(batchId, sample.length);
  const gifts = db.prepare('SELECT * FROM gifts ORDER BY id').all();
  const upd = db.prepare(`UPDATE coupons SET status=?, scans=?, first_scan_at=?, gift_id=?, gift_name=?, gift_kind=?,
    reward_code=?, reward_expires=?, claim_token=?, customer_name=?, phone=?, area=?, consent=1, claimed_at=?, redeemed_at=?
    WHERE id=?`);
  const bump = db.prepare('UPDATE gifts SET stock_used = stock_used + 1 WHERE id = ?');
  sample.forEach(([name, phone, area, giftIdx], i) => {
    const gift = gifts[giftIdx];
    const at = new Date(Date.now() - (i * 26 + 3) * 3600000);
    const atStr = at.toISOString().replace('T', ' ').slice(0, 19);
    const redeemed = i % 3 === 0 && gift.kind === 'prize'
      ? new Date(at.getTime() + 20 * 3600000).toISOString().replace('T', ' ').slice(0, 19) : null;
    upd.run(redeemed ? 'redeemed' : 'claimed', 1 + (i % 2), atStr, gift.id, gift.name, gift.kind,
      gift.kind === 'prize' ? 'NB' + randomCode(6) : null,
      gift.kind === 'prize' ? new Date(at.getTime() + gift.valid_days * 86400000).toISOString().slice(0, 10) : null,
      crypto.randomBytes(16).toString('hex'), name, phone, area, atStr, redeemed, coupons[i].id);
    bump.run(gift.id);
  });
  setSetting('seeded', '1');
}
seed();

module.exports = { db, getSetting, setSetting, tx, createBatch, randomCode, daysFromNow };
